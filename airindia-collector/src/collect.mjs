#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { extractCardsFromHtml, extractPageCards, selectMatchingResponse } from './parse.mjs';
import { verifySearch } from './verify.mjs';
import { chromeExecutable } from './browser-path.mjs';
import { resolveEntryUrl } from './entry-url.mjs';
import { resolveUserAgentProfile } from './user-agent-profile.mjs';
export { resolveEntryUrl } from './entry-url.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HANDOFF = '/in/en/refx-booking.html';
const RESULTS_WAIT_TIMEOUT_MS = 45000;
const DENIAL = new Set(['CAPTCHA', 'ACCESS_DENIED', 'RATE_LIMITED', 'SESSION_EXPIRED']);
const RETRYABLE = new Set(['TIMEOUT', 'SITE_NETWORK_FAILURE', 'FORM_UNCONFIRMED',
  'AIRPORT_PICKER_UNAVAILABLE', 'CALENDAR_NAVIGATION_FAILED', 'RESULTS_NOT_RENDERED', 'RESULTS_UNVERIFIED']);
const stamp = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const codedError = (code, detail) => Object.assign(new Error(detail), { code });

export function shouldRetrySearch(code, attempt, retries) {
  return Number.isInteger(attempt) && Number.isInteger(retries) && attempt > 0 && retries >= 0 &&
    attempt <= retries && RETRYABLE.has(code);
}

export function summarizePostSubmitNetwork(network, limit = 12) {
  return network.filter(item => item.postSubmit).slice(-limit).map(item => ({
    protocol: item.protocol || null, host: item.host || null, path: item.path || null,
    method: item.method || null, status: Number.isInteger(item.status) ? item.status : null,
    failed: item.failed || null
  }));
}

export function parseArgs(args) {
  const options = { searches: [], mode: 'headless', output: path.join(root, 'runs'),
    profile: null, proxy: null, proxyUser: null, proxyPassword: null,
    interactionDelayMs: 1800, minIntervalMs: 20000, retries: 1, externalChrome: false,
    browser: 'chrome', entryUrl: undefined, userAgentProfile: null, disableHttp2: false,
    simpleCaptcha: false, localCaptchaSolver: false, audioCaptchaSolver: false,
    deferVerification: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--headed') { options.mode = 'headed'; continue; }
    if (arg === '--headless') { options.mode = 'headless'; continue; }
    if (arg === '--external-chrome') { options.externalChrome = true; continue; }
    if (arg === '--disable-http2') { options.disableHttp2 = true; continue; }
    if (arg === '--simple-captcha') { options.simpleCaptcha = true; continue; }
    if (arg === '--local-captcha-solver') { options.localCaptchaSolver = true; continue; }
    if (arg === '--audio-captcha-solver') { options.audioCaptchaSolver = true; continue; }
    if (arg === '--defer-verification') { options.deferVerification = true; continue; }
    const value = args[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === '--search') {
      const match = /^([A-Z]{3}):([A-Z]{3}):(\d{4}-\d{2}-\d{2})$/.exec(value.toUpperCase());
      if (!match || match[1] === match[2] || Number.isNaN(Date.parse(`${match[3]}T00:00:00Z`)) ||
          new Date(`${match[3]}T00:00:00Z`).toISOString().slice(0, 10) !== match[3])
        throw new Error(`Invalid search ${value}; use DEL:BOM:YYYY-MM-DD`);
      options.searches.push({ origin: match[1], destination: match[2], travelDate: match[3] });
    } else if (arg === '--entry-url') options.entryUrl = resolveEntryUrl(value);
    else if (arg === '--output') options.output = path.resolve(value);
    else if (arg === '--browser') options.browser = value;
    else if (arg === '--user-agent-profile') options.userAgentProfile = value;
    else if (arg === '--profile') options.profile = path.resolve(value);
    else if (arg === '--proxy') options.proxy = value;
    else if (arg === '--proxy-user') options.proxyUser = value;
    else if (arg === '--proxy-password') options.proxyPassword = value;
    else if (arg === '--interaction-delay-ms') options.interactionDelayMs = Number(value);
    else if (arg === '--min-interval-ms') options.minIntervalMs = Number(value);
    else if (arg === '--retries') options.retries = Number(value);
    else throw new Error(`Unknown option ${arg}`);
  }
  options.entryUrl = resolveEntryUrl(options.entryUrl);
  if (!options.searches.length || options.searches.length > 54)
    throw new Error('Provide 1–54 searches');
  if (!Number.isInteger(options.interactionDelayMs) || options.interactionDelayMs < 0 ||
      options.interactionDelayMs > 10000) throw new Error('Invalid interaction delay');
  if (!Number.isInteger(options.minIntervalMs) || options.minIntervalMs < 0 ||
      options.minIntervalMs > 3600000) throw new Error('Invalid search interval');
  if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 2)
    throw new Error('Retries must be 0, 1, or 2');
  if (!['chrome', 'firefox'].includes(options.browser))
    throw new Error('--browser must be chrome or firefox');
  if (options.disableHttp2 && options.browser !== 'chrome')
    throw new Error('--disable-http2 is available for Chrome only');
  const nativeHeadlessChrome = options.mode === 'headless' && options.browser === 'chrome' && !options.proxy;
  if (nativeHeadlessChrome) options.externalChrome = true;
  options.userAgentProfile ??= nativeHeadlessChrome ? 'chrome-compatible' : 'native';
  if (!['native', 'chrome-compatible'].includes(options.userAgentProfile) ||
      (options.userAgentProfile === 'chrome-compatible' &&
       (options.mode !== 'headless' || !options.externalChrome || options.browser !== 'chrome' || options.proxy)))
    throw new Error('chrome-compatible user agent requires headless external Chrome without a proxy');
  if (options.simpleCaptcha && options.mode !== 'headed')
    throw new Error('--simple-captcha requires --headed');
  if (options.localCaptchaSolver && (options.simpleCaptcha || !options.externalChrome))
    throw new Error('--local-captcha-solver requires --external-chrome and cannot combine with --simple-captcha');
  if (options.audioCaptchaSolver && (options.simpleCaptcha || options.localCaptchaSolver || !options.externalChrome))
    throw new Error('--audio-captcha-solver requires --external-chrome and cannot combine with another CAPTCHA solver');
  if (options.mode !== 'headed' && (options.localCaptchaSolver || options.audioCaptchaSolver))
    throw new Error('CAPTCHA helpers require --headed');
  if (options.proxy) {
    const url = new URL(options.proxy);
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash)
      throw new Error('Proxy must be a plain HTTP, HTTPS, or SOCKS5 server URL');
  } else if (options.proxyUser || options.proxyPassword) throw new Error('Proxy credentials require --proxy');
  if (options.externalChrome && (options.proxy || options.browser !== 'chrome'))
    throw new Error('--external-chrome requires --browser chrome and no proxy');
  return options;
}

