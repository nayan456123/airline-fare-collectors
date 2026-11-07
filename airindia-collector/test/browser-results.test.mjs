import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { classifyPageFailure, readPageAccessState, waitForMatchingResults } from '../src/collect.mjs';

const executablePath = process.env.AIRINDIA_TEST_CHROME_PATH;
const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-31' };
const responseBody = JSON.stringify({
  status: 'SUCCESS', hasError: false,
  dictionaries: { flight: { f1: {
    departure: { locationCode: 'DEL', dateTime: '2026-10-31T09:00:00+05:30' },
    arrival: { locationCode: 'BOM', dateTime: '2026-10-31T11:00:00+05:30' },
    marketingAirlineCode: 'AI', marketingFlightNumber: '123', operatingAirlineCode: 'AI'
  } } },
  responsePayload: [{ airBoundGroups: [{
    boundDetails: { originLocationCode: 'DEL', destinationLocationCode: 'BOM',
      segments: [{ flightId: 'f1' }] },
    airBounds: [{ aiUnitPrice: { value: 6581, currencyCode: 'INR' },
      prices: { totalPrices: [{ currencyCode: 'INR', base: 5000, totalTaxes: 1581,
        total: 6581 }] } }]
  }] }]
});
const fullCard = `<div class="ai-pb-flight-card-wrapper"><div class="ai-pb-flight-item">
  <span class="ai-pb-flight-id">AI 123</span>
  <span class="ai-pb-departure-city-code">DEL</span>
  <span class="ai-pb-actual-arrival-city">BOM</span>
  <span class="ai-pb-departure-time">09:00</span>
  <span class="ai-pb-arrival-time">11:00</span>
  <span class="ai-pb-currency-code">INR</span>
  <span class="ai-pb-price">₹ 6,581</span>
</div></div>`;
const standardError = `<main id="result-shell"><section id="error-panel">
  <h2 class="ai-pb-no-flights-title">Something went wrong</h2>
  <p>The system is facing an unexpected issue</p>
  <button id="ai-pb-air-bound-retry-button">Retry</button>
</section></main>`;

async function localOnly(page, seen = []) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'about:' || url.protocol === 'data:') await route.continue();
    else { seen.push(url.href); await route.abort(); }
  });
}

test('waits for a delayed complete fare card and a stable response match in Chromium', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const nonLocalRequests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'about:' || url.protocol === 'data:') {
        await route.continue();
      } else {
        nonLocalRequests.push(url.href);
        await route.abort();
      }
    });

    await page.setContent('<main id="results"><div class="ai-pb-flight-card-wrapper">' +
      '<div class="ai-pb-flight-item"><span class="ai-pb-flight-id">AI</span></div></div></main>');
    const injectionDelayMs = 500;
    const startedAt = performance.now();
    await page.evaluate(({ markup, delay }) => {
      setTimeout(() => { document.querySelector('#results').innerHTML = markup; }, delay);
    }, { markup: fullCard, delay: injectionDelayMs });

    const matched = await waitForMatchingResults(page, [{ body: responseBody }], query, [],
      { timeoutMs: 5000, pollingMs: 50 });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(matched, true, 'the rendered fare card should match the saved response');
    assert.equal(await page.locator('.ai-pb-flight-card-wrapper').count(), 1);
    assert.match(await page.locator('body').innerText(), /AI 123[\s\S]*6,581/);
    assert.ok(elapsedMs >= 400, 'the helper should wait for the delayed complete card');
    assert.deepEqual(nonLocalRequests, [], 'the browser must make no external requests');
  } finally {
    await browser.close();
  }
});

