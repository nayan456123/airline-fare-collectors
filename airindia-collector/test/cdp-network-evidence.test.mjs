import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import { classifyFailure, createCdpFareNetworkCapture, waitForMatchingResults } from '../src/collect.mjs';

const executablePath = process.env.AIRINDIA_TEST_CHROME_PATH;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test('CDP joins CORS-blocked responses to exact request IDs and keeps only sanitized diagnostics', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium integration test'
}, async () => {
  let fareCalls = 0;
  const fareServer = http.createServer((_request, response) => {
    fareCalls += 1;
    response.writeHead(fareCalls === 1 ? 403 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ secret: 'response-body-must-not-be-saved' }));
  });
  let farePort;
  let pagePort;
  let pageServer;
  let browser;
  let capture;
  let context;
  try {
    farePort = await listen(fareServer);
    pageServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<body><script>
        (async () => {
          for (let i = 0; i < 2; i++) {
            try { await fetch('http://127.0.0.1:${farePort}/fare?token=TOP_SECRET', {
              method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'SECRET_REQUEST_BODY'
            }); }
            catch (error) { document.body.dataset[` + '`failure${i}`' + `] = error.name; }
          }
          document.body.dataset.done = 'yes';
        })();
      </script></body>`);
    });
    pagePort = await listen(pageServer);
    browser = await chromium.launch({ headless: true, executablePath });
    context = await browser.newContext();
    const page = await context.newPage();
    const cdpSession = await context.newCDPSession(page);
    const submittedAt = new Date().toISOString();
    capture = createCdpFareNetworkCapture({
      getSession: async candidate => candidate === page ? cdpSession : null,
      submittedAt: () => submittedAt,
      isTrackedRequest: value => {
        const url = new URL(value);
        return url.hostname === '127.0.0.1' && url.pathname === '/fare';
      }
    });
    await capture.attach(page);
    await page.goto(`http://127.0.0.1:${pagePort}/`);
    await page.waitForFunction(() => document.body.dataset.done === 'yes');
    assert.equal(await page.locator('body').getAttribute('data-failure0'), 'TypeError');
    assert.equal(await page.locator('body').getAttribute('data-failure1'), 'TypeError');

    const diagnostics = [];
    await capture.flush(diagnostics);
    assert.deepEqual(diagnostics.map(item => item.status), [403, 503]);
    assert.deepEqual(diagnostics.map(item => item.method), ['POST', 'POST']);
    assert.ok(diagnostics.every(item => item.cdpCorrelated === true));
    assert.ok(diagnostics.every(item => item.corsError));
    const serialized = JSON.stringify(diagnostics);
    for (const secret of ['TOP_SECRET', 'SECRET_REQUEST_BODY', 'response-body-must-not-be-saved', 'requestId'])
      assert.equal(serialized.includes(secret), false, `diagnostics leaked ${secret}`);
    assert.equal(classifyFailure(Object.assign(new Error('fetch failed'), { code: 'SITE_NETWORK_FAILURE' }),
      diagnostics).code, 'ACCESS_DENIED', 'a correlated fare POST 403 is classified from its exact request status');
    assert.equal(fareCalls, 2, 'the repeated same-URL calls should remain separately ordered');
  } finally {
    await capture?.dispose();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (farePort) await close(fareServer);
    if (pageServer) await close(pageServer);
  }
});