export async function navigateToEntry(page, options = {}) {
  return page.goto(resolveEntryUrl(options.entryUrl), { waitUntil: 'domcontentloaded', timeout: 45000 });
}

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export async function launchBrowser(manifest, options) {
  if (options.disableHttp2 && options.browser !== 'chrome')
    throw new Error('--disable-http2 is available for Chrome only');
  const executablePath = options.browser === 'firefox' ? null : chromeExecutable({ chromiumExecutable: chromium.executablePath() });
  const userAgentProfile = options.userAgentProfile === 'chrome-compatible' ? await resolveUserAgentProfile(executablePath) : null;
  if (!options.externalChrome) {
    const engine = options.browser === 'firefox' ? firefox : chromium;
    const context = await engine.launchPersistentContext(manifest.profile, {
      ...(options.browser === 'chrome' ? { executablePath } : {}),
      headless: options.mode === 'headless', viewport: { width: 1440, height: 900 },
      ...(options.browser === 'chrome' && options.disableHttp2 ? { args: ['--disable-http2'] } : {}),
      ...(options.proxy ? { proxy: { server: options.proxy,
        ...(options.proxyUser ? { username: options.proxyUser } : {}),
        ...(options.proxyPassword ? { password: options.proxyPassword } : {}) } } : {})
    });
    const browser = context.browser();
    const http2FlagEvidence = options.disableHttp2 ? {
      requested: true, flag: '--disable-http2',
      observed: null, evidenceSource: 'Playwright launch option'
    } : { requested: false, flag: null, observed: false, evidenceSource: 'not requested' };
    return { context, browserVersion: browser?.version() || null,
      http2FlagEvidence, close: () => context.close() };
  }
  const port = await freeLoopbackPort();
  const chrome = spawn(executablePath, [
    `--user-data-dir=${manifest.profile}`, `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900', ...(options.mode === 'headless' ? ['--headless', '--no-startup-window'] : ['about:blank']),
    ...(options.disableHttp2 ? ['--disable-http2'] : []),
    ...(userAgentProfile ? [`--user-agent=${userAgentProfile.userAgent}`] : [])
  ], { stdio: 'ignore' });
  let launchError = null;
  chrome.on('error', error => { launchError = error; });
  const running = () => chrome.exitCode === null && chrome.signalCode === null;
  const stopChrome = async () => {
    if (!running()) return;
    await new Promise(resolve => {
      let timer;
      const done = () => { clearTimeout(timer); resolve(); };
      chrome.once('exit', done);
      chrome.kill('SIGTERM');
      timer = setTimeout(() => { if (running()) chrome.kill('SIGKILL'); chrome.off('exit', done); resolve(); }, 3000);
    });
  };
  const onExit = () => { if (running()) chrome.kill('SIGTERM'); };
  const onTerm = async () => { await stopChrome(); process.exit(143); };
  const onInt = async () => { await stopChrome(); process.exit(130); };
  process.once('exit', onExit); process.once('SIGTERM', onTerm); process.once('SIGINT', onInt);
  const detach = () => { process.off('exit', onExit); process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); };
  try {
    let browser;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (launchError) throw launchError;
      if (!running()) throw new Error(chrome.signalCode ?
        `Chrome exited from signal ${chrome.signalCode}` : `Chrome exited with code ${chrome.exitCode}`);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 }); break; }
      catch { await sleep(250); }
    }
    if (!browser) throw new Error('Chrome debugging endpoint did not become ready');
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome did not provide a persistent browser context');
    if (options.mode === 'headless' && context.pages().length) {
      await Promise.all(context.pages().map(page => page.close().catch(() => {})));
      throw new Error('Headless Chrome restored profile tabs despite --no-startup-window; refusing to continue');
    }
    let processEvidence = null;
    if (process.platform === 'linux') {
      const commandLine = await fs.readFile(`/proc/${chrome.pid}/cmdline`, 'utf8').catch(() => '');
      const environment = await fs.readFile(`/proc/${chrome.pid}/environ`, 'utf8').catch(() => null);
      processEvidence = { pid: chrome.pid, evidenceSource: 'linux-proc-cmdline',
        observedHeadlessArgument: commandLine.split(/[\0\s]+/).find(arg => /^--headless(?:=|$)/.test(arg)) || null,
        observedDisableHttp2Argument: commandLine.split(/[\0\s]+/).find(arg => arg === '--disable-http2') || null,
        displayPresent: environment === null ? null : environment.split('\0').some(value => value.startsWith('DISPLAY=')),
        waylandDisplayPresent: environment === null ? null : environment.split('\0').some(value => value.startsWith('WAYLAND_DISPLAY=')) };
    }
    const http2FlagEvidence = options.disableHttp2 ? {
      requested: true, flag: '--disable-http2',
      observed: processEvidence ? processEvidence.observedDisableHttp2Argument === '--disable-http2' : null,
      evidenceSource: processEvidence ? processEvidence.evidenceSource : 'launch arguments'
    } : { requested: false, flag: null, observed: false, evidenceSource: 'not requested' };
    return { context, browserVersion: browser.version(), processEvidence, http2FlagEvidence, userAgentProfile, cdpUrl: `http://127.0.0.1:${port}`, close: async () => {
      try { await browser.close().catch(() => {}); }
      finally { await stopChrome(); detach(); }
    } };
  } catch (error) {
    await stopChrome(); detach();
    throw error;
  }
}

async function sourceFingerprint() {
  const files = ['src/collect.mjs', 'src/parse.mjs', 'src/verify.mjs', 'src/web-jobs.mjs',
    'src/browser-path.mjs', 'src/entry-url.mjs', 'src/user-agent-profile.mjs', 'src/local_recaptcha_solver.py',
    'src/local_audio_solver.py', 'package-lock.json'];
  return hash(Buffer.concat(await Promise.all(files.map(file => fs.readFile(path.join(root, file))))));
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

async function runLocalSolver(cdpUrl, directory, mode = 'image') {
  const executable = process.env.AIRINDIA_SOLVER_PYTHON || 'python3';
  const script = path.join(root, 'src', mode === 'audio' ? 'local_audio_solver.py' : 'local_recaptcha_solver.py');
  const resultFile = path.join(directory, 'local-solver-result.json');
  await fs.rm(resultFile, { force: true });
  return new Promise(resolve => {
    const child = spawn(executable, [script, '--cdp', cdpUrl, '--out', directory],
      { stdio: 'ignore' });
    let done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ status: 'timeout', detail: 'Local solver exceeded 180 seconds' });
    }, 180000);
    child.on('error', error => finish({ status: 'failed', detail: error.message }));
    child.on('close', async code => {
      try {
        const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
        finish({ status: result.status, detail: result.error?.detail || null, exitCode: code });
      } catch (error) {
        finish({ status: 'failed', detail: `Local solver exited ${code}; result read failed: ${error.code || error.name}` });
      }
    });
  });
}

