import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tryBrowserLease } from './browser-admission.mjs';
import { verifySearch } from './verify.mjs';

export const STAGES = Object.freeze([
  'browser_ready', 'homepage_loaded', 'markets_ready', 'form_confirmed',
  'search_submitted', 'airline_response_verified', 'results_rendered',
  'fare_verified', 'complete'
]);
export const OFFSETS = Object.freeze([1, 5, 9, 15, 30, 45]);
const DENIAL = new Set(['ACCESS_DENIED', 'CAPTCHA', 'RATE_LIMITED', 'SESSION_EXPIRED', 'SESSION_INVALID']);
const MAX_TASKS = 54;
const MAX_WORKERS = 3;
const inputError = message => Object.assign(new Error(message), { status: 400 });

export function istDate(offset, at = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10);
}

export function validatePlan(input, at = new Date()) {
  const raw = Array.isArray(input?.routes) ? input.routes : [];
  const routes = [...new Set(raw.map(route => String(route).trim().toUpperCase().replace(/\s+/g, '')))].map(route => {
    const match = /^([A-Z]{3})[-:→]([A-Z]{3})$/.exec(route);
    if (!match || match[1] === match[2]) throw inputError(`Invalid route: ${route}. Use DEL-BOM.`);
    return { origin: match[1], destination: match[2] };
  });
  if (!routes.length) throw inputError('Enter at least one route.');
  const offsets = [...new Set(Array.isArray(input.offsets) ? input.offsets.map(Number) : [])]
    .sort((a, b) => a - b);
  if (!offsets.length || offsets.some(offset => !OFFSETS.includes(offset)))
    throw inputError('Choose at least one offered travel date.');
  const concurrency = Number(input.concurrency ?? Math.min(2, routes.length * offsets.length));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_WORKERS)
    throw inputError(`Agents must be between 1 and ${MAX_WORKERS}.`);
  if (routes.length * offsets.length > MAX_TASKS)
    throw inputError(`This batch is limited to ${MAX_TASKS} searches.`);
  const browserMode = input.browserMode ?? 'headed';
  if (!['headed', 'headless'].includes(browserMode))
    throw inputError('Browser mode must be headed or headless.');
  return { routes, offsets, concurrency, browserMode,
    tasks: routes.flatMap(route => offsets.map(offset => ({
    ...route, offset, travelDate: istDate(offset, at)
  }))) };
}

const publicTask = task => ({
  id: task.id, origin: task.origin, destination: task.destination,
  travelDate: task.travelDate, offset: task.offset, status: task.status,
  stage: task.stage, attempt: task.attempt, worker: task.worker,
  startedAt: task.startedAt, finishedAt: task.finishedAt,
  cause: task.cause, fareCount: task.fares.length, fares: task.fares,
  coverage: task.coverage, observedFareCount: task.observedFareCount,
  expectedJourneys: task.expectedJourneys,
  evidenceVerified: task.evidenceVerified, evidenceErrors: task.evidenceErrors,
  events: task.events.slice(-25), runRoot: task.runRoot
});

export class JobManager extends EventEmitter {
  constructor({ root, packageRoot, minLaunchGapMs = 20000, spawnWorker = spawn } = {}) {
    super();
    this.root = path.resolve(root);
    this.packageRoot = path.resolve(packageRoot);
    this.minLaunchGapMs = minLaunchGapMs;
    this.spawnWorker = spawnWorker;
    this.browserAdmission = spawnWorker === spawn;
    this.jobs = new Map();
    this.activeJob = null;
    this.children = new Map();
    this.launchTimer = null;
    this.lastLaunchAt = 0;
  }

  snapshot(job) {
    return { id: job.id, status: job.status, startedAt: job.startedAt,
      finishedAt: job.finishedAt, stopReason: job.stopReason,
      retryOf: job.retryOf || null,
      routes: job.routes, offsets: job.offsets, concurrency: job.concurrency,
      requestedConcurrency: job.requestedConcurrency, resourceNote: job.resourceNote,
      browserMode: job.browserMode,
      tasks: job.tasks.map(publicTask) };
  }

