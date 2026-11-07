import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSearchResponse, extractCardsFromHtml, matchFaresToCards } from '../src/parse.mjs';
import { verifySearch } from '../src/verify.mjs';

const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-11-10' };
const journey = (key, number) => ({ journeyKey: key, stops: 0,
  designator: { origin: 'DEL', destination: 'BOM', departure: '2026-11-10T10:00:00', arrival: '2026-11-10T12:00:00' },
  segments: [{ identifier: { carrierCode: 'IX', identifier: number } }], fares: [{ fareAvailabilityKey: 'fare' }] });
const response = { passengers: { totalCount: 1, types: [{ type: 'ADT', count: 1 }] }, data: {
  currencyCode: 'INR', includeTaxesAndFees: true,
  results: [{ trips: [{ date: '2026-11-10', journeysAvailableByMarket: { 'DEL|BOM': [journey('one', '101'), journey('two', '102')] } }] }],
  faresAvailable: { fare: { totals: { fareTotal: 110 }, fares: [{ productClass: 'LT', passengerFares: [{ passengerType: 'ADT', multiplier: 1, fareAmount: 110, serviceCharges: [{ type: 0, amount: 100, currencyCode: 'INR' }, { type: 4, amount: 10, currencyCode: 'INR' }] }] }] } } } };
const row = (key, flight) => `<div class="flight-details-wrapper" id="${key}"><span class="source-dest-det">DEL</span><span class="source-arr-det">BOM</span><span class="flight-det-number">${flight}</span><span class="inner-flight-time">10:00</span><span class="inner-flight-time">12:00</span><span class="current-fare">₹110</span></div>`;

test('verification rejects duplicate saved journeys that replace another response journey', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aix-verify-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const evidence = {};
  const save = async (key, file, content) => {
    await fs.writeFile(path.join(dir, file), content);
    evidence[key] = { file, sha256: crypto.createHash('sha256').update(content).digest('hex') };
  };
  await save('formPage', 'form.html', 'form');
  await save('airlineResponse', 'response.json', JSON.stringify(response));
  await save('resultPage', 'page.html', row('one', 'IX101') + row('two', 'IX102'));
  await save('resultScreenshot', 'screenshot.png', 'image');
  await save('responseMetadata', 'metadata.json', JSON.stringify({ host: 'api.airindiaexpress.com', path: '/b2c-flightsearch/v4/fsa', method: 'POST', status: 200, contentType: 'application/json', bodySha256: evidence.airlineResponse.sha256, bodyFile: 'response.json', at: '2026-10-27T10:00:01Z' }));
  await save('row1', 'row1.html', row('one', 'IX101'));
  await save('row2', 'row2.html', row('two', 'IX102'));
  const collectedAt = '2026-10-27T10:00:02Z';
  const fares = parseSearchResponse(response, query, { cards: extractCardsFromHtml(row('one', 'IX101') + row('two', 'IX102')) }).fares.map((fare, i) => ({ ...fare, collectedAt, evidence: { rowHtml: `row${i + 1}.html` } }));
  const result = { status: 'ok', query, collectedAt, submittedAt: '2026-10-27T10:00:00Z', evidence, fares };
  const verify = async () => { await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result)); return verifySearch(dir); };
  assert.equal((await verify()).ok, true);
  result.fares[0].evidence.rowHtml = 'row2.html';
  result.evidence.row1 = result.evidence.row2;
  assert.match((await verify()).errors.join(' '), /Row evidence does not match the saved journey/);
  result.evidence.row1 = { file: 'row1.html', sha256: crypto.createHash('sha256').update(row('one', 'IX101')).digest('hex') };
  result.fares[0].evidence.rowHtml = 'row1.html';
  result.fares[1] = { ...result.fares[0], evidence: { rowHtml: 'row2.html' } };
  assert.match((await verify()).errors.join(' '), /duplicate journey identities/);
});

