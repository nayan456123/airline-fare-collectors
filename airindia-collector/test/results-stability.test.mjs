import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForMatchingResults, classifyFailure, isFareResponsePath,
  shouldRetrySearch, summarizePostSubmitNetwork } from '../src/collect.mjs';

const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-03' };
const body = JSON.stringify({ status: 'SUCCESS', hasError: false,
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
        total: 6581 }] } }]
  }] }]
});

function resultPage(price = '6,581') {
  return `<div class="ai-pb-flight-card-wrapper"><div class="ai-pb-flight-item">
    <span class="ai-pb-flight-id">AI 123</span>
    <span class="ai-pb-departure-city-code">DEL</span>
    <span class="ai-pb-actual-arrival-city">BOM</span>
    <span class="ai-pb-departure-time">09:00</span>
    <span class="ai-pb-arrival-time">11:00</span>
    <span class="ai-pb-currency-code">INR</span>
    <span class="ai-pb-price">₹ ${price}</span>
  </div></div>`;
}

const twentyOffers = Array.from({ length: 20 }, (_, index) => {
  const flightId = `flight${index + 1}`;
  const flightNumber = String(100 + index);
  const fare = 6581 + index;
  return {
    flightId,
    flightNumber,
    fare,
    segment: {
      departure: { locationCode: 'DEL', dateTime: '2026-10-03T09:00:00+05:30' },
      arrival: { locationCode: 'BOM', dateTime: '2026-10-03T11:00:00+05:30' },
      marketingAirlineCode: 'AI', marketingFlightNumber: flightNumber, operatingAirlineCode: 'AI'
    }
  };
});
const twentyResponseBody = JSON.stringify({ status: 'SUCCESS', hasError: false,
  dictionaries: { flight: Object.fromEntries(twentyOffers.map(offer => [offer.flightId, offer.segment])) },
  responsePayload: [{ airBoundGroups: twentyOffers.map(offer => ({
    boundDetails: { originLocationCode: 'DEL', destinationLocationCode: 'BOM',
      segments: [{ flightId: offer.flightId }] },
    airBounds: [{ aiUnitPrice: { value: offer.fare, currencyCode: 'INR' },
      prices: { totalPrices: [{ currencyCode: 'INR', base: 5000, totalTaxes: offer.fare - 5000,
        total: offer.fare }] } }]
  })) }]
});
function twentyCardPage() {
  return twentyOffers.map(offer => `<div class="ai-pb-flight-card-wrapper"><div class="ai-pb-flight-item">
    <span class="ai-pb-flight-id">AI ${offer.flightNumber}</span>
    <span class="ai-pb-departure-city-code">DEL</span>
    <span class="ai-pb-actual-arrival-city">BOM</span>
    <span class="ai-pb-departure-time">09:00</span>
    <span class="ai-pb-arrival-time">11:00</span>
    <span class="ai-pb-currency-code">INR</span>
    <span class="ai-pb-price">₹ ${offer.fare.toLocaleString('en-IN')}</span>
  </div></div>`).join('');
}

function mockPage({ pages, text = '', onWait = null }) {
  let pageIndex = 0;
  let waits = 0;
  return {
    get waits() { return waits; },
    evaluate: async () => ({ ready: true, text,
      visibleChallenge: /verify you are human|please check the box below|security challenge/i.test(text) }),
    locator(selector) {
      return {
        innerText: async () => selector === 'body' ? text : '',
        count: async () => selector === '.ai-pb-flight-card-wrapper' &&
          pages[Math.min(pageIndex, pages.length - 1)].includes('ai-pb-flight-card-wrapper') ? 1 : 0
      };
    },
    content: async () => pages[Math.min(pageIndex, pages.length - 1)],
    waitForTimeout: async milliseconds => {
      waits++; pageIndex++; await onWait?.(milliseconds, pageIndex);
    }
  };
}