test('late CORS 403 is observed before a site-error Retry click', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium integration test'
}, async () => {
  const fareServer = http.createServer((_request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end('{"error":"private"}');
  });
  let pageServer;
  let farePort;
  let pagePort;
  let browser;
  let context;
  let capture;
  try {
    farePort = await listen(fareServer);
    pageServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<body><main><h2 class="ai-pb-no-flights-title">Something went wrong</h2>
        <p>The system is facing an unexpected issue</p>
        <button id="ai-pb-air-bound-retry-button">Retry</button></main><script>
        setTimeout(() => fetch('http://127.0.0.1:${farePort}/fare?secret=URL_SECRET', {
          method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'BODY_SECRET'
        }).catch(() => {}), 100);
      </script></body>`);
    });
    pagePort = await listen(pageServer);
    browser = await chromium.launch({ headless: true, executablePath });
    context = await browser.newContext();
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    const submittedAt = new Date().toISOString();
    capture = createCdpFareNetworkCapture({
      getSession: async () => session,
      submittedAt: () => submittedAt,
      isTrackedRequest: value => new URL(value).pathname === '/fare'
    });
    await capture.attach(page);
    await page.goto(`http://127.0.0.1:${pagePort}/`);
    const network = [];
    let retryCallbacks = 0;
    await assert.rejects(waitForMatchingResults(page, [],
      { origin: 'BLR', destination: 'CCU', travelDate: '2026-11-12' }, network, {
        timeoutMs: 2000, pollingMs: 50,
        onNetworkSnapshot: () => capture.snapshot(network),
        siteErrorSettleMs: 500,
        onSiteRetry: () => { retryCallbacks += 1; }
      }), error => error.code === 'ACCESS_DENIED');
    assert.equal(retryCallbacks, 0);
    assert.equal(network.find(item => item.cdpCorrelated)?.status, 403);
    assert.ok(!JSON.stringify(network).includes('URL_SECRET'));
    assert.ok(!JSON.stringify(network).includes('BODY_SECRET'));
  } finally {
    await capture?.dispose();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (pageServer) await close(pageServer);
    if (farePort) await close(fareServer);
  }
});

test('request IDs are scoped to a CDP target and redirect reuse suppresses status attribution', async () => {
  const sessionA = new EventEmitter();
  const sessionB = new EventEmitter();
  for (const session of [sessionA, sessionB]) {
    session.send = async () => {};
    session.detach = async () => {};
  }
  const submittedAt = new Date(Date.now() - 1000).toISOString();
  const capture = createCdpFareNetworkCapture({
    getSession: async page => page.session,
    submittedAt: () => submittedAt,
    isTrackedRequest: value => new URL(value).pathname === '/fare'
  });
  const pageA = { session: sessionA };
  const pageB = { session: sessionB };
  const pages = [pageA, pageB];
  await Promise.all(pages.map(page => capture.attach(page)));
  const request = (session, { url, redirectResponse, requestId = 'reused-id' }) => session.emit('Network.requestWillBeSent', {
    requestId, wallTime: Date.now() / 1000,
    request: { url, method: 'POST' }, ...(redirectResponse ? { redirectResponse } : {})
  });
  const extra = (session, statusCode, requestId = 'reused-id') => session.emit('Network.responseReceivedExtraInfo', {
    requestId, statusCode, headers: { 'set-cookie': 'secret=never-read' }
  });
  const failed = (session, statusCode, requestId = 'reused-id', errorText = 'net::ERR_FAILED') => {
    extra(session, statusCode, requestId);
    session.emit('Network.loadingFailed', { requestId, errorText,
      corsErrorStatus: { corsError: 'MissingAllowOriginHeader', failedParameter: 'PRIVATE' } });
  };
  // Same synthetic CDP request ID in different targets must not collide.
  request(sessionA, { url: 'https://api.airindia.com/fare?token=SECRET_A' });
  extra(sessionB, 503);
  request(sessionB, { url: 'https://api.airindia.com/fare?token=SECRET_B' });
  failed(sessionA, 403);
  sessionB.emit('Network.loadingFailed', { requestId: 'reused-id', errorText: 'net::ERR_FAILED',
    corsErrorStatus: { corsError: 'MissingAllowOriginHeader', failedParameter: 'PRIVATE' } });
  // Same CDP id across a redirect chain: status from ExtraInfo is intentionally
  // treated as ambiguous and cannot turn the transport failure into a denial.
  sessionA.emit('Network.requestWillBeSent', { requestId: 'redirect-id', wallTime: Date.now() / 1000,
    request: { url: 'https://api.airindia.com/fare?token=redirect', method: 'POST' } });
  sessionA.emit('Network.responseReceived', { requestId: 'redirect-id', hasExtraInfo: true,
    response: { status: 302 } });
  sessionA.emit('Network.requestWillBeSent', { requestId: 'redirect-id', wallTime: Date.now() / 1000,
    request: { url: 'https://api.airindia.com/fare?token=redirected', method: 'POST' },
    redirectResponse: { status: 302 } });
  failed(sessionA, 403, 'redirect-id');

  const diagnostics = [];
  await capture.flush(diagnostics);
  assert.deepEqual(diagnostics.map(item => item.status).sort((a, b) =>
    a === null ? 1 : b === null ? -1 : a - b), [403, 503, null]);
  assert.equal(classifyFailure(Object.assign(new Error('failed'), { code: 'SITE_NETWORK_FAILURE' }),
    diagnostics).code, 'ACCESS_DENIED');
  const transport = Object.assign(new Error('failed'), { code: 'SITE_NETWORK_FAILURE' });
  const ambiguous = diagnostics.find(item => item.status === null);
  assert.equal(ambiguous.failed, 'net::ERR_FAILED');
  assert.equal(classifyFailure(transport, [ambiguous]).code, 'SITE_NETWORK_FAILURE');
  const beforeSubmit = diagnostics.find(item => item.status === 403);
  assert.equal(classifyFailure(transport, [{ ...beforeSubmit, postSubmit: false }]).code,
    'SITE_NETWORK_FAILURE');
  const serialized = JSON.stringify(diagnostics);
  for (const secret of ['SECRET_A', 'SECRET_B', 'PRIVATE', 'set-cookie', 'token=', 'requestId'])
    assert.equal(serialized.includes(secret), false, `diagnostics leaked ${secret}`);
  await capture.dispose();
});

