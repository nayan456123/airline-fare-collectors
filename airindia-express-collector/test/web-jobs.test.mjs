import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { JobManager, istDate, validatePlan } from '../src/web-jobs.mjs';

test('the route/date plan deduplicates inputs and caps work and agents', () => {
  const plan = validatePlan({ routes: ['DEL-BOM', 'del-bom', 'DEL-BLR'],
    offsets: [5, 1, 5], concurrency: 1, browserMode: 'headed' },
  new Date('2026-09-27T06:00:00Z'));
  assert.equal(plan.tasks.length, 4);
  assert.equal(validatePlan({ routes: ['DEL-BOM'], offsets: [1] }).browserMode, 'headless');
  assert.equal(plan.tasks[0].travelDate, '2026-09-28');
  assert.equal(plan.tasks[1].travelDate, '2026-10-02');
  assert.throws(() => validatePlan({ routes: ['DEL-DEL'], offsets: [1] }), /Invalid route/);
  assert.throws(() => validatePlan({ routes: ['DEL-BOM'], offsets: [1], concurrency: 2 }), /Agents/);
  assert.throws(() => validatePlan({ routes: Array.from({ length: 10 }, (_, i) =>
    `DEL-${String.fromCharCode(65 + i)}AA`), offsets: [1, 5, 9, 15, 30, 45] }), /54/);
});

test('one worker runs searches sequentially with a paced launch interval', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aix-web-jobs-'));
  const starts = [];
  const children = [];
  const spawnWorker = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', null, 'SIGTERM');
    starts.push({ at: Date.now(), args });
    children.push(child);
    return child;
  };
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 35, spawnWorker,
    memoryInfo: async () => ({ totalBytes: 16 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 }) });
  try {
    const job = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR'], offsets: [1],
      concurrency: 1 });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('First search did not launch')), 1000);
      const poll = setInterval(() => {
        if (children.length === 1) { clearTimeout(timeout); clearInterval(poll); resolve(); }
      }, 5);
    });
    assert.equal(starts.length, 1);
    assert.ok(starts[0].args.includes('--headless'));
    assert.ok(!starts[0].args.includes('--headed'));
    if (!process.env.AIX_PROXY_SERVER) assert.match(starts[0].args[starts[0].args.indexOf('--profile') + 1], /headless[/\\]chrome-compatible[/\\]agent-1$/);
    assert.equal((await manager.get(job.id)).tasks.filter(task => task.status === 'running').length, 1);
    children[0].emit('close', 2, null);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Second sequential search did not launch')), 1000);
      const poll = setInterval(() => {
        if (children.length === 2) { clearTimeout(timeout); clearInterval(poll); resolve(); }
      }, 5);
    });
    assert.ok(starts[1].at - starts[0].at >= 25);
    assert.equal((await manager.get(job.id)).tasks.filter(task => task.status === 'running').length, 1);
    const snapshot = await manager.get(job.id);
    assert.deepEqual(snapshot.tasks.map(task => task.worker), [1, 1]);
    children[1].emit('close', 2, null);
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a stopped server records interrupted work on disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aix-recovery-'));
  const id = 'saved-batch';
  try {
    await fs.mkdir(path.join(root, id));
    await fs.writeFile(path.join(root, id, 'jobs.json'), JSON.stringify({ id,
      status: 'running', startedAt: '2026-09-27T10:00:00Z', tasks: [
        { id: '001', status: 'running', stage: 'markets_ready', events: [], fares: [] } ] }));
    const manager = new JobManager({ root, packageRoot: root });
    const recovered = await manager.get(id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.tasks[0].cause.code, 'SERVER_INTERRUPTED');
    const stored = JSON.parse(await fs.readFile(path.join(root, id, 'jobs.json'), 'utf8'));
    assert.equal(stored.status, 'interrupted');
    assert.ok(stored.finishedAt);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const denial of ['CAPTCHA', 'RATE_LIMITED', 'VERIFICATION_SERVICE_UNAVAILABLE']) test(`${denial} stops queued searches before another airline request starts`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aix-denial-'));
  let child;
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 1000,
    memoryInfo: async () => ({ totalBytes: 16 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 }),
    spawnWorker: () => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      return child;
    } });
  try {
    const created = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR'],
      offsets: [1], concurrency: 1, browserMode: 'headless' });
    while (!child) await new Promise(resolve => setTimeout(resolve, 5));
    const job = manager.jobs.get(created.id);
    await manager.event(job, job.tasks[0], { event: 'failure',
      cause: { code: denial, detail: 'Airline requested stop' } });
    assert.equal(job.stopReason, denial);
    assert.equal(job.tasks[1].status, 'skipped');
    assert.equal(job.tasks[1].worker, null);
    child.emit('close', 2, null);
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('batch retry selects only eligible failed dates and deletion removes run evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aix-run-actions-'));
  const id = 'saved-run';
  const manager = new JobManager({ root, packageRoot: root });
  try {
    await fs.mkdir(path.join(root, id));
    const saved = { id, status: 'partial', browserMode: 'headless', concurrency: 1,
      tasks: [
        { id: '001', origin: 'DEL', destination: 'BOM', travelDate: istDate(5), offset: 5, status: 'failed', cause: { code: 'TIMEOUT' } },
        { id: '002', origin: 'DEL', destination: 'BLR', travelDate: istDate(15), offset: 15, status: 'skipped', cause: { code: 'BATCH_STOPPED' } },
        { id: '003', origin: 'BOM', destination: 'MAA', travelDate: istDate(5), offset: 5, status: 'blocked', cause: { code: 'CAPTCHA' } }
      ] };
    await fs.writeFile(path.join(root, id, 'jobs.json'), JSON.stringify(saved));
    await fs.writeFile(path.join(root, id, 'evidence.html'), 'saved page');
    manager.createPlan = async (plan, retryOf) => ({ plan, retryOf });
    const retry = await manager.retryFailed(id);
    assert.deepEqual(retry.retryOf, { runId: id, taskIds: ['001', '002'] });
    assert.deepEqual(retry.plan.tasks.map(task => task.travelDate), [istDate(5), istDate(15)]);
    assert.equal(retry.plan.browserMode, 'headless');
    assert.deepEqual(await manager.deleteRun(id), { id, deleted: true });
    await assert.rejects(fs.access(path.join(root, id)));
    assert.equal(await manager.get(id), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a hung worker terminates with its last stage and never publishes fares', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aix-timeout-'));
  let killed;
  const manager = new JobManager({ root, packageRoot: root, workerTimeoutMs: 30,
    spawnWorker: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = signal => { killed = signal; child.emit('close', null, signal); };
      return child;
    } });
  try {
    const run = await manager.create({ routes: ['DEL-BOM'], offsets: [5], concurrency: 1 });
    const finished = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker deadline did not finish the run')), 1000);
      manager.on('change', (_id, snapshot) => {
        if (snapshot.finishedAt) { clearTimeout(timeout); resolve(snapshot); }
      });
    });
    assert.equal(killed, 'SIGTERM');
    assert.equal(finished.id, run.id);
    assert.equal(finished.tasks[0].status, 'failed');
    assert.equal(finished.tasks[0].cause.code, 'WORKER_TIMEOUT');
    assert.equal(finished.tasks[0].fareCount, 0);
    assert.equal(finished.tasks[0].evidenceVerified, false);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});
