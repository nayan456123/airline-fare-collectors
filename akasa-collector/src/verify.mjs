import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { flightCodes, parseDisplayedPrice, parseSearchResponse, rowTimes } from './parse.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function rowFacts(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return { flights: flightCodes(text), times: rowTimes(html),
  airports: [...html.matchAll(/<span>([A-Z]{3})<\/span>/g)].map(match => match[1]),
  price: parseDisplayedPrice(text) };
}

export async function verifySearch(directory, expectedQuery = null) {
  const errors = [];
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  if (expectedQuery && (!result.query || ['origin', 'destination', 'travelDate'].some(key =>
    result.query[key] !== expectedQuery[key])))
    return { ok: false, errors: ['Result query does not match manifest search'],
      query: result.query };
  if (result.status !== 'ok') return { ok: false, errors: [`Search status is ${result.status}`] };
  if (!result.fares?.length || result.fares.length !== result.expectedJourneys ||
      result.pageRows !== result.expectedJourneys || result.issues?.length)
    errors.push('Fare, journey, or page row counts disagree');
  const evidence = result.fares?.[0]?.evidence;
  if (!evidence) return { ok: false, errors: [...errors, 'No fare evidence'] };
  const response = await fs.readFile(path.join(directory, evidence.airlineResponse), 'utf8');
  const page = await fs.readFile(path.join(directory, evidence.resultPage), 'utf8');
  const screenshot = await fs.readFile(path.join(directory, evidence.resultScreenshot));
  const form = await fs.readFile(path.join(directory, evidence.formPage), 'utf8');
  if (sha256(response) !== evidence.airlineResponseSha256)
    errors.push('Airline response hash mismatch');
  if (evidence.resultPageSha256 && sha256(page) !== evidence.resultPageSha256)
    errors.push('Result page hash mismatch');
  if (evidence.resultScreenshotSha256 && sha256(screenshot) !== evidence.resultScreenshotSha256)
    errors.push('Result screenshot hash mismatch');
  if (evidence.formPageSha256 && sha256(form) !== evidence.formPageSha256)
    errors.push('Form page hash mismatch');
  if (!page.includes('aria-label="flight card"') || screenshot.length < 1000 ||
      !form.includes(result.query.origin) || !form.includes(result.query.destination))
    errors.push('Page, screenshot, or form evidence is missing');
  const journeys = parseSearchResponse(response, result.query);
  if (journeys.length !== result.expectedJourneys) errors.push('Airline journey count mismatch');
  const seen = new Set();
  for (const fare of result.fares) {
    if (fare.evidence.resultPage !== evidence.resultPage ||
        fare.evidence.resultScreenshot !== evidence.resultScreenshot ||
        fare.evidence.airlineResponse !== evidence.airlineResponse ||
        fare.evidence.airlineResponseSha256 !== evidence.airlineResponseSha256 ||
        fare.evidence.formPage !== evidence.formPage)
      errors.push(`Evidence reference mismatch for ${fare.flight}`);
    const key = `${fare.journeyKey}:${fare.rowIndex}`;
    if (seen.has(key)) errors.push(`Duplicate fare ${key}`);
    seen.add(key);
    if (fare.origin !== result.query.origin || fare.destination !== result.query.destination ||
        fare.travelDate !== result.query.travelDate || !Number.isFinite(Date.parse(fare.collectedAt)))
      errors.push(`Route, date, or timestamp mismatch for ${fare.flight}`);
    const journey = journeys.find(item => item.journeyKey === fare.journeyKey);
    if (!journey?.routeMatches || journey.flights.join(' + ') !== fare.flight ||
        journey.departureTime !== (fare.airlineDepartureTime ?? fare.departureTime) ||
        journey.arrivalTime !== (fare.airlineArrivalTime ?? fare.arrivalTime) ||
        journey.best?.key !== fare.fareAvailabilityKey ||
        JSON.stringify(journey.best?.price) !== JSON.stringify(fare.price))
      errors.push(`Airline response mismatch for ${fare.flight}`);
    const scheduleDiffers = fare.departureTime !== (fare.airlineDepartureTime ?? fare.departureTime) ||
      fare.arrivalTime !== (fare.airlineArrivalTime ?? fare.arrivalTime);
    if ((fare.scheduleDifference ?? null) !==
        (scheduleDiffers ? 'PAGE_TIME_DIFFERS_FROM_AIRLINE_RESPONSE' : null))
      errors.push(`Schedule difference label mismatch for ${fare.flight}`);
    const html = await fs.readFile(path.join(directory, fare.evidence.rowHtml), 'utf8');
    if (fare.evidence.rowHtmlSha256 && sha256(html) !== fare.evidence.rowHtmlSha256)
      errors.push(`Flight row hash mismatch for ${fare.flight}`);
    const facts = rowFacts(html);
    if (!page.includes(html) || facts.flights.join(' + ') !== fare.flight ||
        facts.airports[0] !== result.query.origin ||
        facts.airports.at(-1) !== result.query.destination ||
        facts.times.current[0] !== fare.departureTime ||
        facts.times.current[1] !== fare.arrivalTime ||
        (fare.departureTime !== (fare.airlineDepartureTime ?? fare.departureTime) &&
          !facts.times.previousByField[0].includes(fare.airlineDepartureTime)) ||
        (fare.arrivalTime !== (fare.airlineArrivalTime ?? fare.arrivalTime) &&
          !facts.times.previousByField[1].includes(fare.airlineArrivalTime)) ||
        facts.price !== fare.price.displayedTotal)
      errors.push(`Displayed page row mismatch for ${fare.flight}`);
  }
  return { ok: errors.length === 0, errors, fareCount: result.fares.length,
    query: result.query };
}