test('GET fare statuses remain valid while CDP denials require a post-submit request', async () => {
  const session = new EventEmitter();
  session.send = async () => {};
  session.detach = async () => {};
  let submittedAt = new Date(Date.now() - 1000).toISOString();
  const capture = createCdpFareNetworkCapture({
    getSession: async () => session,
    submittedAt: () => submittedAt,
    isTrackedRequest: value => new URL(value).pathname === '/fare'
  });
  await capture.attach({});
  for (const [requestId, secondsAgo, status] of [['before', 5000, 403], ['after', 0, 429]]) {
    session.emit('Network.requestWillBeSent', { requestId,
      wallTime: (Date.now() - secondsAgo * 1000) / 1000,
      request: { url: `https://api.airindia.com/fare?token=${requestId}`, method: 'GET' } });
    session.emit('Network.responseReceivedExtraInfo', { requestId, statusCode: status });
    session.emit('Network.loadingFailed', { requestId, errorText: 'net::ERR_FAILED' });
  }
  const diagnostics = [];
  await capture.flush(diagnostics);
  assert.ok(diagnostics.every(item => item.fareResponse && item.method === 'GET'));
  const error = Object.assign(new Error('network failed'), { code: 'SITE_NETWORK_FAILURE' });
  assert.equal(classifyFailure(error, diagnostics.filter(item => item.status === 403)).code,
    'SITE_NETWORK_FAILURE', 'a pre-submit CDP GET is not a denial for the submitted search');
  assert.equal(classifyFailure(error, diagnostics.filter(item => item.status === 429)).code,
    'RATE_LIMITED', 'a correlated post-submit CDP GET remains a fare denial');
  assert.equal(classifyFailure(error, [{ path: '/api/availability', method: 'GET', status: 403,
    fareResponse: true }]).code, 'ACCESS_DENIED', 'ordinary Playwright fareResponse metadata retains GET support');
  await capture.dispose();
});

test('CDP attachment, enable, and detach failures are bounded and fail open', async () => {
  const never = () => new Promise(() => {});
  const delayed = createCdpFareNetworkCapture({ getSession: never,
    getSessionTimeoutMs: 10, commandTimeoutMs: 10, detachTimeoutMs: 10, extraInfoWaitMs: 10 });
  const started = Date.now();
  await delayed.attach({});
  await delayed.flush([]);
  await delayed.dispose();
  assert.ok(Date.now() - started < 250, 'a stalled getSession must not block collection cleanup');

  const session = new EventEmitter();
  session.send = never;
  session.detach = never;
  const stalled = createCdpFareNetworkCapture({ getSession: async () => session,
    getSessionTimeoutMs: 10, commandTimeoutMs: 10, detachTimeoutMs: 10, extraInfoWaitMs: 10 });
  const secondStarted = Date.now();
  await stalled.attach({});
  await stalled.flush([]);
  await stalled.dispose();
  assert.ok(Date.now() - secondStarted < 250, 'stalled CDP commands must not block collection cleanup');
});
