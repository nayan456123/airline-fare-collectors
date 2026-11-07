#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobManager, OFFSETS } from './web-jobs.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(packageRoot, 'web');
const runRoot = path.join(packageRoot, 'web-runs');
const port = Number(process.env.AKASA_PORT || 8788);
const manager = new JobManager({ root: runRoot, packageRoot });
manager.on('error', error => console.error('Web job error:', error));

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

async function bodyJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json'))
    throw Object.assign(new Error('Expected JSON.'), { status: 415 });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16000) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try { return JSON.parse(body); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

async function file(res, filename, type, attachment = false) {
  const contents = await fs.readFile(filename);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': contents.length,
    'Content-Disposition': attachment ? `attachment; filename="${path.basename(filename)}"` : 'inline',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    ...(attachment ? { 'Content-Security-Policy': "default-src 'none'; sandbox" } : {}) });
  res.end(contents);
}

async function route(req, res) {
  const base = `http://127.0.0.1:${port}`;
  const url = new URL(req.url || '/', base);
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`)
    return send(res, 403, { error: 'Local access only.' });
  if (['POST', 'DELETE'].includes(req.method) && req.headers.origin &&
      req.headers.origin !== base && req.headers.origin !== `http://localhost:${port}`)
    return send(res, 403, { error: 'Cross-site requests are not accepted.' });
  if (req.method === 'GET' && url.pathname === '/api/config')
    return send(res, 200, { offsets: OFFSETS, maxAgents: 3,
      todayIndia: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata',
        year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) });
  if (req.method === 'GET' && url.pathname === '/api/runs/latest')
    return send(res, 200, { run: await manager.latest() });
  if (req.method === 'GET' && url.pathname === '/api/runs')
    return send(res, 200, { runs: await manager.recent() });
  if (req.method === 'POST' && url.pathname === '/api/runs') {
    const run = await manager.create(await bodyJson(req));
    return send(res, 201, { run });
  }
  const retry = /^\/api\/runs\/([\w-]+)\/retry\/([0-9]{3})$/.exec(url.pathname);
  if (retry && req.method === 'POST') {
    await bodyJson(req);
    const run = await manager.retry(retry[1], retry[2]);
    return send(res, 201, { run });
  }
  const retryFailed = /^\/api\/runs\/([\w-]+)\/retry-failed$/.exec(url.pathname);
  if (retryFailed && req.method === 'POST') {
    await bodyJson(req);
    const run = await manager.retryFailed(retryFailed[1]);
    return send(res, 201, { run });
  }
  const recover = /^\/api\/runs\/([\w-]+)\/recover-denied$/.exec(url.pathname);
  if (recover && req.method === 'POST') {
    const body = await bodyJson(req);
    const run = await manager.recoverDeniedRun(recover[1], body.accessRestored);
    return send(res, 201, { run });
  }
  const match = /^\/api\/runs\/([\w-]+)(?:\/(events|cancel|evidence)(?:\/([0-9]{3})\/([\w.-]+))?)?$/.exec(url.pathname);
  if (match) {
    const [, id, action, taskId, filename] = match;
    if (!action && req.method === 'DELETE')
      return send(res, 200, await manager.deleteRun(id));
    if (action === 'events' && req.method === 'GET') {
      const initial = await manager.get(id);
      if (!initial) return send(res, 404, { error: 'Run not found.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' });
      const write = snapshot => res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      write(initial);
      const listener = (changedId, snapshot) => { if (changedId === id) write(snapshot); };
      manager.on('change', listener);
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
      req.once('close', () => { clearInterval(heartbeat); manager.off('change', listener); });
      return;
    }
    if (action === 'cancel' && req.method === 'POST') {
      await bodyJson(req);
      const run = await manager.cancel(id);
      return send(res, run ? 200 : 409, run ? { run } : { error: 'No active run to cancel.' });
    }
    if (action === 'evidence' && req.method === 'GET' && taskId && filename) {
      if (path.basename(filename) !== filename || !/^(?:home-attempt-\d+|form-attempt-\d+|failure-attempt-\d+|results-attempt-\d+|row-\d{3}|flight-search-attempt-\d+|result)\.(?:png|html|json)$/.test(filename))
        return send(res, 400, { error: 'Invalid evidence file.' });
      const run = await manager.get(id);
      const task = run?.tasks.find(item => item.id === taskId);
      if (!task?.runRoot) return send(res, 404, { error: 'Saved evidence is unavailable.' });
      const expectedBase = path.resolve(runRoot, id);
      const actualRun = path.resolve(task.runRoot);
      if (!actualRun.startsWith(expectedBase + path.sep)) return send(res, 403, { error: 'Invalid run path.' });
      const dir = path.join(actualRun, `01-${task.origin}-${task.destination}-${task.travelDate}`);
      try { return await file(res, path.join(dir, filename), filename.endsWith('.png') ? 'image/png' :
        filename.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
        !filename.endsWith('.png')); }
      catch { return send(res, 404, { error: 'Evidence file not found.' }); }
    }
    if (!action && req.method === 'GET') {
      const run = await manager.get(id);
      return send(res, run ? 200 : 404, run ? { run } : { error: 'Run not found.' });
    }
  }
  if (req.method === 'GET') {
    const assets = { '/': ['index.html', 'text/html; charset=utf-8'],
      '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
    const asset = assets[url.pathname];
    if (asset) return file(res, path.join(webRoot, asset[0]), asset[1]);
  }
  send(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch(error => send(res, error.status || 500,
    { error: error.status ? error.message : 'Server error. Check the terminal log.' }));
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Akasa local page: http://127.0.0.1:${port}`);
  console.log(`Run evidence: ${runRoot}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await manager.close();
  server.close(() => process.exit(0));
});
