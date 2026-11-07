import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { extractCardsFromHtml, matchFaresToCards, parseSearchResponse } from '../src/parse.mjs';
import { verifySearch } from '../src/verify.mjs';

const query = { origin: 'DEL', destination: 'BLR', travelDate: '2026-10-27' };
const flightId = 'SEG-AI2409-DELBLR-2026-10-27-0600';
const executablePath = process.env.AIRINDIA_TEST_CHROME_PATH;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// Sanitized single-flight subset from the saved successful airline response.
const response = JSON.stringify({
  status: 'SUCCESS', hasError: false,
  dictionaries: { flight: { [flightId]: {
    departure: { locationCode: 'DEL', dateTime: '2026-10-27T06:00:00.000+05:30' },
    arrival: { locationCode: 'BLR', dateTime: '2026-10-27T08:50:00.000+05:30' },
    marketingAirlineCode: 'AI', marketingFlightNumber: '2409', operatingAirlineCode: 'AI'
  } } },
  responsePayload: [{ airBoundGroups: [{
    boundDetails: { originLocationCode: 'DEL', destinationLocationCode: 'BLR',
      segments: [{ flightId }] },
    airBounds: [
      { fareFamilyCode: 'PWININ', availabilityDetails: [{ flightId, cabin: 'ecoPremium', bookingClass: 'R', statusCode: 'HK', quota: 3 }],
        aiUnitPrice: { value: 34432, currencyCode: 'INR' },
        prices: { totalPrices: [{ currencyCode: 'INR', base: 27355, totalTaxes: 7077, total: 34907 }] } },
      { fareFamilyCode: 'PFININ', availabilityDetails: [{ flightId, cabin: 'ecoPremium', bookingClass: 'R', statusCode: 'HK', quota: 3 }],
        aiUnitPrice: { value: 36202, currencyCode: 'INR' },
        prices: { totalPrices: [{ currencyCode: 'INR', base: 28855, totalTaxes: 7347, total: 36677 }] } },
      { fareFamilyCode: 'CWININ', availabilityDetails: [{ flightId, cabin: 'business', bookingClass: 'D', statusCode: 'HK', quota: 1 }],
        aiUnitPrice: { value: 56386, currencyCode: 'INR' },
        prices: { totalPrices: [{ currencyCode: 'INR', base: 45960, totalTaxes: 10426, total: 56861 }] } },
      { fareFamilyCode: 'CFININ', availabilityDetails: [{ flightId, cabin: 'business', bookingClass: 'D', statusCode: 'HK', quota: 1 }],
        aiUnitPrice: { value: 58156, currencyCode: 'INR' },
        prices: { totalPrices: [{ currencyCode: 'INR', base: 47460, totalTaxes: 10696, total: 58631 }] } }
    ]
  }] }]
});

// The summary price is unavailable at Economy; the selectable Premium Economy
// card shows the cheapest actual cabin offer, matching the API bound.
const page = `<div class="ai-pb-flight-item">
  <span class="ai-pb-flight-id">AI 2409</span>
  <span class="ai-pb-departure-city-code">DEL</span>
  <span class="ai-pb-actual-arrival-city">BLR</span>
  <span class="ai-pb-departure-time">06:00</span>
  <span class="ai-pb-arrival-time">08:50</span>
  <span class="ai-pb-currency-code">INR</span>
  <span class="ai-pb-price">₹ 0</span>
  <button role="button" aria-label="SELECT_CABIN premium economy" aria-disabled="false">
    <span class="ai-pb-actual-price-currency-code">INR</span><span class="ai-pb-actual-price">₹ 34,432</span>
  </button>
  <button role="button" aria-label="SELECT_CABIN business" aria-disabled="false">
    <span class="ai-pb-actual-price-currency-code">INR</span><span class="ai-pb-actual-price">₹ 56,386</span>
  </button>
</div>`;