function classify(error, network, text = '', { visibleChallenge = null, siteError = false } = {}) {
  if (/access denied|you don't have permission|request blocked/i.test(text))
    return { code: 'ACCESS_DENIED', detail: 'Air India displayed an access denial' };
  const denial = network.findLast(item => [401, 403, 429].includes(item.status) &&
    ((item.path === HANDOFF && item.method === 'POST') ||
      (item.navigationResponse === true && item.method === 'GET') ||
      (item.fareResponse === true && (item.cdpCorrelated !== true || item.postSubmit === true))));
  if (denial) {
    const code = { 401: 'SESSION_EXPIRED', 403: 'ACCESS_DENIED', 429: 'RATE_LIMITED' }[denial.status];
    return { code, detail: `Air India search request returned HTTP ${denial.status}` };
  }
  if (visibleChallenge === true || (visibleChallenge === null &&
      /verify you are human|please check the box below|captcha|security challenge/i.test(text)))
    return { code: 'CAPTCHA', detail: 'Air India displayed a human verification challenge' };
  if (siteError) return { code: 'SITE_ERROR', detail: 'Air India reported an unexpected issue processing the flight request' };
  if (error.code === 'ERR_HTTP2_PROTOCOL_ERROR')
    return { code: 'SITE_NETWORK_FAILURE', detail: error.message };
  if (error.code) return { code: error.code, detail: error.message };
  if (/ERR_CERT_|CERTIFICATE_VERIFY_FAILED/i.test(error.message))
    return { code: 'TLS_TRUST_FAILURE', detail: error.message };
  if (/timeout/i.test(error.message)) return { code: 'TIMEOUT', detail: error.message };
  if (network.some(item => item.failed)) return { code: 'SITE_NETWORK_FAILURE', detail: error.message };
  return { code: 'SEARCH_FAILED', detail: error.message };
}

export function classifyFailure(error, network, text = '') {
  const cause = classify(error, network, text);
  if (error.code && cause.code === error.code) cause.detail = error.message;
  return cause;
}

export async function readPageAccessState(page) {
  return page.evaluate(() => {
    const visible = node => {
      if (!node || !node.getClientRects().length) return false;
      for (let current = node; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
      }
      const rect = node.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      const top = document.elementFromPoint(x, y);
      return !!top && (node.contains(top) || top.contains(node));
    };
    const ready = visible(document.body);
    const explicitText = /verify you are human|please check the box below|security challenge/i;
    const challenge = ready && [...document.querySelectorAll('h1,h2,h3,p,label,iframe[title*="reCAPTCHA"],iframe[title*="challenge"]')]
      .some(node => visible(node) && (node.tagName === 'IFRAME' || explicitText.test(node.innerText || '')));
    const siteError = ready && [...document.querySelectorAll('.ai-pb-no-flights-title')]
      .some(node => visible(node) && /^something went wrong$/i.test(node.innerText.trim()) &&
        /system is facing an unexpected issue/i.test(node.parentElement.innerText));
    return { ready, text: ready ? document.body.innerText : '', visibleChallenge: challenge, siteError };
  }).catch(() => ({ ready: false, text: '', visibleChallenge: false }));
}

export async function classifyPageFailure(page, error, network) {
  const state = await readPageAccessState(page);
  return classify(error, network, state.text, state);
}

export async function prepareBookingInteraction(page, target) {
  // Dismiss ordinary navigation without forcing clicks or changing overlays.
  await page.keyboard.press('Escape');
  const viewport = page.viewportSize();
  await page.mouse.move(Math.max(1, (viewport?.width || 1440) - 10),
    Math.max(1, (viewport?.height || 900) - 10));
  await target.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
}

export async function selectOneWay(page, delayMs = 0) {
  const selector = 'input[value="one-way"]';
  const input = page.locator(selector).first();
  await input.waitFor({ state: 'attached', timeout: 20000 });
  await sleep(delayMs);
  if (await input.isVisible()) {
    await input.check();
    if (!await input.isChecked()) throw codedError('FORM_UNCONFIRMED', 'One Way was not selected');
    return;
  }
  const label = page.locator('label').filter({ has: page.locator(selector) })
    .filter({ visible: true }).first();
  await label.waitFor({ state: 'visible', timeout: 10000 });
  await prepareBookingInteraction(page, label);
  try { await label.click({ timeout: 3000 }); }
  catch {
    await prepareBookingInteraction(page, label);
    await label.click({ timeout: 7000 });
  }
  if (!await label.locator(selector).isChecked())
    throw codedError('FORM_UNCONFIRMED', 'One Way was not selected');
}

export async function confirmSelectedAirport(field, code, city,
  { timeoutMs = 5000, pollingMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const input = field.locator('input[role="combobox"]');
  let state;
  do {
    state = { code: (await input.inputValue()).trim(),
      city: (await field.locator('.ai-origin-destination__bottom-label').innerText()).trim(),
      expanded: await input.getAttribute('aria-expanded') };
    if (state.code === code && state.city.toUpperCase() === city.toUpperCase() && state.expanded === 'false')
      return { code, city: state.city };
    await sleep(pollingMs);
  } while (Date.now() < deadline);
  throw codedError('FORM_UNCONFIRMED', `Airport ${code} did not finish selection: ${JSON.stringify(state)}`);
}

export async function selectAirport(page, label, code, delayMs = 0) {
  const homepageField = page.locator(label === 'FROM'
    ? '.ai-origin-destination__field-container[aria-label="Select origin airport"]'
    : '.ai-origin-destination__field-container[aria-label="Select destination airport"]')
    .filter({ visible: true }).first();
  if (await homepageField.count()) {
    const input = homepageField.locator('input[role="combobox"]');
    await input.click({ timeout: 10000 });
    await input.fill('');
    await input.fill(code);
    const option = page.getByRole('option').filter({
      has: page.locator(`.ai-autocomplete-option__airport-code:text-is("${code}")`)
    }).first();
    await option.waitFor({ state: 'visible', timeout: 10000 });
    const city = (await option.locator('.ai-autocomplete-option__city').innerText()).split(',')[0].trim();
    if (!city) throw codedError('FORM_UNCONFIRMED', `Airport ${code} option has no city`);
    await sleep(delayMs);
    try { await option.click({ timeout: 5000 }); }
    catch (error) {
      // The widget can commit the origin and focus the destination while its
      // original option is disappearing. Accept only the exact committed
      // airport, never the typed code or another field's autocomplete.
      try { return await confirmSelectedAirport(homepageField, code, city, { timeoutMs: 1000 }); }
      catch { /* A missing commit requires a fresh selection below. */ }
      await input.click({ timeout: 10000 });
      await input.fill('');
      await input.fill(code);
      await option.waitFor({ state: 'visible', timeout: 10000 });
      await option.click({ timeout: 5000 });
    }
    await option.waitFor({ state: 'hidden', timeout: 10000 });
    return confirmSelectedAirport(homepageField, code, city);
  }
  const open = page.getByRole('button', { name: label, exact: true }).first();
  await open.click({ timeout: 10000 });
  const input = page.getByPlaceholder('Search airport...');
  await input.fill(code);
  const option = page.locator('button').filter({ has: page.locator(`div:text-is("${code}")`) }).last();
  const waitForOption = async () => {
    try { await option.waitFor({ state: 'visible', timeout: 10000 }); }
    catch { throw codedError('AIRPORT_PICKER_UNAVAILABLE',
      `Air India did not show airport ${code} in the ${label} picker`); }
  };
  await waitForOption();
  await sleep(delayMs);
  if (!await input.isVisible().catch(() => false)) {
    await open.click({ timeout: 10000 });
    await input.fill(code);
    await waitForOption();
  }
  let clickError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await option.waitFor({ state: 'visible', timeout: 5000 });
      await option.click({ timeout: 7000 });
      clickError = null;
      break;
    } catch (error) {
      clickError = error;
      if (attempt === 0) {
        if (!await input.isVisible().catch(() => false)) await open.click({ timeout: 5000 });
        await input.fill(code);
      }
    }
  }
  if (clickError) throw codedError('AIRPORT_PICKER_UNAVAILABLE',
    `Air India showed airport ${code}, but the ${label} choice could not be selected: ` +
    clickError.message.split('\n')[0]);
  const selected = await page.locator('button').filter({ has: page.locator(`div:text-is("${code}")`) })
    .first().innerText().catch(() => '');
  if (!selected.includes(code)) throw codedError('FORM_UNCONFIRMED', `${label} did not confirm ${code}`);
}

