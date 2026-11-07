import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifySearch } from '../src/verify.mjs';

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

async function blockedSearch(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-blocked-evidence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = { failurePage: '<html>Access Denied</html>',
    failureScreenshot: Buffer.from('failure screenshot bytes') };
  const evidence = {};
  for (const [key, contents] of Object.entries(files)) {
    const filename = `${key}${key === 'failurePage' ? '.html' : '.png'}`;
    await fs.writeFile(path.join(directory, filename), contents);
    evidence[key] = filename;
    evidence[`${key}Sha256`] = sha256(contents);
  }
  const result = { status: 'blocked', query: { origin: 'DEL', destination: 'BOM',
    travelDate: '2026-10-03' }, cause: { code: 'ACCESS_DENIED' }, fares: [], evidence };
  return { directory, result };
}

test('blocked search keeps valid failure evidence intact without becoming a fare result', async t => {
  const { directory, result } = await blockedSearch(t);
  const report = await verifySearch(directory, result);
  assert.equal(report.ok, false);
  assert.equal(report.evidenceIntegrityOk, true);
  assert.ok(report.errors.some(error => /Search status is blocked: ACCESS_DENIED/.test(error)));
  assert.deepEqual(result.fares, []);
});

test('blocked search reports named integrity errors for tampered or missing failure evidence', async t => {
  const { directory, result } = await blockedSearch(t);
  await fs.appendFile(path.join(directory, result.evidence.failurePage), '<!-- altered -->');
  await fs.rm(path.join(directory, result.evidence.failureScreenshot));
  const report = await verifySearch(directory, result);
  assert.equal(report.ok, false);
  assert.equal(report.evidenceIntegrityOk, false);
  assert.ok(report.errors.some(error => /failurePage hash differs from the saved file/.test(error)));
  assert.ok(report.errors.some(error => /failureScreenshot file is missing/.test(error)));
  assert.deepEqual(result.fares, []);
});