export async function verifyRun(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const checks = [];
  const searches = manifest.searches;
  if (!Array.isArray(searches) || searches.length === 0)
    return { run: manifest.id, status: manifest.status, ok: false,
      checks: [{ name: 'manifest', ok: false, errors: ['Manifest has no searches'] }] };
  if (!['complete', 'partial', 'blocked', 'failed'].includes(manifest.status))
    return { run: manifest.id, status: manifest.status, ok: false,
      checks: [{ name: 'manifest', ok: false, errors: ['Manifest has invalid or unfinished run status'] }] };
  const resultStatuses = [];
  for (const [index, query] of searches.entries()) {
    if (!query || !/^[A-Z]{3}$/.test(query.origin || '') ||
        !/^[A-Z]{3}$/.test(query.destination || '') ||
        !/^\d{4}-\d{2}-\d{2}$/.test(query.travelDate || '')) {
      checks.push({ name: `search-${index + 1}`, ok: false,
        errors: ['Manifest search has an invalid route or travel date'] });
      continue;
    }
    const name = `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`;
    try {
      const saved = JSON.parse(await fs.readFile(path.join(directory, name, 'result.json'), 'utf8'));
      resultStatuses.push(saved.status);
    } catch { resultStatuses.push(null); }
    try { checks.push({ name, ...await verifySearch(path.join(directory, name), query) }); }
    catch (error) { checks.push({ name, ok: false, errors: [error.message] }); }
  }
  if (manifest.status === 'complete' && checks.some(check => !check.ok))
    checks.push({ name: 'manifest', ok: false,
      errors: ['Manifest claims completion while a search did not verify'] });
  if (manifest.status === 'partial' && resultStatuses.every(status => status === 'ok'))
    checks.push({ name: 'manifest', ok: false,
      errors: ['Manifest claims a partial run but every search is marked successful'] });
  if (manifest.status === 'blocked' && !resultStatuses.includes('blocked'))
    checks.push({ name: 'manifest', ok: false,
      errors: ['Manifest claims a blocked run without a blocked search'] });
  const searchesVerified = checks.every(check => check.ok);
  return { run: manifest.id, status: manifest.status,
    ok: manifest.status === 'complete' && searchesVerified, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directories = process.argv.slice(2);
  if (!directories.length) { console.error('Usage: node src/verify.mjs RUN_DIRECTORY [...]'); process.exitCode = 2; }
  else for (const directory of directories) {
    const report = await verifyRun(path.resolve(directory));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
  }
}
