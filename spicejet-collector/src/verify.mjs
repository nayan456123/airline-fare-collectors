import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseAvailability, matchCards, parseCardHtml, hasEmptyResultText } from './parse.mjs';

export async function verifyRun(directory, expectedQuery = null) {
  try {
    const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
    if (expectedQuery && ['origin', 'destination', 'travelDate'].some(key => result.query?.[key] !== expectedQuery[key])) throw new Error('Saved result does not match the requested task');
    if (!['ok', 'empty'].includes(result.status) || !result.evidenceVerified) throw new Error('Run is not a verified success');
    const files = {};
    for (const name of ['availability.json', 'results.html', 'cards.json', 'results.png']) {
      files[name] = await fs.readFile(path.join(directory, name));
      if (crypto.createHash('sha256').update(files[name]).digest('hex') !== result.evidence?.[name])
        throw new Error(`Evidence hash mismatch: ${name}`);
    }
    const cards = JSON.parse(files['cards.json'].toString());
    const html = files['results.html'].toString();
    if (!Array.isArray(cards) || cards.some(card => !card.html || !html.includes(card.html)))
      throw new Error('Flight card not present in saved result page');
    const pageCards = cards.map(card => parseCardHtml(card.html));
    const journeys = parseAvailability(JSON.parse(files['availability.json']), result.query);
    if (result.status === 'empty') {
      if (journeys.length || cards.length || result.fares?.length !== 0 || !hasEmptyResultText(html))
        throw new Error('Empty result lacks matching airline and page evidence');
      return { ok: true, status: 'empty', query: result.query, fareCount: 0, errors: [] };
    }
    const matched = matchCards(journeys, pageCards);
    if (JSON.stringify(matched) !== JSON.stringify(result.fares)) throw new Error('Saved fares do not match evidence');
    return { ok: true, query: result.query, fareCount: matched.length, errors: [] };
  } catch (error) { return { ok: false, errors: [String(error.message)] }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error('Usage: node src/verify.mjs RUN_DIRECTORY'); process.exitCode = 2; }
  else { const report = await verifyRun(path.resolve(process.argv[2])); console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1; }
}
