import test from 'node:test';
import assert from 'node:assert/strict';
import { planSearches, runBatch } from '../src/batch.mjs';

test('plans unique exact route/date searches', () => {
  const plan = planSearches(['DEL:BOM:2099-11-10', 'DEL:BOM:2099-11-10', 'BOM:DEL:2099-11-11']);
  assert.equal(plan.length, 2);
  assert.equal(plan[1].travelDate, '2099-11-11');
  assert.throws(() => planSearches(['DEL:BOM:2099-02-30']));
});

test('stops a sequential batch on denial and never exposes fares for a blocked task', async () => {
  const plan = planSearches(['DEL:BOM:2099-11-10', 'DEL:BOM:2099-11-11', 'DEL:BOM:2099-11-12']);
  let calls = 0, waits = 0;
  const report = await runBatch(plan, async query => ++calls === 1
    ? { status: 'ok', query, evidenceVerified: true, fares: [{ flight: 'SG 1' }] }
    : { status: 'blocked', cause: { code: 'ACCESS_DENIED' }, fares: [{ flight: 'bad' }] },
  { wait: async () => { waits++; } });
  assert.equal(calls, 2);
  assert.equal(waits, 1);
  assert.equal(report.stopReason, 'ACCESS_DENIED');
  assert.deepEqual(report.tasks.map(t => t.status), ['ok', 'blocked', 'skipped']);
  assert.deepEqual(report.tasks[1].fares, []);
  assert.equal(report.tasks[2].query.travelDate, '2099-11-12');
});

test('does not accept unverified fares or results for a different route', async () => {
  const [query] = planSearches(['DEL:BOM:2099-11-10']);
  for (const result of [
    { status: 'ok', query, fares: [{ flight: 'SG 1' }] },
    { status: 'ok', query: { ...query, destination: 'BLR' }, evidenceVerified: true, fares: [{ flight: 'SG 1' }] }
  ]) {
    const report = await runBatch([query], async () => result);
    assert.equal(report.status, 'partial');
    assert.equal(report.tasks[0].status, 'failed');
    assert.deepEqual(report.tasks[0].fares, []);
  }
});

test('keeps a verified no-flight result distinct from unverified empty fares', async () => {
  const [query] = planSearches(['DEL:BOM:2099-11-10']);
  const report = await runBatch([query], async () => ({ query, status: 'empty', evidenceVerified: true, fares: [] }));
  assert.equal(report.status, 'complete');
  assert.equal(report.tasks[0].status, 'empty');
  const unverified = await runBatch([query], async () => ({ query, status: 'empty', fares: [] }));
  assert.equal(unverified.tasks[0].status, 'failed');
});

test('retries a temporary server failure once after a rest and preserves both attempts', async () => {
  const [query] = planSearches(['DEL:BOM:2099-11-10']);
  let calls = 0; const waits = [];
  const report = await runBatch([query], async () => ++calls === 1
    ? { status: 'failed', cause: { code: 'SITE_UNAVAILABLE', detail: 'HTTP 502' }, runId: 'failed-attempt' }
    : { status: 'ok', query, evidenceVerified: true, fares: [{ flight: 'SG 1' }], runId: 'successful-attempt' },
  { wait: async ms => waits.push(ms) });
  assert.equal(report.status, 'complete');
  assert.equal(calls, 2); assert.deepEqual(waits, [20000]);
  assert.deepEqual(report.tasks[0].attempts.map(a => a.runId), ['failed-attempt', 'successful-attempt']);
});

test('never retries a denial or a fare-verification failure and bounds server retries', async () => {
  const [query] = planSearches(['DEL:BOM:2099-11-10']);
  for (const [code, status, expected] of [['ACCESS_DENIED','blocked',1],['SEARCH_UNVERIFIED','failed',1],['SITE_UNAVAILABLE','failed',2]]) {
    let calls = 0;
    const report = await runBatch([query], async () => { calls++; return { status, cause: { code } }; }, { wait: async () => {} });
    assert.equal(calls, expected);
    assert.notEqual(report.status, 'complete');
  }
});
