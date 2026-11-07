#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseSearchResponse, matchPageCards } from './parse.mjs';
import { verifySearch } from './verify.mjs';
import { chromeExecutable } from './browser-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = 'https://www.akasaair.com/flight-booking';
const SEARCH_PATH = '/api/ibe/availability/search';
const MARKETS_PATH = '/api/nsk/v2/resources/markets';
const DENIAL = new Set(['CAPTCHA', 'ACCESS_DENIED', 'RATE_LIMITED', 'SESSION_EXPIRED']);
const RETRYABLE = new Set(['TIMEOUT', 'SITE_NETWORK_FAILURE', 'MARKETS_UNAVAILABLE',
  'FORM_UNCONFIRMED', 'RESULTS_UNVERIFIED', 'AIRPORT_PICKER_UNAVAILABLE']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

export function parseArgs(args) {
  const options = { searches: [], mode: 'headless', output: path.join(root, 'runs'),
    profile: null, proxy: null, proxyUser: null, proxyPassword: null,
    interactionDelayMs: 700, minIntervalMs: 20000, retries: 1 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--headed') { options.mode = 'headed'; continue; }
    if (arg === '--headless') { options.mode = 'headless'; continue; }
    const value = args[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === '--search') {
      const match = /^([A-Z]{3}):([A-Z]{3}):(\d{4}-\d{2}-\d{2})$/.exec(value.toUpperCase());
      if (!match || match[1] === match[2] ||
          Number.isNaN(Date.parse(`${match[3]}T00:00:00Z`)) ||
          new Date(`${match[3]}T00:00:00Z`).toISOString().slice(0, 10) !== match[3])
        throw new Error(`Invalid search ${value}; use DEL:BOM:YYYY-MM-DD`);
      options.searches.push({ origin: match[1], destination: match[2], travelDate: match[3] });
    } else if (arg === '--output') options.output = path.resolve(value);
    else if (arg === '--profile') options.profile = path.resolve(value);
    else if (arg === '--proxy') options.proxy = value;
    else if (arg === '--proxy-user') options.proxyUser = value;
    else if (arg === '--proxy-password') options.proxyPassword = value;
    else if (arg === '--interaction-delay-ms') options.interactionDelayMs = Number(value);
    else if (arg === '--min-interval-ms') options.minIntervalMs = Number(value);
    else if (arg === '--retries') options.retries = Number(value);
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.searches.length) throw new Error('At least one --search is required');
  if (options.searches.length > 54) throw new Error('One run is limited to 54 searches');
  if (!Number.isInteger(options.interactionDelayMs) || options.interactionDelayMs < 0 ||
      options.interactionDelayMs > 10000) throw new Error('Invalid interaction delay');
  if (!Number.isInteger(options.minIntervalMs) || options.minIntervalMs < 0 ||
      options.minIntervalMs > 3600000) throw new Error('Invalid search interval');
  if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 2)
    throw new Error('Retries must be 0, 1, or 2');
  if (options.proxy) {
    const url = new URL(options.proxy);
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash)
      throw new Error('Proxy must be a plain HTTP, HTTPS, or SOCKS5 server URL');
  } else if (options.proxyUser || options.proxyPassword) {
    throw new Error('Proxy credentials require --proxy');
  }
  return options;
}

