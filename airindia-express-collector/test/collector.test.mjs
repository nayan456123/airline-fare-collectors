import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, dayAccessibleLabel, isFirstParty, isObservedHost,
  shouldCaptureJsonBody, classifyFailure, classifyPageState, withDeadline, sourceRole,
  parseBookingHandoff, isFareResponseCandidate, selectBookingPage, retryDelayMs } from '../src/collect.mjs';
import { parseSearchResponse } from '../src/parse.mjs';

test('transient retries respect both backoff and the configured launch interval', () => {
  assert.equal(retryDelayMs(1000, 3000, 20000, 6000), 18000);
  assert.equal(retryDelayMs(1000, 21000, 20000, 6000), 6000);
  assert.equal(retryDelayMs(1000, 3000, 0, 6000), 6000);
});

test('invalid route, date, browser, and browser-specific HTTP/2 input are rejected', () => {
  assert.throws(() => parseArgs(['--search', 'DEL:DEL:2026-10-02']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-02-30']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--browser', 'safari']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--browser', 'firefox', '--disable-http2']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--http-transport', 'proxy']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--retries', '2']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--retries', '-1']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--renew-session=true']));
  assert.equal(parseArgs(['--search', 'DEL:BOM:2026-10-02', '--renew-session']).renewSession, true);
});

test('search defaults to native headless Chrome and the AIX calendar label is exact', () => {
  const options = parseArgs(['--search', 'del:bom:2026-10-02']);
  assert.equal(options.browser, 'chrome');
  assert.equal(options.mode, 'headless');
  assert.equal(options.browserLauncher, 'cdp');
  assert.equal(options.userAgentProfile, 'chrome-compatible');
  assert.equal(options.disableHttp2, false);
  assert.equal(options.httpTransport, 'native');
  assert.equal(parseArgs(['--search', 'DEL:BOM:2026-10-02', '--http-transport', 'http1']).httpTransport, 'http1');
  assert.equal(dayAccessibleLabel('2026-10-02'), 'Fri, Oct 02 2026');
  assert.throws(() => dayAccessibleLabel('2026-02-30'), /Invalid calendar date/);
});

test('response capture is limited to observed first-party hosts and post-submit JSON', () => {
  assert.equal(isFirstParty('https://www.airindiaexpress.com/en/book-flights/'), true);
  assert.equal(isFirstParty('https://openair-california.airtrfx.com/api'), false);
  assert.equal(isObservedHost('https://openair-california.airtrfx.com/api'), true);
  assert.equal(isObservedHost('https://example.com/api'), false);
  const submittedAt = 1000;
  const capture = (host, responseAt, contentType = 'application/json') =>
    shouldCaptureJsonBody({ submittedAt, responseAt, contentType, host });
  assert.equal(capture('airindiaexpress.com', 1001), true);
  assert.equal(capture('openair-california.airtrfx.com', 1001), true);
  assert.equal(capture('example.com', 1001), false);
  assert.equal(capture('airindiaexpress.com', 999), false);
  assert.equal(capture('airindiaexpress.com', 1001, 'text/html'), false);
  assert.equal(capture('airindiaexpress.com', NaN), false);
});

test('booking challenges and denials are classified as blocking states', () => {
  assert.equal(classifyPageState('Complete the CAPTCHA').code, 'CAPTCHA');
  assert.equal(classifyPageState('', [{ sourceRole: 'aix-site', status: 403 }]).code, 'ACCESS_DENIED');
  assert.equal(classifyPageState('', [{ sourceRole: 'aix-site', status: 429 }]).code, 'RATE_LIMITED');
  assert.equal(classifyPageState('Your session has expired').code, 'SESSION_EXPIRED');
  assert.equal(classifyPageState('No flights found').code, 'EMPTY_RESULTS');
  assert.equal(classifyPageState('Search results'), null);
});

test('unknown AIX response schema fails closed without emitting fare rows', () => {
  const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-02' };
  assert.equal(parseSearchResponse({ fares: [{ flight: 'IX123', price: 1 }] }, query), null);
  assert.equal(parseSearchResponse('{"fares":[{"flight":"IX123","price":1}]}', query), null);
  assert.throws(() => parseSearchResponse('not json', query), error =>
    error.code === 'FARE_RESPONSE_UNVERIFIED');
  assert.throws(() => parseSearchResponse('{}', { ...query, origin: 'DEL2' }), error =>
    error.code === 'FARE_RESPONSE_UNVERIFIED');
});

