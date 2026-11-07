import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyRun } from '../src/verify.mjs';

async function savedRun(manifest) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'akasa-verify-'));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  for (const [index, query] of (manifest.searches || []).entries()) {
    const name = `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`;
    const searchDir = path.join(directory, name);
    await fs.mkdir(searchDir);
    await fs.writeFile(path.join(searchDir, 'result.json'), JSON.stringify({
      query, status: 'failed', collectedAt: new Date().toISOString(), fares: [],
      cause: { code: 'TEST_FAILURE' }
    }));
  }
  return directory;
}

test('saved run verifier rejects empty and unfinished manifests', async () => {
  for (const manifest of [
    { id: 'empty', status: 'complete', searches: [] },
    { id: 'running', status: 'running', searches: [
      { origin: 'DEL', destination: 'BOM', travelDate: '2026-11-01' }
    ] }
  ]) {
    const directory = await savedRun(manifest);
    try {
      const report = await verifyRun(directory);
      assert.equal(report.ok, false);
      assert.ok(report.checks.some(check => /Manifest/.test(check.errors.join(' '))));
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
});

test('saved run verifier binds each result to its manifest query and status', async () => {
  const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-11-01' };
  const directory = await savedRun({ id: 'mismatch', status: 'complete', searches: [query] });
  try {
    const resultPath = path.join(directory, '01-DEL-BOM-2026-11-01', 'result.json');
    await fs.writeFile(resultPath, JSON.stringify({
      query: { ...query, destination: 'BLR' }, status: 'failed',
      collectedAt: new Date().toISOString(), fares: [], cause: { code: 'TEST_FAILURE' }
    }));
    const report = await verifyRun(directory);
    assert.equal(report.ok, false);
    assert.match(report.checks[0].errors.join(' '), /query does not match manifest/);
    assert.match(report.checks.at(-1).errors.join(' '), /claims completion/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a non-complete run can never pass even when every search verifies', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'akasa-verified-partial-'));
  try {
    const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-11-01' };
    const searchDir = path.join(directory, '01-DEL-BOM-2026-11-01');
    await fs.mkdir(searchDir);
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    const writeEvidence = async (name, value) => {
      await fs.writeFile(path.join(searchDir, name), value);
      return digest(value);
    };
    const row = '<div><span>DEL</span><span>BOM</span><h2>10:00</h2><h2>12:00</h2>' +
      'QP1234 Starting ₹1,100</div>';
    const page = `<main aria-label="flight card">${row}</main>`;
    const response = { data: {
      currencyCode: 'INR',
      results: [{ trips: [{
        date: query.travelDate,
        journeysAvailableByMarket: [{
          key: 'DEL|BOM',
          value: [{
            journeyKey: 'journey-1',
            designator: { origin: 'DEL', destination: 'BOM',
              departure: '2026-11-01T10:00:00', arrival: '2026-11-01T12:00:00' },
            segments: [{ identifier: { carrierCode: 'QP', identifier: '1234' } }],
            fares: [{ fareAvailabilityKey: 'fare-1' }]
          }]
        }]
      }] }],
      faresAvailable: [{
        key: 'fare-1',
        value: {
          totals: { fareTotal: 1150 },
          fares: [{ passengerFares: [{
            passengerType: 'ADT', multiplier: 1,
            serviceCharges: [
              { type: 'FarePrice', code: null, amount: 1000, currencyCode: 'INR' },
              { type: 'Tax', code: null, amount: 100, currencyCode: 'INR' },
              { type: 'TravelFee', code: 'WFE', amount: 50, currencyCode: 'INR' }
            ]
          }] }]
        }
      }]
    } };
    const responseText = JSON.stringify(response);
    const evidence = {
      resultPage: 'results.html', resultPageSha256: await writeEvidence('results.html', page),
      resultScreenshot: 'results.png',
      resultScreenshotSha256: await writeEvidence('results.png', Buffer.alloc(1000, 1)),
      rowHtml: 'row.html', rowHtmlSha256: await writeEvidence('row.html', row),
      airlineResponse: 'response.json',
      airlineResponseSha256: await writeEvidence('response.json', responseText),
      formPage: 'form.html',
      formPageSha256: await writeEvidence('form.html', '<div>DEL BOM</div>')
    };
    const fare = { ...query, collectedAt: '2026-10-29T00:00:00Z', flight: 'QP1234',
      flights: ['QP1234'], departureTime: '10:00', arrivalTime: '12:00',
      airlineDepartureTime: '10:00', airlineArrivalTime: '12:00', scheduleDifference: null,
      journeyKey: 'journey-1', fareAvailabilityKey: 'fare-1',
      price: { currency: 'INR', base: 1000, includedTaxesAndFees: 100, additionalWfe: 50,
        displayedTotal: 1100, fullTotal: 1150, charges: [
          { type: 'FarePrice', code: null, amount: 1000, currencyCode: 'INR' },
          { type: 'Tax', code: null, amount: 100, currencyCode: 'INR' },
          { type: 'TravelFee', code: 'WFE', amount: 50, currencyCode: 'INR' }
        ] }, rowIndex: 0, evidence };
    await fs.writeFile(path.join(searchDir, 'result.json'), JSON.stringify({
      query, status: 'ok', collectedAt: '2026-10-29T00:00:00Z', expectedJourneys: 1,
      pageRows: 1, nearbyRows: 0, fares: [fare], issues: []
    }));
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = { id: 'verified-but-partial', status: 'complete', searches: [query] };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const completeReport = await verifyRun(directory);
    assert.equal(completeReport.ok, true, JSON.stringify(completeReport));
    manifest.status = 'failed';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const report = await verifyRun(directory);
    assert.equal(report.checks.every(check => check.ok), true);
    assert.equal(report.ok, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