async function sourceFingerprint() {
  const files = ['src/collect.mjs', 'src/parse.mjs', 'src/verify.mjs', 'src/browser-path.mjs',
    'src/web-jobs.mjs', 'src/browser-admission.mjs', 'package-lock.json'];
  const contents = await Promise.all(files.map(file => fs.readFile(path.join(root, file))));
  return hash(Buffer.concat(contents));
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

async function savePage(page, directory, label) {
  const html = await page.content().catch(() => null);
  const screenshot = await page.screenshot({ fullPage: true, timeout: 15000 }).catch(() => null);
  if (html) await fs.writeFile(path.join(directory, `${label}.html`), html, { mode: 0o600 });
  if (screenshot) await fs.writeFile(path.join(directory, `${label}.png`), screenshot, { mode: 0o600 });
  return { html: html ? `${label}.html` : null, htmlSha256: html ? hash(html) : null,
    screenshot: screenshot ? `${label}.png` : null,
    screenshotSha256: screenshot ? hash(screenshot) : null };
}

export function classify(error, network, pageText = '') {
  if (/captcha|verify you are human|security challenge/i.test(pageText))
    return { code: 'CAPTCHA', detail: 'Akasa showed a challenge' };
  if (/access denied|request blocked|forbidden/i.test(pageText))
    return { code: 'ACCESS_DENIED', detail: 'Akasa showed an access block' };
  const booking = network.filter(item => item.host === 'prod-bl.qp.akasaair.com' &&
    /^\/api\/(ibe|nsk)\//.test(item.path));
  const deniedResponse = status => booking.find(item => item.status === status);
  const detail = response => `Akasa returned HTTP ${response.status} from ${response.path}`;
  const rateLimited = deniedResponse(429);
  if (rateLimited) return { code: 'RATE_LIMITED', detail: detail(rateLimited) };
  const accessDenied = deniedResponse(403);
  if (accessDenied) return { code: 'ACCESS_DENIED', detail: detail(accessDenied) };
  const unauthorized = deniedResponse(401);
  if (unauthorized) return { code: 'SESSION_EXPIRED', detail: detail(unauthorized) };
  if (error.code) return { code: error.code, detail: error.message };
  if (/ERR_CERT_|CERTIFICATE_VERIFY_FAILED|certificate authority/i.test(error.message))
    return { code: 'TLS_TRUST_FAILURE', detail: error.message };
  if (/Timeout|timeout/i.test(error.message))
    return { code: 'TIMEOUT', detail: error.message };
  if (network.some(item => item.failed))
    return { code: 'SITE_NETWORK_FAILURE', detail: error.message };
  return { code: 'SEARCH_FAILED', detail: error.message };
}

function checkAccess(pageText, network) {
  const cause = classify(new Error('Page access check'), network, pageText);
  if (DENIAL.has(cause.code)) throw Object.assign(new Error(cause.detail), { code: cause.code });
}

async function selectAirport(page, field, code, delayMs) {
  const input = page.locator(`input[name="${field}"]`);
  await input.click();
  await input.fill('');
  await input.pressSequentially(code, { delay: Math.max(75, Math.min(180, delayMs / 5)) });
  const option = page.locator(`li[id="${code}"]`).filter({ visible: true }).first();
  await option.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {
    throw Object.assign(new Error(`${field} airport ${code} did not appear in Akasa suggestions`),
      { code: 'AIRPORT_PICKER_UNAVAILABLE' });
  });
  await sleep(delayMs);
  await option.click();
  const value = await input.inputValue();
  if (!value.endsWith(`(${code})`))
    throw Object.assign(new Error(`${field} airport displayed ${value || 'nothing'} instead of ${code}`),
      { code: 'FORM_UNCONFIRMED' });
}

function dayLabel(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const day = date.getUTCDate();
  const suffix = day % 10 === 1 && day !== 11 ? 'st' :
    day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(date);
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(date);
  return `Choose ${weekday}, ${month} ${day}${suffix}, ${date.getUTCFullYear()}`;
}

export function matchesDateInput(value, isoDate) {
  const match = String(value).match(/(?:^|,\s*)(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return false;
  const date = new Date(`${isoDate}T12:00:00Z`);
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date);
  return Number(match[1]) === date.getUTCDate() &&
    match[2].slice(0, 3).toLowerCase() === month.slice(0, 3).toLowerCase() &&
    Number(match[3]) === date.getUTCFullYear();
}

export function marketsResponseFailure(response) {
  const status = response.status();
  const detail = `Akasa returned HTTP ${status} from ${MARKETS_PATH}`;
  if (status === 401) return { code: 'SESSION_EXPIRED', detail };
  if (status === 403) return { code: 'ACCESS_DENIED', detail };
  if (status === 429) return { code: 'RATE_LIMITED', detail };
  if (status !== 200) return { code: 'MARKETS_UNAVAILABLE', detail };
  return null;
}

export async function waitForMarketsResponse(page, timeoutMs = 30000) {
  return page.waitForResponse(response => response.url().includes(MARKETS_PATH),
    { timeout: timeoutMs }).catch(() => null);
}

async function selectDate(page, isoDate, delayMs) {
  await page.locator('input[name="DepartureDate"]').click();
  const day = page.locator(`[role="gridcell"][aria-label="${dayLabel(isoDate)}"]:not(.react-datepicker__day--outside-month)`);
  const month = page.locator('.react-datepicker__current-month').filter({ visible: true }).first();
  for (let step = 0; step < 13 && !await day.isVisible().catch(() => false); step++) {
    const before = await month.innerText().catch(() => null);
    await page.locator('.react-datepicker__navigation--next').first().click({ timeout: 5000 })
      .catch(() => { throw Object.assign(new Error(`Akasa next-month control was unavailable at ${before}`),
        { code: 'CALENDAR_NAVIGATION_FAILED' }); });
    await page.waitForFunction(previous => {
      const heading = document.querySelector('.react-datepicker__current-month');
      return heading && heading.textContent !== previous;
    }, before, { timeout: 3500 }).catch(() => {
      throw Object.assign(new Error(`Akasa calendar did not advance from ${before}`),
        { code: 'CALENDAR_NAVIGATION_FAILED' });
    });
    await sleep(delayMs);
  }
  if (!await day.isVisible().catch(() => false))
    throw Object.assign(new Error(`Akasa calendar did not show ${isoDate}`), { code: 'DATE_UNAVAILABLE' });
  await day.click();
  const value = await page.locator('input[name="DepartureDate"]').inputValue();
  if (!matchesDateInput(value, isoDate)) throw Object.assign(new Error(`Departure date mismatch: ${value}`),
    { code: 'FORM_UNCONFIRMED' });
}

async function loadCards(page, expected) {
  const locator = page.locator('[aria-label="flight card"]');
  await locator.first().waitFor({ state: 'visible', timeout: 30000 });
  let stagnant = 0, previous = -1;
  for (let attempt = 0; attempt < 8; attempt++) {
    const count = await locator.count();
    if (count >= expected) break;
    if (count === previous) stagnant++; else stagnant = 0;
    if (stagnant >= 2) break;
    previous = count;
    await locator.last().scrollIntoViewIfNeeded();
    await sleep(900);
  }
  const cards = [];
  for (const [index, element] of (await locator.all()).entries())
    cards.push({ index, text: await element.innerText(),
      times: (await element.locator('h2').allTextContents()).map(value => value.trim()),
      html: await element.evaluate(node => node.outerHTML) });
  return cards;
}

async function collectAttempt(context, query, directory, options, log, attempt) {
  const page = await context.newPage();
  const network = [];
  const flightResponses = [];
  let stage = 'browser_ready';
  const stageLog = async value => { stage = value; await log('stage', { query, attempt, stage: value }); };
  await stageLog('browser_ready');
  const siteUrl = url => {
    try { const parsed = new URL(url); return parsed.hostname.endsWith('akasaair.com') ?
      { host: parsed.hostname, path: parsed.pathname } : null; } catch { return null; }
  };
  page.on('response', response => {
    const site = siteUrl(response.url());
    if (!site) return;
    const record = { at: stamp(), ...site, method: response.request().method(),
      status: response.status() };
    if (record.status >= 400) network.push(record);
    if (site.host === 'prod-bl.qp.akasaair.com' && site.path === SEARCH_PATH &&
        record.method === 'POST') {
      const pending = response.text().then(body => ({ ...record, body })).catch(error =>
        ({ ...record, readError: error.message }));
      flightResponses.push(pending);
    }
  });
  page.on('requestfailed', request => {
    const site = siteUrl(request.url());
    if (site) network.push({ at: stamp(), ...site, method: request.method(),
      failed: request.failure()?.errorText || 'unknown' });
  });
  try {
    const markets = waitForMarketsResponse(page);
    const home = await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await stageLog('homepage_loaded');
    if (home?.status() === 403) throw Object.assign(new Error('Akasa homepage returned 403'),
      { code: 'ACCESS_DENIED' });
    const marketsResponse = await markets;
    if (!marketsResponse) throw Object.assign(new Error(`No response arrived from ${MARKETS_PATH}`),
      { code: 'MARKETS_UNAVAILABLE' });
    const marketsFailure = marketsResponseFailure(marketsResponse);
    if (marketsFailure) throw Object.assign(new Error(marketsFailure.detail), marketsFailure);
    await page.locator('input[name="From"]').waitFor({ state: 'visible', timeout: 15000 });
    await stageLog('markets_ready');
    await savePage(page, directory, `home-attempt-${attempt}`);
    await sleep(options.interactionDelayMs);
    await selectAirport(page, 'From', query.origin, options.interactionDelayMs);
    await selectAirport(page, 'To', query.destination, options.interactionDelayMs);
    await selectDate(page, query.travelDate, options.interactionDelayMs);
    const from = await page.locator('input[name="From"]').inputValue();
    const to = await page.locator('input[name="To"]').inputValue();
    const disabled = await page.locator('button[name="Search Flights"]').isDisabled();
    if (!from.endsWith(`(${query.origin})`) || !to.endsWith(`(${query.destination})`) || disabled) {
      const pageText = await page.locator('body').innerText().catch(() => '');
      const validation = pageText.match(/Please enter a valid airport\/city name|errInvalidAirportSearch/gi) || [];
      throw Object.assign(new Error(`Akasa did not confirm route/date: From=${from || 'empty'}, ` +
        `To=${to || 'empty'}, searchDisabled=${disabled}, airportErrors=${validation.length}`),
      { code: 'FORM_UNCONFIRMED' });
    }
    await stageLog('form_confirmed');
    const formEvidence = await savePage(page, directory, `form-attempt-${attempt}`);
    checkAccess(await page.locator('body').innerText(), network);
    const responseWait = page.waitForResponse(response => {
      const site = siteUrl(response.url());
      return site?.host === 'prod-bl.qp.akasaair.com' && site.path === SEARCH_PATH &&
        response.request().method() === 'POST';
    }, { timeout: 50000 }).catch(() => null);
    await page.locator('button[name="Search Flights"]').click();
    await stageLog('search_submitted');
    const response = await responseWait;
    if (!response) throw Object.assign(new Error('No Akasa flight-search response arrived'),
      { code: 'SITE_NETWORK_FAILURE' });
    if (response.status() === 403) throw Object.assign(new Error('Akasa flight search returned 403'),
      { code: 'ACCESS_DENIED' });
    if (response.status() === 429) throw Object.assign(new Error('Akasa flight search returned 429'),
      { code: 'RATE_LIMITED' });
    if (response.status() === 401) throw Object.assign(new Error('Akasa flight search returned 401'),
      { code: 'SESSION_EXPIRED' });
    if (response.status() !== 200) throw Object.assign(new Error(`Akasa flight search returned ${response.status()}`),
      { code: 'SITE_NETWORK_FAILURE' });
    const received = (await Promise.all(flightResponses)).find(item => item.status === 200 && item.body);
    if (!received) throw Object.assign(new Error('Akasa flight response body could not be read'),
      { code: 'FARE_RESPONSE_UNVERIFIED' });
    await fs.writeFile(path.join(directory, `flight-search-attempt-${attempt}.json`), received.body,
      { mode: 0o600 });
    const journeys = parseSearchResponse(received.body, query);
    if (!journeys.length) throw Object.assign(new Error('Akasa response contained no exact-route journeys'),
      { code: 'EMPTY_RESULTS' });
    await stageLog('airline_response_verified');
    await page.waitForURL(/\/flight-search/, { timeout: 30000 });
    const cards = await loadCards(page, journeys.length);
    await stageLog('results_rendered');
    const pageEvidence = await savePage(page, directory, `results-attempt-${attempt}`);
    if (!pageEvidence.html || !pageEvidence.screenshot)
      throw Object.assign(new Error('Result page evidence is incomplete'),
        { code: 'EVIDENCE_CAPTURE_FAILED' });
    const matched = matchPageCards(journeys, cards, query, stamp());
    for (const card of cards)
      await fs.writeFile(path.join(directory, `row-${String(card.index + 1).padStart(3, '0')}.html`),
        card.html, { mode: 0o600 });
    const fares = matched.fares.map(fare => ({ ...fare,
      evidence: { resultPage: pageEvidence.html,
        resultPageSha256: pageEvidence.htmlSha256,
        resultScreenshot: pageEvidence.screenshot,
        resultScreenshotSha256: pageEvidence.screenshotSha256,
        rowHtml: `row-${String(fare.rowIndex + 1).padStart(3, '0')}.html`,
        rowHtmlSha256: hash(cards[fare.rowIndex].html),
        airlineResponse: `flight-search-attempt-${attempt}.json`,
        airlineResponseSha256: hash(received.body),
        formPage: formEvidence.html,
        formPageSha256: formEvidence.htmlSha256 } }));
    const status = matched.complete ? 'ok' : 'partial';
    if (!matched.complete) await stageLog('verification_partial');
    return { status, stage, cause: matched.complete ? null :
      { code: 'RESULTS_UNVERIFIED', detail: 'Some airline journeys could not be matched to displayed cards' },
      query, collectedAt: stamp(), expectedJourneys: matched.expectedJourneys,
      pageRows: matched.pageRows, nearbyRows: matched.nearbyRows,
      fares, issues: matched.issues,
      sourcePage: page.url(), network, attempt };
  } catch (error) {
    const text = await page.locator('body').innerText().catch(() => '');
    const cause = classify(error, network, text);
    const failureEvidence = await savePage(page, directory, `failure-attempt-${attempt}`);
    await log('failure', { query, attempt, stage, cause, network });
    return { status: DENIAL.has(cause.code) ? 'blocked' : 'failed', stage, cause,
      query, collectedAt: stamp(), fares: [], issues: [], network,
      failureEvidence, attempt };
  } finally { await page.close().catch(() => {}); }
}

export async function collect(options) {
  const id = `${stamp().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const runDir = path.join(options.output, id);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  const manifest = { id, startedAt: stamp(), finishedAt: null,
    source: HOME, sourceFingerprint: await sourceFingerprint(),
    browserMode: options.mode, profile: options.profile || path.join(root, '.session', options.mode),
    proxyConfigured: Boolean(options.proxy), proxyServer: options.proxy || null,
    interactionDelayMs: options.interactionDelayMs, minIntervalMs: options.minIntervalMs,
    searches: options.searches, status: 'running' };
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  console.log(`RUN_DIR=${runDir}`);
  const log = async (event, detail) => {
    const record = { at: stamp(), event, ...detail };
    await fs.appendFile(path.join(runDir, 'events.ndjson'), JSON.stringify(record) + '\n',
      { mode: 0o600 });
    console.log(JSON.stringify(record));
  };
  let context;
  let lastSearchAt = 0;
  try {
    context = await chromium.launchPersistentContext(manifest.profile, {
      executablePath: chromeExecutable(),
      headless: options.mode === 'headless', viewport: { width: 1440, height: 900 },
      ...(options.proxy ? { proxy: { server: options.proxy,
        ...(options.proxyUser ? { username: options.proxyUser } : {}),
        ...(options.proxyPassword ? { password: options.proxyPassword } : {}) } } : {})
    });
  } catch (error) {
    const code = 'BROWSER_START_FAILED';
    await log('browser_failure', { cause: { code, detail: error.message } });
    for (const [index, query] of options.searches.entries()) {
      const directory = path.join(runDir,
        `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeJson(path.join(directory, 'result.json'), { query, status: 'failed',
        collectedAt: stamp(), fares: [], cause: { code, detail: error.message } });
    }
    manifest.status = 'failed'; manifest.finishedAt = stamp();
    await writeJson(path.join(runDir, 'manifest.json'), manifest);
    return { runDir, manifest };
  }
  try {
    for (const [index, query] of options.searches.entries()) {
      const directory = path.join(runDir,
        `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      let result;
      for (let attempt = 1; attempt <= options.retries + 1; attempt++) {
        const gap = options.minIntervalMs - (Date.now() - lastSearchAt);
        if (gap > 0) await sleep(gap);
        lastSearchAt = Date.now();
        await log('search_start', { query, attempt });
        result = await collectAttempt(context, query, directory, options, log, attempt);
        if (result.status === 'ok' || result.status === 'partial' ||
            DENIAL.has(result.cause?.code) || !RETRYABLE.has(result.cause?.code) ||
            attempt > options.retries) break;
        const backoffMs = Math.min(12000, 2000 * 2 ** (attempt - 1));
        await log('backoff', { query, attempt, cause: result.cause.code, backoffMs });
        await sleep(backoffMs);
      }
      await writeJson(path.join(directory, 'result.json'), result);
      if (result.status === 'ok') {
        try {
          const check = await verifySearch(directory);
          if (!check.ok) {
            result.status = 'failed';
            result.cause = { code: 'EVIDENCE_VERIFICATION_FAILED', detail: check.errors.join('; ') };
            result.fares = [];
            await writeJson(path.join(directory, 'result.json'), result);
          }
          await log('evidence_checked', { query, ok: check.ok, errors: check.errors });
          if (check.ok) await log('stage', { query, attempt: result.attempt, stage: 'complete' });
        } catch (error) {
          result.status = 'failed';
          result.cause = { code: 'EVIDENCE_VERIFICATION_FAILED', detail: error.message };
          result.fares = [];
          await writeJson(path.join(directory, 'result.json'), result);
          await log('evidence_checked', { query, ok: false, errors: [error.message] });
        }
      }
      await log('search_finished', { query, status: result.status, cause: result.cause,
        fareCount: result.fares.length, expectedJourneys: result.expectedJourneys ?? null });
      if (DENIAL.has(result.cause?.code)) {
        manifest.status = 'blocked';
        for (const [remainingIndex, remainingQuery] of options.searches.entries()) {
          if (remainingIndex <= index) continue;
          const skipped = path.join(runDir, `${String(remainingIndex + 1).padStart(2, '0')}-` +
            `${remainingQuery.origin}-${remainingQuery.destination}-${remainingQuery.travelDate}`);
          await fs.mkdir(skipped, { recursive: true, mode: 0o700 });
          await writeJson(path.join(skipped, 'result.json'), { query: remainingQuery,
            collectedAt: stamp(), status: 'skipped', fares: [],
            cause: { code: 'BATCH_STOPPED', detail: result.cause.code } });
        }
        break;
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
  if (manifest.status !== 'blocked') {
    const results = await Promise.all(options.searches.map(async (query, index) => {
      const file = path.join(runDir, `${String(index + 1).padStart(2, '0')}-` +
        `${query.origin}-${query.destination}-${query.travelDate}`, 'result.json');
      return JSON.parse(await fs.readFile(file));
    }));
    manifest.status = results.every(result => result.status === 'ok') ? 'complete' : 'partial';
  }
  manifest.finishedAt = stamp();
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  return { runDir, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await collect(parseArgs(process.argv.slice(2)));
    console.log(`RUN_STATUS=${result.manifest.status}`);
    if (result.manifest.status !== 'complete') process.exitCode = 2;
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 2; }
}