test('an unresponsive browser operation has a bounded diagnostic failure', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 15, 'Read page'),
    error => error.code === 'TIMEOUT' && /Read page exceeded 15 ms/.test(error.message));
  assert.equal(await withDeadline(Promise.resolve('ready'), 100, 'Read page'), 'ready');
});

test('the booking deeplink is a handoff and cannot be treated as a fare response', () => {
  const handoffUrl = 'https://openair-california.airtrfx.com/deeplink-service/v2/i5/deeplinks';
  const role = sourceRole(handoffUrl);
  assert.equal(role, 'booking-handoff');
  assert.equal(isFareResponseCandidate({ sourceRole: role, status: 200,
    contentType: 'application/json', path: '/deeplink-service/v2/i5/deeplinks' }), false);
  assert.deepEqual(parseBookingHandoff({ method: 'POST', url: 'https://www.airindiaexpress.com/booking' }),
    { method: 'POST', url: 'https://www.airindiaexpress.com/booking' });
  assert.equal(parseBookingHandoff({ method: 'GET', url: 'http://www.airindiaexpress.com/booking' }), null);
  assert.equal(parseBookingHandoff({ method: 'GET', url: 'https://user:secret@example.com/' }), null);
  assert.equal(parseBookingHandoff({ method: 'DELETE', url: 'https://www.airindiaexpress.com/booking' }), null);
  assert.equal(isFareResponseCandidate({ sourceRole: 'airport-suggestions', status: 200,
    contentType: 'application/json', path: '/airports/search' }), false);
  assert.equal(isFareResponseCandidate({ sourceRole: 'aix-booking-engine', status: 200,
    contentType: 'application/json', path: '/api/availability' }), false);
  assert.equal(isFareResponseCandidate({ sourceRole: 'aix-booking-engine', status: 403,
    contentType: 'application/json', path: '/api/availability' }), false);
});

test('a delayed popup is followed only after it reaches the booking destination', () => {
  const landing = { url: () => 'https://www.airindiaexpress.com/en/book-flights/' };
  let destination = 'about:blank';
  const popup = { url: () => destination, isClosed: () => false };
  const pages = new Set([landing, popup]);
  assert.equal(selectBookingPage(pages, landing), landing);
  destination = 'https://www.airindiaexpress.com/booking';
  assert.equal(selectBookingPage(pages, landing), popup);
  destination = 'https://unconfirmed.example/booking';
  assert.equal(selectBookingPage(pages, landing), landing);
  assert.equal(selectBookingPage(pages, landing, landing.url(), new Set(['unconfirmed.example'])), popup);
});


test('explicit airline cooldown overrides transport errors and cannot become a transient retry', () => {
  const failures = [{ sourceRole: 'aix-site', resourceType: 'fetch', failed: 'net::ERR_HTTP2_PROTOCOL_ERROR' }];
  for (const text of [
    'Take a Break\nSearch after some time',
    'Looks like you’ve tried a few times. Please try searching for flights after some time.',
    "Looks like you've tried a few times."
  ]) {
    assert.equal(classifyPageState(text, failures).code, 'RATE_LIMITED');
    const cause = classifyFailure(Object.assign(new Error('Search timed out'), { code: 'TIMEOUT' }), failures, text);
    assert.equal(cause.code, 'RATE_LIMITED');
    assert.equal(['SITE_NETWORK_FAILURE', 'TIMEOUT', 'FORM_NOT_READY'].includes(cause.code), false);
  }
  assert.equal(classifyPageState('Something went wrong. Please try again.'), null);
  assert.equal(classifyPageState('Take a break and discover our offers'), null);
  assert.equal(classifyFailure(new Error('Search failed'), failures, 'Please try again.').code, 'SITE_NETWORK_FAILURE');
});


