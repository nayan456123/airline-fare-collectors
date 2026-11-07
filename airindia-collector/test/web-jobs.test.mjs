import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { JobManager, istDate, validatePlan } from '../src/web-jobs.mjs';

const GIB = 1024 ** 3;
const roomyMemory = async () => ({ totalBytes: 16 * GIB, availableBytes: 12 * GIB });
const waitUntil = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for job state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

function siteErrorWorkerHarness(root, outcomes) {
  const children = [];
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 0,
    verifySavedSearch: async () => ({ ok: true, errors: [] }),
    spawnWorker: (_command, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.output = args[args.indexOf('--output') + 1];
      child.complete = async (outcome, query) => {
        const run = path.join(child.output, 'saved-run');
        const directory = path.join(run, `01-${query.origin}-${query.destination}-${query.travelDate}`);
        await fs.mkdir(directory, { recursive: true });
        const result = outcome === 'SITE_ERROR' ? {
          status: 'failed', cause: { code: 'SITE_ERROR', detail: 'Air India reported an unexpected issue' },
          fares: [], evidence: {}, attempt: 1
        } : {
          status: 'ok', cause: null, fares: [{ flight: 'AI 101', price: { displayedTotal: 1000 } }],
          collectedAt: new Date().toISOString(), expectedJourneys: 1,
          evidence: { resultScreenshot: 'result.png', resultPage: 'result.html', airlineResponse: 'response.json' },
          attempt: 1
        };
        await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result));
        child.stdout.write(`RUN_DIR=${run}\n`);
        child.emit('close', 0, null);
      };
      child.kill = () => child.emit('close', null, 'SIGTERM');
      children.push(child);
      return child;
    } });
  return { manager, children };
}

test('the route/date plan deduplicates inputs and caps work and agents', () => {
  const plan = validatePlan({ routes: ['DEL-BOM', 'del-bom', 'DEL-BLR'],
    offsets: [5, 1, 5], concurrency: 2, browserMode: 'headed' },
  new Date('2026-09-27T06:00:00Z'));
  assert.equal(plan.tasks.length, 4);
  assert.equal(plan.tasks[0].travelDate, '2026-09-28');
  assert.equal(plan.tasks[1].travelDate, '2026-10-02');
  assert.equal(plan.audioCaptchaSolver, false);
  assert.throws(() => validatePlan({ routes: ['DEL-BOM'], offsets: [5],
    browserMode: 'headless', audioCaptchaSolver: true }), /visible Chrome/);
  assert.throws(() => validatePlan({ routes: ['DEL-DEL'], offsets: [1] }), /Invalid route/);
  assert.throws(() => validatePlan({ routes: ['DEL-BOM'], offsets: [1], concurrency: 4 }), /Agents/);
  assert.throws(() => validatePlan({ routes: Array.from({ length: 10 }, (_, i) =>
    `DEL-${String.fromCharCode(65 + i)}AA`), offsets: [1, 5, 9, 15, 30, 45] }), /54/);
});

