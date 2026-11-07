import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../src/server.mjs';

const post = (url, data) => fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(data) });
async function terminal(url) {
  for (let i = 0; i < 200; i++) {
    const { run } = await (await fetch(url + '/api/run')).json();
    if (run && !['running','stopping'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Run did not finish');
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.close(); server.closeAllConnections(); await once(server, 'close'); }

test('dashboard saves verified results, exposes history, and restores latest after restart', async () => {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spice-server-'));
  let server;
  try {
    server = await createServer({ runRoot, intervalMs:0, collector: async query => ({ query, status:'empty', fares:[], evidenceVerified:true }) });
    let url = await listen(server);
    assert.equal((await fetch(url + '/')).status, 200);
    assert.equal((await fetch(url + '/app.js')).status, 200);
    assert.equal((await post(url + '/api/run', { searches:['DEL:BOM:2099-02-30'] })).status, 400);
    assert.equal((await post(url + '/api/run', { searches:['DEL:BOM:2099-11-10'] })).status, 201);
    const completed = await terminal(url);
    assert.equal(completed.status, 'complete');
    assert.equal(completed.tasks[0].status, 'empty');
    const saved = JSON.parse(await fs.readFile(path.join(runRoot, completed.id, 'job.json')));
    assert.equal(saved.tasks[0].query.travelDate, '2099-11-10');
    await close(server);
    server = await createServer({ runRoot }); url = await listen(server);
    assert.equal((await (await fetch(url + '/api/run')).json()).run.id, completed.id);
    assert.equal((await (await fetch(url + '/api/runs')).json()).runs.length, 1);
  } finally { if (server?.listening) await close(server); await fs.rm(runRoot, { recursive:true, force:true }); }
});

test('Stop interrupts the active search and never submits remaining tasks', async () => {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spice-stop-'));
  let server, calls = 0;
  try {
    server = await createServer({ runRoot, intervalMs:0, collector: async (query, mode, signal) => {
      calls++;
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once:true }));
      return { status:'interrupted', cause:{ code:'USER_STOP' } };
    } });
    const url = await listen(server);
    await post(url + '/api/run', { searches:['DEL:BOM:2099-11-10','DEL:BOM:2099-11-11'] });
    assert.equal((await post(url + '/api/run', { searches:['DEL:BOM:2099-11-12'] })).status, 409);
    await post(url + '/api/stop', {});
    const run = await terminal(url);
    assert.equal(calls, 1); assert.equal(run.status, 'cancelled');
    assert.deepEqual(run.tasks.map(t => t.status), ['interrupted','skipped']);
  } finally { if (server?.listening) await close(server); await fs.rm(runRoot, { recursive:true, force:true }); }
});
