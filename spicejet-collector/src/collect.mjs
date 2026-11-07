import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { classifyResponse, validateSearch, classifyFailure } from './diagnostics.mjs';
import { parseAvailability, matchCards, parseCardHtml } from './parse.mjs';
import { chromeExecutable } from './browser-path.mjs';
import { selectAirport } from './form.mjs';
import { backgroundDisplay } from './background-display.mjs';

const args = process.argv.slice(2);
const index = args.indexOf('--search');
let query;
try { query = validateSearch(index >= 0 ? args[index + 1] : ''); }
catch (error) { console.error(error.message); process.exit(2); }
const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
const directory = path.resolve('runs', id);
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
const result = { id, query, startedAt: new Date().toISOString(), status: 'failed', fares: [], cause: null, network: [] };
const source = crypto.createHash('sha256');
for (const name of ['collect.mjs', 'parse.mjs', 'diagnostics.mjs', 'verify.mjs', 'browser-path.mjs', 'form.mjs', 'background-display.mjs']) source.update(await fs.readFile(new URL(name, import.meta.url)));
result.sourceFingerprint = source.digest('hex');
result.browserMode = args.includes('--background') ? 'background' : args.includes('--headed') ? 'headed' : 'headless';
const stage = async name => {
  result.stage = name;
  const event = { at: new Date().toISOString(), event: 'stage', stage: name };
  await fs.appendFile(path.join(directory, 'events.ndjson'), JSON.stringify(event) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(event));
};
let browser, page, display;
try {
  if (result.browserMode === 'background') display = await backgroundDisplay();
  const browserEnv = { ...process.env };
  if (display) { browserEnv.DISPLAY = display.display; delete browserEnv.WAYLAND_DISPLAY; }
  browser = await chromium.launch({ headless: result.browserMode === 'headless',
    executablePath: chromeExecutable(), env: browserEnv, ...(display ? {args:['--ozone-platform=x11']} : {}) });
  result.browserDisplay = display ? 'virtual' : result.browserMode === 'headless' ? 'headless' : 'desktop';
  result.browserVersion = browser.version();
  await stage('browser_ready');
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('response', response => {
    const denial = classifyResponse(response.url(), response.status());
    if (denial && result.network.length < 100) result.network.push(denial);
  });
  const home = await page.goto('https://www.spicejet.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  if ([401, 403, 429].includes(home?.status())) throw Object.assign(new Error(`SpiceJet homepage returned HTTP ${home.status()}`), { code: ({401:'SESSION_INVALID',403:'ACCESS_DENIED',429:'RATE_LIMITED'})[home.status()] });
  if ([500, 502, 503, 504].includes(home?.status())) throw Object.assign(new Error(`SpiceJet homepage returned HTTP ${home.status()}`), { code:'SITE_UNAVAILABLE' });
  await stage('homepage_loaded');
  await page.waitForTimeout(10000);
  if (result.network.length) throw Object.assign(new Error(result.network[0].detail), { code: result.network[0].code });
  await selectAirport(page, 0, query.origin);
  await selectAirport(page, 1, query.destination);
  // The desktop calendar renders its months in chronological order.
  const now = new Date();
  const current = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = Number(current.find(x => x.type === 'year').value), month = Number(current.find(x => x.type === 'month').value);
  const [targetYear, targetMonth, targetDay] = query.travelDate.split('-').map(Number);
  const monthIndex = (targetYear - year) * 12 + targetMonth - month;
  if (monthIndex < 0) throw new Error('Date is outside the calendar');
  const day = page.locator(`[data-testid$="-calendar-day-${targetDay}"]`).nth(monthIndex);
  if (!await day.isVisible()) await page.getByText('Departure Date', { exact: true }).first().click();
  await day.click({ timeout: 10000 });
  const label = page.getByTestId('departure-date-dropdown-label-test-id');
  const expected = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${query.travelDate}T00:00:00Z`));
  if (!(await label.innerText()).includes(expected)) throw new Error('Selected date did not match the requested date');
  await stage('form_confirmed');
  const searchResponse = page.waitForResponse(r => {
    const u = new URL(r.url());
    return u.hostname === 'www.spicejet.com' && u.pathname === '/api/v3/search/availability';
  }, { timeout: 60000 }).catch(() => null);
  await page.getByTestId('home-page-flight-cta').click({ timeout: 10000 });
  await stage('search_submitted');
  const response = await searchResponse;
  if (!response) throw Object.assign(new Error('No availability response arrived'), { code: 'SITE_NETWORK_FAILURE' });
  if (response.status() !== 200) throw Object.assign(new Error(`Availability endpoint returned HTTP ${response.status()}`),
    { code: [500, 502, 503, 504].includes(response.status()) ? 'SITE_UNAVAILABLE' : 'SEARCH_UNVERIFIED' });
  const raw = await response.text();
  await fs.writeFile(path.join(directory, 'availability.json'), raw, { mode: 0o600 });
  const journeys = parseAvailability(JSON.parse(raw), query);
  if (!journeys.length) {
    await page.getByText('Unfortunately, there are no flights available.', { exact: true }).waitFor({ timeout: 45000 });
    await page.getByText('Please search again with a different date.', { exact: true }).waitFor({ timeout: 5000 });
    await page.getByText('Search again', { exact: true }).locator('..').click({ trial: true, timeout: 45000 });
    if (await page.locator('[data-testid^="spicesaver-flight-select-radio-button-"]').count()) throw new Error('Empty response conflicts with displayed flight cards');
    await fs.writeFile(path.join(directory, 'results.html'), await page.content(), { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'cards.json'), '[]', { mode: 0o600 });
    await page.screenshot({ path: path.join(directory, 'results.png'), fullPage: true, timeout: 15000 });
    result.status = 'empty'; result.evidenceVerified = true;
  } else {
  const firstCard = page.locator('[data-testid^="spicesaver-flight-select-radio-button-"]').first();
  await firstCard.waitFor({ timeout: 45000 });
  // Trial interaction waits for booking overlays to clear without selecting a fare.
  await firstCard.click({ trial: true, timeout: 45000 });
  await page.mouse.move(0, 0);
  const rawCards = await page.locator('[data-testid^="spicesaver-flight-select-radio-button-"]').evaluateAll(nodes => nodes.map(node => {
    let row = node;
    for (let i = 0; i < 6; i++) row = row.parentElement;
    const text = row.innerText;
    const times = [...text.matchAll(/\b\d{2}:\d{2}\b/g)].map(m => m[0]);
    const airports = [...text.matchAll(/\b[A-Z]{3}\b/g)].map(m => m[0]);
    const flights = [...text.matchAll(/\bSG\s*\d{2,4}\b/g)].map(m => m[0].replace(/\s+/, ' '));
    const prices = [...text.matchAll(/₹\s*([\d,]+)/g)].map(m => Number(m[1].replaceAll(',', '')));
    return { text, html: row.outerHTML, flight: flights.join(' + '), origin: airports[0], destination: airports[1], departureTime: times[0], arrivalTime: times[1], prices };
  }));
  const cards = rawCards.map(card => ({ ...card, ...parseCardHtml(card.html) }));
  await fs.writeFile(path.join(directory, 'availability.json'), raw, { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'results.html'), await page.content(), { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'cards.json'), JSON.stringify(cards, null, 2), { mode: 0o600 });
  await page.screenshot({ path: path.join(directory, 'results.png'), fullPage: true, timeout: 15000 });
  const matched = matchCards(journeys, cards);
  result.fares = matched;
  result.status = 'ok';
  result.evidenceVerified = true;
  }
  result.evidence = {};
  for (const name of ['availability.json', 'results.html', 'cards.json', 'results.png'])
    result.evidence[name] = crypto.createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex');
  await stage('evidence_verified');
} catch (error) {
  Object.assign(result, classifyFailure(error, result.network));
} finally {
  if (page && !['ok', 'empty'].includes(result.status)) {
    await fs.writeFile(path.join(directory, 'failure.html'), await page.content().catch(() => ''), { mode: 0o600 }).catch(() => {});
    await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true, timeout: 10000 }).catch(() => {});
  }
  if (browser) await browser.close().catch(() => {});
  if (display) await display.close().catch(() => {});
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ run: id, status: result.status, cause: result.cause, evidence: directory }));
process.exitCode = ['ok', 'empty'].includes(result.status) ? 0 : 1;