test('waits through partial cards, then requires a stable complete match', async () => {
  const page = mockPage({ pages: [resultPage(''), resultPage(), resultPage()] });
  const responses = [{ body }];
  const stable = await waitForMatchingResults(page, responses, query, [],
    { timeoutMs: 40, pollingMs: 1 });
  assert.equal(stable, true);
  assert.ok(page.waits >= 2);
});

test('accepts an exact 20-card/API match that arrives after 20 seconds and still needs two snapshots', async () => {
  let elapsed = 0;
  const responses = [];
  const loading = '<body>Loading results</body>';
  const page = mockPage({ pages: [
    ...Array.from({ length: 21 }, () => loading), twentyCardPage(), twentyCardPage()
  ], onWait(milliseconds) {
    elapsed += milliseconds;
    if (elapsed > 20000 && responses.length === 0) responses.push({ body: twentyResponseBody });
  } });
  const stable = await waitForMatchingResults(page, responses, query, [], {
    pollingMs: 1000, now: () => elapsed
  });
  assert.equal(stable, true);
  assert.ok(elapsed > 20000, `match arrived after ${elapsed}ms`);
  assert.ok(page.waits >= 22, 'the exact match must be observed twice after it arrives');
});

test('diagnoses no flight cards at the full results deadline', async () => {
  let elapsed = 0;
  const diagnostics = {};
  const page = mockPage({ pages: ['<body>Booking shell remains visible</body>'],
    onWait(milliseconds) { elapsed += milliseconds; } });
  const stable = await waitForMatchingResults(page, [], query, [], {
    pollingMs: 1000, diagnostics, now: () => elapsed
  });
  assert.equal(stable, false);
  assert.deepEqual(diagnostics, {
    reason: 'no_cards', timeoutMs: 45000, elapsedMs: 45000, pageReady: true,
    cardCount: 0, sawCards: false, responseCandidates: 0, matchSnapshots: 0
  });
});

test('distinguishes a fare mismatch from one late exact snapshot at timeout', async () => {
  let elapsed = 0;
  const responses = [{ body }];
  const mismatchDiagnostics = {};
  const mismatchPage = mockPage({ pages: [resultPage('6,582')],
    onWait(milliseconds) { elapsed += milliseconds; } });
  assert.equal(await waitForMatchingResults(mismatchPage, responses, query, [], {
    timeoutMs: 3000, pollingMs: 1000, diagnostics: mismatchDiagnostics, now: () => elapsed
  }), false);
  assert.equal(mismatchDiagnostics.reason, 'fare_response_page_mismatch');
  assert.equal(mismatchDiagnostics.cardCount, 1);
  assert.match(mismatchDiagnostics.comparisonError, /RESULTS_UNVERIFIED/);

  elapsed = 0;
  const lateResponses = [];
  const lateDiagnostics = {};
  const latePage = mockPage({ pages: [
    ...Array.from({ length: 44 }, () => '<body>Loading results</body>'), resultPage()
  ], onWait(milliseconds) {
    elapsed += milliseconds;
    if (elapsed >= 44000 && lateResponses.length === 0) lateResponses.push({ body });
  } });
  assert.equal(await waitForMatchingResults(latePage, lateResponses, query, [], {
    timeoutMs: 45000, pollingMs: 1000, diagnostics: lateDiagnostics, now: () => elapsed
  }), false);
  assert.equal(lateDiagnostics.reason, 'single_matching_snapshot');
  assert.equal(lateDiagnostics.matchSnapshots, 1);
  assert.equal(lateDiagnostics.responseCandidates, 1);
});

test('results timeout failures get one bounded retry while denials stay terminal', () => {
  assert.equal(shouldRetrySearch('RESULTS_NOT_RENDERED', 1, 1), true);
  assert.equal(shouldRetrySearch('RESULTS_UNVERIFIED', 1, 1), true);
  assert.equal(shouldRetrySearch('RESULTS_UNVERIFIED', 2, 1), false);
  assert.equal(shouldRetrySearch('RESULTS_NOT_RENDERED', 1, 0), false);
  assert.equal(shouldRetrySearch('CAPTCHA', 1, 1), false);
});

