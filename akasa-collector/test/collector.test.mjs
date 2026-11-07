import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, matchesDateInput, marketsResponseFailure, waitForMarketsResponse,
  classify } from '../src/collect.mjs';
import { matchPageCards, parseSearchResponse, rowTimes } from '../src/parse.mjs';

test('invalid route, date, and proxy input are rejected before a browser starts', () => {
  assert.throws(() => parseArgs(['--search', 'DEL:DEL:2026-10-02']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-02-30']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--proxy', 'http://user:pass@proxy:8080']));
});

test('Akasa weekday prefix and September abbreviation validate against the exact date', () => {
  assert.equal(matchesDateInput('Mon, 28 Sep 2026', '2026-09-28'), true);
  assert.equal(matchesDateInput('Mon, 28 Sept 2026', '2026-09-28'), true);
  assert.equal(matchesDateInput('Wed, 11 Nov 2026', '2026-11-11'), true);
  assert.equal(matchesDateInput('Mon, 29 Sep 2026', '2026-09-28'), false);
  assert.equal(matchesDateInput('Mon, 28 Oct 2026', '2026-09-28'), false);
});

test('markets bootstrap accepts a denial response immediately instead of waiting for HTTP 200', async () => {
  const response = { url: () => 'https://prod-bl.qp.akasaair.com/api/nsk/v2/resources/markets',
    status: () => 401 };
  const page = { async waitForResponse(predicate, options) {
    assert.equal(options.timeout, 30000);
    assert.equal(predicate(response), true);
    return response;
  } };
  assert.equal(await waitForMarketsResponse(page), response);
});

test('markets bootstrap preserves denial codes and reports endpoint/status without guessing cause', () => {
  const endpoint = '/api/nsk/v2/resources/markets';
  const failure = status => marketsResponseFailure({ status: () => status });
  assert.deepEqual(failure(401), { code: 'SESSION_EXPIRED',
    detail: `Akasa returned HTTP 401 from ${endpoint}` });
  assert.deepEqual(failure(403), { code: 'ACCESS_DENIED',
    detail: `Akasa returned HTTP 403 from ${endpoint}` });
  assert.deepEqual(failure(429), { code: 'RATE_LIMITED',
    detail: `Akasa returned HTTP 429 from ${endpoint}` });
  assert.deepEqual(failure(503), { code: 'MARKETS_UNAVAILABLE',
    detail: `Akasa returned HTTP 503 from ${endpoint}` });
  assert.equal(failure(200), null);
});

test('booking API denial classification retains endpoint/status before the generic error detail', () => {
  const error = Object.assign(new Error('Airport suggestions unavailable'),
    { code: 'AIRPORT_PICKER_UNAVAILABLE' });
  const network = [{ host: 'prod-bl.qp.akasaair.com', path: '/api/nsk/v2/resources/markets',
    status: 401 }];
  assert.deepEqual(classify(error, network), { code: 'SESSION_EXPIRED',
    detail: 'Akasa returned HTTP 401 from /api/nsk/v2/resources/markets' });
  assert.deepEqual(classify(error, [...network, { ...network[0],
    path: '/api/ibe/resources/master-data', status: 403 }]), { code: 'ACCESS_DENIED',
    detail: 'Akasa returned HTTP 403 from /api/ibe/resources/master-data' });
});

test('nearby airport rows cannot be mistaken for exact-route fares', () => {
  const query = { origin: 'DEL', destination: 'BLR', travelDate: '2026-10-07' };
  const journey = { journeyKey: 'exact', routeMatches: true, flights: ['QP1574'],
    departureTime: '14:10', arrivalTime: '17:05', stops: 0,
    best: { key: 'priced', price: { displayedTotal: 8829 } } };
  const card = (index, from, flight, price) => ({ index,
    html: `<span>${from}</span><span>BLR</span>`,
    text: `${flight} 14:10 ${from} 17:05 BLR Starting ₹${price.toLocaleString('en-IN')}`,
    times: ['14:10', '17:05'] });
  const result = matchPageCards([journey], [card(0, 'DXN', 'QP1526', 8164),
    card(1, 'DEL', 'QP1574', 8829)], query, '2026-09-27T09:00:00Z');
  assert.equal(result.complete, true);
  assert.equal(result.nearbyRows, 1);
  assert.equal(result.fares[0].flight, 'QP1574');
});