  async persist(job) {
    const snapshot = this.snapshot(job);
    job.writeChain = (job.writeChain || Promise.resolve()).then(async () => {
      const file = path.join(job.root, 'jobs.json');
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(temporary, file);
    });
    await job.writeChain;
  }

  async publish(job) {
    await this.persist(job);
    this.emit('change', job.id, this.snapshot(job));
  }

  async createPlan(plan, retryOf = null) {
    if (['running', 'stopping'].includes(this.activeJob?.status))
      throw Object.assign(new Error('A batch is already running.'), { status: 409 });
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const root = path.join(this.root, id);
    const job = { id, root, status: 'running', startedAt: new Date().toISOString(),
      finishedAt: null, stopReason: null, routes: plan.routes, offsets: plan.offsets,
      concurrency: plan.concurrency, requestedConcurrency: plan.requestedConcurrency || plan.concurrency,
      resourceNote: plan.resourceNote || null, browserMode: plan.browserMode, retryOf,
      writeChain: Promise.resolve(),
      tasks: plan.tasks.map((task, index) => ({ ...task, id: String(index + 1).padStart(3, '0'),
        status: 'queued', stage: null, attempt: 0, worker: null,
        startedAt: null, finishedAt: null, cause: null, fares: [],
        evidenceVerified: false, evidenceErrors: [], events: [], runRoot: null,
        coverage: null, observedFareCount: 0, expectedJourneys: null })) };
    this.activeJob = job;
    try {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      this.jobs.set(id, job);
      await this.publish(job);
      this.pump(job);
      return this.snapshot(job);
    } catch (error) {
      if (this.activeJob === job) this.activeJob = null;
      this.jobs.delete(id);
      throw error;
    }
  }

  async admitPlan(plan) {
    return { ...plan, requestedConcurrency: plan.concurrency, resourceNote: null };
  }

  async create(input) {
    return this.createPlan(await this.admitPlan(validatePlan(input)));
  }

  async retry(runId, taskId) {
    const source = await this.get(runId);
    const task = source?.tasks.find(item => item.id === taskId);
    if (!task) throw inputError('Saved search not found.');
    if (!['failed', 'partial', 'skipped', 'interrupted'].includes(task.status))
      throw Object.assign(new Error('Only unfinished searches can be run again.'), { status: 409 });
    if (DENIAL.has(source.stopReason) || DENIAL.has(task.cause?.code))
      throw Object.assign(new Error('Akasa denied access. Check access before starting a new search.'), { status: 409 });
    if (task.travelDate <= istDate(0))
      throw Object.assign(new Error('This travel date has passed. Choose a future date in a new collection.'), { status: 409 });
    const route = { origin: task.origin, destination: task.destination };
    return this.createPlan(await this.admitPlan({ routes: [route], offsets: [task.offset], concurrency: 1,
      browserMode: source.browserMode || 'headed',
      tasks: [{ ...route, offset: task.offset, travelDate: task.travelDate }] }),
    { runId, taskId });
  }

  async retryFailed(runId) {
    const source = await this.get(runId);
    if (!source) throw inputError('Saved run not found.');
    if (['running', 'stopping'].includes(source.status))
      throw Object.assign(new Error('Wait until the saved run finishes.'), { status: 409 });
    if (DENIAL.has(source.stopReason))
      throw Object.assign(new Error('Akasa denied access. Check access before retrying.'), { status: 409 });
    const tasks = source.tasks.filter(task =>
      ['failed', 'partial', 'skipped', 'interrupted'].includes(task.status) &&
      !DENIAL.has(task.cause?.code) && task.travelDate > istDate(0));
    if (!tasks.length)
      throw Object.assign(new Error('This run has no retryable future searches.'), { status: 409 });
    const routes = [...new Map(tasks.map(task => [
      `${task.origin}-${task.destination}`, { origin: task.origin, destination: task.destination }
    ])).values()];
    const offsets = [...new Set(tasks.map(task => task.offset))].sort((a, b) => a - b);
    return this.createPlan(await this.admitPlan({ routes, offsets,
      browserMode: source.browserMode || 'headed', concurrency: Math.min(MAX_WORKERS, source.concurrency || 1, tasks.length),
      tasks: tasks.map(task => ({ origin: task.origin, destination: task.destination,
        travelDate: task.travelDate, offset: task.offset })) }),
    { runId, taskIds: tasks.map(task => task.id) });
  }