test('two consecutive SITE_ERROR results stop queued searches and preserve zero-fare failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-site-error-breaker-'));
  const { manager, children } = siteErrorWorkerHarness(root);
  try {
    const job = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR', 'DEL-MAA'],
      offsets: [5], concurrency: 1, browserMode: 'headless' });
    for (const index of [0, 1]) {
      await waitUntil(() => children.length === index + 1);
      const task = manager.jobs.get(job.id).tasks[index];
      await children[index].complete('SITE_ERROR', task);
      await waitUntil(() => task.finishedAt);
    }
    await waitUntil(() => manager.jobs.get(job.id).stopReason === 'REPEATED_SITE_ERROR');
    const final = await manager.get(job.id);
    assert.equal(children.length, 2, 'the third search must never launch');
    assert.equal(final.stopReason, 'REPEATED_SITE_ERROR');
    assert.equal(final.status, 'partial');
    assert.deepEqual(final.tasks.slice(0, 2).map(task => [task.status, task.cause.code, task.fareCount]),
      [['failed', 'SITE_ERROR', 0], ['failed', 'SITE_ERROR', 0]]);
    assert.equal(final.tasks[2].status, 'skipped');
    assert.equal(final.tasks[2].cause.code, 'BATCH_STOPPED');
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a successful search resets the consecutive SITE_ERROR circuit breaker', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-site-error-reset-'));
  const { manager, children } = siteErrorWorkerHarness(root);
  try {
    const job = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR', 'DEL-MAA', 'DEL-CCU', 'DEL-HYD'],
      offsets: [5], concurrency: 1, browserMode: 'headless' });
    const outcomes = ['SITE_ERROR', 'ok', 'SITE_ERROR', 'SITE_ERROR'];
    for (let index = 0; index < outcomes.length; index++) {
      await waitUntil(() => children.length === index + 1);
      const task = manager.jobs.get(job.id).tasks[index];
      await children[index].complete(outcomes[index], task);
      await waitUntil(() => task.finishedAt);
    }
    await waitUntil(() => manager.jobs.get(job.id).stopReason === 'REPEATED_SITE_ERROR');
    const final = await manager.get(job.id);
    assert.equal(children.length, 4);
    assert.equal(final.stopReason, 'REPEATED_SITE_ERROR');
    assert.equal(final.tasks[1].status, 'ok');
    assert.equal(final.tasks[1].fareCount, 1);
    assert.equal(final.tasks[2].cause.code, 'SITE_ERROR');
    assert.equal(final.tasks[3].cause.code, 'SITE_ERROR');
    assert.equal(final.tasks[3].fareCount, 0);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('the SITE_ERROR breaker interrupts active peers and prevents later launches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-site-error-parallel-'));
  const { manager, children } = siteErrorWorkerHarness(root);
  try {
    const job = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR', 'DEL-MAA', 'DEL-CCU', 'DEL-HYD'],
      offsets: [5], concurrency: 3, browserMode: 'headless' });
    await waitUntil(() => children.length === 3);
    const tasks = manager.jobs.get(job.id).tasks;
    await children[0].complete('SITE_ERROR', tasks[0]);
    await waitUntil(() => tasks[0].finishedAt);
    await waitUntil(() => children.length === 4);
    await children[1].complete('SITE_ERROR', tasks[1]);
    await waitUntil(() => manager.jobs.get(job.id).status === 'partial');
    const final = await manager.get(job.id);
    assert.equal(children.length, 4, 'the fourth worker can start before the second failure resolves, but no later worker can');
    assert.equal(final.stopReason, 'REPEATED_SITE_ERROR');
    assert.equal(final.tasks[2].status, 'interrupted', 'active peers are stopped after the breaker trips');
    assert.equal(final.tasks[3].status, 'interrupted');
    assert.equal(final.tasks[4].status, 'skipped');
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('the explicitly selected audio helper reaches the worker with its existing interpreter', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-audio-option-'));
  const python = path.join(root, '.session', 'audio-venv',
    ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, 'mock interpreter for the intercepted spawn');
  let started, child;
  const manager = new JobManager({ root: path.join(root, 'runs'), packageRoot: root,
    spawnWorker: (command, args, options) => {
      started = { args, env: options.env };
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM'); return child;
    } });
  try {
    const run = await manager.create({ routes: ['DEL-BOM'], offsets: [5], browserMode: 'headed', audioCaptchaSolver: true });
    while (!started) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(run.audioCaptchaSolver, true);
    assert.ok(started.args.includes('--audio-captcha-solver'));
    assert.ok(started.args.includes('--external-chrome'));
    assert.equal(started.env.AIRINDIA_SOLVER_PYTHON, process.env.AIRINDIA_SOLVER_PYTHON || python);
    await manager.cancel(run.id);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('parallel workers have separate profiles and spaced launches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-web-jobs-'));
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
    memoryInfo: async () => ({ totalBytes: 16 * GIB, availableBytes: 12 * GIB }) });
  try {
    const job = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR'], offsets: [1],
      concurrency: 2, browserMode: 'headless' });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Two workers did not launch')), 1000);
      const poll = setInterval(() => {
        if (children.length === 2) { clearTimeout(timeout); clearInterval(poll); resolve(); }
      }, 5);
    });
    assert.ok(starts[1].at - starts[0].at >= 25);
    assert.notEqual(starts[0].args.at(starts[0].args.indexOf('--profile') + 1),
      starts[1].args.at(starts[1].args.indexOf('--profile') + 1));
    assert.ok(starts.every(start => start.args.at(start.args.indexOf('--profile') + 1).includes('dashboard-headless')));
    assert.ok(starts.every(start => start.args.includes('--disable-http2')));
    assert.ok(starts.every(start => start.args.includes('--defer-verification')));
    const snapshot = await manager.get(job.id);
    assert.deepEqual(snapshot.tasks.map(task => task.worker), [1, 2]);
    assert.equal(snapshot.browserMode, 'headless');
    assert.equal(snapshot.browserTransport, 'external-chrome-cdp');
    assert.equal(snapshot.disableHttp2, true);
    children.forEach(child => child.emit('close', 2, null));
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dashboard transport flags and headless profiles are scoped to each job without copying cookies', async () => {
  const previousProxy = process.env.AIRINDIA_PROXY_SERVER;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-dashboard-profile-'));
  const historicalProfile = path.join(root, '.session', 'web-agents', 'headless-compatible', 'agent-1');
  await fs.mkdir(historicalProfile, { recursive: true });
  const historicalCookieState = path.join(historicalProfile, 'cookie-state-fixture');
  await fs.writeFile(historicalCookieState, 'historical profile marker');
  const scenarios = [
    { mode: 'headless', proxy: null, transport: 'external-chrome-cdp', flag: true, owned: true },
    { mode: 'headless', proxy: 'http://127.0.0.1:8080', transport: 'playwright-launch', flag: false, owned: false },
    { mode: 'headed', proxy: null, transport: 'external-chrome-cdp', flag: false, owned: false },
    { mode: 'headed', proxy: 'http://127.0.0.1:8080', transport: 'playwright-launch', flag: false, owned: false }
  ];
  const profiles = [];
  try {
    for (const scenario of scenarios) {
      if (scenario.proxy) process.env.AIRINDIA_PROXY_SERVER = scenario.proxy;
      else delete process.env.AIRINDIA_PROXY_SERVER;
      let started;
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 0,
        memoryInfo: roomyMemory, spawnWorker: (_command, args) => { started = args; return child; } });
      try {
        const job = await manager.create({ routes: ['DEL-BOM'], offsets: [1], concurrency: 1,
          browserMode: scenario.mode });
        for (let wait = 0; !started && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(started, `worker launched for ${scenario.mode} ${scenario.proxy || 'direct'}`);
        const profile = started[started.indexOf('--profile') + 1];
        profiles.push(profile);
        assert.equal(started.includes('--disable-http2'), scenario.flag);
        assert.equal(job.browserTransport, scenario.transport);
        assert.equal(job.disableHttp2, scenario.flag);
        if (scenario.owned) {
          assert.equal(profile, path.join(root, '.session', 'dashboard-headless', job.id, '001'));
          assert.notEqual(profile, historicalProfile);
          assert.equal(started.some(arg => /cookie/i.test(arg)), false);
        } else if (scenario.proxy) {
          assert.ok(profile.includes(path.join('.session', 'web-agents')));
        } else {
          assert.equal(profile, path.join(root, '.session', 'headed'));
        }
        await manager.cancel(job.id);
      } finally {
        await manager.close();
      }
    }
    assert.equal(new Set(profiles).size, profiles.length);
    assert.equal(await fs.readFile(historicalCookieState, 'utf8'), 'historical profile marker');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    if (previousProxy === undefined) delete process.env.AIRINDIA_PROXY_SERVER;
    else process.env.AIRINDIA_PROXY_SERVER = previousProxy;
  }
});