test('duplicate response identities cannot cover distinct page rows', () => {
  const fares = parseSearchResponse(response, query, { cards: extractCardsFromHtml(row('one', 'IX101') + row('two', 'IX102')) }).fares;
  const cards = fares.map(f => ({ journeyKey: f.journeyKey, origin: 'DEL', destination: 'BOM', flights: f.flights, times: ['10:00', '12:00'], displayedTotal: 110 }));
  assert.throws(() => matchFaresToCards([fares[0], fares[0]], cards, query), /duplicate journey identities/);
});

test('the rendered fare selects its unique matching response option', () => {
  const data = structuredClone(response);
  const cheap = structuredClone(data.data.faresAvailable.fare);
  cheap.totals.fareTotal = 100;
  cheap.fares[0].productClass = 'SM';
  cheap.fares[0].passengerFares[0].fareAmount = 100;
  cheap.fares[0].passengerFares[0].serviceCharges[0].amount = 90;
  data.data.faresAvailable.cheap = cheap;
  const journeys = data.data.results[0].trips[0].journeysAvailableByMarket['DEL|BOM'];
  for (const item of journeys) item.fares.unshift({ fareAvailabilityKey: 'cheap' });
  const rendered = extractCardsFromHtml(row('one', 'IX101') + row('two', 'IX102'));
  const fares = parseSearchResponse(data, query, { cards: rendered }).fares;
  assert.equal(fares[0].brand, 'LT');
  assert.equal(fares[0].price.displayedTotal, 110);
  const cards = fares.map(f => ({ journeyKey: f.journeyKey, origin: 'DEL', destination: 'BOM', flights: f.flights, times: ['10:00', '12:00'], displayedTotal: 110 }));
  assert.equal(matchFaresToCards(fares, cards, query).complete, true);
  cards[0].displayedTotal = 100;
  assert.throws(() => matchFaresToCards(fares, cards, query), /price differs/);
  rendered[0].displayedTotal = 100;
  assert.equal(parseSearchResponse(data, query, { cards: rendered }).fares[0].brand, 'SM');
  rendered[0].displayedTotal = 105;
  assert.throws(() => parseSearchResponse(data, query, { cards: rendered }), /does not uniquely match/);
  rendered[0].displayedTotal = 110;
  data.data.faresAvailable.cheap.totals.fareTotal = 110;
  data.data.faresAvailable.cheap.fares[0].passengerFares[0].fareAmount = 110;
  data.data.faresAvailable.cheap.fares[0].passengerFares[0].serviceCharges[0].amount = 100;
  assert.throws(() => parseSearchResponse(data, query, { cards: rendered }), /does not uniquely match/);
});

test('response selection skips stale matching-price results with different flight details', async () => {
  const { selectVerifiedFareResponse } = await import('../src/collect.mjs');
  const cards = extractCardsFromHtml(row('one', 'IX101') + row('two', 'IX102'));
  const metadata = { host: 'api.airindiaexpress.com', path: '/b2c-flightsearch/v4/fsa', method: 'POST', status: 200, contentType: 'application/json', sourceRole: 'aix-site' };
  const stale = structuredClone(response);
  stale.data.results[0].trips[0].journeysAvailableByMarket['DEL|BOM'][0].designator.departure = '2026-11-10T09:00:00';
  const matching = { body: response, metadata };
  const bad = { body: stale, metadata };
  assert.equal(selectVerifiedFareResponse([matching, bad], query, cards).response, matching);
  assert.throws(() => selectVerifiedFareResponse([bad], query, cards), /time or price differs/);
});

test('a valid empty response can be checked without rendered cards', () => {
  const empty = structuredClone(response);
  empty.data.results[0].trips[0].journeysAvailableByMarket['DEL|BOM'] = [];
  assert.equal(parseSearchResponse(empty, query).fares.length, 0);
  assert.throws(() => parseSearchResponse(response, query), /no unique exact-route rendered row/);
});
