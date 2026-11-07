import assert from 'node:assert/strict';
import test from 'node:test';
import { retryableTasks } from '../web/retry-eligibility.js';

const base = { id: 'saved-54', status: 'complete', stopReason: null, tasks: [] };
const task = (id, status, extra = {}) => ({ id, status, travelDate: '2026-11-03', cause: null, ...extra });

test('batch retry eligibility counts only unfinished future searches and preserves successful results', () => {
  const run = { ...base, tasks: [
    ...Array.from({ length: 22 }, (_, i) => task(`ok-${i}`, 'ok')),
    ...Array.from({ length: 32 }, (_, i) => task(`unfinished-${i}`, ['failed', 'partial', 'skipped', 'interrupted'][i % 4]))
  ] };

  const eligible = retryableTasks(run, '2026-10-28');
  assert.equal(eligible.length, 32);
  assert.equal(eligible.some(item => item.status === 'ok'), false);
  assert.equal(run.tasks.filter(item => item.status === 'ok').length, 22);
});

test('batch retry excludes completed and past-date searches', () => {
  const run = { ...base, tasks: [
    task('ok', 'ok'),
    task('old', 'failed', { travelDate: '2026-10-28' }),
    task('good', 'failed')
  ] };
  assert.deepEqual(retryableTasks(run, '2026-10-28').map(item => item.id), ['good']);
});

test('a denial anywhere in a mixed run disables retries for every search', () => {
  const run = { ...base, tasks: [
    task('eligible', 'failed'),
    task('denied', 'skipped', { cause: { code: 'CAPTCHA' } })
  ] };
  assert.deepEqual(retryableTasks(run, '2026-10-28'), []);
});

test('batch retry is unavailable for active or access-denied runs', () => {
  const one = task('one', 'failed');
  assert.deepEqual(retryableTasks({ ...base, status: 'running', tasks: [one] }, '2026-10-28'), []);
  assert.deepEqual(retryableTasks({ ...base, stopReason: 'ACCESS_DENIED', tasks: [one] }, '2026-10-28'), []);
  assert.deepEqual(retryableTasks({ ...base, tasks: [task('past', 'failed', { travelDate: '2026-10-28' })] }, '2026-10-28'), []);
});