test('requested worker concurrency is preserved without a RAM gate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-memory-'));
  const children = [];
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 35,
    memoryInfo: async () => ({ totalBytes: 5.2 * GIB, availableBytes: 3 * GIB }),
    spawnWorker: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      children.push(child);
      return child;
    } });
  try {
    const run = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR'],
      offsets: [9], concurrency: 2 });
    assert.equal(run.requestedConcurrency, 2);
    assert.equal(run.concurrency, 2);
    assert.equal(run.resourceNote, null);
    assert.equal(run.tasks.length, 2);
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(children.length, 2);
    await manager.cancel(run.id);
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('admission does not inspect RAM or reject a batch for low memory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-memory-refusal-'));
  const plan = validatePlan({ routes: ['DEL-BOM'], offsets: [9], concurrency: 2 });
  const waiting = new JobManager({ root, packageRoot: root,
    memoryInfo: async () => ({ totalBytes: 5.2 * GIB, availableBytes: 1.6 * GIB }) });
  const critical = new JobManager({ root, packageRoot: root,
    memoryInfo: async () => ({ totalBytes: 5.2 * GIB, availableBytes: 0.5 * GIB }) });
  try {
    const queued = await waiting.admitPlan(plan);
    assert.equal(queued.concurrency, 2);
    assert.equal(queued.resourceNote, null);
    assert.equal((await critical.admitPlan(plan)).concurrency, 2);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('desk verification waits for all browser workers and runs one check at a time', async () => {
  const seen = [];
  let activeChecks = 0;
  let peakChecks = 0;
  const manager = new JobManager({ root: os.tmpdir(), packageRoot: os.tmpdir(),
    verifySavedSearch: async directory => {
      seen.push(directory);
      activeChecks++;
      peakChecks = Math.max(peakChecks, activeChecks);
      await new Promise(resolve => setTimeout(resolve, 20));
      activeChecks--;
      return { ok: true, errors: [] };
    } });
  manager.children.set('worker', {});
  const first = manager.verifyWhenIdle('first');
  const second = manager.verifyWhenIdle('second');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(seen, []);
  manager.children.delete('worker');
  const checks = await Promise.all([first, second]);
  assert.ok(checks.every(check => check.ok));
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(peakChecks, 1);
  assert.equal(manager.verifying, 0);
});

test('a stopped server records interrupted work on disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-recovery-'));
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

