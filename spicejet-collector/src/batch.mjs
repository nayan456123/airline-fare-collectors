import { validateSearch } from './diagnostics.mjs';

const DENIAL = new Set(['ACCESS_DENIED', 'RATE_LIMITED', 'SESSION_INVALID', 'CAPTCHA']);
const RETRYABLE = new Set(['SITE_UNAVAILABLE', 'SITE_NETWORK_FAILURE']);
const delay = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener('abort', finish, { once: true });
});

// A task always carries its actual travel date, so a later recovery cannot
// accidentally reinterpret a relative offset from a different day.
export function planSearches(searches) {
  if (!Array.isArray(searches) || !searches.length || searches.length > 54)
    throw new Error('Provide between 1 and 54 searches.');
  const unique = new Map();
  for (const search of searches) {
    const query = validateSearch(search);
    unique.set(`${query.origin}:${query.destination}:${query.travelDate}`, query);
  }
  return [...unique.values()];
}

export async function runBatch(queries, collect, { intervalMs = 20000, wait = delay, onUpdate = async () => {}, signal, maxRetries = 1 } = {}) {
  if (!Array.isArray(queries) || !queries.length || queries.length > 54 || typeof collect !== 'function')
    throw new Error('A non-empty search plan and collector are required.');
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('Invalid interval.');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 1) throw new Error('At most one delayed retry is allowed.');
  const tasks = queries.map(query => ({ query: { ...query }, status: 'queued', fares: [] }));
  let stopReason = null;
  for (let i = 0; i < tasks.length; i++) {
    if (i) await wait(intervalMs, signal);
    if (signal?.aborted) {
      stopReason = 'USER_STOP';
      for (const task of tasks.slice(i)) { task.status = 'skipped'; task.cause = { code: 'USER_STOP' }; }
      await onUpdate(tasks); break;
    }
    tasks[i].status = 'running';
    await onUpdate(tasks);
    try {
      let result;
      tasks[i].attempts = [];
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        result = await collect(tasks[i].query);
        tasks[i].attempts.push({ attempt: attempt + 1, status: result?.status, cause: result?.cause || null, runId: result?.runId || result?.id || null });
        if (signal?.aborted || result?.status !== 'failed' || !RETRYABLE.has(result?.cause?.code) || DENIAL.has(result?.cause?.code) || attempt === maxRetries) break;
        tasks[i].stage = 'retry_wait';
        await onUpdate(tasks);
        await wait(Math.max(20000, intervalMs), signal);
        if (signal?.aborted) break;
      }
      if (!result || !['ok', 'empty', 'failed', 'blocked', 'interrupted'].includes(result.status))
        throw new Error('Collector returned an invalid result.');
      if (result.status === 'ok' && (result.evidenceVerified !== true ||
          !Array.isArray(result.fares) || !result.fares.length || !result.query ||
          ['origin', 'destination', 'travelDate'].some(key => result.query[key] !== tasks[i].query[key])))
        throw new Error('Successful result lacks verified fares for the requested route and date.');
      if (result.status === 'empty' && (result.evidenceVerified !== true || !Array.isArray(result.fares) || result.fares.length || !result.query ||
          ['origin', 'destination', 'travelDate'].some(key => result.query[key] !== tasks[i].query[key])))
        throw new Error('Empty result lacks verified evidence for the requested query.');
      tasks[i] = { ...tasks[i], ...result, query: tasks[i].query,
        fares: result.status === 'ok' ? (result.fares || []) : [] };
    } catch (error) {
      tasks[i] = { ...tasks[i], status: 'failed', fares: [], cause: { code: 'COLLECTOR_ERROR', detail: String(error.message) } };
    }
    if (signal?.aborted || tasks[i].status === 'blocked' || DENIAL.has(tasks[i].cause?.code)) {
      stopReason = signal?.aborted ? 'USER_STOP' : tasks[i].cause?.code || 'BLOCKED';
      for (const task of tasks.slice(i + 1)) { task.status = 'skipped'; task.cause = { code: 'BATCH_STOPPED' }; }
      await onUpdate(tasks);
      break;
    }
    await onUpdate(tasks);
  }
  return { status: stopReason === 'USER_STOP' ? 'cancelled' : stopReason ? 'blocked' : tasks.every(task => ['ok', 'empty'].includes(task.status)) ? 'complete' : 'partial', stopReason, tasks };
}
