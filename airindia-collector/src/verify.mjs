import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseSearchResponse, extractCardsFromHtml, matchFaresToCards } from './parse.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export async function verifySavedEvidence(directory, result) {
  const errors = [];
  for (const [key, filename] of Object.entries(result.evidence || {})) {
    if (key.endsWith('Sha256') || !filename) continue;
    const digest = result.evidence[`${key}Sha256`];
    if (!digest || path.basename(filename) !== filename) {
      errors.push(`${key} has no valid filename or hash`);
      continue;
    }
    try {
      if (sha256(await fs.readFile(path.join(directory, filename))) !== digest)
        errors.push(`${key} hash differs from the saved file`);
    } catch { errors.push(`${key} file is missing`); }
  }
  return { ok: errors.length === 0, errors };
}

export async function verifySearch(directory, savedResult = null, { allowLegacy = false } = {}) {
  const result = savedResult || JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  const integrity = await verifySavedEvidence(directory, result);
  if (result.status !== 'ok') return { ok: false, evidenceIntegrityOk: integrity.ok,
    errors: [`Search status is ${result.status}: ${result.cause?.code || 'UNKNOWN'}`,
      ...integrity.errors], query: result.query };
  const errors = [...integrity.errors];
  if (!result.fares?.length || !result.evidence?.resultPage ||
      !result.evidence?.airlineResponse || !result.evidence?.resultScreenshot)
    errors.push('Fare or result evidence is missing');
  if (errors.length) return { ok: false, errors };
  const response = await fs.readFile(path.join(directory, result.evidence.airlineResponse));
  const page = await fs.readFile(path.join(directory, result.evidence.resultPage));
  const screenshot = await fs.readFile(path.join(directory, result.evidence.resultScreenshot));
  if (sha256(response) !== result.evidence.airlineResponseSha256 ||
      sha256(page) !== result.evidence.resultPageSha256 ||
      sha256(screenshot) !== result.evidence.resultScreenshotSha256)
    errors.push('Saved response or page hash differs from the recorded hash');
  if (result.responseEvidenceVersion === 1 || result.airlineResponseProvenance !== undefined) {
    const p = result.airlineResponseProvenance;
    if (result.responseEvidenceVersion !== 1 || !p || p.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)*airindia\.com$/i.test(p.host || '') ||
        !/^\//.test(p.path || '') || !/api|availability|offer|flight|search|journey|shopping/i.test(p.path || '') ||
        p.status !== 200 || !/^(GET|POST)$/.test(p.method || '') || !/json/i.test(p.contentType || '') ||
        !Number.isFinite(Date.parse(p.submittedAt)) || !Number.isFinite(Date.parse(p.requestStartedAt)) ||
        Date.parse(p.requestStartedAt) < Date.parse(p.submittedAt) ||
        !Number.isFinite(Date.parse(p.at)) || Date.parse(p.at) < Date.parse(p.requestStartedAt) ||
        !Number.isFinite(Date.parse(result.collectedAt)) || Date.parse(p.at) > Date.parse(result.collectedAt) ||
        p.bodySha256 !== sha256(response) || p.bodySha256 !== result.evidence.airlineResponseSha256)
      errors.push('Selected airline response provenance is invalid');
  } else if (result.responseEvidenceVersion !== undefined) errors.push('Unsupported response evidence version');
  else if (!allowLegacy) errors.push('Airline response provenance is missing; legacy verification requires explicit opt-in');
  try {
    const offers = parseSearchResponse(response.toString(), result.query);
    if (!offers || offers.length !== result.fares.length)
      errors.push('Airline response fare count differs');
    const unmatched = [...(offers || [])];
    for (const fare of result.fares) {
      const index = unmatched.findIndex(item => {
        // Cabin is additive for older saved records only. Every other field
        // remains part of the exact comparison, including unexpected fields.
        const comparable = { ...item };
        if (!Object.hasOwn(fare, 'cabin') && result.fareEvidenceVersion !== 2) delete comparable.cabin;
        return JSON.stringify(comparable) === JSON.stringify(fare);
      });
      if (index < 0) errors.push(`Saved fare differs from airline response for ${fare.flight}`);
      else unmatched.splice(index, 1);
    }
    if (offers?.length) matchFaresToCards(offers,
      extractCardsFromHtml(page.toString()), result.query,
      { requireCabin: result.fareEvidenceVersion === 2 || result.fares.some(fare => Object.hasOwn(fare, 'cabin')) });
  } catch (error) { errors.push(error.code || error.message); }
  return { ok: errors.length === 0, evidenceIntegrityOk: integrity.ok, errors,
    fareCount: result.fares.length,
    query: result.query, provenanceVerified: result.responseEvidenceVersion === 1 && !errors.some(error => /provenance/.test(error)) };
}