export async function selectDate(page, isoDate, delayMs = 0) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
  const option = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
  const day = String(date.getUTCDate());
  const homepage = page.locator('.ai-booking-widget--desktop.ai-booking-widget--homepage')
    .filter({ visible: true }).first();
  if (await homepage.count()) {
    // The same button also contains Add Return. Its center can open return
    // selection; target the visible departure field itself.
    await homepage.locator('button[aria-label="Open date picker"] .ai-booking-widget__date-field')
      .first().click({ timeout: 10000 });
    const calendar = page.locator('.ai-date-picker').filter({ visible: true }).first();
    await calendar.waitFor({ state: 'visible', timeout: 10000 });
    if (!await calendar.getByRole('heading', { name: 'Select Departure Date', exact: true }).isVisible())
      throw codedError('FORM_UNCONFIRMED', 'The calendar did not open departure-date selection');
    const oneWay = calendar.locator('input[name="isOneWay"]');
    if (await oneWay.count() && !await oneWay.isChecked())
      throw codedError('FORM_UNCONFIRMED', 'The departure calendar opened in return-trip mode');
    const dateName = `${date.getUTCMonth() + 1}/${day}/${date.getUTCFullYear()}`;
    const dateButton = calendar.getByRole('button', { name: dateName, exact: true });
    for (let step = 0; step < 18 && !await dateButton.isVisible().catch(() => false); step++) {
      const next = calendar.getByRole('button', { name: 'Next month', exact: true });
      if (!await next.isEnabled().catch(() => false)) break;
      await next.click({ timeout: 10000 });
      await sleep(Math.max(delayMs, 250));
    }
    if (!await dateButton.isVisible().catch(() => false) || !await dateButton.isEnabled())
      throw codedError('CALENDAR_NAVIGATION_FAILED', `The calendar did not offer ${isoDate}`);
    await dateButton.click({ timeout: 10000 });
    // The homepage one-way picker commits and closes on date selection. Other
    // widget versions keep an explicit confirmation button. Support both, then
    // verify the committed date and trip mode rather than trusting the click.
    const confirm = calendar.getByRole('button', { name: 'Confirm', exact: true });
    const commitDeadline = Date.now() + 10000;
    while (await calendar.isVisible().catch(() => false)) {
      if (await confirm.isVisible().catch(() => false) && await confirm.isEnabled()) {
        await confirm.click({ timeout: 10000 });
        break;
      }
      if (Date.now() >= commitDeadline)
        throw codedError('FORM_UNCONFIRMED', 'The departure calendar did not commit the selected date');
      await sleep(100);
    }
    await calendar.waitFor({ state: 'hidden', timeout: 10000 });
    await sleep(delayMs);
    await confirmBookingForm(page, { travelDate: isoDate }, { dateOnly: true });
    return;
  }
  await page.getByRole('button', { name: /Depart\s*Select Date/ }).first().click({ timeout: 10000 });
  const monthHeading = page.locator('h4').filter({ hasText: month }).filter({ visible: true });
  if (!await monthHeading.count()) {
    const selector = page.locator('select').filter({ has: page.locator(`option[value="${option}"]`) }).first();
    await selector.selectOption(option);
  }
  const calendar = page.locator('h4').filter({ hasText: month }).filter({ visible: true }).last().locator('..');
  const dayButton = calendar.getByRole('button', { name: day, exact: true });
  await dayButton.click({ timeout: 10000 });
  await page.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 10000 });
  await sleep(delayMs);
  const actual = await page.getByRole('button', { name: /Depart/i }).first().innerText();
  const expected = `${day.padStart(2, '0')} ${new Intl.DateTimeFormat('en-US',
    { month: 'short', timeZone: 'UTC' }).format(date).toUpperCase()} ${date.getUTCFullYear()}`;
  if (!actual.includes(expected)) throw codedError('FORM_UNCONFIRMED',
    `Departure date displayed ${actual.replace(/\s+/g, ' ')} instead of ${expected}`);
}

export async function confirmBookingForm(page, query, { dateOnly = false, airportSelections = {} } = {}) {
  const date = new Date(`${query.travelDate}T12:00:00Z`);
  const dateLabel = `${String(date.getUTCDate()).padStart(2, '0')} ${new Intl.DateTimeFormat('en-US',
    { month: 'short', timeZone: 'UTC' }).format(date).toUpperCase()} ${date.getUTCFullYear()}`;
  const normalized = text => text.replace(/,/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  const homepage = page.locator('.ai-booking-widget--desktop.ai-booking-widget--homepage')
    .filter({ visible: true }).first();
  if (await homepage.count()) {
    const dates = normalized(await homepage.locator('button[aria-label="Open date picker"]').innerText());
    const oneWay = homepage.locator('input[value="one-way"]');
    if (!dates.includes(dateLabel) || !/ADD RETURN/.test(dates) || !await oneWay.isChecked())
      throw codedError('FORM_UNCONFIRMED', 'The homepage did not confirm the requested one-way departure date');
    if (!dateOnly) {
      for (const [field, expected] of [['origin', query.origin], ['destination', query.destination]]) {
        const container = homepage.locator(`.ai-origin-destination__field-container[aria-label="Select ${field} airport"]`);
        const input = container.locator('input[role="combobox"]');
        const actual = await input.inputValue();
        const city = (await container.locator('.ai-origin-destination__bottom-label').innerText()).trim();
        if (actual.trim() !== expected || await input.getAttribute('aria-expanded') !== 'false' ||
            !city || /^(Origin|Destination)$/i.test(city) ||
            (airportSelections[field] && city.toUpperCase() !== airportSelections[field].city.toUpperCase()))
          throw codedError('FORM_UNCONFIRMED', `The homepage ${field} changed after selection`);
      }
    }
    return homepage;
  }
  const widget = page.locator('.ai-booking-widget').first();
  const text = normalized(await widget.innerText());
  if (!text.includes(dateLabel) || (!dateOnly && ![query.origin, query.destination].every(code =>
      new RegExp(`\\b${code}\\b`).test(text))))
    throw codedError('FORM_UNCONFIRMED', 'The booking form changed after the cookie dialog');
  if (!await widget.locator('input[value="one-way"]').isChecked())
    throw codedError('FORM_UNCONFIRMED', 'The booking form is no longer one way');
  return widget;
}

export async function waitForMatchingResults(pageOrGet, responses, query, network,
  { timeoutMs = RESULTS_WAIT_TIMEOUT_MS, pollingMs = 1000, onSiteError = null, onSiteRetry = null,
    onNetworkSnapshot = null, siteErrorSettleMs = 0, diagnostics = null, now = Date.now } = {}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let previousMatch = null;
  let previousPage = null;
  let siteRetriedAt = null;
  let lastSiteError = false;
  let pageReady = false;
  let cardCount = null;
  let sawCards = false;
  let matchSnapshots = 0;
  let comparisonError = null;
  let comparisonErrorCode = null;
  let responseCandidates = responses.length;
  while (now() < deadline) {
    await onNetworkSnapshot?.();
    const page = typeof pageOrGet === 'function' ? pageOrGet() : pageOrGet;
    const state = await readPageAccessState(page);
    pageReady = state.ready;
    let access = classify(new Error('Air India results check'), network, state.text,
      state);
    if (DENIAL.has(access.code)) throw codedError(access.code, access.detail);
    lastSiteError = access.code === 'SITE_ERROR';
    if (access.code === 'SITE_ERROR') {
      const retry = page.locator('button#ai-pb-air-bound-retry-button');
      if (siteRetriedAt === null) {
        if (siteErrorSettleMs > 0) {
          await page.waitForTimeout(siteErrorSettleMs);
          await onNetworkSnapshot?.();
          access = classify(new Error('Air India results check'), network, state.text, state);
          if (DENIAL.has(access.code)) throw codedError(access.code, access.detail);
          lastSiteError = access.code === 'SITE_ERROR';
        }
        if (access.code !== 'SITE_ERROR') continue;
        await onSiteError?.();
        if (!await retry.isVisible().catch(() => false) || !await retry.isEnabled())
          throw codedError('SITE_ERROR', access.detail);
        siteRetriedAt = now();
        await retry.click({ timeout: Math.max(1, Math.min(5000, deadline - now())) });
        await onSiteRetry?.();
        previousMatch = null;
      }
      await page.waitForTimeout(pollingMs);
      continue;
    }
    cardCount = state.ready ? await page.locator('.ai-pb-flight-card-wrapper').count() : 0;
    responseCandidates = responses.length;
    if (cardCount > 0) sawCards = true;
    if (state.ready && responses.length && cardCount > 0) {
      try {
        const cards = await extractPageCards(page);
        const offer = selectMatchingResponse(responses, cards, query);
        const currentMatch = JSON.stringify([cards, offer.body]);
        comparisonError = null;
        comparisonErrorCode = null;
        matchSnapshots = currentMatch === previousMatch && page === previousPage ? matchSnapshots + 1 : 1;
        if (matchSnapshots >= 2) return true;
        previousMatch = currentMatch;
        previousPage = page;
      } catch (error) {
        comparisonErrorCode = error.code || null;
        comparisonError = `${error.code || error.name || 'MATCH_FAILED'}: ${String(error.message || error).slice(0, 240)}`;
        matchSnapshots = 0;
        previousMatch = null;
        previousPage = null;
      }
    } else {
      matchSnapshots = 0;
      previousMatch = null;
      previousPage = null;
    }
    try { await page.waitForTimeout(pollingMs); }
    catch (error) {
      if (typeof pageOrGet !== 'function' || pageOrGet() === page) throw error;
    }
  }
  if (diagnostics) {
    const reason = !pageReady ? 'page_not_ready' : cardCount === 0 ? 'no_cards' :
      responseCandidates === 0 ? 'no_response_candidates' : matchSnapshots === 1 ? 'single_matching_snapshot' :
      'fare_response_page_mismatch';
    Object.assign(diagnostics, { reason, timeoutMs, elapsedMs: Math.max(0, now() - startedAt),
      pageReady, cardCount, sawCards, responseCandidates, matchSnapshots,
      ...(comparisonError ? { comparisonError, comparisonErrorCode } : {}) });
  }
  if (lastSiteError) throw codedError('SITE_ERROR',
    'Air India still reported an unexpected issue after the single page Retry and bounded results wait');
  return false;
}

// Deliberately omit credentials, ports, query strings, fragments, and payloads.
export function airIndiaLocation(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      (url.hostname === 'airindia.com' || url.hostname.endsWith('.airindia.com'))
      ? { protocol: url.protocol, host: url.hostname, path: url.pathname } : null;
  } catch { return null; }
}

