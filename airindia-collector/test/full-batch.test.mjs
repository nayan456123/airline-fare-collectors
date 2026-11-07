import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { JobManager, validatePlan } from '../src/web-jobs.mjs';

const waitUntil = async predicate => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the 54-search batch');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('a full 54-search batch schedules each route/date once and persists every outcome', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-full-batch-'));
  const routes = ['DEL-BOM', 'DEL-BLR', 'DEL-MAA', 'DEL-CCU', 'DEL-HYD',
    'DEL-AMD', 'DEL-COK', 'DEL-GOI', 'DEL-PNQ'];
  const offsets = [1, 5, 9, 15, 30, 45];
  const launches = [];
  const finished = [];
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 0,
    verifySavedSearch: async () => ({ ok: true, errors: [] }),
    spawnWorker: (_command, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const output = args[args.indexOf('--output') + 1];
      const [origin, destination, travelDate] = args[args.indexOf('--search') + 1].split(':');
      const identity = `${origin}:${destination}:${travelDate}`;
      const index = launches.push(identity);
      child.kill = () => child.emit('close', null, 'SIGTERM');

      void (async () => {
        const run = path.join(output, 'fake-run');
        const directory = path.join(run, `01-${origin}-${destination}-${travelDate}`);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({
          status: 'ok', collectedAt: '2026-10-28T00:00:00.000Z',
          fares: [{ flightNumber: `AI${index}`, total: 5000 + index }],
          expectedJourneys: 1,
          evidence: { resultScreenshot: 'result.png', resultPage: 'result.html', airlineResponse: 'response.json' }
        }));
        child.stdout.write(`RUN_DIR=${run}\n`);
        setImmediate(() => {
          finished.push(identity);
          child.emit('close', 0, null);
        });
      })().catch(error => child.emit('error', error));
      return child;
    } });

  try {
    const options = { routes, offsets, concurrency: 3, browserMode: 'headless' };
    const plan = validatePlan(options);
    assert.equal(plan.tasks.length, 54);
    const expected = plan.tasks.map(task => `${task.origin}:${task.destination}:${task.travelDate}`);
    assert.equal(new Set(expected).size, 54, 'the plan itself must contain 54 distinct route/date pairs');
    const job = await manager.createPlan(plan);

    await waitUntil(() => ['complete', 'partial', 'blocked', 'cancelled'].includes(manager.jobs.get(job.id)?.status));

    assert.equal(launches.length, 54, 'completion must wait until every planned search has launched');
    assert.equal(finished.length, 54, 'completion must wait until every fake worker has finished');
    assert.equal(new Set(launches).size, 54, 'no route/date pair may be launched twice');
    assert.deepEqual([...launches].sort(), [...expected].sort(), 'every planned route/date pair must launch');

    const final = await manager.get(job.id);
    assert.equal(final.status, 'complete');
    assert.equal(final.tasks.length, 54);
    assert.equal(new Set(final.tasks.map(task => task.id)).size, 54, 'task identities must be unique');
    assert.deepEqual(final.tasks.map(task => `${task.origin}:${task.destination}:${task.travelDate}`).sort(),
      [...expected].sort());
    assert.deepEqual(new Set(final.tasks.map(task => task.worker)), new Set([1, 2, 3]),
      'the requested three worker slots must take part in scheduling');
    assert.ok(final.tasks.every(task => task.status === 'ok' && task.evidenceVerified && task.fareCount === 1),
      'each completed task must contain a verified saved fare');

    await manager.jobs.get(job.id).writeChain;
    const persisted = JSON.parse(await fs.readFile(path.join(root, job.id, 'jobs.json'), 'utf8'));
    assert.equal(persisted.status, 'complete');
    assert.equal(persisted.tasks.length, 54);
    assert.deepEqual(persisted.tasks.map(task => [task.id, task.status, task.fareCount, task.evidenceVerified]),
      final.tasks.map(task => [task.id, task.status, task.fareCount, task.evidenceVerified]));
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