test('a revised displayed arrival is kept distinct from the crossed-out airline time', () => {
  const query = { origin: 'BOM', destination: 'BLR', travelDate: '2026-09-28' };
  const journey = { journeyKey: 'revised', routeMatches: true, flights: ['QP1527'],
    departureTime: '07:35', arrivalTime: '09:35', stops: 0,
    best: { key: 'fare', price: { displayedTotal: 6914 } } };
  const html = '<span>BOM</span><span>BLR</span><h2>07:35</h2>' +
    '<h2>09:19</h2><h2 class="line-through">09:35</h2>Starting ₹6,914';
  const card = { index: 0, html, text: 'QP1527 07:35 BOM 09:19 09:35 BLR Starting ₹6,914',
    times: ['07:35', '09:19', '09:35'] };
  assert.deepEqual(rowTimes(html), { current: ['07:35', '09:19'],
    previousByField: [[], ['09:35']] });
  const result = matchPageCards([journey], [card], query, '2026-09-27T18:23:55Z');
  assert.equal(result.complete, true);
  assert.equal(result.fares[0].arrivalTime, '09:19');
  assert.equal(result.fares[0].airlineArrivalTime, '09:35');
  assert.equal(result.fares[0].scheduleDifference, 'PAGE_TIME_DIFFERS_FROM_AIRLINE_RESPONSE');
  assert.equal(matchPageCards([journey], [{ ...card, html: html.replace('line-through', 'normal') }],
    query, '2026-09-27T18:23:55Z').complete, false);
});

test('connecting journey price includes every segment and reconciles to the airline total', () => {
  const query = { origin: 'BOM', destination: 'HYD', travelDate: '2026-10-02' };
  const passenger = charges => ({ passengerType: 'ADT', multiplier: 1,
    serviceCharges: charges.map(([type, code, amount]) =>
      ({ type, code, amount, currencyCode: 'INR' })) });
  const response = { data: { currencyCode: 'INR', results: [{ trips: [{ date: '2026-10-02',
    journeysAvailableByMarket: [{ key: 'BOM|HYD', value: [{ journeyKey: 'connection',
      designator: { origin: 'BOM', destination: 'HYD', departure: '2026-10-02T10:00:00',
        arrival: '2026-10-02T15:00:00' },
      segments: [{ identifier: { carrierCode: 'QP', identifier: '1111' } },
        { identifier: { carrierCode: 'QP', identifier: '2222' } }],
      fares: [{ fareAvailabilityKey: 'fare' }] }] }] }] }],
    faresAvailable: [{ key: 'fare', value: { totals: { fareTotal: 3150 }, fares: [
      { passengerFares: [passenger([['FarePrice', null, 1000], ['TravelFee', 'WFE', 50],
        ['Tax', null, 100]])] },
      { passengerFares: [passenger([['FarePrice', null, 2000]])] }
    ] } }] } };
  const [journey] = parseSearchResponse(response, query);
  assert.deepEqual(journey.best.price && {
    base: journey.best.price.base, included: journey.best.price.includedTaxesAndFees,
    additional: journey.best.price.additionalWfe,
    displayed: journey.best.price.displayedTotal, full: journey.best.price.fullTotal
  }, { base: 3000, included: 100, additional: 50, displayed: 3100, full: 3150 });
  response.data.faresAvailable[0].value.totals.fareTotal = 3151;
  assert.equal(parseSearchResponse(response, query)[0].best, null);
});
