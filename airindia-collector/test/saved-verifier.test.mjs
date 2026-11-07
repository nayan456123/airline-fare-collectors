import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSearchResponse } from '../src/parse.mjs';
import { verifyRun, verifySearch } from '../src/verify.mjs';

const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-03' };
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function sourceResponse() {
  return JSON.stringify({ status: 'SUCCESS', hasError: false,
    dictionaries: { flight: { one: {
      departure: { locationCode: 'DEL', dateTime: '2026-10-03T09:00:00+05:30' },
      arrival: { locationCode: 'BOM', dateTime: '2026-10-03T11:00:00+05:30' },
      marketingAirlineCode: 'AI', marketingFlightNumber: '123', operatingAirlineCode: 'AI'
    } } },
    responsePayload: [{ airBoundGroups: [{
      boundDetails: { originLocationCode: 'DEL', destinationLocationCode: 'BOM',
        segments: [{ flightId: 'one' }] },
      airBounds: [{ aiUnitPrice: { value: 6581, currencyCode: 'INR' },
        prices: { totalPrices: [{ currencyCode: 'INR', base: 5000, totalTaxes: 1581,
          total: 6581, taxes: [{ code: 'YQ', value: 1581, currencyCode: 'INR' }] }] } }]
    }] }]
  });
}

function twoOfferResponse() {
  const data = JSON.parse(sourceResponse());
  const second = structuredClone(data.dictionaries.flight.one);
  second.marketingFlightNumber = '456';
  second.departure.dateTime = '2026-10-03T12:00:00+05:30';
  second.arrival.dateTime = '2026-10-03T14:00:00+05:30';
  data.dictionaries.flight.two = second;
  const group = structuredClone(data.responsePayload[0].airBoundGroups[0]);
  group.boundDetails.segments = [{ flightId: 'two' }];
  group.airBounds[0].aiUnitPrice.value = 7581;
  const price = group.airBounds[0].prices.totalPrices[0];
  price.base = 6000;
  price.total = 7581;
  data.responsePayload[0].airBoundGroups.push(group);
  return JSON.stringify(data);
}

const page = `<div class="ai-pb-flight-item">
  <span class="ai-pb-flight-id">AI 123</span>
  <span class="ai-pb-departure-city-code">DEL</span>
  <span class="ai-pb-actual-arrival-city">BOM</span>
  <span class="ai-pb-departure-time">09:00</span>
  <span class="ai-pb-arrival-time">11:00</span>
  <span class="ai-pb-currency-code">INR</span>
  <span class="ai-pb-price">₹ 6,581</span>
</div>`;

async function savedEvidence(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-verify-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = { airlineResponse: sourceResponse(), resultPage: page, resultScreenshot: 'fake image bytes' };
  const evidence = {};
  for (const [key, contents] of Object.entries(files)) {
    const filename = `${key}.dat`;
    await fs.writeFile(path.join(directory, filename), contents);
    evidence[key] = filename;
    evidence[`${key}Sha256`] = sha256(contents);
  }
  const result = { status: 'ok', query, fares: parseSearchResponse(files.airlineResponse, query), evidence,
    collectedAt: '2026-10-01T00:00:03.000Z', responseEvidenceVersion: 1,
    airlineResponseProvenance: { protocol: 'https:', host: 'www.airindia.com', path: '/api/flight',
      method: 'POST', status: 200, contentType: 'application/json',
      submittedAt: '2026-10-01T00:00:00.000Z', requestStartedAt: '2026-10-01T00:00:01.000Z',
      at: '2026-10-01T00:00:02.000Z', bodySha256: evidence.airlineResponseSha256 } };
  return { directory, result };
}

test('saved search verifies complete response, page, and screenshot file hashes', async t => {
  const { directory, result } = await savedEvidence(t);
  const report = await verifySearch(directory, result);
  assert.equal(report.ok, true, report.errors.join('; '));
  assert.equal(report.evidenceIntegrityOk, true);
});