test('AI 2409 unavailable Economy summary does not override its available Premium Economy fare', () => {
  const fares = parseSearchResponse(response, query);
  const cards = extractCardsFromHtml(page);
  assert.equal(fares.length, 1);
  assert.equal(fares[0].cabin, 'premium economy');
  assert.equal(fares[0].price.displayedTotal, 34432);
  assert.deepEqual(cards.map(({ cabin, displayedTotal }) => ({ cabin, displayedTotal })),
    [{ cabin: 'premium economy', displayedTotal: 34432 }]);
  assert.equal(matchFaresToCards(fares, cards, query), true);

  const unavailableSummaryOnly = extractCardsFromHtml(page.replace(/\s*<button role="button" aria-label="SELECT_CABIN[\s\S]*?<\/button>/g, ''));
  assert.equal(unavailableSummaryOnly[0].displayedTotal, 0);
  assert.throws(() => matchFaresToCards(fares, unavailableSummaryOnly, query),
    error => error.code === 'RESULTS_UNVERIFIED');

  const mislabeledCabin = extractCardsFromHtml(page.replace('SELECT_CABIN premium economy', 'SELECT_CABIN economy'));
  assert.throws(() => matchFaresToCards(fares, mislabeledCabin, query),
    error => error.code === 'RESULTS_UNVERIFIED');

  const tamperedResponse = JSON.parse(response);
  tamperedResponse.responsePayload[0].airBoundGroups[0].airBounds[0]
    .availabilityDetails[0].cabin = 'eco';
  const wrongCabinFare = parseSearchResponse(JSON.stringify(tamperedResponse), query);
  assert.equal(wrongCabinFare[0].cabin, 'economy');
  assert.throws(() => matchFaresToCards(wrongCabinFare, cards, query),
    error => error.code === 'RESULTS_UNVERIFIED');
});

test('version 2 saved AI 2409 evidence verifies its cabin and rejects a tampered cabin', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-ai2409-cabin-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = { airlineResponse: response, resultPage: page, resultScreenshot: 'saved screenshot bytes' };
  const evidence = {};
  for (const [key, contents] of Object.entries(files)) {
    const filename = `${key}.dat`;
    await fs.writeFile(path.join(directory, filename), contents);
    evidence[key] = filename;
    evidence[`${key}Sha256`] = sha256(contents);
  }
  const result = { status: 'ok', fareEvidenceVersion: 2, query,
    fares: parseSearchResponse(response, query), evidence };
  const valid = await verifySearch(directory, result, { allowLegacy: true });
  assert.equal(valid.ok, true, valid.errors.join('; '));

  result.fares[0].cabin = 'economy';
  const tampered = await verifySearch(directory, result, { allowLegacy: true });
  assert.equal(tampered.ok, false);
  assert.ok(tampered.errors.some(error => /Saved fare differs/.test(error)));
});

test('legacy saved AI 2409 fares may omit only cabin while keeping every core field strict', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-ai2409-legacy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = { airlineResponse: response, resultPage: page, resultScreenshot: 'saved screenshot bytes' };
  const evidence = {};
  for (const [key, contents] of Object.entries(files)) {
    const filename = `${key}.dat`;
    await fs.writeFile(path.join(directory, filename), contents);
    evidence[key] = filename;
    evidence[`${key}Sha256`] = sha256(contents);
  }
  const result = { status: 'ok', query, fares: parseSearchResponse(response, query), evidence };
  delete result.fares[0].cabin;
  const legacy = await verifySearch(directory, result, { allowLegacy: true });
  assert.equal(legacy.ok, true, legacy.errors.join('; '));

  result.fares[0].price.displayedTotal = 34433;
  const tamperedCore = await verifySearch(directory, result, { allowLegacy: true });
  assert.equal(tamperedCore.ok, false);
  assert.ok(tamperedCore.errors.some(error => /Saved fare differs/.test(error)));
});

test('dashboard shows the verified cabin beside the flight number', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium UI test'
}, async () => {
  const webRoot = new URL('../web/', import.meta.url);
  const [html, appJs, retryEligibilityJs] = await Promise.all([
    fs.readFile(new URL('index.html', webRoot), 'utf8'),
    fs.readFile(new URL('app.js', webRoot), 'utf8'),
    fs.readFile(new URL('retry-eligibility.js', webRoot), 'utf8')
  ]);
  const run = { id: 'saved-ai2409', status: 'complete', startedAt: '2026-10-26T17:00:00.000Z',
    stopReason: null, retryOf: null, routes: ['DEL-BLR'], browserMode: 'headless', tasks: [{
      id: '001', origin: 'DEL', destination: 'BLR', offset: 1, travelDate: query.travelDate,
      status: 'ok', stage: 'complete', worker: 1, events: [], fares: [{
        flight: 'AI 2409', cabin: 'premium economy', departureTime: '06:00', arrivalTime: '08:50',
        stops: 0, price: { currency: 'INR', displayedTotal: 34432, base: 27355,
          taxesAndFees: 7077, additionalUnitemizedAmount: 475, fullTotal: 34907 },
        screenshot: 'result.png', response: 'response.json'
      }], evidenceVerified: true, expectedJourneys: 1, observedFareCount: 1,
      coverage: { captured: 1, expectedJourneys: 1 }, failureEvidence: null
    }] };
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'airindia.test') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: appJs });
      if (url.pathname === '/retry-eligibility.js') return route.fulfill({ contentType: 'text/javascript', body: retryEligibilityJs });
      if (url.pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: '' });
      if (url.pathname === '/api/config') return route.fulfill({ json: { audioHelperAvailable: true } });
      if (url.pathname === '/api/runs') return route.fulfill({ json: { runs: [run] } });
      if (url.pathname === '/api/runs/latest') return route.fulfill({ json: { run } });
      return route.fulfill({ status: 404, json: { error: 'Not found' } });
    });
    await page.goto('http://airindia.test/');
    const cabin = page.locator('#task-list .flight-name small');
    await cabin.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await cabin.innerText(), 'premium economy');
    assert.match(await page.locator('#task-list').innerText(), /AI 2409[\s\S]*premium economy/);
  } finally { await browser.close(); }
});