test('ignores a hidden challenge template while the booking handoff becomes results', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium UI test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const externalRequests = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'about:' || url.protocol === 'data:') await route.continue();
      else { externalRequests.push(url.href); await route.abort(); }
    });
    await page.setContent(`<style id="alloy-prehiding">body{opacity:0!important}</style>
      <main id="handoff" aria-busy="true">
        <div class="loading-overlay">Loading flights</div>
        <section><h2>Please check the box below</h2><iframe title="reCAPTCHA"></iframe></section>
      </main>`);
    const initial = await readPageAccessState(page);
    assert.equal(initial.ready, false);
    assert.equal(initial.visibleChallenge, false);
    assert.equal((await classifyPageFailure(page, Object.assign(new Error('waiting for results'), { code: 'TIMEOUT' }), [])).code,
      'TIMEOUT');

    await page.evaluate(({ markup, delay }) => setTimeout(() => {
      const handoff = document.querySelector('#handoff');
      handoff.removeAttribute('aria-busy');
      handoff.innerHTML = markup;
      document.querySelector('#alloy-prehiding')?.remove();
    }, delay), { markup: fullCard, delay: 150 });
    const matched = await waitForMatchingResults(page, [{ body: responseBody }], query, [],
      { timeoutMs: 2000, pollingMs: 25 });
    assert.equal(matched, true, 'the eventual booking results should be verified');
    assert.deepEqual(externalRequests, []);
  } finally {
    await browser.close();
  }
});

test('stops immediately for an actually visible human verification prompt', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium UI test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.request().url().startsWith('about:') ||
      route.request().url().startsWith('data:') ? route.continue() : route.abort());
    await page.setContent('<main><h2>Verify you are human</h2><p>Please check the box below</p></main>');
    const state = await readPageAccessState(page);
    assert.equal(state.visibleChallenge, true);
    const started = performance.now();
    await assert.rejects(waitForMatchingResults(page, [], query, [],
      { timeoutMs: 1000, pollingMs: 10 }), error => error.code === 'CAPTCHA');
    assert.ok(performance.now() - started < 250, 'visible challenge should stop polling immediately');
  } finally {
    await browser.close();
  }
});

test('ignores hidden challenge markup and a prompt occluded by the loading overlay', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium UI test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent(`<main>Checking availability
      <div style="display:none">captcha</div>
      <section><h2>Verify you are human</h2></section>
      <div style="position:fixed;inset:0;background:#fff;z-index:9999">Loading flights</div>
      <section style="opacity:0"><h2>Security challenge</h2></section>
    </main>`);
    const state = await readPageAccessState(page);
    assert.equal(state.visibleChallenge, false);
    assert.deepEqual(await classifyPageFailure(page,
      Object.assign(new Error('booking request timed out'), { code: 'TIMEOUT' }), []),
    { code: 'TIMEOUT', detail: 'booking request timed out' });
  } finally {
    await browser.close();
  }
});

