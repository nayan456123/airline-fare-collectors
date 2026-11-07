import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchResponse, selectMatchingResponse } from '../src/parse.mjs';

const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-03' };

function response({ secondDeparture = 'HYD', secondDate = '2026-10-03T13:00:00+05:30',
  secondArrivalDate = '2026-10-03T15:00:00+05:30', displayedTotal = 10000,
  total = displayedTotal, totalTaxes = 2000, taxCurrency = 'INR',
  firstFlight = true } = {}) {
  const flights = {
    first: { departure: { locationCode: 'DEL', dateTime: '2026-10-03T09:00:00+05:30' },
      arrival: { locationCode: 'HYD', dateTime: '2026-10-03T11:00:00+05:30' },
      marketingAirlineCode: 'AI', marketingFlightNumber: '101', operatingAirlineCode: 'AI' },
    second: { departure: { locationCode: secondDeparture, dateTime: secondDate },
      arrival: { locationCode: 'BOM', dateTime: secondArrivalDate },
      marketingAirlineCode: 'AI', marketingFlightNumber: '202', operatingAirlineCode: 'AI' }
  };
  const segments = firstFlight ? [{ flightId: 'first' }, { flightId: 'second' }] : [{ flightId: 'second' }];
  return JSON.stringify({
    status: 'SUCCESS', hasError: false,
    dictionaries: { flight: flights },
    responsePayload: [{ airBoundGroups: [{
      boundDetails: { originLocationCode: 'DEL', destinationLocationCode: 'BOM',
        segments },
      airBounds: [{ fareFamilyCode: 'ECO', aiUnitPrice: { value: displayedTotal, currencyCode: 'INR' },
        prices: { totalPrices: [{ currencyCode: 'INR', base: displayedTotal - totalTaxes,
          totalTaxes, total,
          taxes: [{ code: 'YQ', value: totalTaxes, currencyCode: taxCurrency }] }] } }]
    }] }]
  });
}

function pageCard(overrides = {}) {
  return { flight: 'AI 101 + AI 202', origin: 'DEL', destination: 'BOM',
    departureTime: '09:00', arrivalTime: '15:00', currency: 'INR', displayedTotal: 10000,
    ...overrides };
}

test('parses a valid connected itinerary and reconciles its fare', () => {
  const fares = parseSearchResponse(response(), query);
  assert.equal(fares.length, 1);
  assert.equal(fares[0].flight, 'AI 101 + AI 202');
  assert.equal(fares[0].stops, 1);
  assert.equal(fares[0].price.displayedTotal, 10000);
});

test('accepts direct and overnight connections across explicit time offsets', () => {
  const direct = parseSearchResponse(response({ firstFlight: false,
    secondDeparture: 'DEL', secondDate: '2026-10-03T09:00:00+05:30',
    secondArrivalDate: '2026-10-03T11:00:00+05:30' }), query);
  assert.equal(direct[0].flight, 'AI 202');
  const overnight = parseSearchResponse(response({
    secondDate: '2026-10-04T00:30:00+05:30',
    secondArrivalDate: '2026-10-04T03:00:00+05:30'
  }), query);
  assert.equal(overnight[0].arrivalDateTime, '2026-10-04T03:00:00+05:30');
});

test('rejects a connection whose next segment departs from another airport', () => {
  assert.throws(() => parseSearchResponse(response({ secondDeparture: 'MAA' }), query),
    error => error.code === 'AIRLINE_SCHEMA_UNVERIFIED');
});

test('rejects a connection that starts before the previous segment arrives', () => {
  assert.throws(() => parseSearchResponse(response({
    secondDate: '2026-10-03T10:30:00+05:30'
  }), query), error => error.code === 'AIRLINE_SCHEMA_UNVERIFIED');
});

test('falls back from newer stale, mismatched, empty, and invalid replies to a matching response', () => {
  const selected = selectMatchingResponse([
    { body: response() },
    { body: response({ displayedTotal: 11000 }) },
    { body: response({ secondDeparture: 'MAA' }) },
    { body: JSON.stringify({ status: 'SUCCESS', hasError: false, dictionaries: { flight: {} },
      responsePayload: [{ airBoundGroups: [] }] }) },
    { body: JSON.stringify({ status: 'ERROR', hasError: true, responsePayload: [{ airBoundGroups: [] }] }) },
    { body: response().replace('"status":"SUCCESS","hasError":false',
      '"status":"ERROR","hasError":true') }
  ], [pageCard()], query);
  assert.equal(selected.index, 0);
});

test('fails when every offer response is stale or mismatched', () => {
  assert.throws(() => selectMatchingResponse([
    { body: response({ secondDeparture: 'MAA' }) },
    { body: response({ secondDate: '2026-10-03T10:30:00+05:30' }) }
  ], [pageCard()], query), error => ['AIRLINE_SCHEMA_UNVERIFIED', 'RESULTS_UNVERIFIED'].includes(error.code));
});

test('rejects malformed totals, taxes, and missing flight dictionary entries', () => {
  for (const candidate of [
    response({ total: 9000 }),
    response({ taxCurrency: 'USD' }),
    response().replace('"flightId":"first"', '"flightId":"missing"')
  ]) {
    assert.throws(() => parseSearchResponse(candidate, query),
      error => error.code === 'AIRLINE_SCHEMA_UNVERIFIED');
  }
});