  async recoverDeniedRun(runId, accessRestored) {
    if (accessRestored !== true)
      throw inputError('Confirm that Akasa access has been restored before resuming this saved run.');
    const source = await this.get(runId);
    if (!source) throw inputError('Saved run not found.');
    if (['running', 'stopping'].includes(source.status))
      throw Object.assign(new Error('Wait until the saved run finishes.'), { status: 409 });
    const hasDenial = DENIAL.has(source.stopReason) || source.tasks.some(task => DENIAL.has(task.cause?.code));
    if (!hasDenial)
      throw Object.assign(new Error('This saved run has no recorded access denial to recover from.'), { status: 409 });
    const tasks = source.tasks.filter(task =>
      ['failed', 'partial', 'skipped', 'interrupted', 'blocked'].includes(task.status) &&
      task.travelDate > istDate(0));
    if (!tasks.length)
      throw Object.assign(new Error('This run has no unfinished future searches to resume.'), { status: 409 });
    if (tasks.length > MAX_TASKS)
      throw Object.assign(new Error(`This recovery is limited to ${MAX_TASKS} searches.`), { status: 409 });
    const routes = [...new Map(tasks.map(task => [
      `${task.origin}-${task.destination}`, { origin: task.origin, destination: task.destination }
    ])).values()];
    const offsets = [...new Set(tasks.map(task => task.offset))].sort((a, b) => a - b);
    return this.createPlan(await this.admitPlan({ routes, offsets,
      browserMode: source.browserMode || 'headed', concurrency: Math.min(MAX_WORKERS, source.concurrency || 1, tasks.length),
      tasks: tasks.map(task => ({ origin: task.origin, destination: task.destination,
        travelDate: task.travelDate, offset: task.offset })) }),
    { runId, taskIds: tasks.map(task => task.id), recovery: true });
  }

  async deleteRun(id) {
    if (!/^[\w-]+$/.test(id)) throw inputError('Invalid run ID.');
    const run = await this.get(id);
    if (!run) throw Object.assign(new Error('Saved run not found.'), { status: 404 });
    if (['running', 'stopping'].includes(run.status))
      throw Object.assign(new Error('Stop this run before deleting it.'), { status: 409 });
    const job = this.jobs.get(id);
    if (job?.writeChain) await job.writeChain;
    await fs.rm(path.join(this.root, id), { recursive: true });
    this.jobs.delete(id);
    if (this.activeJob?.id === id) this.activeJob = null;
    return { id, deleted: true };
  }

  async get(id) {
    if (this.jobs.has(id)) return this.snapshot(this.jobs.get(id));
    if (!/^[\w-]+$/.test(id)) return null;
    try {
      const snapshot = JSON.parse(await fs.readFile(path.join(this.root, id, 'jobs.json'), 'utf8'));
      if (['running', 'stopping'].includes(snapshot.status)) {
        const recoveredAt = new Date().toISOString();
        snapshot.status = 'interrupted';
        snapshot.stopReason = 'Server stopped while this batch was running';
        snapshot.finishedAt = recoveredAt;
        for (const task of snapshot.tasks) if (['queued', 'running'].includes(task.status)) {
          task.status = 'interrupted';
          task.cause = { code: 'SERVER_INTERRUPTED' };
          task.finishedAt = recoveredAt;
          task.events.push({ at: recoveredAt, event: 'server_interrupted',
            stage: task.stage, code: 'SERVER_INTERRUPTED', message: null });
        }
        const file = path.join(this.root, id, 'jobs.json');
        const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
        await fs.rename(temporary, file);
      }
      return snapshot;
    } catch { return null; }
  }