test('a persistent hidden prehide times out without a false CAPTCHA', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium UI test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style id="alloy-prehiding">body{opacity:0!important}</style>
      <main id="handoff"><div class="loading-overlay">Loading</div>
        <section><h2>Verify you are human</h2></section>
      </main>`);
    const state = await readPageAccessState(page);
    assert.equal(state.ready, false);
    assert.equal(state.visibleChallenge, false);
    const started = performance.now();
    const matched = await waitForMatchingResults(page, [], query, [], { timeoutMs: 100, pollingMs: 10 });
    assert.equal(matched, false);
    assert.ok(performance.now() - started < 500, 'bounded readiness polling should honor its deadline');
    assert.equal((await classifyPageFailure(page, Object.assign(new Error('results wait timed out'),
      { code: 'TIMEOUT' }), [])).code, 'TIMEOUT');
  } finally {
    await browser.close();
  }
});

test('HTTP access denials take priority when a page body is prehidden', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium UI test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent('<main style="opacity:0">Verify you are human</main>');
    const cause = await classifyPageFailure(page, new Error('request failed'), [
      { path: '/in/en/refx-booking.html', method: 'POST', status: 403 }
    ]);
    assert.equal(cause.code, 'ACCESS_DENIED');
  } finally {
    await browser.close();
  }
});

test('retries the visible standard Air India error once and still requires the exact fare match', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium UI test'
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const externalRequests = [];
    await localOnly(page, externalRequests);
    await page.setContent(`${standardError}<script>
      window.retryClicks=0;
      document.addEventListener('click',event=>{
        if(!event.target.matches('#ai-pb-air-bound-retry-button'))return;
        window.retryClicks++;
        setTimeout(()=>document.querySelector('#result-shell').innerHTML=${JSON.stringify(fullCard)},50);
      });
    </script>`);
    let detected=0, retried=0;
    const matched=await waitForMatchingResults(page,[{body:responseBody}],query,[],{
      timeoutMs:2000,pollingMs:25,onSiteError:()=>{detected++},onSiteRetry:()=>{retried++}
    });
    assert.equal(matched,true,'a recovered result must still match the saved response exactly');
    assert.equal(await page.evaluate(()=>window.retryClicks),1);
    assert.equal(detected,1);
    assert.equal(retried,1);
    assert.deepEqual(externalRequests,[]);
  } finally {
    await browser.close();
  }
});

test('a persistent standard Air India error gets only one native Retry click', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium UI test'
}, async () => {
  const browser=await chromium.launch({headless:true,executablePath});
  try {
    const page=await browser.newPage();
    await localOnly(page);
    await page.setContent(`${standardError}<script>
      window.retryClicks=0;
      document.querySelector('#ai-pb-air-bound-retry-button').addEventListener('click',()=>window.retryClicks++);
    </script>`);
    let detected=0,retried=0;
    await assert.rejects(waitForMatchingResults(page,[],query,[],{
      timeoutMs:1200,pollingMs:20,onSiteError:()=>{detected++},onSiteRetry:()=>{retried++}
    }),error=>error.code==='SITE_ERROR');
    assert.equal(await page.evaluate(()=>window.retryClicks),1);
    assert.equal(detected,1);
    assert.equal(retried,1);
  } finally {
    await browser.close();
  }
});

test('HTTP 403/429 and a visible human check stop without interacting with native Retry', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium UI test'
}, async () => {
  const browser=await chromium.launch({headless:true,executablePath});
  try {
    const page=await browser.newPage();
    await localOnly(page);
    for(const [status,code] of [[403,'ACCESS_DENIED'],[429,'RATE_LIMITED']]){
      await page.setContent(`${standardError}<script>window.retryClicks=0;
        document.querySelector('#ai-pb-air-bound-retry-button').addEventListener('click',()=>window.retryClicks++);
      </script>`);
      let detected=0,retried=0;
      await assert.rejects(waitForMatchingResults(page,[],query,[{
        path:'/api/availability',method:'POST',status,fareResponse:true
      }],{timeoutMs:500,pollingMs:10,onSiteError:()=>{detected++},onSiteRetry:()=>{retried++}}),
      error=>error.code===code);
      assert.equal(await page.evaluate(()=>window.retryClicks),0,`HTTP ${status} must not trigger page interaction`);
      assert.equal(detected,0);
      assert.equal(retried,0);
    }
    await page.setContent(`<main id="result-shell"><h2>Verify you are human</h2>
      <button id="ai-pb-air-bound-retry-button">Retry</button></main>
      <script>window.retryClicks=0;
        document.querySelector('#ai-pb-air-bound-retry-button').addEventListener('click',()=>window.retryClicks++);
      </script>`);
    let detected=0,retried=0;
    await assert.rejects(waitForMatchingResults(page,[],query,[],{
      timeoutMs:500,pollingMs:10,onSiteError:()=>{detected++},onSiteRetry:()=>{retried++}
    }),error=>error.code==='CAPTCHA');
    assert.equal(await page.evaluate(()=>window.retryClicks),0,'a visible human check must not be clicked or retried');
    assert.equal(detected,0);
    assert.equal(retried,0);
  } finally {
    await browser.close();
  }
});

test('a standard-error Retry never accepts a fare card with a different displayed total', {
  skip: !executablePath && 'Set AIRINDIA_TEST_CHROME_PATH to run the optional Chromium UI test'
}, async () => {
  const browser=await chromium.launch({headless:true,executablePath});
  try {
    const page=await browser.newPage();
    await localOnly(page);
    await page.setContent(`${standardError}<script>
      window.retryClicks=0;
      document.querySelector('#ai-pb-air-bound-retry-button').addEventListener('click',()=>{
        window.retryClicks++;
        setTimeout(()=>document.querySelector('#result-shell').innerHTML=${JSON.stringify(fullCard.replace('6,581','6,582'))},40);
      });
    </script>`);
    const matched=await waitForMatchingResults(page,[{body:responseBody}],query,[],{
      timeoutMs:1200,pollingMs:20
    });
    assert.equal(matched,false,'the retry result must still pass the exact response-to-card comparison');
    assert.equal(await page.evaluate(()=>window.retryClicks),1);
  } finally {
    await browser.close();
  }
});