test('versioned response provenance rejects stale, missing, altered and foreign evidence', async t => {
  const { directory, result } = await savedEvidence(t);
  result.collectedAt = '2026-10-01T00:00:03.000Z';
  result.responseEvidenceVersion = 1;
  result.airlineResponseProvenance = { protocol: 'https:', host: 'www.airindia.com', path: '/api/flight',
    method: 'POST', status: 200, contentType: 'application/json',
    submittedAt: '2026-10-01T00:00:00.000Z', requestStartedAt: '2026-10-01T00:00:01.000Z',
    at: '2026-10-01T00:00:02.000Z', bodySha256: result.evidence.airlineResponseSha256 };
  assert.equal((await verifySearch(directory, result)).ok, true);
  for (const change of [
    { requestStartedAt: '2026-09-30T23:59:59.000Z' }, { submittedAt: null },
    { bodySha256: 'bad' }, { host: 'airindia.com.evil.example' }, { status: 403 }, { contentType: 'text/html' },
    { at: '2026-10-01T00:00:00.000Z' }, { at: '2026-10-01T00:00:04.000Z' }
  ]) {
    const altered = structuredClone(result);
    Object.assign(altered.airlineResponseProvenance, change);
    assert.equal((await verifySearch(directory, altered)).ok, false, JSON.stringify(change));
  }
  const noVersion = structuredClone(result); delete noVersion.responseEvidenceVersion;
  assert.equal((await verifySearch(directory, noVersion)).ok, false);
  const noProvenance = structuredClone(result); delete noProvenance.airlineResponseProvenance;
  assert.equal((await verifySearch(directory, noProvenance)).ok, false);
  const legacy = structuredClone(noProvenance); delete legacy.responseEvidenceVersion;
  assert.equal((await verifySearch(directory, legacy)).ok, false);
  const legacyReport = await verifySearch(directory, legacy, { allowLegacy: true });
  assert.equal(legacyReport.ok, true);
  assert.equal(legacyReport.provenanceVerified, false);
});

test('saved verifier rejects same-count duplicate substitution across two source offers', async t => {
  const { directory, result } = await savedEvidence(t);
  const response = twoOfferResponse();
  await fs.writeFile(path.join(directory, result.evidence.airlineResponse), response);
  result.evidence.airlineResponseSha256 = sha256(response);
  result.airlineResponseProvenance.bodySha256 = sha256(response);
  const secondCard = page.replace('AI 123', 'AI 456').replace('09:00', '12:00')
    .replace('11:00', '14:00').replace('6,581', '7,581');
  const pageFile = path.join(directory, result.evidence.resultPage);
  const twoCardPage = `${page}${secondCard}`;
  await fs.writeFile(pageFile, twoCardPage);
  result.evidence.resultPageSha256 = sha256(twoCardPage);
  result.fares = parseSearchResponse(response, query);
  assert.equal(result.fares.length, 2);
  result.fares = [result.fares[0], result.fares[0]];
  const report = await verifySearch(directory, result);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(error => /Saved fare differs/.test(error)));
});

test('saved verifier rejects a tampered HTML result page', async t => {
  const { directory, result } = await savedEvidence(t);
  await fs.appendFile(path.join(directory, result.evidence.resultPage), '<!-- changed -->');
  const report = await verifySearch(directory, result);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(error => /hash differs/.test(error)));
});

test('agent run verifier rejects an empty manifest', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-empty-manifest-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ id: 'empty', searches: [] }));
  const report = await verifyRun(directory);
  assert.equal(report.ok, false);
  assert.equal(report.checks.length, 0);
});

test('run binds queries and validates evidence from every attempt', async t => {
  const { directory, result } = await savedEvidence(t);
  const run = path.join(directory, 'run');
  const search = path.join(run, `01-${query.origin}-${query.destination}-${query.travelDate}`);
  await fs.mkdir(search, { recursive: true });
  for (const key of ['airlineResponse', 'resultPage', 'resultScreenshot'])
    await fs.copyFile(path.join(directory, result.evidence[key]), path.join(search, result.evidence[key]));
  result.attempt = 2;
  const failed = { status: 'failed', query, attempt: 1, evidence: { failurePage: 'failure.html', failurePageSha256: sha256('failure') } };
  await fs.writeFile(path.join(search, 'failure.html'), 'failure');
  await fs.writeFile(path.join(search, 'attempt-1.json'), JSON.stringify(failed));
  await fs.writeFile(path.join(search, 'attempt-2.json'), JSON.stringify(result));
  await fs.writeFile(path.join(search, 'result.json'), JSON.stringify(result));
  const manifest = { id: 'run', status: 'complete', searches: [query] };
  await fs.writeFile(path.join(run, 'manifest.json'), JSON.stringify(manifest));
  assert.equal((await verifyRun(run)).ok, true);
  for (const status of ['blocked', 'partial']) {
    manifest.status = status;
    await fs.writeFile(path.join(run, 'manifest.json'), JSON.stringify(manifest));
    const aggregateFailure = await verifyRun(run);
    assert.equal(aggregateFailure.ok, false, `${status} collector run cannot verify as complete`);
    assert.ok(aggregateFailure.errors.some(error => error.includes(`Collector run status is ${status}`)));
    assert.equal(aggregateFailure.checks[0].ok, true, 'valid child fare evidence remains visible');
  }
  manifest.status = 'complete';
  await fs.writeFile(path.join(run, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(search, 'attempt-2.json'), JSON.stringify({ query, evidence: {} }));
  const substituted = await verifyRun(run);
  assert.equal(substituted.ok, false);
  assert.ok(substituted.checks[0].errors.some(error => /Final attempt record differs/.test(error)));
  await fs.writeFile(path.join(search, 'attempt-2.json'), JSON.stringify(result));
  const annotated = { ...result, evidenceVerified: true, evidenceErrors: [] };
  await fs.writeFile(path.join(search, 'result.json'), JSON.stringify(annotated));
  assert.equal((await verifyRun(run)).ok, true);
  await fs.writeFile(path.join(search, 'result.json'), JSON.stringify(result));
  await fs.writeFile(path.join(search, 'failure.html'), 'changed');
  assert.equal((await verifyRun(run)).ok, false);
  await fs.writeFile(path.join(search, 'failure.html'), 'failure');
  failed.query = { ...query, travelDate: '2026-10-04' };
  await fs.writeFile(path.join(search, 'attempt-1.json'), JSON.stringify(failed));
  assert.equal((await verifyRun(run)).ok, false);
  failed.query = query;
  await fs.writeFile(path.join(search, 'attempt-1.json'), JSON.stringify(failed));
  const changed = { ...result, query: { ...query, travelDate: '2026-10-04' } };
  await fs.writeFile(path.join(search, 'result.json'), JSON.stringify(changed));
  const mismatch = await verifyRun(run);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.checks[0].errors.some(error => /query differs/.test(error)));
  await fs.writeFile(path.join(search, 'result.json'), JSON.stringify(result));
  await fs.rm(path.join(search, 'attempt-2.json'));
  assert.equal((await verifyRun(run)).ok, false);
});