  async latest() {
    const names = (await fs.readdir(this.root, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
    for (const id of names) {
      const job = await this.get(id);
      if (job) return job;
    }
    return null;
  }

  async recent(limit = 10) {
    const names = (await fs.readdir(this.root, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse().slice(0, limit);
    const runs = await Promise.all(names.map(id => this.get(id)));
    return runs.filter(Boolean).map(run => ({ id: run.id, status: run.status,
      startedAt: run.startedAt, browserMode: run.browserMode || 'headed',
      routes: run.routes?.map(route => `${route.origin}-${route.destination}`) || [],
      searches: run.tasks?.length || 0 }));
  }

  async event(job, task, record) {
    if (task.status !== 'running') return;
    if (record.event === 'search_start') task.cause = null;
    if (record.event === 'stage' && STAGES.includes(record.stage)) {
      task.stage = record.stage;
      task.attempt = record.attempt || task.attempt;
    }
    if (record.event === 'failure' && record.cause) task.cause = record.cause;
    if (record.event === 'search_finished') {
      task.expectedJourneys = record.expectedJourneys ?? task.expectedJourneys;
      task.observedFareCount = record.fareCount ?? task.observedFareCount;
      if (record.cause) task.cause = record.cause;
    }
    if (record.event === 'evidence_checked' && record.ok) task.stage = 'fare_verified';
    task.events.push({ at: record.at || new Date().toISOString(), event: record.event,
      stage: record.stage || null, code: record.cause?.code || null,
      message: record.cause?.detail || (record.event === 'search_finished' ?
        `${record.status}: ${record.fareCount || 0} fares` : null) });
    task.events = task.events.slice(-80);
    await this.publish(job);
    if (record.event === 'failure' && DENIAL.has(record.cause?.code))
      await this.stop(job, record.cause.code, task.id);
  }

  consumeLine(job, task, line) {
    if (line.startsWith('RUN_DIR=')) {
      const candidate = path.resolve(line.slice(8).trim());
      const expected = path.join(job.root, `agent-${task.worker}`);
      if (candidate.startsWith(expected + path.sep)) task.runRoot = candidate;
      return;
    }
    if (!line.startsWith('{')) return;
    try {
      const record = JSON.parse(line);
      task.eventChain = (task.eventChain || Promise.resolve())
        .then(() => this.event(job, task, record)).catch(error => this.emit('error', error));
    }
    catch { /* Chrome startup output is not collector JSON. */ }
  }

  launch(job, task, worker, lease = null) {
    task.worker = worker;
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    const output = path.join(job.root, `agent-${worker}`);
    const profileMode = job.browserMode;
    const profile = path.join(this.packageRoot, '.session', 'web-agents',
      profileMode, `agent-${worker}`);
    const args = [path.join(this.packageRoot, 'src', 'collect.mjs'),
      '--search', `${task.origin}:${task.destination}:${task.travelDate}`,
      '--output', output, '--profile', profile, '--interaction-delay-ms', '700',
      '--min-interval-ms', '20000', '--retries', '1',
      job.browserMode === 'headless' ? '--headless' : '--headed'];
    if (process.env.AKASA_PROXY_SERVER) args.push('--proxy', process.env.AKASA_PROXY_SERVER);
    const child = this.spawnWorker(process.execPath, args, { cwd: this.packageRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.children.set(task.id, child);
    void lease?.attach(child.pid).catch(failure => this.emit('error', failure));
    let buffer = '';
    child.stdout?.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) this.consumeLine(job, task, line.trim());
    });
    child.stderr?.on('data', data => {
      const message = data.toString().trim().slice(0, 500);
      if (message) {
        task.events.push({ at: new Date().toISOString(), event: 'worker_stderr', message });
        task.events = task.events.slice(-80);
        void this.publish(job).catch(error => this.emit('error', error));
      }
    });
    let finishStarted = false;
    const finish = (code, signal, error) => {
      if (finishStarted) return;
      finishStarted = true;
      if (buffer.trim()) this.consumeLine(job, task, buffer.trim());
      void this.finish(job, task, code, signal, error)
        .finally(() => lease?.release()).catch(failure => this.emit('error', failure));
    };
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal, null));
    void this.publish(job).catch(error => this.emit('error', error));
  }

  async finish(job, task, code, signal, error) {
    if (task.finishedAt || task.finishing) return;
    task.finishing = true;
    await task.eventChain;
    this.children.delete(task.id);
    task.finishedAt = new Date().toISOString();
    if (task.runRoot) {
      try {
        const dir = path.join(task.runRoot,
          `01-${task.origin}-${task.destination}-${task.travelDate}`);
        const result = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
        const report = result.status === 'ok' ? await verifySearch(dir, {
          origin: task.origin, destination: task.destination, travelDate: task.travelDate
        }) :
          { ok: false, errors: [result.cause?.code || `Search status ${result.status}`] };
        task.evidenceVerified = report.ok;
        task.evidenceErrors = report.errors;
        task.coverage = result.expectedJourneys == null ? null :
          { captured: result.fares?.length || 0, expectedJourneys: result.expectedJourneys };
        task.expectedJourneys = result.expectedJourneys ?? task.expectedJourneys;
        task.observedFareCount = result.fares?.length || 0;
        task.cause = result.cause ? { code: result.cause.code, detail: result.cause.detail } : null;
        if (report.ok && result.status === 'ok')
          task.fares = result.fares.map((fare, index) => ({
            flight: fare.flight, collectedAt: fare.collectedAt,
            price: fare.price,
            departureTime: fare.departureTime, arrivalTime: fare.arrivalTime,
            stops: fare.stops,
            screenshot: fare.evidence.resultScreenshot,
            rowFile: fare.evidence.rowHtml,
            resultPage: fare.evidence.resultPage,
            response: fare.evidence.airlineResponse
          }));
        if (task.status === 'running') task.status = report.ok ? 'ok' :
          result.status === 'blocked' || result.status === 'partial' ? result.status : 'failed';
        if (result.status === 'ok' && !report.ok) task.cause = { code: 'EVIDENCE_UNVERIFIED',
          detail: report.errors.join('; ').slice(0, 700) };
      } catch (failure) {
        if (task.status === 'running') task.status = 'failed';
        if (task.status !== 'interrupted') task.cause =
          { code: 'WORKER_RESULT_UNAVAILABLE', detail: failure.message };
      }
    } else if (task.status === 'running') {
      task.status = 'failed';
      task.cause = { code: 'WORKER_DID_NOT_SAVE_RUN',
        detail: error?.message || `Exit ${code ?? signal ?? 'unknown'} before run evidence was available` };
    }
    if (!task.cause && code !== 0 && task.status !== 'ok')
      task.cause = { code: 'WORKER_EXIT', detail: `Exit ${code ?? signal ?? 'unknown'}` };
    await this.publish(job);
    if (DENIAL.has(task.cause?.code)) await this.stop(job, task.cause.code, task.id);
    if (job.status === 'running') {
      const repeatable = new Set(['SITE_NETWORK_FAILURE', 'TLS_TRUST_FAILURE',
        'MARKETS_UNAVAILABLE', 'RESULTS_UNVERIFIED', 'FORM_UNCONFIRMED']);
      const code = task.status === 'failed' ? task.cause?.code : null;
      job.lastFailure = repeatable.has(code) ?
        { code, count: job.lastFailure?.code === code ? job.lastFailure.count + 1 : 1 } : null;
      if (job.lastFailure?.count >= 2) await this.stop(job, `REPEATED_${code}`);
    }
    if (job.status === 'stopping' && this.children.size === 0) {
      job.status = job.stopKind;
      job.finishedAt = new Date().toISOString();
      await this.publish(job);
    } else this.pump(job);
  }

  async stop(job, reason, exceptId = null) {
    if (job.status !== 'running') return;
    job.status = 'stopping';
    job.stopKind = reason === 'USER_CANCELLED' || reason === 'SERVER_INTERRUPTED' ? 'cancelled' :
      DENIAL.has(reason) ? 'blocked' : 'partial';
    job.stopReason = reason;
    const stoppedAt = new Date().toISOString();
    clearTimeout(this.launchTimer);
    this.launchTimer = null;
    for (const task of job.tasks) {
      if (task.status === 'queued') {
        task.status = 'skipped'; task.finishedAt = stoppedAt;
        task.cause = { code: 'BATCH_STOPPED', detail: reason };
      } else if (task.status === 'running' && task.id !== exceptId) {
        task.status = 'interrupted';
        task.cause = { code: 'BATCH_STOPPED', detail: reason };
        const child = this.children.get(task.id);
        if (child?.pid) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
          const timer = setTimeout(() => {
            if (!this.children.has(task.id)) return;
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }, 5000);
          timer.unref();
        } else child?.kill('SIGTERM');
      }
    }
    if (this.children.size === 0) {
      job.status = job.stopKind;
      job.finishedAt = stoppedAt;
    }
    await this.publish(job);
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return null;
    await this.stop(job, 'USER_CANCELLED');
    return this.snapshot(job);
  }