const sameQuery = (a, b) => !!a && !!b && ['origin', 'destination', 'travelDate'].every(key => a[key] === b[key]);
const collectionRecord = record => {
  const copy = { ...record };
  delete copy.evidenceVerified;
  delete copy.evidenceErrors;
  return copy;
};

async function verifyAgentRun(directory, manifest, options) {
  const checks = [];
  for (const [index, query] of manifest.searches.entries()) {
    const name = `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`;
    try {
      const searchDir = path.join(directory, name);
      const result = JSON.parse(await fs.readFile(path.join(searchDir, 'result.json'), 'utf8'));
      const check = await verifySearch(searchDir, result, options);
      if (!sameQuery(result.query, query)) {
        check.ok = false;
        check.errors.push('Saved result query differs from manifest search');
      }
      const attempts = [];
      let finalAttempt = null;
      for (const filename of (await fs.readdir(searchDir)).filter(file => /^attempt-\d+\.json$/.test(file)).sort()) {
        const attempt = JSON.parse(await fs.readFile(path.join(searchDir, filename), 'utf8'));
        if (filename === `attempt-${result.attempt}.json`) finalAttempt = attempt;
        const evidence = await verifySavedEvidence(searchDir, attempt);
        if (!sameQuery(attempt.query, query)) evidence.errors.push('Attempt query differs from manifest search');
        evidence.ok = evidence.errors.length === 0;
        attempts.push({ filename, status: attempt.status,
          cause: attempt.cause?.code || null,
          evidence });
      }
      if (attempts.some(attempt => !attempt.evidence.ok)) {
        check.ok = false;
        check.errors.push('Attempt evidence or query is invalid');
      }
      if (result.status === 'ok' && !options.allowLegacy && (!Number.isInteger(result.attempt) ||
          !finalAttempt)) {
        check.ok = false;
        check.errors.push('Final attempt record is missing');
      }
      if (result.status === 'ok' && finalAttempt &&
          !isDeepStrictEqual(collectionRecord(finalAttempt), collectionRecord(result))) {
        check.ok = false;
        check.errors.push('Final attempt record differs from saved result');
      }
      checks.push({ name, ...check, attempts });
    }
    catch (error) { checks.push({ name, ok: false, errors: [error.message] }); }
  }
  const errors = manifest.status === 'complete' ? [] :
    [`Collector run status is ${manifest.status || 'UNKNOWN'}`];
  return { run: manifest.id, status: manifest.status,
    ok: errors.length === 0 && checks.length > 0 && checks.every(check => check.ok), errors, checks };
}

async function verifyWebRun(directory, job, options) {
  const checks = [];
  for (const task of job.tasks || []) {
    if (!task.runRoot) {
      checks.push({ task: task.id, status: task.status, ok: false,
        errors: [`No collector run: ${task.cause?.code || task.status}`] });
      continue;
    }
    const agentRoot = path.resolve(task.runRoot);
    if (!agentRoot.startsWith(path.resolve(directory) + path.sep)) {
      checks.push({ task: task.id, status: task.status, ok: false,
        errors: ['Collector run path is outside this desk run'] });
      continue;
    }
    try {
      const check = await verifyRun(agentRoot, options);
      if (check.checks?.length !== 1 || !sameQuery(check.checks[0].query, task)) {
        check.ok = false;
        check.errors = [...(check.errors || []), 'Collector search query differs from desk task'];
      }
      checks.push({ task: task.id, ...check });
    }
    catch (error) { checks.push({ task: task.id, status: task.status,
      ok: false, errors: [error.message] }); }
  }
  const errors = job.status === 'complete' ? [] :
    [`Desk run status is ${job.status || 'UNKNOWN'}`];
  return { run: job.id, kind: 'desk', status: job.status,
    ok: errors.length === 0 && checks.length > 0 && checks.every(check => check.ok), errors, checks };
}

export async function verifyRun(directory, options = {}) {
  const manifestFile = path.join(directory, 'manifest.json');
  try {
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    return verifyAgentRun(directory, manifest, options);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const job = JSON.parse(await fs.readFile(path.join(directory, 'jobs.json'), 'utf8'));
    return verifyWebRun(directory, job, options);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowLegacy = args.includes('--allow-legacy');
  for (const directory of args.filter(arg => arg !== '--allow-legacy')) {
    const report = await verifyRun(path.resolve(directory), { allowLegacy });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
  }
}