test('desk rejects a valid collector run belonging to a different task', async t => {
  const { directory, result } = await savedEvidence(t);
  const run = path.join(directory, 'agent');
  const search = path.join(run, `01-${query.origin}-${query.destination}-${query.travelDate}`);
  await fs.mkdir(search, { recursive: true });
  for (const key of ['airlineResponse', 'resultPage', 'resultScreenshot'])
    await fs.copyFile(path.join(directory, result.evidence[key]), path.join(search, result.evidence[key]));
  result.attempt = 1;
  await fs.writeFile(path.join(search, 'attempt-1.json'), JSON.stringify(result));
  await fs.writeFile(path.join(search, 'result.json'), JSON.stringify(result));
  await fs.writeFile(path.join(run, 'manifest.json'), JSON.stringify({ id: 'agent', status: 'complete', searches: [query] }));
  const task = { id: 'task', ...query, runRoot: run };
  const job = { id: 'desk', status: 'complete', tasks: [task] };
  await fs.writeFile(path.join(directory, 'jobs.json'), JSON.stringify(job));
  assert.equal((await verifyRun(directory)).ok, true);
  for (const status of ['blocked', 'partial']) {
    job.status = status;
    await fs.writeFile(path.join(directory, 'jobs.json'), JSON.stringify(job));
    const aggregateFailure = await verifyRun(directory);
    assert.equal(aggregateFailure.ok, false, `${status} desk run cannot verify as complete`);
    assert.ok(aggregateFailure.errors.some(error => error.includes(`Desk run status is ${status}`)));
    assert.equal(aggregateFailure.checks[0].ok, true, 'valid child collector evidence remains visible');
  }
  job.status = 'complete';
  await fs.writeFile(path.join(directory, 'jobs.json'), JSON.stringify(job));
  task.travelDate = '2026-10-04';
  await fs.writeFile(path.join(directory, 'jobs.json'), JSON.stringify(job));
  assert.equal((await verifyRun(directory)).ok, false);
});

test('desk verifier reports the real failure for a matching blocked collector run', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-blocked-desk-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const run = path.join(directory, 'agent');
  const search = path.join(run, `01-${query.origin}-${query.destination}-${query.travelDate}`);
  await fs.mkdir(search, { recursive: true });
  await fs.writeFile(path.join(run, 'manifest.json'), JSON.stringify({
    id: 'agent', status: 'blocked', searches: [query]
  }));
  await fs.writeFile(path.join(search, 'result.json'), JSON.stringify({
    status: 'blocked', query, attempt: 1, fares: [],
    cause: { code: 'ACCESS_DENIED' }, evidence: {}
  }));
  await fs.writeFile(path.join(directory, 'jobs.json'), JSON.stringify({
    id: 'desk', status: 'blocked', tasks: [{ id: '001', ...query, status: 'blocked',
      cause: { code: 'ACCESS_DENIED' }, runRoot: run }]
  }));

  const report = await verifyRun(directory);
  assert.equal(report.ok, false, 'a blocked search must remain an invalid fare verification');
  const errors = report.checks[0].checks[0].errors;
  assert.ok(errors.some(error => /Search status is blocked: ACCESS_DENIED/.test(error)));
  assert.ok(!errors.some(error => /Collector search query differs from desk task/.test(error)),
    'matching failure queries must not create a spurious query mismatch');
});