  pump(job) {
    if (job.status !== 'running') return;
    const active = job.tasks.filter(task => task.status === 'running').length;
    const next = job.tasks.find(task => task.status === 'queued');
    if (!next && active === 0) {
      job.status = job.tasks.every(task => task.status === 'ok') ? 'complete' : 'partial';
      job.finishedAt = new Date().toISOString();
      void this.publish(job).catch(error => this.emit('error', error));
      return;
    }
    if (!next || active >= job.concurrency || this.launchTimer) return;
    const wait = Math.max(0, this.minLaunchGapMs - (Date.now() - this.lastLaunchAt));
    this.launchTimer = setTimeout(async () => {
      if (job.status !== 'running') { this.launchTimer = null; return; }
      const task = job.tasks.find(item => item.status === 'queued');
      const used = new Set(job.tasks.filter(item => item.status === 'running').map(item => item.worker));
      const worker = Array.from({ length: job.concurrency }, (_, index) => index + 1)
        .find(index => !used.has(index));
      if (task && worker) {
        let lease;
        try { lease = this.browserAdmission ? await tryBrowserLease() : null; }
        catch (failure) {
          this.launchTimer = null;
          await this.stop(job, 'RESOURCE_ADMISSION_FAILED');
          this.emit('error', failure); return;
        }
        if (this.browserAdmission && !lease) {
          job.resourceNote = 'Waiting for another airline browser to finish; shared memory protection is active.';
          await this.publish(job);
          this.launchTimer = setTimeout(() => { this.launchTimer = null; this.pump(job); }, 1000);
          return;
        }
        if (job.status !== 'running') { await lease?.release(); this.launchTimer = null; return; }
        job.resourceNote = 'Shared browser admission is active across the airline collectors.';
        this.lastLaunchAt = Date.now();
        try { this.launch(job, task, worker, lease); }
        catch (failure) { await lease?.release(); this.launchTimer = null; task.status = 'failed'; task.cause = { code: 'WORKER_LAUNCH_FAILED', detail: failure.message }; task.finishedAt = new Date().toISOString(); await this.stop(job, 'WORKER_LAUNCH_FAILED'); this.emit('error', failure); return; }
      }
      this.launchTimer = null;
      this.pump(job);
    }, wait);
  }

  async close() {
    if (this.activeJob?.status === 'running') await this.stop(this.activeJob, 'SERVER_INTERRUPTED');
  }
}
