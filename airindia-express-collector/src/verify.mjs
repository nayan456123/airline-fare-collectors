import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSearchResponse, extractCardsFromHtml, matchFaresToCards } from './parse.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

export async function verifySearch(directory) {
  const errors = [];
  const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  if (result.status !== 'ok') return { ok: false, errors: [`Search status is ${result.status}`] };
  if (!Array.isArray(result.fares) || result.fares.length === 0)
    return { ok: false, errors: ['No verified Air India Express fare rows are available.'] };
  for (const [key, evidence] of Object.entries(result.evidence || {})) {
    if (!evidence?.file || !evidence?.sha256 || path.basename(evidence.file) !== evidence.file) {
      errors.push(`${key} evidence reference is invalid`); continue;
    }
    try {
      const bytes = await fs.readFile(path.join(directory, evidence.file));
      if (hash(bytes) !== evidence.sha256) errors.push(`${key} evidence hash mismatch`);
    } catch { errors.push(`${key} evidence file is missing`); }
  }
  const required = ['formPage', 'airlineResponse', 'resultPage', 'resultScreenshot', 'responseMetadata'];
  for (const key of required) if (!result.evidence?.[key]) errors.push(`Missing ${key} evidence`);
  if (errors.length) return { ok: false, errors };
  try {
    const read = key => fs.readFile(path.join(directory, result.evidence[key].file), 'utf8');
    const metadata = JSON.parse(await read('responseMetadata'));
    if (metadata.host !== 'api.airindiaexpress.com' || metadata.path !== '/b2c-flightsearch/v4/fsa' ||
        metadata.method !== 'POST' || metadata.status !== 200 || !/json/i.test(metadata.contentType || '') ||
        metadata.bodySha256 !== result.evidence.airlineResponse.sha256 ||
        metadata.bodyFile !== result.evidence.airlineResponse.file ||
        !(Date.parse(metadata.at) >= Date.parse(result.submittedAt)) ||
        !(Date.parse(result.collectedAt) >= Date.parse(metadata.at)))
      errors.push('Fare response is not attributable to a fresh, submitted official AIX search');
    const page = await read('resultPage');
    const cards = extractCardsFromHtml(page);
    const parsed = parseSearchResponse(await read('airlineResponse'), result.query, { cards });
    if (!parsed || parsed.fares.length !== result.fares.length)
      errors.push('Saved fares differ in count from the airline response');
    if (new Set(result.fares.map(fare => fare.journeyKey)).size !== result.fares.length)
      errors.push('Saved fares contain duplicate journey identities');
    if (parsed?.fares.length) matchFaresToCards(parsed.fares, cards, result.query);
    for (const [index, fare] of result.fares.entries()) {
      const original = parsed?.fares.find(item => item.journeyKey === fare.journeyKey);
      if (!original || Object.keys(original).some(key => JSON.stringify(original[key]) !== JSON.stringify(fare[key])))
        errors.push(`Saved flight or breakdown differs from the response for ${fare.flight}`);
      if (fare.collectedAt !== result.collectedAt) errors.push(`Collection timestamp differs for ${fare.flight}`);
      const rowRef = result.evidence[`row${index + 1}`];
      if (!rowRef || fare.evidence?.rowHtml !== rowRef.file)
        errors.push(`No matching row evidence for ${fare.flight}`);
      else {
        const row = await fs.readFile(path.join(directory, rowRef.file), 'utf8');
        const matchingCard = cards.find(card => card.journeyKey === fare.journeyKey &&
          card.origin === result.query.origin && card.destination === result.query.destination);
        if (!matchingCard || row !== matchingCard.html)
          errors.push(`Row evidence does not match the saved journey for ${fare.flight}`);
      }
    }
  } catch (error) { errors.push(error.message || 'Airline/page evidence could not be verified'); }
  return { ok: errors.length === 0, errors };
}