export function isMainFrameNavigation(request, page) {
  try { return request.isNavigationRequest() && request.frame() === page.mainFrame(); }
  catch { return false; }
}

export function describeAirIndiaResponse(response, statuses = new WeakMap()) {
  const target = airIndiaLocation(response.url());
  if (!target) return null;
  const request = response.request();
  statuses.set(request, response.status());
  const redirects = [];
  for (let previous = request.redirectedFrom(); previous; previous = previous.redirectedFrom()) {
    const location = airIndiaLocation(previous.url());
    if (location) redirects.unshift({ ...location, status: statuses.get(previous) ?? null });
  }
  let redirectTo = null;
  if (response.status() >= 300 && response.status() < 400) {
    try {
      const location = response.headers().location;
      if (location) redirectTo = airIndiaLocation(new URL(location, response.url()).href);
    }
    catch { /* Missing or invalid Location must not interrupt evidence capture. */ }
  }
  return { ...target, method: request.method(), status: response.status(), redirects,
    ...(redirectTo ? { redirectTo } : {}) };
}

export function isFareResponsePath(target, contentType) {
  if (target.host === 'api.airindia.com' &&
      ['/cbiz-booking/v2/prime/search/air-bounds', '/cbiz-booking/v2/prime/search/air-calendar'].includes(target.path)) return true;
  return /json/i.test(contentType || '') && /availability|offer|flight|journey|shopping/i.test(target.path) && !target.path.startsWith('/nNnW/');
}

const isFareApiRequest = value => {
  const target = airIndiaLocation(value);
  return target?.host === 'api.airindia.com' &&
    ['/cbiz-booking/v2/prime/search/air-bounds', '/cbiz-booking/v2/prime/search/air-calendar'].includes(target.path);
};

function sanitizedHttpLocation(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return { protocol: url.protocol, host: url.hostname.toLowerCase(), path: url.pathname };
  } catch { return null; }
}