test('restart recovery preserves a known denial on its originating task only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-denial-recovery-'));
  const id = 'denied-stopping-batch';
  try {
    await fs.mkdir(path.join(root, id));
    const denialEvent = { at: '2026-09-27T10:00:01Z', event: 'failure', stage: 'search_submitted',
      code: 'ACCESS_DENIED', message: 'Air India search request returned HTTP 403' };
    await fs.writeFile(path.join(root, id, 'jobs.json'), JSON.stringify({ id,
      status: 'stopping', stopReason: 'ACCESS_DENIED', startedAt: '2026-09-27T10:00:00Z', tasks: [
        { id: '001', status: 'running', stage: 'search_submitted', cause: {
          code: 'ACCESS_DENIED', detail: 'Air India search request returned HTTP 403' },
          events: [denialEvent], fares: [{ flight: 'must be discarded' }],
          fareCount: 1, evidenceVerified: true, evidenceErrors: ['stale fare result'],
          coverage: { captured: 1, expectedJourneys: 1 }, observedFareCount: 1,
          expectedJourneys: 1 },
        { id: '002', status: 'running', stage: 'homepage_loaded', cause: null,
          events: [], fares: [] },
        { id: '003', status: 'skipped', cause: { code: 'BATCH_STOPPED', detail: 'ACCESS_DENIED' },
          events: [], fares: [] }
      ] }));
    const manager = new JobManager({ root, packageRoot: root });
    const recovered = await manager.get(id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.stopReason, 'ACCESS_DENIED');
    assert.equal(recovered.tasks[0].status, 'blocked');
    assert.deepEqual(recovered.tasks[0].cause, {
      code: 'ACCESS_DENIED', detail: 'Air India search request returned HTTP 403' });
    assert.deepEqual(recovered.tasks[0].events, [denialEvent], 'known event history stays intact');
    assert.deepEqual(recovered.tasks[0].fares, [], 'denial recovery cannot retain fare rows');
    assert.equal(recovered.tasks[0].fareCount, 0);
    assert.equal(recovered.tasks[0].evidenceVerified, false);
    assert.deepEqual(recovered.tasks[0].evidenceErrors, []);
    assert.equal(recovered.tasks[0].coverage, null);
    assert.equal(recovered.tasks[0].observedFareCount, 0);
    assert.equal(recovered.tasks[0].expectedJourneys, null);
    assert.equal(recovered.tasks[1].status, 'interrupted');
    assert.equal(recovered.tasks[1].cause.code, 'SERVER_INTERRUPTED',
      'recovery does not attribute the denial to another active task');
    assert.equal(recovered.tasks[2].status, 'skipped');
    assert.equal(recovered.tasks[2].cause.code, 'BATCH_STOPPED');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('restart recovery derives a run denial from the known task cause before retries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-denial-crash-window-'));
  const id = 'denial-before-stop-persisted';
  const travelDate = istDate(5);
  try {
    await fs.mkdir(path.join(root, id));
    await fs.writeFile(path.join(root, id, 'jobs.json'), JSON.stringify({ id,
      status: 'running', stopReason: null, browserMode: 'headless', tasks: [
        { id: '001', origin: 'DEL', destination: 'BOM', travelDate, offset: 5,
          status: 'running', cause: { code: 'ACCESS_DENIED', detail: 'HTTP 403' }, events: [], fares: [] },
        { id: '002', origin: 'DEL', destination: 'BLR', travelDate, offset: 5,
          status: 'running', cause: { code: 'SITE_NETWORK_FAILURE' }, events: [], fares: [] }
      ] }));
    const restartedManager = new JobManager({ root, packageRoot: root });
    const recovered = await restartedManager.get(id);
    assert.equal(recovered.stopReason, 'ACCESS_DENIED');
    assert.equal(recovered.tasks[0].status, 'blocked');
    assert.equal(recovered.tasks[1].status, 'interrupted');
    assert.equal(recovered.tasks[1].cause.code, 'SERVER_INTERRUPTED');
    await assert.rejects(restartedManager.retry(id, '002'), /Air India denied access/);
    await assert.rejects(restartedManager.retryFailed(id), /Air India denied access/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('retry APIs reject a persisted denied run after manager restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-denial-retry-restart-'));
  const runId = 'persisted-denial';
  const travelDate = istDate(5);
  try {
    await fs.mkdir(path.join(root, runId));
    await fs.writeFile(path.join(root, runId, 'jobs.json'), JSON.stringify({ id: runId,
      status: 'blocked', stopReason: 'ACCESS_DENIED', browserMode: 'headless',
      tasks: [{ id: '001', origin: 'DEL', destination: 'BOM', travelDate, offset: 5,
        status: 'blocked', cause: { code: 'ACCESS_DENIED', detail: 'HTTP 403' }, events: [], fares: [] }] }));
    const restartedManager = new JobManager({ root, packageRoot: root });
    assert.equal((await restartedManager.get(runId)).stopReason, 'ACCESS_DENIED');
    await assert.rejects(restartedManager.retry(runId, '001'), /Air India denied access/);
    await assert.rejects(restartedManager.retryFailed(runId), /Air India denied access/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('retry APIs reject a mixed run with any saved denial cause', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-mixed-denial-retry-'));
  const runId = 'cancelled-with-denial';
  const travelDate = istDate(5);
  try {
    await fs.mkdir(path.join(root, runId));
    await fs.writeFile(path.join(root, runId, 'jobs.json'), JSON.stringify({ id: runId,
      status: 'cancelled', stopReason: 'USER_CANCELLED', browserMode: 'headless', tasks: [
        { id: '001', origin: 'DEL', destination: 'BOM', travelDate, offset: 5,
          status: 'blocked', cause: { code: 'ACCESS_DENIED', detail: 'HTTP 403' }, events: [], fares: [] },
        { id: '002', origin: 'DEL', destination: 'BLR', travelDate, offset: 5,
          status: 'skipped', cause: { code: 'BATCH_STOPPED', detail: 'USER_CANCELLED' }, events: [], fares: [] }
      ] }));
    const manager = new JobManager({ root, packageRoot: root });
    await assert.rejects(manager.retry(runId, '002'), /Air India denied access/);
    await assert.rejects(manager.retryFailed(runId), /Air India denied access/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('retryFailed accepts cancelled SITE_ERROR work when no denial was saved', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-cancelled-site-error-retry-'));
  const runId = 'cancelled-site-error';
  const travelDate = istDate(5);
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 10000,
    spawnWorker: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      return child;
    } });
  try {
    await fs.mkdir(path.join(root, runId));
    await fs.writeFile(path.join(root, runId, 'jobs.json'), JSON.stringify({ id: runId,
      status: 'cancelled', stopReason: 'USER_CANCELLED', browserMode: 'headless', tasks: [
        { id: '001', origin: 'DEL', destination: 'BOM', travelDate, offset: 5,
          status: 'failed', cause: { code: 'SITE_ERROR', detail: 'Temporary airline error' }, events: [], fares: [] }
      ] }));
    const retry = await manager.retryFailed(runId);
    assert.equal(retry.retryOf.runId, runId);
    assert.deepEqual(retry.retryOf.taskIds, ['001']);
    await manager.cancel(retry.id);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('CAPTCHA stops queued searches before another airline request starts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-denial-'));
  let child;
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 1000,
    memoryInfo: roomyMemory,
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
      cause: { code: 'CAPTCHA', detail: 'Challenge shown' } });
    assert.equal(job.stopReason, 'CAPTCHA');
    assert.equal(job.tasks[1].status, 'skipped');
    assert.equal(job.tasks[1].worker, null);
    child.emit('close', 2, null);
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a failed worker exposes its saved failure evidence without a fare', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-failure-evidence-'));
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 1000,
    memoryInfo: roomyMemory,
    spawnWorker: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      return child;
    } });
  try {
    const created = await manager.create({ routes: ['DEL-BOM'], offsets: [5],
      concurrency: 1, browserMode: 'headed' });
    const job = manager.jobs.get(created.id);
    while (job.tasks[0].status !== 'running') await new Promise(resolve => setTimeout(resolve, 5));
    const task = job.tasks[0];
    const run = path.join(job.root, 'agent-1', 'saved-attempt');
    const directory = path.join(run, `01-${task.origin}-${task.destination}-${task.travelDate}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({
      status: 'blocked', query: { origin: task.origin, destination: task.destination,
        travelDate: task.travelDate }, fares: [], attempt: 1,
      cause: { code: 'ACCESS_DENIED', detail: 'Booking handoff returned HTTP 403' },
      evidence: { failurePage: 'failure-attempt-1.html',
        failureScreenshot: 'failure-attempt-1.png',
        bookingResponse: 'booking-response-attempt-1.html' }
    }));
    task.runRoot = run;
    await manager.finish(job, task, 2, null, null);
    const snapshot = await manager.get(created.id);
    assert.equal(snapshot.status, 'blocked');
    assert.deepEqual(snapshot.tasks[0].fares, []);
    assert.equal(snapshot.tasks[0].failureEvidence.screenshot, 'failure-attempt-1.png');
    assert.equal(snapshot.tasks[0].cause.code, 'ACCESS_DENIED');
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Stop interrupts the active worker and skips unsent searches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-stop-'));
  let launches = 0;
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 1000,
    memoryInfo: roomyMemory,
    spawnWorker: () => {
      launches++;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      return child;
    } });
  try {
    const created = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR'],
      offsets: [5], concurrency: 1, browserMode: 'headed' });
    while (!launches) await new Promise(resolve => setTimeout(resolve, 5));
    const stopped = await manager.cancel(created.id);
    assert.equal(stopped.stopReason, 'USER_CANCELLED');
    assert.equal(stopped.tasks[1].status, 'skipped');
    assert.equal(stopped.tasks[1].worker, null);
    assert.equal(launches, 1);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('single-search retry keeps the original future travel date', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-retry-'));
  const sourceId = 'saved-failure';
  const travelDate = istDate(5);
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 1000,
    memoryInfo: roomyMemory,
    spawnWorker: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      return child;
    } });
  try {
    await fs.mkdir(path.join(root, sourceId));
    await fs.writeFile(path.join(root, sourceId, 'jobs.json'), JSON.stringify({
      id: sourceId, status: 'partial', stopReason: null, browserMode: 'headed',
      tasks: [{ id: '001', origin: 'DEL', destination: 'BOM', travelDate,
        offset: 5, status: 'failed', cause: { code: 'SITE_NETWORK_FAILURE' },
        events: [], fares: [] }] }));
    const retry = await manager.retry(sourceId, '001');
    assert.equal(retry.tasks.length, 1);
    assert.equal(retry.tasks[0].travelDate, travelDate);
    assert.equal(retry.retryOf.runId, sourceId);
    await manager.cancel(retry.id);
    const second = await manager.retry(sourceId, '001');
    assert.equal(second.tasks[0].travelDate, travelDate);
    await manager.cancel(second.id);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('dashboard workers inherit the validated entry URL captured when a run starts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-dashboard-entry-'));
  const previous = process.env.AIRINDIA_ENTRY_URL;
  const campaign = 'https://www.airindia.com/?ai_pc=MYFLIGHTAIR';
  let started, child;
  process.env.AIRINDIA_ENTRY_URL = campaign;
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 1000,
    spawnWorker: (_command, args) => {
      started = args;
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM'); return child;
    } });
  try {
    const run = await manager.create({ routes: ['DEL-BOM'], offsets: [5], browserMode: 'headless' });
    while (!started) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(run.entryUrl, campaign);
    assert.equal(started[started.indexOf('--entry-url') + 1], campaign);
    const saved = JSON.parse(await fs.readFile(path.join(root, run.id, 'jobs.json'), 'utf8'));
    assert.equal(saved.entryUrl, campaign);
    await manager.cancel(run.id);
  } finally {
    await manager.close(); await fs.rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AIRINDIA_ENTRY_URL;
    else process.env.AIRINDIA_ENTRY_URL = previous;
  }
});

test('an invalid shared entry URL is rejected before any dashboard worker starts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-invalid-entry-'));
  const previous = process.env.AIRINDIA_ENTRY_URL;
  let launches = 0;
  process.env.AIRINDIA_ENTRY_URL = 'https://elsewhere.example/';
  const manager = new JobManager({ root, packageRoot: root,
    spawnWorker: () => { launches++; throw new Error('worker must not launch'); } });
  try {
    await assert.rejects(manager.create({ routes: ['DEL-BOM'], offsets: [5] }), /AIRINDIA_ENTRY_URL/);
    assert.equal(launches, 0);
    assert.equal((await fs.readdir(root)).length, 0);
  } finally {
    await manager.close(); await fs.rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AIRINDIA_ENTRY_URL;
    else process.env.AIRINDIA_ENTRY_URL = previous;
  }
});

test('dashboard retries preserve the saved run entry URL after the environment changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-retry-entry-'));
  const sourceId = 'saved-entry-failure';
  const travelDate = istDate(5);
  const originalEntry = 'https://www.airindia.com/?ai_pc=MYFLIGHTAIR';
  const previous = process.env.AIRINDIA_ENTRY_URL;
  let started, child;
  process.env.AIRINDIA_ENTRY_URL = 'https://www.airindia.com/';
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 1000,
    spawnWorker: (_command, args) => {
      started = args;
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM'); return child;
    } });
  try {
    await fs.mkdir(path.join(root, sourceId));
    await fs.writeFile(path.join(root, sourceId, 'jobs.json'), JSON.stringify({
      id: sourceId, status: 'partial', stopReason: null, browserMode: 'headless',
      entryUrl: originalEntry,
      tasks: [{ id: '001', origin: 'DEL', destination: 'BOM', travelDate,
        offset: 5, status: 'failed', cause: { code: 'SITE_NETWORK_FAILURE' },
        events: [], fares: [] }] }));
    const retry = await manager.retry(sourceId, '001');
    while (!started) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(retry.entryUrl, originalEntry);
    assert.equal(started[started.indexOf('--entry-url') + 1], originalEntry);
    await manager.cancel(retry.id);
  } finally {
    await manager.close(); await fs.rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AIRINDIA_ENTRY_URL;
    else process.env.AIRINDIA_ENTRY_URL = previous;
  }
});
