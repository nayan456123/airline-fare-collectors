import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseAvailability, matchCards, parseCardHtml, hasEmptyResultText } from '../src/parse.mjs';

const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-11-10' };
const payload = JSON.parse(await fs.readFile(new URL('./fixtures/availability.json', import.meta.url)));
const card = { flight: 'SG 671', origin: 'DEL', destination: 'BOM', departureTime: '05:40', arrivalTime: '07:55', prices: [8405, 8825, 9717] };

test('matches observed flight response to its displayed flight card', () => {
  const journeys = parseAvailability(payload, query);
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].amount, 8405);
  assert.equal(matchCards(journeys, [card])[0].flight, 'SG 671');
});

test('a connecting card uses its destination, not the later stopover airport', () => {
  const parsed = parseCardHtml('<div>05:40 DEL 22:40 BLR SG 671, SG 487 Connecting, with halt at BOM ₹ 13,737</div>');
  assert.equal(parsed.destination, 'BLR');
  assert.equal(parsed.flight, 'SG 671 + SG 487');
  assert.deepEqual(parsed.prices, [13737]);
});

test('rejects route mismatch and an inconsistent displayed fare', () => {
  assert.throws(() => parseAvailability(payload, { ...query, destination: 'CCU' }), /query mismatch/);
  assert.throws(() => matchCards(parseAvailability(payload, query), [{ ...card, prices: [1] }]), /missing or ambiguous/);
  assert.throws(() => matchCards(parseAvailability(payload, query), [{ ...card, prices: [8000, 8405] }]), /missing or ambiguous/);
});

test('accepts revised times only when the response times are explicitly crossed out', () => {
  const journeys = parseAvailability(payload, query);
  const html = '<div><div class="r-142tt33">05:40</div><div>06:40</div> DEL <div class="r-142tt33">07:55</div><div>08:55</div> BOM SG 671 Rescheduled ₹ 8,405</div>';
  const [fare] = matchCards(journeys, [parseCardHtml(html)]);
  assert.equal(fare.departureTime, '06:40');
  assert.equal(fare.arrivalTime, '08:55');
  assert.equal(fare.airlineDepartureTime, '05:40');
  assert.equal(fare.airlineArrivalTime, '07:55');
  assert.equal(fare.scheduleDifference, 'PAGE_RESCHEDULED');
  assert.throws(() => matchCards(journeys, [parseCardHtml(html.replaceAll('class="r-142tt33"', ''))]), /missing or ambiguous/);
});

test('recognizes an empty availability response only for the requested query', () => {
  const empty = { data: { searchParams: payload.data.searchParams, trips: [] } };
  assert.deepEqual(parseAvailability(empty, query), []);
  assert.throws(() => parseAvailability(empty, { ...query, travelDate: '2026-11-11' }), /query mismatch/);
  assert.throws(() => parseAvailability({ data: { searchParams: payload.data.searchParams } }, query), /Unknown/);
});

test('recognizes the no-flight notice split across page elements, excluding script text', () => {
  assert.equal(hasEmptyResultText('<div>Unfortunately, there are no flights available.</div><div>Please search again with a different date.</div>'), true);
  assert.equal(hasEmptyResultText('<script>Unfortunately, there are no flights available. Please search again with a different date.</script>'), false);
  assert.equal(hasEmptyResultText('<div>Request failed. Please search again with a different date.</div>'), false);
});
