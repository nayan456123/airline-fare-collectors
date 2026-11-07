import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseAvailability, matchCards } from '../src/parse.mjs';
import { verifyRun } from '../src/verify.mjs';

test('saved result verifier accepts matching evidence and rejects altered evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spice-verify-'));
  try {
    const response = await fs.readFile(new URL('./fixtures/availability.json', import.meta.url));
    const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-11-10' };
    const card = { html: '<div><div>05:40</div> DEL <div>07:55</div> BOM SG 671 ₹ 8,405</div>', flight: 'SG 671', origin: 'DEL', destination: 'BOM', departureTime: '05:40', arrivalTime: '07:55', prices: [8405] };
    const files = { 'availability.json': response, 'results.html': Buffer.from(`<html>${card.html}</html>`), 'cards.json': Buffer.from(JSON.stringify([card])), 'results.png': Buffer.from('test screenshot') };
    const evidence = {};
    for (const [name, content] of Object.entries(files)) { await fs.writeFile(path.join(dir, name), content); evidence[name] = crypto.createHash('sha256').update(content).digest('hex'); }
    const fares = matchCards(parseAvailability(JSON.parse(response), query), [card]);
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ status: 'ok', evidenceVerified: true, query, fares, evidence }));
    assert.equal((await verifyRun(dir)).ok, true);
    await fs.appendFile(path.join(dir, 'results.html'), 'changed');
    const report = await verifyRun(dir);
    assert.equal(report.ok, false);
    assert.match(report.errors[0], /hash mismatch/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
