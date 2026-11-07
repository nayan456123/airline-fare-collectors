import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planSearches, runBatch } from './batch.mjs';
import { verifyRun } from './verify.mjs';
import { tryBrowserLease } from './browser-admission.mjs';
import { backgroundDisplay } from './background-display.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idPattern = /^[\w-]+$/;
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const pause = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
});
const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('Send JSON input.');
  let value = '';
  for await (const chunk of req) { value += chunk; if (value.length > 20000) throw new Error('Request too large'); }
  return JSON.parse(value || '{}');
}

async function collectSearch(query, mode, signal, onWorker = async () => {}, onProgress = async () => {}) {
  let lease;
  while (!signal.aborted && !(lease = await tryBrowserLease())) await pause(500, signal);
  if (signal.aborted) { await lease?.release(); return { status: 'interrupted', cause: { code: 'USER_STOP' } }; }
  try {
    return await new Promise(resolve => {
      const args = [path.join(root, 'src/collect.mjs'), '--search', `${query.origin}:${query.destination}:${query.travelDate}`, mode === 'headless' ? '--headless' : '--background'];
      const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      onWorker(child.pid || null).catch(() => {});
      let output = '', error = '', killTimer, pending = '';
      const stop = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 8000); };
      signal.addEventListener('abort', stop, { once: true });
      if (child.pid) lease.attach(child.pid).catch(() => {});
      child.stdout.on('data', data => {
        output = (output + data).slice(-20000); pending += data;
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) { try { const event = JSON.parse(line); if (event.event === 'stage') onProgress(event.stage).catch(() => {}); } catch {} }
      });
      child.stderr.on('data', data => { error = (error + data).slice(-2000); });
      const cleanup = () => { clearTimeout(killTimer); signal.removeEventListener('abort', stop); };
      child.on('error', e => { cleanup(); resolve({ status: 'failed', cause: { code: 'WORKER_ERROR', detail: e.message } }); });
      child.on('close', async () => {
        cleanup();
        if (signal.aborted) return resolve({ status: 'interrupted', cause: { code: 'USER_STOP' } });
        try {
          const summary = JSON.parse(output.trim().split('\n').at(-1));
          if (!idPattern.test(summary.run)) throw new Error('Invalid run identifier');
          const dir = path.join(root, 'runs', summary.run);
          const result = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
          if (['ok', 'empty'].includes(result.status)) {
            const verified = await verifyRun(dir, query);
            if (!verified.ok) throw new Error(verified.errors.join('; '));
          }
          resolve({ ...result, runId: summary.run });
        } catch (e) { resolve({ status: 'failed', cause: { code: 'WORKER_ERROR', detail: error || e.message } }); }
      });
    });
  } finally { await lease.release(); await onWorker(null); }
}

export async function createServer({ runRoot = path.join(root, 'web-runs'), collector = collectSearch, intervalMs = 20000 } = {}) {
  let active = null, controller;
  const writes = new Map();
  await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
  const save = job => {
    const content = JSON.stringify(job, null, 2);
    const next = (writes.get(job.id) || Promise.resolve()).then(async () => {
      const dir = path.join(runRoot, job.id); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const temporary = path.join(dir, 'job.tmp');
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, path.join(dir, 'job.json'));
    });
    writes.set(job.id, next); return next;
  };
  const load = async id => JSON.parse(await fs.readFile(path.join(runRoot, id, 'job.json'), 'utf8'));
  const recent = async () => {
    const dirs = (await fs.readdir(runRoot)).filter(id => idPattern.test(id)).sort().reverse();
    const runs = [];
    for (const id of dirs.slice(0, 30)) { try { const job = await load(id); runs.push({ id, status: job.status, count: job.tasks.length }); } catch {} }
    return runs;
  };
  for (const item of await recent()) {
    const job = await load(item.id);
    if (['running', 'stopping'].includes(job.status) && (!job.ownerPid || !alive(job.ownerPid))) {
      if (alive(job.workerPid)) throw new Error(`A previous SpiceJet worker is still active (PID ${job.workerPid}). Wait for it before restarting.`);
      job.status = 'interrupted'; job.stopReason = 'SERVER_STOPPED';
      for (const task of job.tasks) {
        if (task.status === 'running') { task.status = 'interrupted'; task.fares = []; task.cause = { code: 'SERVER_STOPPED' }; }
        if (task.status === 'queued') { task.status = 'skipped'; task.cause = { code: 'SERVER_STOPPED' }; }
      }
      await save(job);
    }
    if (!active) active = job;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && ['/', '/app.js', '/styles.css'].includes(url.pathname)) {
        const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        res.writeHead(200, { 'content-type': filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.js') ? 'text/javascript' : 'text/css', 'cache-control': 'no-store' });
        return res.end(await fs.readFile(path.join(root, 'web', filename)));
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') return send(res, 200, { runs: await recent() });
      if (req.method === 'GET' && url.pathname === '/api/run') {
        const id = url.searchParams.get('id');
        if (id && !idPattern.test(id)) throw new Error('Invalid run identifier');
        return send(res, 200, { run: id ? active?.id === id ? active : await load(id) : active });
      }
      const evidence = /^\/evidence\/([\w-]+)\/(result\.json|availability\.json|cards\.json|results\.html|results\.png|failure\.html|failure\.png)$/.exec(url.pathname);
      if (req.method === 'GET' && evidence) {
        const content = await fs.readFile(path.join(root, 'runs', evidence[1], evidence[2]));
        res.writeHead(200, { 'content-type': evidence[2].endsWith('.png') ? 'image/png' : 'application/octet-stream', 'content-disposition': `attachment; filename="${evidence[2]}"`, 'x-content-type-options': 'nosniff' }); return res.end(content);
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        await body(req);
        if (controller && active?.status === 'running') { active.status = 'stopping'; controller.abort(); }
        return send(res, 200, { run: active });
      }
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const input = await body(req), queries = planSearches(input.searches), mode = input.mode === 'headless' ? 'headless' : 'background';
        if (active && ['running', 'stopping'].includes(active.status)) return send(res, 409, { error: 'A batch is already running.' });
        const job = { id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`, ownerPid: process.pid, startedAt: new Date().toISOString(), status: 'running', mode, policy: { intervalMs, maxRetries: 1, retryWaitMs: Math.max(20000, intervalMs) }, tasks: queries.map(query => ({ query, status: 'queued', fares: [] })) };
        controller = new AbortController(); const signal = controller.signal; active = job;
        await save(job);
        runBatch(queries, query => collector(query, mode, signal, async pid => { job.workerPid = pid; await save(job); }, async stage => { const task = job.tasks.find(t => t.status === 'running'); if (task) { task.stage = stage; await save(job); } }), { intervalMs, signal, onUpdate: async tasks => { job.tasks = tasks; await save(job); } })
          .then(async result => { Object.assign(job, result, { finishedAt: new Date().toISOString() }); await save(job); })
          .catch(async error => { job.status = 'failed'; job.error = error.message; await save(job); });
        return send(res, 201, { run: job });
      }
      send(res, 404, { error: 'Not found' });
    } catch (error) { send(res, 400, { error: error.message }); }
  });
  server.on('close', () => controller?.abort());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SPICEJET_PORT || 8790);
  const display = await backgroundDisplay();
  process.env.SPICEJET_BACKGROUND_DISPLAY = display.display;
  const server = await createServer().catch(async error => { await display.close(); throw error; });
  server.on('close', () => { display.close().catch(() => {}); });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; display.close().catch(() => {}); });
  server.listen(port, '127.0.0.1', () => console.log(`SpiceJet local page: http://127.0.0.1:${server.address().port}`));
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}