test('post-submit network diagnostics retain sanitized request status without query or payload', () => {
  const summary = summarizePostSubmitNetwork([
    { postSubmit: false, host: 'www.airindia.com', path: '/old', method: 'GET', status: 200 },
    { postSubmit: true, protocol: 'https:', host: 'api.airindia.com', path: '/api/availability',
      method: 'POST', status: 200, failed: null,
      url: 'https://api.airindia.com/api/availability?token=secret', body: 'private payload' }
  ]);
  assert.deepEqual(summary, [{ protocol: 'https:', host: 'api.airindia.com', path: '/api/availability',
    method: 'POST', status: 200, failed: null }]);
  assert.equal(JSON.stringify(summary).includes('secret'), false);
  assert.equal(JSON.stringify(summary).includes('private payload'), false);
});

test('uses an older matching response despite newer stale and malformed candidates', async () => {
  const stale = body.replace('"value":6581', '"value":7000')
    .replace('"base":5000', '"base":5419').replace('"total":6581', '"total":7000');
  const page = mockPage({ pages: [resultPage(), resultPage(), resultPage()] });
  assert.equal(await waitForMatchingResults(page, [
    { body }, { body: stale }, { body: '{invalid json' }
  ], query, [], { timeoutMs: 40, pollingMs: 1 }), true);
});

test('stops immediately when access challenge appears', async () => {
  const page = mockPage({ pages: [resultPage()], text: 'Please check the box below' });
  await assert.rejects(waitForMatchingResults(page, [], query, [],
    { timeoutMs: 100, pollingMs: 1 }), error => error.code === 'CAPTCHA');
  assert.equal(page.waits, 0);
});

test('returns false within a zero-length deadline when no response is available', async () => {
  const page = mockPage({ pages: [resultPage()] });
  assert.equal(await waitForMatchingResults(page, [], query, [],
    { timeoutMs: 0, pollingMs: 1 }), false);
  assert.equal(page.waits, 0);
});

test('rebinds readiness polling after the old active page closes during its wait', async () => {
  let active = mockPage({ pages: ['<body>old</body>'] });
  let oldWaits = 0;
  active.waitForTimeout = async () => {
    oldWaits++;
    active = mockPage({ pages: [resultPage(), resultPage()] });
    throw new Error('Target page, context or browser has been closed');
  };
  const matched = await waitForMatchingResults(() => active, [{ body }], query, [],
    { timeoutMs: 100, pollingMs: 1 });
  assert.equal(matched, true);
  assert.equal(oldWaits, 1);
});

test('classifies Air India homepage and fare API 401, 403, and 429 responses', () => {
  for (const [status, expected] of [[401, 'SESSION_EXPIRED'], [403, 'ACCESS_DENIED'], [429, 'RATE_LIMITED']]) {
    const homepage = classifyFailure(new Error('search failed'), [
      { path: '/in/en/book/search-flights.html', method: 'GET', status, navigationResponse: true }
    ]);
    const api = classifyFailure(new Error('search failed'), [
      { path: '/api/availability', method: 'POST', status, fareResponse: true }
    ]);
    assert.equal(homepage.code, expected);
    assert.equal(api.code, expected);
  }
});

test('ignores static asset 403 responses when classifying a search failure', () => {
  const cause = classifyFailure(new Error('search failed'), [
    { path: '/assets/logo.svg', method: 'GET', status: 403, fareResponse: false }
  ]);
  assert.equal(cause.code, 'SEARCH_FAILED');
});

test('observed air-bounds denial statuses stop as access failures even with HTML', () => {
  const target = { host: 'api.airindia.com', path: '/cbiz-booking/v2/prime/search/air-bounds' };
  for (const [status, code] of [[401, 'SESSION_EXPIRED'], [403, 'ACCESS_DENIED'], [429, 'RATE_LIMITED']]) {
    const cause = classifyFailure(new Error('search failed'), [{ ...target, status, method: 'POST', fareResponse: isFareResponsePath(target, 'text/html') }]);
    assert.equal(cause.code, code);
  }
});
