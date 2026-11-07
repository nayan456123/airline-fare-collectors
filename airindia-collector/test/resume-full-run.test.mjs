import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobManager, istDate, OFFSETS } from '../src/web-jobs.mjs';

const sourceId = '2026-10-28T12-35-18-441Z-256587';
const routes = ['DEL-BOM', 'DEL-BLR', 'BOM-MAA', 'DEL-HYD', 'BLR-CCU',
  'BLR-PNQ', 'BOM-BLR', 'DEL-CCU', 'DEL-MAA'];

function makeSourceRun() {
  const tasks = routes.flatMap(route => {
    const [origin, destination] = route.split('-');
    return OFFSETS.map((offset, dateIndex) => ({ origin, destination, offset,
      travelDate: istDate(offset, new Date('2026-10-28T12:35:18.441Z')),
      status: 'queued', fares: [], cause: null }));
  });
  for (const task of tasks.slice(0, 22)) {
    task.status = 'ok';
    task.fares = [{ flight: 'AI 100', price: { displayedTotal: 1000 } }];
  }
  for (const task of tasks.slice(22, 29)) {
    task.status = 'failed';
    task.cause = { code: 'SITE_ERROR', detail: 'Air India reported an unexpected issue processing the flight request' };
  }
  tasks[29].status = 'interrupted';
  tasks[29].cause = { code: 'BATCH_STOPPED', detail: 'USER_CANCELLED' };
  for (const task of tasks.slice(30)) {
    task.status = 'skipped';
    task.cause = { code: 'BATCH_STOPPED', detail: 'USER_CANCELLED' };
  }
  tasks.forEach((task, index) => { task.id = String(index + 1).padStart(3, '0'); });
  return { id: sourceId, status: 'cancelled', stopReason: 'USER_CANCELLED',
    browserMode: 'headless', concurrency: 1, entryUrl: 'https://www.airindia.com/?ai_pc=MYFLIGHTAIR',
    tasks };
}

async function savedRun(root, run) {
  const directory = path.join(root, run.id);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'jobs.json');
  const contents = JSON.stringify(run, null, 2) + '\n';
  await fs.writeFile(file, contents);
  return { file, contents };
}

test('retryFailed selects only the 32 unfinished original searches and preserves the source run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-full-run-resume-'));
  const source = makeSourceRun();
  const { file, contents } = await savedRun(root, source);
  const manager = new JobManager({ root, packageRoot: root });
  let admittedPlan;
  let createdRetryOf;
  manager.admitPlan = async plan => { admittedPlan = plan; return plan; };
  manager.createPlan = async (plan, retryOf) => {
    createdRetryOf = retryOf;
    return { id: 'offline-retry', retryOf, tasks: plan.tasks };
  };

  try {
    const result = await manager.retryFailed(sourceId);
    const expected = source.tasks.slice(22);
    assert.deepEqual(admittedPlan.tasks.map(task => [task.origin, task.destination, task.travelDate, task.offset]),
      expected.map(task => [task.origin, task.destination, task.travelDate, task.offset]));
    assert.equal(admittedPlan.tasks.length, 32);
    assert.deepEqual(createdRetryOf, { runId: sourceId, taskIds: expected.map(task => task.id) });
    assert.deepEqual(result.retryOf, createdRetryOf);
    assert.equal(admittedPlan.browserMode, 'headless');
    assert.equal(admittedPlan.entryUrl, source.entryUrl);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), source);
    assert.equal(await fs.readFile(file, 'utf8'), contents);
    assert.equal(source.tasks.slice(0, 22).every(task => task.status === 'ok' && task.fares.length > 0), true);
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retryFailed rejects a source run whose saved stop reason is a denial', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-full-run-denial-'));
  const source = makeSourceRun();
  source.stopReason = 'ACCESS_DENIED';
  const { file } = await savedRun(root, source);
  const before = await fs.readFile(file, 'utf8');
  const manager = new JobManager({ root, packageRoot: root });
  let attemptedPlan = false;
  manager.admitPlan = async plan => { attemptedPlan = true; return plan; };
  manager.createPlan = async () => { attemptedPlan = true; throw new Error('unexpected retry creation'); };
  try {
    await assert.rejects(manager.retryFailed(sourceId), /Air India denied access/);
    assert.equal(attemptedPlan, false);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
