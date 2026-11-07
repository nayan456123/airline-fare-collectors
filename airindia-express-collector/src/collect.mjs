#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { chromium, firefox } from 'playwright';
import { chromeExecutable } from './browser-path.mjs';
import { parseSearchResponse, extractCardsFromHtml, matchFaresToCards } from './parse.mjs';
import { verifySearch } from './verify.mjs';
import { installHttpTransport } from './http-transport.mjs';
import { resolveUserAgentProfile } from './user-agent-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = 'https://www.airindiaexpress.com/en/book-flights/';
const DENIALS = new Set(['CAPTCHA', 'ACCESS_DENIED', 'RATE_LIMITED', 'SESSION_EXPIRED', 'VERIFICATION_SERVICE_UNAVAILABLE']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const coded = (code, detail) => Object.assign(new Error(detail), { code });
const runFile = promisify(execFile);

export function retryDelayMs(lastLaunch, now, minIntervalMs, backoffMs) {
  return Math.max(backoffMs, minIntervalMs - (now - lastLaunch), 0);
}

export async function withDeadline(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(coded('TIMEOUT', `${label} exceeded ${milliseconds} ms.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

const pageText = page => withDeadline(page.locator('body').innerText({ timeout: 2500 }),
  3000, 'Read page state').catch(() => '');

export async function launchBrowser(profile, options) {
  const browserExecutable = () => chromeExecutable({ chromiumExecutable: chromium.executablePath() });
  const userAgentProfile = options.userAgentProfile === 'chrome-compatible' ?
    await resolveUserAgentProfile(browserExecutable()) : null;
  const externalChrome = options.browser === 'chrome' && !options.proxy &&
    (options.mode === 'headed' || options.browserLauncher === 'cdp');
  // Reuse the ordinary Chrome + local CDP transport already used by the
  // Air India collector. Browser sessions stay dedicated to this source.
  if (!externalChrome) {
    const engine = options.browser === 'firefox' ? firefox : chromium;
    const context = await engine.launchPersistentContext(profile, {
      ...(userAgentProfile ? { userAgent: userAgentProfile.userAgent } : {}),
      ...(options.browser === 'chrome' ? { executablePath: browserExecutable() } : {}),
      headless: options.mode === 'headless', viewport: { width: 1440, height: 900 },
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(options.disableHttp2 ? { args: ['--disable-http2'] } : {})
    });
    return { context, userAgentProfile, close: () => context.close() };
  }
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
  const chrome = spawn(browserExecutable(), [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900', ...(options.mode === 'headless' ? ['--headless'] : []),
    ...(userAgentProfile ? [`--user-agent=${userAgentProfile.userAgent}`] : []), ...(options.disableHttp2 ? ['--disable-http2'] : []), 'about:blank'
  ], { stdio: 'ignore' });
  let launchError;
  chrome.on('error', error => { launchError = error; });
  const running = () => chrome.exitCode === null && chrome.signalCode === null;
  const exitCleanup = () => { if (running()) chrome.kill('SIGTERM'); };
  const stopChrome = async () => {
    if (!running()) return;
    await new Promise(resolve => {
      let timer;
      const exited = () => { clearTimeout(timer); resolve(); };
      chrome.once('exit', exited);
      chrome.kill('SIGTERM');
      timer = setTimeout(() => {
        if (running()) chrome.kill('SIGKILL');
        chrome.off('exit', exited); resolve();
      }, 3000);
    });
  };
  const sigterm = async () => { await stopChrome(); process.exit(143); };
  const sigint = async () => { await stopChrome(); process.exit(130); };
  process.once('exit', exitCleanup);
  process.once('SIGTERM', sigterm);
  process.once('SIGINT', sigint);
  const detachCleanup = () => {
    process.off('exit', exitCleanup); process.off('SIGTERM', sigterm); process.off('SIGINT', sigint);
  };
  try {
    const deadline = Date.now() + 20000;
    let browser;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (!running()) throw new Error(`Chrome exited with code ${chrome.exitCode}, signal ${chrome.signalCode}`);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); break; }
      catch { await sleep(250); }
    }
    const context = browser?.contexts()[0];
    if (!context) throw new Error('Ordinary Chrome did not provide its dedicated persistent context.');
    let processEvidence = { pid: chrome.pid, evidenceSource: null, observedHeadlessArgument: null };
    if (process.platform === 'linux') {
      const commandLine = await fs.readFile(`/proc/${chrome.pid}/cmdline`, 'utf8').catch(() => null);
      if (commandLine) processEvidence = { pid: chrome.pid, evidenceSource: 'linux-proc-cmdline',
        observedHeadlessArgument: commandLine.split(/[\0\s]+/).find(argument => /^--headless(?:=|$)/.test(argument)) || null };
    }
    return { context, userAgentProfile, processEvidence, close: async () => {
      try { await withDeadline(browser.close(), 5000, 'Close ordinary Chrome'); }
      finally { await stopChrome(); detachCleanup(); }
    } };
  } catch (error) { await stopChrome(); detachCleanup(); throw error; }
}

export function proxyConfig(server, env = process.env) {
  if (!server) return undefined;
  let url;
  try { url = new URL(server); } catch { throw new Error('Proxy must be a valid HTTP or SOCKS URL.'); }
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new Error('Proxy must be an HTTP or SOCKS server URL without embedded credentials.');
  return { server: url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin,
    ...(env.AIX_PROXY_USERNAME ? { username: env.AIX_PROXY_USERNAME } : {}),
    ...(env.AIX_PROXY_PASSWORD ? { password: env.AIX_PROXY_PASSWORD } : {}) };
}

export function parseArgs(args) {
  const options = { searches: [], mode: 'headless', browser: 'chrome', disableHttp2: false,
    output: path.join(root, 'runs'), profile: null, interactionDelayMs: 1800,
    minIntervalMs: 20000, retries: 1, httpTransport: 'native', userAgentProfile: null, browserLauncher: null, proxy: proxyConfig(process.env.AIX_PROXY_SERVER) };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--headed') { options.mode = 'headed'; continue; }
    if (arg === '--headless') { options.mode = 'headless'; continue; }
    if (arg === '--disable-http2') { options.disableHttp2 = true; continue; }
    if (arg === '--renew-session') { options.renewSession = true; continue; }
    if (arg === '--search') {
      const value = args[++i];
      const m = /^([A-Z]{3}):([A-Z]{3}):(\d{4}-\d{2}-\d{2})$/i.exec(value || '');
      if (!m || m[1].toUpperCase() === m[2].toUpperCase() ||
          Number.isNaN(Date.parse(`${m[3]}T00:00:00Z`)) ||
          new Date(`${m[3]}T00:00:00Z`).toISOString().slice(0, 10) !== m[3])
        throw new Error(`Invalid search ${value || ''}; use DEL:BOM:YYYY-MM-DD`);
      options.searches.push({ origin: m[1].toUpperCase(), destination: m[2].toUpperCase(), travelDate: m[3] });
      continue;
    }
    const value = args[++i];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === '--output') options.output = path.resolve(value);
    else if (arg === '--profile') options.profile = path.resolve(value);
    else if (arg === '--browser') options.browser = value.toLowerCase();
    else if (arg === '--proxy') options.proxy = proxyConfig(value);
    else if (arg === '--interaction-delay-ms') options.interactionDelayMs = Number(value);
    else if (arg === '--min-interval-ms') options.minIntervalMs = Number(value);
    else if (arg === '--retries') options.retries = Number(value);
    else if (arg === '--browser-launcher') options.browserLauncher = value;
    else if (arg === '--user-agent-profile') options.userAgentProfile = value;
    else if (arg === '--http-transport') options.httpTransport = value;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.searches.length || options.searches.length > 54) throw new Error('Provide 1–54 searches.');
  if (!['chrome', 'firefox'].includes(options.browser)) throw new Error('--browser must be chrome or firefox.');
  if (options.disableHttp2 && options.browser !== 'chrome') throw new Error('--disable-http2 applies to Chrome only.');
  if (!Number.isInteger(options.interactionDelayMs) || options.interactionDelayMs < 0 || options.interactionDelayMs > 10000)
    throw new Error('Invalid interaction delay.');
  if (!Number.isInteger(options.minIntervalMs) || options.minIntervalMs < 0 || options.minIntervalMs > 3600000)
    throw new Error('Invalid search interval.');
  if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 1)
    throw new Error('--retries must be 0 or 1.');
  if (!['http1', 'native'].includes(options.httpTransport))
    throw new Error('--http-transport must be http1 or native.');
  const nativeHeadlessChrome = options.mode === 'headless' && options.browser === 'chrome' && !options.proxy;
  options.browserLauncher ??= nativeHeadlessChrome ? 'cdp' : 'playwright';
  options.userAgentProfile ??= nativeHeadlessChrome ? 'chrome-compatible' : 'native';
  if (!['native', 'chrome-compatible'].includes(options.userAgentProfile))
    throw new Error('--user-agent-profile must be native or chrome-compatible.');
  if (options.userAgentProfile === 'chrome-compatible' && (options.browser !== 'chrome' || options.mode !== 'headless' || options.proxy))
    throw new Error('chrome-compatible user-agent profile requires native headless Chrome without a proxy.');
  if (!['playwright', 'cdp'].includes(options.browserLauncher))
    throw new Error('--browser-launcher must be playwright or cdp.');
  if (options.browserLauncher === 'cdp' && (options.browser !== 'chrome' || options.mode !== 'headless' || options.proxy))
    throw new Error('cdp browser launcher requires native headless Chrome without a proxy.');
  return options;
}

export function airportTriggerSelector(which) {
  if (which === 'origin') return '[aria-label="fc-booking-origin-aria-label"]';
  if (which === 'destination') return '[aria-label="fc-booking-destination-aria-label"]';
  throw new Error('Unknown airport field.');
}

export function airportFieldLocator(page, which) {
  const marker = airportTriggerSelector(which);
  // SSR initially exposes buttons; the interactive booking widget replaces
  // them with these inputs. Wait for that transition before selecting routes.
  return page.locator(`input${marker}`).filter({ visible: true }).first();
}

export function dayAccessibleLabel(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== isoDate)
    throw new Error(`Invalid calendar date ${isoDate}`);
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric',
    timeZone: 'UTC' }).format(date).replace(/,(\s+\d{4})$/, '$1');
}

export function sanitizeUrl(raw) {
  try {
    const u = new URL(raw);
    const pathname = u.pathname.replace(/[\w-]{28,}/g, '[redacted]').slice(0, 200);
    return { host: u.hostname.toLowerCase(), path: pathname };
  } catch { return { host: null, path: null }; }
}


export function verificationDependencyMetadata(raw, fields = {}) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || !['www.google.com', 'www.gstatic.com', 'www.recaptcha.net', 'recaptcha.google.com'].includes(url.hostname) ||
      !/^\/recaptcha(?:\/|$)/.test(url.pathname)) return null;
  const metadata = { ...sanitizeUrl(raw), sourceRole: 'verification-dependency' };
  for (const name of ['method', 'resourceType', 'status']) if (fields[name] !== undefined) metadata[name] = fields[name];
  // Record only a browser error code, never a URL-bearing error message.
  if (fields.failed) metadata.failed = /^net::[A-Z0-9_]+$/.test(fields.failed) ? fields.failed : 'DEPENDENCY_REQUEST_FAILED';
  return metadata;
}

function verificationPageState(text) {
  if (/complete (?:the )?(?:re)?captcha|solve (?:the )?(?:re)?captcha|verify you are human|human verification|security challenge|(?:i'm|i am) not a robot|select all (?:images|squares)/i.test(text))
    return { code: 'CAPTCHA', detail: 'Air India Express displayed a human verification challenge.' };
  if (/could not connect to the (?:re)?captcha service|(?:re)?captcha (?:service )?(?:is )?(?:unavailable|failed to load)|unable to (?:connect to|load) (?:the )?(?:re)?captcha/i.test(text))
    return { code: 'VERIFICATION_SERVICE_UNAVAILABLE', detail: 'The page reported that its verification service could not connect or load; no interactive challenge was established.' };
  if (/\b(?:re)?captcha challenge\b/i.test(text))
    return { code: 'CAPTCHA', detail: 'Air India Express displayed a human verification challenge.' };
  return null;
}

export function isFirstParty(raw) {
  const host = sanitizeUrl(raw).host;
  return host === 'airindiaexpress.com' || host?.endsWith('.airindiaexpress.com');
}

export function isObservedHost(raw) {
  return isFirstParty(raw) || sanitizeUrl(raw).host === 'openair-california.airtrfx.com';
}

export function sourceRole(raw) {
  if (isFirstParty(raw)) return 'aix-site';
  if (/\/deeplink-service\/v2\/i5\/deeplinks(?:\/|$)/.test(sanitizeUrl(raw).path || ''))
    return 'booking-handoff';
  return /\/airports\/search(?:\/|$)/.test(sanitizeUrl(raw).path || '') ?
    'airport-suggestions' : 'aix-booking-widget';
}

export function parseBookingHandoff(body) {
  let value;
  try { value = typeof body === 'string' ? JSON.parse(body) : body; } catch { return null; }
  if (!['GET', 'POST'].includes(String(value?.method || '').toUpperCase())) return null;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return { url: url.href, method: value.method.toUpperCase() };
  } catch { return null; }
}

export function isFareResponseCandidate(record) {
  return record?.host === 'api.airindiaexpress.com' &&
    record.path === '/b2c-flightsearch/v4/fsa' && record.method === 'POST' &&
    record.status === 200 && /json/i.test(record.contentType || '');
}

export const RESULT_READINESS_MS = 120000;

export function incompleteSearchFailure(network, submittedAt, bookingHandoff) {
  const post = network.filter(item => Date.parse(item.at) >= submittedAt);
  const failed = post.find(item => item.failed && item.sourceRole !== 'verification-dependency' && ['document', 'xhr', 'fetch'].includes(item.resourceType));
  if (failed) return coded('SITE_NETWORK_FAILURE', `${failed.failed} ${failed.host}${failed.path}`);
  const pendingDocument = post.find(item => item.resourceType === 'document' && !item.status &&
    !post.some(response => response.status && response.host === item.host && response.path === item.path &&
      response.method === item.method && Date.parse(response.at) >= Date.parse(item.at)));
  if (pendingDocument) return coded('TIMEOUT',
    `Booking navigation timeout after ${RESULT_READINESS_MS} ms: no response for ${pendingDocument.host}${pendingDocument.path}; official FSA was not received.`);
  return coded('TIMEOUT', bookingHandoff ?
    `Booking handoff received, but official FSA response loading timeout after ${RESULT_READINESS_MS} ms.` :
    `Submitted search loading timeout after ${RESULT_READINESS_MS} ms: no official FSA response or completed booking handoff.`);
}

export function selectVerifiedFareResponse(items, query, cards) {
  let error;
  for (const item of [...items].reverse()) {
    if (item.metadata?.host !== 'api.airindiaexpress.com' ||
        item.metadata?.path !== '/b2c-flightsearch/v4/fsa' ||
        item.metadata?.method !== 'POST' || item.metadata?.status !== 200 ||
        !isFareResponseCandidate(item.metadata)) continue;
    try {
      const parsed = parseSearchResponse(item.body, query, { cards });
      if (!parsed?.fares.length) continue;
      const coverage = matchFaresToCards(parsed.fares, cards, query);
      return { parsed, response: item, coverage };
    } catch (cause) { error = cause; }
  }
  throw coded('FARE_RESPONSE_UNVERIFIED', error?.message ||
    'No official fare response matched the rendered results.');
}

export function selectBookingPage(pages, current, landingUrl = HOME, bookingHosts = new Set()) {
  for (const candidate of [...pages].reverse()) {
    try {
      const url = new URL(candidate.url());
      if (url.protocol !== 'https:' || candidate.isClosed?.()) continue;
      const landing = new URL(landingUrl);
      const isLanding = (url.hostname === landing.hostname && url.pathname === landing.pathname) ||
        /^\/en(?:-[a-z]{2})?\/book-flights(?:\/|$)/i.test(url.pathname);
      if (!isLanding && (isFirstParty(url.href) || bookingHosts.has(url.hostname))) return candidate;
    } catch { /* Popup may still be about:blank while the handoff resolves. */ }
  }
  return current;
}

function explicitRateLimit(text) {
  const normalized = String(text || '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
  if (/\bsearch after some time\b|\bplease try searching for flights after some time\b|\blooks like you've tried a few times\b/i.test(normalized))
    return { code: 'RATE_LIMITED', detail: 'Air India Express requested a cooldown: search after some time.' };
  return null;
}

export function classifyFailure(error, network = [], pageText = '') {
  const text = String(pageText);
  const cooldown = explicitRateLimit(text);
  if (cooldown) return cooldown;
  const aixResponses = network.filter(x => !['airport-suggestions', 'verification-dependency'].includes(x.sourceRole));
  const verification = verificationPageState(text);
  if (verification) return verification;
  if (/access denied|request blocked|not authorized to access/i.test(text) || aixResponses.some(x => x.status === 403))
    return { code: 'ACCESS_DENIED', detail: 'Air India Express denied access to the booking page or request.' };
  if (aixResponses.some(x => x.status === 429))
    return { code: 'RATE_LIMITED', detail: 'Air India Express returned HTTP 429.' };
  if (/session (?:has )?expired|session timed out|your session has ended/i.test(text) || aixResponses.some(x => x.status === 401))
    return { code: 'SESSION_EXPIRED', detail: 'The booking session expired or returned HTTP 401.' };
  if (error?.code && !['SITE_NETWORK_FAILURE', 'TIMEOUT'].includes(error.code))
    return { code: error.code, detail: error.message };
  const transport = network.find(x => x.failed && x.sourceRole !== 'verification-dependency' && ['document', 'xhr', 'fetch'].includes(x.resourceType)) ||
    network.find(x => x.failed && x.sourceRole !== 'verification-dependency');
  if (transport) return { code: 'SITE_NETWORK_FAILURE', detail: `${transport.failed} at ${transport.host || 'site'}${transport.path || ''}` };
  if (/timeout/i.test(error?.message || '')) return { code: 'TIMEOUT', detail: error.message };
  return { code: error?.code || 'SEARCH_FAILED', detail: error?.message || 'Search did not complete.' };
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function savePage(page, directory, label) {
  const [html, screenshot] = await Promise.all([
    withDeadline(page.content(), 4000, 'Save page HTML').catch(() => null),
    withDeadline(page.screenshot({ fullPage: false, timeout: 4000 }), 5000,
      'Save page screenshot').catch(() => null)
  ]);
  const evidence = {};
  if (html) {
    const name = `${label}.html`;
    await fs.writeFile(path.join(directory, name), html, { mode: 0o600 });
    evidence.html = name; evidence.htmlSha256 = sha256(html);
  }
  if (screenshot) {
    const name = `${label}.png`;
    await fs.writeFile(path.join(directory, name), screenshot, { mode: 0o600 });
    evidence.screenshot = name; evidence.screenshotSha256 = sha256(screenshot);
  }
  return evidence;
}

async function openAirport(page, which, code, delayMs) {
  const trigger = airportFieldLocator(page, which);
  await trigger.waitFor({ state: 'visible', timeout: 8000 });
  await trigger.click();
  const combo = trigger;
  await combo.waitFor({ state: 'visible', timeout: 8000 });
  await sleep(delayMs);
  await combo.fill(code);
  // The picker is populated by the site's airport suggestion service. Select
  // only an accessible option containing the requested IATA code.
  // This page has several promotional airport filters as well as the live
  // booking form. Scope selection to the exact list owned by this input.
  let controls;
  for (let tick = 0; tick < 24; tick++) {
    controls = await combo.getAttribute('aria-controls');
    if (controls && /^[\w:-]+$/.test(controls)) break;
    await sleep(100);
  }
  if (!controls || !/^[\w:-]+$/.test(controls))
    throw coded('FORM_MISMATCH', `${which} picker did not expose its own airport list.`);
  const option = page.locator(`[id="${controls}"]`).getByRole('option')
    .filter({ hasText: new RegExp(`\\b${code}\\b`, 'i') }).first();
  await option.waitFor({ state: 'visible', timeout: 12000 });
  await option.click({ timeout: 8000 });
  let selected = '';
  for (let tick = 0; tick < 20; tick++) {
    selected = await trigger.inputValue();
    if (new RegExp(`\\b${code}\\b`, 'i').test(selected)) break;
    await sleep(100);
  }
  if (!new RegExp(`\\b${code}\\b`, 'i').test(selected))
    throw coded('FORM_MISMATCH', `${which} selection did not confirm ${code}.`);
}

async function chooseDate(page, travelDate, delayMs) {
  const dateButton = page.locator('[aria-label="fc-booking-departure-date-aria-label"], [id^="date-input-"][id$="-trigger"]').filter({ visible: true }).first();
  await dateButton.waitFor({ state: 'visible', timeout: 8000 });
  await dateButton.click();
  const label = dayAccessibleLabel(travelDate);
  await page.getByRole('gridcell').first().waitFor({ state: 'visible', timeout: 5000 });
  // AIX dates have role=gridcell and suffix state text (e.g. ", , ").
  const day = page.getByRole('gridcell', { name: new RegExp(`^${label}(?:,|$)`) });
  for (let month = 0; month < 14; month++) {
    if (await day.isVisible().catch(() => false)) break;
    const next = page.locator('[aria-label="fc-booking-date-selector-next-month"]')
      .filter({ visible: true }).first();
    if (!await next.isVisible().catch(() => false))
      throw coded('CALENDAR_NAVIGATION_FAILED', `AIX calendar did not expose ${label} or a next-month control.`);
    await next.click({ timeout: 5000 });
    await sleep(Math.min(delayMs, 700));
  }
  if (!await day.isVisible().catch(() => false))
    throw coded('DATE_UNAVAILABLE', `AIX calendar did not show ${label}.`);
  if (await day.isDisabled()) throw coded('DATE_UNAVAILABLE', `AIX calendar disabled ${label}.`);
  await sleep(delayMs);
  await day.click({ timeout: 8000 });
  return label;
}

export function classifyPageState(text, network = []) {
  const resultText = String(text || '');
  const cooldown = explicitRateLimit(resultText);
  if (cooldown) return cooldown;
  const aixResponses = network.filter(x => !['airport-suggestions', 'verification-dependency'].includes(x.sourceRole));
  const verification = verificationPageState(resultText);
  if (verification) return verification;
  if (/access denied|request blocked|not authorized to access/i.test(resultText) || aixResponses.some(x => x.status === 403))
    return { code: 'ACCESS_DENIED', detail: 'Air India Express denied access to the booking page or request.' };
  if (aixResponses.some(x => x.status === 429)) return { code: 'RATE_LIMITED', detail: 'Air India Express returned HTTP 429.' };
  if (/session (?:has )?expired|session timed out|your session has ended/i.test(resultText) || aixResponses.some(x => x.status === 401))
    return { code: 'SESSION_EXPIRED', detail: 'The booking session expired or returned HTTP 401.' };
  if (/no flights found|no flights available|no results found|no data available/i.test(resultText))
    return { code: 'EMPTY_RESULTS', detail: 'The submitted search displayed an explicit empty-results message.' };
  return null;
}

// Airport autosuggest is served by the confirmed AirTRFX widget host. Keep
// its post-submit response evidence, but never mistake pre-submit suggestions
// or promo JSON for submitted search evidence.
export function shouldCaptureJsonBody({ submittedAt, responseAt, contentType, host }) {
  if (!submittedAt || !Number.isFinite(responseAt) || responseAt < submittedAt || !/json/i.test(contentType || ''))
    return false;
  return host === 'airindiaexpress.com' || host?.endsWith('.airindiaexpress.com') ||
    host === 'openair-california.airtrfx.com';
}

async function collectAttempt(context, query, directory, options, log, attempt) {
  let page = await context.newPage();
  const openedPages = new Set([page]);
  const trackPage = opened => openedPages.add(opened);
  context.on('page', trackPage);
  const network = [];
  const responseBodies = [];
  const bookingHosts = new Set();
  let bookingHandoff = null;
  const observed = raw => isObservedHost(raw) || bookingHosts.has(sanitizeUrl(raw).host);
  const role = raw => isObservedHost(raw) ? sourceRole(raw) : 'aix-booking-engine';
  const captureJobs = [];
  let submittedAt = null;
  let captureCount = 0;
  let fareCaptureCount = 0;
  const recordRequest = request => {
    const url = request.url();
    const dependency = verificationDependencyMetadata(url, { method: request.method(), resourceType: request.resourceType(),
      ...(request.failure() ? { failed: request.failure().errorText } : {}) });
    if (dependency) { network.push({ at: stamp(), ...dependency }); return; }
    if (!observed(url)) return;
    network.push({ at: stamp(), ...sanitizeUrl(url), sourceRole: role(url), method: request.method(),
      resourceType: request.resourceType(), ...(request.failure() ? { failed: request.failure().errorText } : {}) });
  };
  const removeTransport = options.httpTransport !== 'native' ? await installHttpTransport(context, {
    accepts: observed,
    record: async item => {
      const metadata = { at: stamp(), ...sanitizeUrl(item.url), sourceRole: role(item.url),
        method: item.method, resourceType: item.resourceType, transport: item.transport,
        status: item.status, failed: item.failed, responseBytes: item.bytes, responseSha256: item.sha256 };
      network.push(metadata);
      if (item.failed || item.resourceType === 'document')
        await log(item.failed ? 'http1_transport_failure' : 'http1_document_received',
          { query, attempt, ...metadata });
    }
  }) : null;
  const onResponse = response => {
    const dependency = verificationDependencyMetadata(response.url(), { method: response.request().method(),
      resourceType: response.request().resourceType(), status: response.status() });
    if (dependency) { network.push({ at: stamp(), ...dependency }); return; }
    if (!observed(response.url())) return;
    const at = stamp();
    const item = { at, ...sanitizeUrl(response.url()), method: response.request().method(),
      sourceRole: role(response.url()),
      status: response.status(), contentType: response.headers()['content-type'] || null };
    network.push(item);
    const eligible = shouldCaptureJsonBody({ submittedAt, responseAt: Date.parse(at), contentType: item.contentType,
      host: item.host }) || (submittedAt && Date.parse(at) >= submittedAt &&
        bookingHosts.has(item.host) && /json/i.test(item.contentType || ''));
    if (!eligible) return;
    const primaryFareResponse = item.host === 'api.airindiaexpress.com' &&
      item.path === '/b2c-flightsearch/v4/fsa';
    // Config, telemetry and auth responses must not exhaust the fare budget.
    if ((captureCount >= 12 && !primaryFareResponse) ||
        (primaryFareResponse && fareCaptureCount >= 2)) {
      item.bodySaved = false; item.bodyReason = 'response capture count limit reached'; return;
    }
    if (primaryFareResponse) fareCaptureCount++;
    const file = `airline-response-${String(++captureCount).padStart(2, '0')}.json`;
    const job = (async () => {
      try {
        const body = await withDeadline(response.body(), 7000, 'Capture airline response');
        if (body.length > 2 * 1024 * 1024) { item.bodySaved = false; item.bodyReason = 'response exceeds 2 MiB cap'; return; }
        if (item.sourceRole === 'booking-handoff') {
          const target = parseBookingHandoff(body.toString('utf8'));
          if (target && item.status >= 200 && item.status < 300) {
            bookingHandoff = target;
            bookingHosts.add(new URL(target.url).hostname);
            // Keep query tokens local in the saved response. Logs expose only
            // the destination host/path and the GET/POST handoff method.
            await log('booking_handoff_received', { query, attempt, method: target.method,
              destination: sanitizeUrl(target.url) });
          }
        }
        await fs.writeFile(path.join(directory, file), body, { mode: 0o600 });
        item.bodyFile = file; item.bodySha256 = sha256(body); item.bodyBytes = body.length;
        responseBodies.push({ file, body: body.toString('utf8'), metadata: item });
      } catch (error) { item.bodySaved = false; item.bodyReason = error.name || 'response body unavailable'; }
    })();
    captureJobs.push(job);
  };
  context.on('request', recordRequest);
  context.on('requestfailed', recordRequest);
  context.on('response', onResponse);

  let stage = 'browser_ready';
  const stageLog = async value => { stage = value; await log('stage', { query, attempt, stage: value }); };
  try {
    await stageLog('browser_ready');
    let home;
    try { home = await withDeadline(page.goto(HOME, { waitUntil: 'commit', timeout: 45000 }),
      46000, 'Navigate to official booking page'); }
    catch (error) {
      const state = classifyPageState(await pageText(page), network);
      throw state ? coded(state.code, state.detail) : coded('SITE_NETWORK_FAILURE', error.message);
    }
    await stageLog('homepage_commit');
    if (home?.status() === 403) throw coded('ACCESS_DENIED', 'AIX booking page returned HTTP 403.');
    await savePage(page, directory, `home-attempt-${attempt}`);
    const origin = airportFieldLocator(page, 'origin');
    const destination = airportFieldLocator(page, 'destination');
    const dateButton = page.locator('[aria-label="fc-booking-departure-date-aria-label"], [id^="date-input-"][id$="-trigger"]').filter({ visible: true }).first();
    const search = page.getByRole('button', { name: /^search$/i }).filter({ visible: true }).first();
    for (let tick = 0; tick < 60; tick++) {
      const ready = await Promise.all([origin.isVisible().catch(() => false), destination.isVisible().catch(() => false),
        dateButton.isVisible().catch(() => false), search.isVisible().catch(() => false)]);
      if (ready.every(Boolean)) break;
      const state = classifyPageState(await pageText(page), network);
      if (state) throw coded(state.code, state.detail);
      if (tick === 59) {
        const failedChunk = network.find(x => x.failed && /\.js(?:$|\/)/.test(x.path || ''));
        throw coded(failedChunk ? 'SITE_NETWORK_FAILURE' : 'FORM_NOT_READY',
          failedChunk ? `Booking widget asset failed: ${failedChunk.failed} ${failedChunk.path}` :
            'Official booking form did not become visible after navigation commit.');
      }
      await page.waitForTimeout(500);
    }
    await stageLog('form_ready');
    const accept = page.getByRole('button', { name: /^accept$/i }).filter({ visible: true }).first();
    if (await accept.isVisible().catch(() => false)) await accept.click({ timeout: 5000 });
    const journeyType = page.locator('button[aria-label^="fc-booking-journey-type"]').filter({ visible: true }).first();
    if (await journeyType.isVisible().catch(() => false) &&
        !/one[ -]?way/i.test(await journeyType.getAttribute('aria-label') || '')) {
      await journeyType.click();
      await page.getByRole('option', { name: /^one[ -]?way$/i }).click();
    }
    await sleep(options.interactionDelayMs);
    await openAirport(page, 'origin', query.origin, options.interactionDelayMs);
    await openAirport(page, 'destination', query.destination, options.interactionDelayMs);
    await chooseDate(page, query.travelDate, options.interactionDelayMs);
    const formEvidence = await savePage(page, directory, `form-attempt-${attempt}`);
    await stageLog('form_confirmed');
    if (await search.isDisabled().catch(() => true)) throw coded('FORM_MISMATCH', 'Search stayed disabled after selecting route and date.');

    submittedAt = Date.now();
    const popup = page.waitForEvent('popup', { timeout: 2500 }).catch(() => null);
    await search.click({ timeout: 8000 });
    page = await popup || page;
    await stageLog('search_submitted');
    const deadline = Date.now() + RESULT_READINESS_MS;
    let terminalState = null;
    while (Date.now() < deadline) {
      await Promise.allSettled(captureJobs);
      page = selectBookingPage(openedPages, page, HOME, bookingHosts);
      const text = await pageText(page);
      terminalState = classifyPageState(text, network);
      if (terminalState?.code === 'EMPTY_RESULTS') {
        // The SPA paints its empty-state shell while anonymous auth and FSA
        // are still pending. An empty message alone cannot end the search.
        const actual = [...responseBodies].reverse().find(item => item.metadata.host === 'api.airindiaexpress.com' &&
          item.metadata.path === '/b2c-flightsearch/v4/fsa' && isFareResponseCandidate(item.metadata));
        let emptyConfirmed = false;
        if (actual) {
          try { const parsed = parseSearchResponse(actual.body, query);
            emptyConfirmed = parsed?.fares.length === 0; } catch { /* Report invalid schema below. */ }
        }
        if (!emptyConfirmed) terminalState = null;
      }
      if (terminalState || (responseBodies.some(item => item.metadata.host === 'api.airindiaexpress.com' &&
          item.metadata.path === '/b2c-flightsearch/v4/fsa' && isFareResponseCandidate(item.metadata)) &&
          /\bIX\s?\d{1,4}\b/i.test(text))) break;
      const submittedNetwork = network.filter(x => Date.parse(x.at) >= submittedAt);
      const failed = submittedNetwork.find(x => x.failed &&
        ['document', 'xhr', 'fetch'].includes(x.resourceType) && !['airport-suggestions', 'verification-dependency'].includes(x.sourceRole));
      if (failed) throw coded('SITE_NETWORK_FAILURE', `${failed.failed} ${failed.host}${failed.path}`);
      await page.waitForTimeout(350);
    }
    await Promise.allSettled(captureJobs);
    const resultEvidence = await savePage(page, directory, `result-attempt-${attempt}`);
    await writeJson(path.join(directory, `network-attempt-${attempt}.json`), network);
    if (DENIALS.has(terminalState?.code))
      throw coded(terminalState.code, terminalState.detail);
    if (terminalState?.code === 'EMPTY_RESULTS')
      throw coded('EMPTY_RESULTS', terminalState.detail);
    const fareResponses = responseBodies.filter(item => isFareResponseCandidate(item.metadata));
    if (!fareResponses.length) throw incompleteSearchFailure(network, submittedAt, bookingHandoff);
    await stageLog('airline_response_received');
    if (!/\bIX\s?\d{1,4}\b/i.test(await pageText(page)))
      throw coded('TIMEOUT', `Official FSA received, but flight row rendering timeout after ${RESULT_READINESS_MS} ms.`);
    await stageLog('results_rendered');
    if (!formEvidence.html || !resultEvidence.html || !resultEvidence.screenshot)
      throw coded('EVIDENCE_UNAVAILABLE', 'Submitted form, result HTML or result screenshot could not be saved.');
    const resultHtml = await fs.readFile(path.join(directory, resultEvidence.html), 'utf8');
    const cards = extractCardsFromHtml(resultHtml);
    const { parsed, response: parsedResponse, coverage } = selectVerifiedFareResponse(fareResponses, query, cards);
    const evidence = {
      formPage: { file: formEvidence.html, sha256: formEvidence.htmlSha256 },
      resultPage: { file: resultEvidence.html, sha256: resultEvidence.htmlSha256 },
      resultScreenshot: { file: resultEvidence.screenshot, sha256: resultEvidence.screenshotSha256 },
      airlineResponse: { file: parsedResponse.file, sha256: parsedResponse.metadata.bodySha256 }
    };
    const metadataFile = `fare-response-metadata-attempt-${attempt}.json`;
    await writeJson(path.join(directory, metadataFile), parsedResponse.metadata);
    evidence.responseMetadata = { file: metadataFile,
      sha256: sha256(await fs.readFile(path.join(directory, metadataFile))) };
    const collectedAt = stamp();
    const fares = [];
    for (const [index, fare] of parsed.fares.entries()) {
      const card = cards.find(row => row.journeyKey === fare.journeyKey);
      const rowFile = `row-${String(index + 1).padStart(3, '0')}.html`;
      await fs.writeFile(path.join(directory, rowFile), card.html, { mode: 0o600 });
      evidence[`row${index + 1}`] = { file: rowFile, sha256: sha256(card.html) };
      fares.push({ ...fare, collectedAt, rowIndex: card.index, evidence: {
        resultPage: resultEvidence.html, resultScreenshot: resultEvidence.screenshot,
        airlineResponse: parsedResponse.file, rowHtml: rowFile } });
    }
    return { status: 'ok', stage, query, collectedAt, submittedAt: new Date(submittedAt).toISOString(),
      fares, expectedJourneys: parsed.expectedJourneys, coverage, evidence,
      network, responseFiles: responseBodies.map(x => x.file), attempt };
  } catch (error) {
    const text = await pageText(page);
    const cause = classifyFailure(error, network, text);
    // Report the failed operation before collecting best-effort artifacts;
    // an unresponsive renderer must not keep the UI stuck on its last step.
    await log('failure', { query, attempt, stage, cause });
    const failureEvidence = await savePage(page, directory, `failure-attempt-${attempt}`);
    await writeJson(path.join(directory, `network-attempt-${attempt}.json`), network);
    const result = { status: DENIALS.has(cause.code) ? 'blocked' : 'failed', stage, cause,
      query, collectedAt: stamp(), fares: [], failureEvidence, network,
      responseFiles: responseBodies.map(x => x.file), attempt };
    await writeJson(path.join(directory, 'result.json'), result);
    return result;
  } finally {
    await removeTransport?.().catch(() => {});
    context.off('request', recordRequest);
    context.off('requestfailed', recordRequest);
    context.off('response', onResponse);
    context.off('page', trackPage);
    await Promise.allSettled(captureJobs);
    await Promise.allSettled([...openedPages].map(opened =>
      withDeadline(opened.close(), 5000, 'Close search page')));
  }
}

export async function collect(options) {
  const id = `${stamp().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const runDir = path.join(options.output, id);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  const profile = options.profile || path.join(root, '.session', 'web-agents', options.browser, options.mode,
    ...(options.userAgentProfile === 'chrome-compatible' ? ['chrome-compatible'] : []), 'agent-1');
  const manifest = { id, startedAt: stamp(), finishedAt: null, source: HOME,
    sourceFingerprint: await sourceFingerprint(), browser: options.browser, browserMode: options.mode,
    browserLauncher: options.browserLauncher || 'playwright',
    browserTransport: options.browser === 'chrome' && !options.proxy &&
      (options.mode === 'headed' || options.browserLauncher === 'cdp') ?
      'external-chrome-cdp' : 'playwright-launch',
    userAgentProfile: options.userAgentProfile || 'native', userAgent: null, installedBrowserVersion: null,
    browserProcess: null,
    nativeHeadless: options.mode === 'headless',
    disableHttp2: options.disableHttp2, profile, interactionDelayMs: options.interactionDelayMs,
    httpTransport: options.httpTransport === 'native' ? 'browser-native' : 'playwright-http1-forwarder',
    renewSessionRequested: Boolean(options.renewSession),
    proxyConfigured: Boolean(options.proxy), networkName: await connectedNetworkName(),
    searches: options.searches, status: 'running' };
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  console.log(`RUN_DIR=${runDir}`);
  const log = async (event, fields) => {
    const record = { at: stamp(), event, ...fields };
    await fs.appendFile(path.join(runDir, 'events.ndjson'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(record));
  };
  let browserSession;
  let context;
  try {
    await fs.mkdir(profile, { recursive: true, mode: 0o700 });
    browserSession = await launchBrowser(profile, options);
    context = browserSession.context;
    if (browserSession.processEvidence) {
      manifest.browserProcess = browserSession.processEvidence;
      await writeJson(path.join(runDir, 'manifest.json'), manifest);
    }
    if (browserSession.userAgentProfile) {
      manifest.userAgent = browserSession.userAgentProfile.userAgent;
      manifest.installedBrowserVersion = browserSession.userAgentProfile.installedBrowserVersion;
      await writeJson(path.join(runDir, 'manifest.json'), manifest);
    }
    if (options.renewSession) {
      await context.clearCookies({ domain: /(^|\.)airindiaexpress\.com$/i });
      await log('session_renewed', { reason: 'explicit renewal of AIX cookies', profilePreserved: true });
    }
  } catch (error) {
    manifest.status = 'failed'; manifest.finishedAt = stamp();
    manifest.stopReason = { code: 'BROWSER_START_FAILED', detail: error.message };
    for (const [index, query] of options.searches.entries()) {
      const dir = path.join(runDir, `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await writeJson(path.join(dir, 'result.json'), { query, status: 'failed', fares: [],
        collectedAt: stamp(), cause: manifest.stopReason });
    }
    await writeJson(path.join(runDir, 'manifest.json'), manifest);
    return { runDir, manifest };
  }
  let stopped = false;
  let lastSubmit = 0;
  try {
    for (const [index, query] of options.searches.entries()) {
      const dir = path.join(runDir, `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const gap = options.minIntervalMs - (Date.now() - lastSubmit);
      if (lastSubmit && gap > 0) await sleep(gap);
      lastSubmit = Date.now();
      let result;
      for (let attempt = 1; attempt <= 1 + (options.retries ?? 1); attempt++) {
        await log('search_start', { query, attempt });
        result = await collectAttempt(context, query, dir, options, log, attempt);
        if (attempt === 1 + (options.retries ?? 1) || !['SITE_NETWORK_FAILURE', 'TIMEOUT', 'FORM_NOT_READY'].includes(result.cause?.code)) break;
        const delayMs = retryDelayMs(lastSubmit, Date.now(), options.minIntervalMs,
          6000 + crypto.randomInt(0, 1500));
        await log('backoff', { query, attempt, delayMs, cause: result.cause });
        if (result.stage === 'browser_ready' && result.cause?.code === 'SITE_NETWORK_FAILURE' &&
            !result.network?.some(item => [401, 403, 429].includes(item.status))) {
          await context.clearCookies({ domain: /(^|\.)airindiaexpress\.com$/i });
          await log('session_renewed', { query, attempt, reason: 'initial page transport failed without an HTTP denial',
            profilePreserved: true });
        }
        await sleep(delayMs);
        lastSubmit = Date.now();
      }
      await writeJson(path.join(dir, 'result.json'), result);
      if (result.status === 'ok') {
        const report = await verifySearch(dir).catch(error => ({ ok: false, errors: [error.message] }));
        result.evidenceVerified = report.ok;
        if (!report.ok) { result.status = 'failed'; result.fares = [];
          result.cause = { code: 'EVIDENCE_VERIFICATION_FAILED', detail: report.errors.join('; ') }; }
        await writeJson(path.join(dir, 'result.json'), result);
        await log('evidence_checked', { query, ok: report.ok, errors: report.errors });
        if (report.ok) {
          await log('stage', { query, stage: 'fare_verified', attempt: result.attempt });
          await log('stage', { query, stage: 'complete', attempt: result.attempt });
        }
      }
      await log('search_finished', { query, status: result.status, cause: result.cause || null,
        fareCount: result.fares?.length || 0 });
      if (DENIALS.has(result.cause?.code)) {
        stopped = true; manifest.status = 'blocked'; manifest.stopReason = result.cause;
        for (const [n, pending] of options.searches.entries()) if (n > index) {
          const skipped = path.join(runDir, `${String(n + 1).padStart(2, '0')}-${pending.origin}-${pending.destination}-${pending.travelDate}`);
          await fs.mkdir(skipped, { recursive: true, mode: 0o700 });
          await writeJson(path.join(skipped, 'result.json'), { query: pending, status: 'skipped', fares: [],
            cause: { code: 'BATCH_STOPPED', detail: result.cause.code } });
        }
        break;
      }
    }
  } finally { await withDeadline(browserSession.close(), 6000, 'Close browser session').catch(() => {}); }
  if (!stopped) {
    const statuses = await Promise.all(options.searches.map(async (q, index) => {
      const dir = path.join(runDir, `${String(index + 1).padStart(2, '0')}-${q.origin}-${q.destination}-${q.travelDate}`);
      return JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8')).status;
    }));
    manifest.status = statuses.every(status => status === 'ok') ? 'complete' : 'partial';
  }
  manifest.finishedAt = stamp();
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  return { runDir, manifest };
}

async function sourceFingerprint() {
  const files = ['src/collect.mjs', 'src/parse.mjs', 'src/verify.mjs', 'src/browser-path.mjs',
    'src/browser-admission.mjs', 'src/web-jobs.mjs', 'src/http-transport.mjs', 'src/user-agent-profile.mjs', 'package-lock.json'];
  const chunks = await Promise.all(files.map(file => fs.readFile(path.join(root, file))));
  return sha256(Buffer.concat(chunks));
}

async function connectedNetworkName() {
  if (process.platform !== 'linux') return null;
  try {
    const { stdout } = await runFile('nmcli', ['-t', '-f', 'active,ssid', 'dev', 'wifi'], { timeout: 2500 });
    return stdout.split('\n').find(line => line.startsWith('yes:'))?.slice(4) || null;
  } catch { return null; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await collect(parseArgs(process.argv.slice(2)));
    console.log(`RUN_STATUS=${result.manifest.status}`);
    if (result.manifest.status !== 'complete') process.exitCode = 2;
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 2; }
}