// Capture only status and failure metadata for the current fare endpoints. CDP
// requestIds stay in memory and let us join ExtraInfo even when CORS prevents
// Playwright from constructing a Response. Headers and bodies are never read.
export function createCdpFareNetworkCapture({ getSession, submittedAt = () => null,
  isTrackedRequest = isFareApiRequest, getSessionTimeoutMs = 1000,
  commandTimeoutMs = 1000, detachTimeoutMs = 500, extraInfoWaitMs = 1000 } = {}) {
  const sessions = new Set();
  const sessionStates = new Map();
  const materializedRecords = new Map();
  const pending = new Set();
  let closed = false;
  const withTimeout = (promise, timeoutMs) => {
    let timer;
    return Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('CDP diagnostic operation timed out')), timeoutMs);
    })]).finally(() => clearTimeout(timer));
  };
  const detach = session => withTimeout(Promise.resolve().then(() => session.detach()), detachTimeoutMs)
    .catch(() => {});

  const attach = page => {
    if (closed) return Promise.resolve();
    const task = (async () => {
      let session;
      const sessionPromise = Promise.resolve().then(() => getSession(page));
      try { session = await withTimeout(sessionPromise, getSessionTimeoutMs); }
      catch {
        void sessionPromise.then(lateSession => detach(lateSession)).catch(() => {});
        return;
      }
      if (!session || closed) { await detach(session); return; }
      if (sessionStates.size >= 16) { await detach(session); return; }
      sessions.add(session);
      const sessionState = { requests: new Map(), earlyExtraInfo: new Map() };
      sessionStates.set(session, sessionState);
      const recordFor = params => {
        let state = sessionState.requests.get(params.requestId);
        if (!state) {
          const url = params.request?.url;
          if (!url || !isTrackedRequest(url)) return null;
          const target = sanitizedHttpLocation(url);
          if (!target) return null;
          const wallTime = params.wallTime;
          const requestStartedAt = Number.isFinite(wallTime) ? new Date(wallTime * 1000).toISOString() : null;
          state = { requestId: params.requestId, ...target, method: params.request.method,
            requestStartedAt, status: null, failed: null, corsError: null, blockedReason: null,
            hasExtraInfo: false, extraInfoReceived: false, ambiguousRedirect: Boolean(params.redirectResponse) };
          const early = sessionState.earlyExtraInfo.get(params.requestId);
          if (early) {
            if (!params.redirectResponse) state.status = early.status;
            state.extraInfoReceived = true;
            sessionState.earlyExtraInfo.delete(params.requestId);
          }
          sessionState.requests.set(params.requestId, state);
          while (sessionState.requests.size > 500)
            sessionState.requests.delete(sessionState.requests.keys().next().value);
        }
        return state;
      };
      const request = params => {
        const prior = sessionState.requests.get(params.requestId);
        if (prior && params.redirectResponse) {
          prior.ambiguousRedirect = true;
          prior.status = null;
        }
        recordFor(params);
      };
      const response = params => {
        const state = recordFor(params);
        if (state) {
          if (!state.ambiguousRedirect && Number.isFinite(params.response?.status)) state.status = params.response.status;
          state.hasExtraInfo ||= params.hasExtraInfo === true;
        }
      };
      const extraInfo = params => {
        const state = sessionState.requests.get(params.requestId);
        if (state) {
          if (!state.ambiguousRedirect && Number.isFinite(params.statusCode)) state.status = params.statusCode;
          state.extraInfoReceived = true;
        } else {
          sessionState.earlyExtraInfo.set(params.requestId, {
            status: Number.isFinite(params.statusCode) ? params.statusCode : null
          });
          while (sessionState.earlyExtraInfo.size > 200)
            sessionState.earlyExtraInfo.delete(sessionState.earlyExtraInfo.keys().next().value);
        }
      };
      const failed = params => {
        const state = sessionState.requests.get(params.requestId);
        if (!state) return;
        state.failed = /^[A-Za-z0-9_.:-]{1,80}$/.test(params.errorText || '') ? params.errorText : 'network_failed';
        const cors = params.corsErrorStatus?.corsError;
        const safeEnum = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value)
          ? value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase() : null;
        state.corsError = safeEnum(cors);
        state.blockedReason = safeEnum(params.blockedReason);
      };
      session.on('Network.requestWillBeSent', request);
      session.on('Network.responseReceived', response);
      session.on('Network.responseReceivedExtraInfo', extraInfo);
      session.on('Network.loadingFailed', failed);
      try { await withTimeout(session.send('Network.enable'), commandTimeoutMs); }
      catch {
        session.off('Network.requestWillBeSent', request);
        session.off('Network.responseReceived', response);
        session.off('Network.responseReceivedExtraInfo', extraInfo);
        session.off('Network.loadingFailed', failed);
        sessions.delete(session);
        sessionStates.delete(session);
        await detach(session);
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  };

  const snapshot = network => {
    for (const sessionState of sessionStates.values()) for (const state of sessionState.requests.values()) {
      if (!(state.status >= 400 || state.failed)) continue;
      let record = materializedRecords.get(state);
      if (!record) {
        if (materializedRecords.size >= 500) continue;
        record = { at: stamp(), protocol: state.protocol, host: state.host, path: state.path,
          method: state.method, status: null, requestStartedAt: state.requestStartedAt,
          postSubmit: Boolean(submittedAt() && state.requestStartedAt &&
            Date.parse(state.requestStartedAt) >= Date.parse(submittedAt())),
          fareResponse: true, cdpCorrelated: true };
        materializedRecords.set(state, record);
        network.push(record);
      }
      record.status = Number.isFinite(state.status) ? state.status : null;
      if (state.failed) record.failed = state.failed;
      else delete record.failed;
      if (state.corsError) record.corsError = state.corsError;
      if (state.blockedReason) record.blockedReason = state.blockedReason;
    }
  };

  const flush = async network => {
    await Promise.allSettled([...pending]);
    // ExtraInfo can follow loadingFailed; honor the response's explicit promise
    // that extra information is forthcoming, with a finite wait for a lost event.
    const extraInfoDeadline = Date.now() + extraInfoWaitMs;
    while (Date.now() < extraInfoDeadline && [...sessionStates.values()].some(sessionState =>
      [...sessionState.requests.values()].some(state => state.hasExtraInfo && !state.extraInfoReceived)))
      await new Promise(resolve => setTimeout(resolve, 20));
    snapshot(network);
  };

  const dispose = async () => {
    closed = true;
    await Promise.allSettled([...pending]);
    for (const session of sessions) await detach(session);
    sessions.clear();
    sessionStates.clear();
    materializedRecords.clear();
  };
  return { attach, snapshot, flush, dispose };
}

// Context events include a popup's initial navigation response, which can arrive
// before page-level listeners are installed. Scope them to this attempt's pages.
export function observeSearchPages(context, initialPage, { onResponse, onRequestFailed, onPage = () => {} }) {
  const pages = new Set([initialPage]);
  const popupListeners = new Map();
  const observe = candidate => {
    if (pages.has(candidate)) return;
    pages.add(candidate);
    const popup = child => observe(child);
    candidate.on('popup', popup);
    popupListeners.set(candidate, popup);
    onPage(candidate);
  };
  const initialPopup = candidate => observe(candidate);
  initialPage.on('popup', initialPopup);
  popupListeners.set(initialPage, initialPopup);
  const belongs = async candidate => {
    if (pages.has(candidate)) return true;
    const lineage = [];
    const visited = new Set();
    let ancestor = candidate;
    while (ancestor && !visited.has(ancestor) && lineage.length < 10) {
      if (pages.has(ancestor)) {
        for (const child of lineage.reverse()) observe(child);
        return true;
      }
      visited.add(ancestor);
      lineage.push(ancestor);
      try { ancestor = await ancestor.opener(); } catch { return false; }
    }
    return false;
  };
  const response = async value => {
    let source;
    try { source = value.request().frame().page(); } catch { return; }
    if (await belongs(source)) onResponse(value, source);
  };
  const failed = async value => {
    let source;
    try { source = value.frame().page(); } catch { return; }
    if (await belongs(source)) onRequestFailed(value, source);
  };
  context.on('response', response);
  context.on('requestfailed', failed);
  return { pages, dispose: () => {
    context.off('response', response);
    context.off('requestfailed', failed);
    for (const [candidate, listener] of popupListeners) candidate.off('popup', listener);
  } };
}

async function collectAttempt(context, query, directory, options, log, attempt, cdpUrl) {
  let page = await context.newPage();
  await page.addLocatorHandler(page.locator('#onetrust-accept-btn-handler'), async accept => {
    await accept.click({ timeout: 5000 });
    await log('cookie_consent_dismissed', { query, attempt });
  });
  const network = [];
  const completedResponses = [];
  let observedHandoff = null;
  let submitted = false;
  let submittedAt = null;
  let stage = 'browser_ready';
  let evidence = {};
  const stageLog = async value => { stage = value; await log('stage', { query, attempt, stage: value }); };
  const site = airIndiaLocation;
  const responseStatuses = new WeakMap();
  const cdpNetwork = options.browser === 'firefox' ? null : createCdpFareNetworkCapture({
    getSession: candidate => context.newCDPSession(candidate),
    submittedAt: () => submittedAt
  });
  await cdpNetwork?.attach(page);
  const observed = observeSearchPages(context, page, {
    onPage: candidate => {
      if (submitted) page = candidate;
      void cdpNetwork?.attach(candidate);
    },
    onResponse: (response, responsePage) => {
    const target = describeAirIndiaResponse(response, responseStatuses);
    if (!target) return;
    const requestStart = response.request().timing().startTime;
    const requestStartedAt = Number.isFinite(requestStart) && requestStart > 0 ? new Date(requestStart).toISOString() : null;
    const postSubmit = Boolean(submittedAt && requestStartedAt &&
      Date.parse(requestStartedAt) >= Date.parse(submittedAt));
    const record = { at: stamp(), ...target, contentType: response.headers()['content-type'] || '',
      requestStartedAt, postSubmit,
      navigationResponse: isMainFrameNavigation(response.request(), responsePage),
      fareResponse: isFareResponsePath(target, response.headers()['content-type']) };
    const searchApiPath = /(?:api|availability|offer|flight|journey|shopping|air-bounds)/i.test(record.path) &&
      !record.path.startsWith('/nNnW/');
    if (record.status >= 400 || record.path === HANDOFF || record.navigationResponse ||
        (postSubmit && searchApiPath)) network.push(record);
    if (submitted && record.path === HANDOFF && record.method === 'POST') observedHandoff = response;
    if (submitted && record.status === 200 && record.requestStartedAt &&
        Date.parse(record.requestStartedAt) >= Date.parse(submittedAt) && /json/i.test(record.contentType) &&
        !record.path.startsWith('/nNnW/') && /api|availability|offer|flight|search|journey|shopping/i.test(record.path))
      void response.text().then(body => {
        const candidate = { record, body };
        completedResponses.push(candidate);
        return candidate;
      }).catch(() => null);
    },
    onRequestFailed: request => {
    const target = site(request.url());
    if (target) {
      const requestStart = request.timing().startTime;
      const requestStartedAt = Number.isFinite(requestStart) && requestStart > 0 ? new Date(requestStart).toISOString() : null;
      network.push({ at: stamp(), ...target, method: request.method(), requestStartedAt,
        postSubmit: Boolean(submittedAt && requestStartedAt &&
          Date.parse(requestStartedAt) >= Date.parse(submittedAt)),
        failed: request.failure()?.errorText || 'unknown' });
    }
    }
  });
  try {
    await stageLog('browser_ready');
    const home = await navigateToEntry(page, options);
    await stageLog('homepage_loaded');
    if ([401, 403, 429].includes(home?.status())) {
      const code = { 401: 'SESSION_EXPIRED', 403: 'ACCESS_DENIED', 429: 'RATE_LIMITED' }[home.status()];
      throw codedError(code, `Air India booking page returned HTTP ${home.status()}`);
    }
    await selectOneWay(page, options.interactionDelayMs);
    await stageLog('airports_ready');
    const originSelection = await selectAirport(page, 'FROM', query.origin, options.interactionDelayMs);
    const destinationSelection = await selectAirport(page, 'TO', query.destination, options.interactionDelayMs);
    await selectDate(page, query.travelDate, options.interactionDelayMs);
    await stageLog('form_confirmed');
    const form = await savePage(page, directory, `form-attempt-${attempt}`);
    evidence.formPage = form.html;
    evidence.formPageSha256 = form.htmlSha256;
    evidence.formScreenshot = form.screenshot;
    evidence.formScreenshotSha256 = form.screenshotSha256;
    const widget = await confirmBookingForm(page, query, {
      airportSelections: { origin: originSelection, destination: destinationSelection } });
    const search = widget.getByRole('button', { name: 'Search', exact: true }).first();
    if (!await search.isEnabled()) throw codedError('FORM_UNCONFIRMED', 'Air India search remained disabled');
    const homepageWidget = await page.locator('.ai-booking-widget--desktop.ai-booking-widget--homepage')
      .filter({ visible: true }).count() > 0;
    const handoffWait = homepageWidget ? null : page.waitForResponse(response => {
      const target = site(response.url());
      return target?.path === HANDOFF && response.request().method() === 'POST';
    }, { timeout: 50000 }).catch(() => null);
    submittedAt = stamp();
    submitted = true;
    await search.click({ timeout: 12000 });
    await stageLog('search_submitted');
    if (homepageWidget) await sleep(2500);
    const handoff = homepageWidget ? observedHandoff : await handoffWait;
    if (!homepageWidget && !handoff) throw codedError('SITE_NETWORK_FAILURE', 'No Air India booking handoff response arrived');
    const handoffBody = handoff ? await handoff.text().catch(() => null) : null;
    if (handoffBody) {
      const filename = `booking-response-attempt-${attempt}.html`;
      await fs.writeFile(path.join(directory, filename), handoffBody, { mode: 0o600 });
      evidence.bookingResponse = filename;
      evidence.bookingResponseSha256 = hash(handoffBody);
    }
    if (!homepageWidget) await page.waitForTimeout(2500);
    let captchaPuzzleRequired = false;
    let solverOutcome = null;
    if ((options.localCaptchaSolver || options.audioCaptchaSolver) &&
        (await classifyPageFailure(page, new Error('Air India access check'), network)).code === 'CAPTCHA') {
      const solverMode = options.audioCaptchaSolver ? 'audio' : 'image';
      await stageLog(`${solverMode}_captcha_solver`);
      const outcome = await runLocalSolver(cdpUrl, directory, solverMode);
      solverOutcome = outcome;
      await log(`${solverMode}_captcha_solver_result`, { query, attempt, ...outcome });
      if (outcome.status === 'challenge_submitted') await page.waitForTimeout(10000);
    }
    if (options.simpleCaptcha && (await classifyPageFailure(page, new Error('Air India access check'), network)).code === 'CAPTCHA') {
      await stageLog('simple_captcha');
      await log('captcha_checkbox_attempt', { query, attempt });
      try {
        await page.frameLocator('iframe[title="reCAPTCHA"]').locator('#recaptcha-anchor').click({ timeout: 10000 });
        await page.waitForTimeout(3500);
        const submit = page.locator('#refx-submit-btn');
        if (await submit.isEnabled().catch(() => false)) {
          await submit.click({ timeout: 10000 });
          await page.waitForTimeout(8000);
          await log('captcha_submit_attempt', { query, attempt, pageHost: site(page.url())?.host || null });
        } else {
          captchaPuzzleRequired = true;
          await log('captcha_puzzle_required', { query, attempt });
        }
      } catch (captchaError) {
        await log('captcha_checkbox_failed', { query, attempt, detail: captchaError.message.slice(0, 300) });
      }
    }
    await cdpNetwork?.flush(network);
    const access = await classifyPageFailure(page, new Error('Air India access check'), network);
    if (captchaPuzzleRequired && access.code === 'CAPTCHA')
      access.detail = 'Google reCAPTCHA opened an image-selection puzzle after the checkbox';
    if (solverOutcome?.status === 'rate_limited' && access.code === 'CAPTCHA')
      throw codedError('RATE_LIMITED', 'Google limited the audio challenge');
    if (solverOutcome && solverOutcome.status !== 'challenge_submitted' && access.code === 'CAPTCHA')
      access.detail = `Access check remained open after local helper: ${solverOutcome.status}${solverOutcome.detail ? ` (${solverOutcome.detail})` : ''}`;
    if (DENIAL.has(access.code)) throw codedError(access.code, access.detail);
    if (handoff && handoff.status() !== 200) throw codedError('SITE_NETWORK_FAILURE',
      `Air India booking handoff returned HTTP ${handoff.status()}`);
    const resultsDiagnostics = {};
    const resultsStable = await waitForMatchingResults(() => page, completedResponses, query, network,
      { timeoutMs: RESULTS_WAIT_TIMEOUT_MS, diagnostics: resultsDiagnostics,
        onNetworkSnapshot: cdpNetwork ? () => cdpNetwork.snapshot(network) : null,
        siteErrorSettleMs: cdpNetwork ? 500 : 0,
        onSiteError: () => log('site_error_detected', { query, attempt, stage }),
        onSiteRetry: () => log('site_retry', { query, attempt, stage, count: 1, limit: 'per-collector-attempt' }) });
    const resultPage = await savePage(page, directory, `results-attempt-${attempt}`);
    evidence.resultPage = resultPage.html;
    evidence.resultPageSha256 = resultPage.htmlSha256;
    evidence.resultScreenshot = resultPage.screenshot;
    evidence.resultScreenshotSha256 = resultPage.screenshotSha256;
    // Preserve completed candidate evidence even if the rendered markup has
    // changed. Pending bodies never extend the bounded results wait.
    const responses = [...completedResponses];
    for (const [index, response] of responses.entries()) {
      const filename = `candidate-response-attempt-${attempt}-${index + 1}.json`;
      await fs.writeFile(path.join(directory, filename), response.body, { mode: 0o600 });
      evidence[`candidateResponse${index + 1}`] = filename;
      evidence[`candidateResponse${index + 1}Sha256`] = hash(response.body);
    }
    if (!resultsStable) {
      await log('results_wait_timeout', { query, attempt, ...resultsDiagnostics,
        postSubmitNetwork: summarizePostSubmitNetwork(network) });
      const detail = `Air India results did not stabilize within ${Math.round(RESULTS_WAIT_TIMEOUT_MS / 1000)} seconds: ` +
        `${resultsDiagnostics.reason}; pageReady=${resultsDiagnostics.pageReady}; ` +
        `cards=${resultsDiagnostics.cardCount ?? 'unknown'}; ` +
        `responseCandidates=${resultsDiagnostics.responseCandidates ?? 0}; ` +
        `matchingSnapshots=${resultsDiagnostics.matchSnapshots ?? 0}` +
        (resultsDiagnostics.comparisonError ? `; lastComparison=${resultsDiagnostics.comparisonError}` : '');
      if (resultsDiagnostics.reason === 'no_cards' || resultsDiagnostics.reason === 'page_not_ready')
        throw codedError('RESULTS_NOT_RENDERED',
          `Air India returned no flight cards within ${Math.round(RESULTS_WAIT_TIMEOUT_MS / 1000)} seconds ` +
          `(pageReady=${resultsDiagnostics.pageReady}, responseCandidates=${resultsDiagnostics.responseCandidates ?? 0})`);
      if (resultsDiagnostics.reason === 'no_response_candidates')
        throw codedError('FARE_RESPONSE_UNVERIFIED',
          `No post-submit response candidates were observed within ${Math.round(RESULTS_WAIT_TIMEOUT_MS / 1000)} seconds ` +
          `(cards=${resultsDiagnostics.cardCount ?? 0})`);
      if (resultsDiagnostics.comparisonErrorCode && resultsDiagnostics.comparisonErrorCode !== 'RESULTS_UNVERIFIED')
        throw codedError(resultsDiagnostics.comparisonErrorCode, resultsDiagnostics.comparisonError);
      throw codedError('RESULTS_UNVERIFIED', detail);
    }
    if (!await page.locator('.ai-pb-flight-card-wrapper').count())
      throw codedError('RESULTS_NOT_RENDERED', 'Air India displayed no flight cards after results stabilization');
    await stageLog('results_rendered');
    if (!responses.length) throw codedError('FARE_RESPONSE_UNVERIFIED',
      'No matching Air India flight-response JSON was observed after submission');
    const cards = extractCardsFromHtml(await fs.readFile(path.join(directory, resultPage.html), 'utf8'));
    const offer = selectMatchingResponse(responses, cards, query);
    if (offer.record.status !== 200 || !/json/i.test(offer.record.contentType) ||
        !Number.isFinite(Date.parse(offer.record.requestStartedAt)) || Date.parse(offer.record.requestStartedAt) < Date.parse(submittedAt))
      throw codedError('FARE_RESPONSE_UNVERIFIED', 'Selected fare response lacks a fresh successful JSON request');
    await stageLog('airline_response_verified');
    const fares = offer.fares;
    evidence.airlineResponse = evidence[`candidateResponse${offer.index + 1}`];
    evidence.airlineResponseSha256 = hash(offer.body);
    await stageLog('fare_verified');
    await log('fare_verified', { query, attempt, exactAirportFlightCount: fares.length,
      renderedFlightCount: cards.length, lowestDisplayedFare: Math.min(...fares.map(fare => fare.price.displayedTotal)) });
    return { status: 'ok', fareEvidenceVersion: 2, stage, query, collectedAt: stamp(), fares,
      expectedJourneys: fares.length, coverage: { captured: fares.length, expectedJourneys: fares.length },
      network, evidence, responseEvidenceVersion: 1,
      airlineResponseProvenance: { ...offer.record, submittedAt, bodySha256: hash(offer.body) }, attempt };
  } catch (error) {
    await cdpNetwork?.flush(network);
    const cause = await classifyPageFailure(page, error, network);
    const failure = await savePage(page, directory, `failure-attempt-${attempt}`);
    evidence.failurePage = failure.html;
    evidence.failurePageSha256 = failure.htmlSha256;
    evidence.failureScreenshot = failure.screenshot;
    evidence.failureScreenshotSha256 = failure.screenshotSha256;
    await log('failure', { query, attempt, stage, cause, network });
    return { status: DENIAL.has(cause.code) ? 'blocked' : 'failed', stage, cause, query,
      collectedAt: stamp(), fares: [], network, evidence, attempt };
  } finally {
    observed.dispose();
    await cdpNetwork?.dispose();
    await Promise.allSettled([...observed.pages].map(candidate => candidate.close()));
  }
}

export async function collect(options) {
  if (!Array.isArray(options.searches) || !options.searches.length || options.searches.length > 54)
    throw new Error('Provide 1–54 searches');
  const id = `${stamp().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const runDir = path.join(options.output, id);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  const manifest = { id, startedAt: stamp(), finishedAt: null, source: resolveEntryUrl(options.entryUrl),
    sourceFingerprint: await sourceFingerprint(), browserMode: options.mode,
    disableHttp2: Boolean(options.disableHttp2),
    profile: options.profile || path.join(root, '.session',
      options.browser === 'chrome' ? (options.userAgentProfile === 'chrome-compatible' ? 'headless-compatible' : options.mode) : `firefox-${options.mode}`),
    proxyConfigured: Boolean(options.proxy), browserEngine: options.browser,
    browserTransport: options.externalChrome ? 'external-chrome-cdp' : 'playwright-launch',
    networkName: process.env.AIRINDIA_NETWORK_NAME || null, simpleCaptcha: options.simpleCaptcha,
    localCaptchaSolver: options.localCaptchaSolver,
    audioCaptchaSolver: options.audioCaptchaSolver,
    deferredVerification: options.deferVerification,
    interactionDelayMs: options.interactionDelayMs,
    minIntervalMs: options.minIntervalMs, searches: options.searches, status: 'running' };
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  console.log(`RUN_DIR=${runDir}`);
  const log = async (event, detail) => {
    const record = { at: stamp(), event, ...detail };
    await fs.appendFile(path.join(runDir, 'events.ndjson'), JSON.stringify(record) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(record));
  };
  let browserSession;
  try {
    browserSession = await launchBrowser(manifest, options);
    manifest.browserVersion = browserSession.browserVersion;
    manifest.processEvidence = browserSession.processEvidence || null;
    manifest.http2FlagEvidence = browserSession.http2FlagEvidence || {
      requested: false, flag: null, observed: false, evidenceSource: 'not requested' };
    manifest.userAgentProfile = options.userAgentProfile;
    if (browserSession.userAgentProfile) manifest.userAgentEvidence = browserSession.userAgentProfile;
    await writeJson(path.join(runDir, 'manifest.json'), manifest);
    await log('browser_launched', { browserVersion: manifest.browserVersion,
      browserTransport: manifest.browserTransport });
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
  let lastSearchAt = 0;
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
        try {
          result = await collectAttempt(browserSession.context, query, directory, options, log, attempt,
            browserSession.cdpUrl);
        } catch (error) {
          const closed = /Target page, context or browser has been closed|Target crashed/i.test(error.message);
          const cause = { code: closed ? 'BROWSER_CONTEXT_CLOSED' : 'COLLECTOR_UNCAUGHT',
            detail: String(error.message).slice(0, 800) };
          result = { status: 'failed', stage: 'browser_ready', query,
            collectedAt: stamp(), fares: [], network: [], evidence: {}, cause, attempt };
          await log('failure', { query, attempt, stage: result.stage, cause });
        }
        await writeJson(path.join(directory, `attempt-${attempt}.json`), result);
        if (result.status === 'ok' || DENIAL.has(result.cause?.code) ||
            !shouldRetrySearch(result.cause?.code, attempt, options.retries)) break;
        const backoffMs = Math.min(12000, 2000 * 2 ** (attempt - 1));
        await log('backoff', { query, attempt, cause: result.cause.code, backoffMs });
        await sleep(backoffMs);
      }
      await writeJson(path.join(directory, 'result.json'), result);
      if (result.status !== 'ok')
        await log('search_finished', { query, status: result.status, cause: result.cause,
          fareCount: 0, expectedJourneys: result.expectedJourneys ?? null });
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
    await browserSession.close().catch(() => {});
  }
  // Close collection before independently verifying the saved evidence.
  for (const [index, query] of options.searches.entries()) {
    const directory = path.join(runDir, `${String(index + 1).padStart(2, '0')}-` +
      `${query.origin}-${query.destination}-${query.travelDate}`);
    const file = path.join(directory, 'result.json');
    const result = JSON.parse(await fs.readFile(file));
    if (result.status !== 'ok') continue;
    if (options.deferVerification) {
      await log('evidence_pending', { query, reason: 'desk_verifies_after_workers_exit' });
      continue;
    }
    let check = await verifySearch(directory).catch(error => ({ ok: false, errors: [error.message] }));
    if (!check.ok && check.errors.some(error => /Target crashed|browser has been closed/i.test(error))) {
      await sleep(2000);
      check = await verifySearch(directory).catch(error => ({ ok: false, errors: [error.message] }));
    }
    if (!check.ok) {
      result.status = 'failed'; result.fares = [];
      result.cause = { code: 'EVIDENCE_VERIFICATION_FAILED', detail: check.errors.join('; ') };
      await writeJson(file, result);
    }
    await log('evidence_checked', { query, ok: check.ok, errors: check.errors });
    if (check.ok) await log('stage', { query, attempt: result.attempt, stage: 'complete' });
    await log('search_finished', { query, status: result.status, cause: result.cause,
      fareCount: result.fares.length, expectedJourneys: result.expectedJourneys ?? null });
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