test('only official POST 200 FSA JSON counts as a fare response', () => {
  const valid = { host: 'api.airindiaexpress.com', path: '/b2c-flightsearch/v4/fsa', method: 'POST', status: 200, contentType: 'application/json' };
  assert.equal(isFareResponseCandidate(valid), true);
  for (const change of [{ path: '/b2c-flightsearch/v3/station' }, { method: 'GET' }, { status: 201 },
    { host: 'other.example' }, { contentType: 'text/html' }]) assert.equal(isFareResponseCandidate({ ...valid, ...change }), false);
});

test('pending booking navigation is a bounded retryable timeout without inventing a fare response', async () => {
  const { incompleteSearchFailure } = await import('../src/collect.mjs');
  const network = [{ at: '2026-10-27T09:52:46Z', host: 'www.airindiaexpress.com', path: '/flight-availability', method: 'GET', resourceType: 'document' }];
  const result = incompleteSearchFailure(network, Date.parse('2026-10-27T09:52:00Z'), { url: 'https://www.airindiaexpress.com/flight-availability' });
  assert.equal(result.code, 'TIMEOUT'); assert.match(result.message, /Booking navigation timeout.*no response/);
  network.push({ ...network[0], at: '2026-10-27T09:52:47Z', status: 200 });
  assert.match(incompleteSearchFailure(network, Date.parse('2026-10-27T09:52:00Z'), {}).message, /FSA response loading timeout/);
});

test('verification connectivity text is distinct from an interactive challenge', () => {
  const unavailable = 'Could not connect to the reCAPTCHA service. Please check your internet connection and reload to get a reCAPTCHA challenge.';
  assert.equal(classifyPageState(unavailable).code, 'VERIFICATION_SERVICE_UNAVAILABLE');
  assert.equal(classifyFailure(new Error('navigation timeout'), [], unavailable).code, 'VERIFICATION_SERVICE_UNAVAILABLE');
  for (const challenge of ['Complete the CAPTCHA', 'Verify you are human', 'Select all images with traffic lights', "I'm not a robot"]) {
    assert.equal(classifyPageState(`${unavailable} ${challenge}`).code, 'CAPTCHA');
    assert.equal(classifyFailure(new Error('timeout'), [], challenge).code, 'CAPTCHA');
  }
  assert.equal(classifyPageState('Protected by reCAPTCHA Privacy Terms'), null);
});

test('verification dependency diagnostics contain only allowlisted sanitized metadata', async () => {
  const { verificationDependencyMetadata, isFirstParty, isObservedHost } = await import('../src/collect.mjs');
  const url = 'https://www.google.com/recaptcha/api2/reload?k=PRIVATE_SITE_KEY&c=PRIVATE_TOKEN#PRIVATE_FRAGMENT';
  const metadata = verificationDependencyMetadata(url, { method: 'POST', resourceType: 'xhr', status: 503,
    failed: `Error loading ${url}`, body: 'PRIVATE_BODY', headers: { cookie: 'PRIVATE_COOKIE' } });
  assert.deepEqual(metadata, { host: 'www.google.com', path: '/recaptcha/api2/reload', sourceRole: 'verification-dependency',
    method: 'POST', resourceType: 'xhr', status: 503, failed: 'DEPENDENCY_REQUEST_FAILED' });
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE/);
  assert.equal(isFirstParty(url), false); assert.equal(isObservedHost(url), false);
  assert.equal(isFareResponseCandidate(metadata), false);
  assert.equal(classifyPageState('', [{ ...metadata, status: 403 }]), null);
  assert.equal(classifyFailure(Object.assign(new Error('loading timeout'), { code: 'TIMEOUT' }), [{ ...metadata, failed: 'net::ERR_CONNECTION_RESET' }]).code, 'TIMEOUT');
  for (const other of ['https://google.com.evil.test/recaptcha/api.js', 'https://www.google.com/search?recaptcha=1', 'http://www.google.com/recaptcha/api.js', 'https://other.example/recaptcha/api.js'])
    assert.equal(verificationDependencyMetadata(other), null);
  assert.equal(verificationDependencyMetadata('https://www.gstatic.com/recaptcha/releases/abcdefghijklmnopqrstuvwxyz123456/recaptcha__en.js').path,
    '/recaptcha/releases/[redacted]/recaptcha__en.js');
});
