// Calibrated from official /b2c-flightsearch/v4/fsa JSON and rendered rows
// of the submitted 14 Oct 2026 DEL–BOM search collected on 9 Oct 2026.
const fail = detail => Object.assign(new Error(detail), { code: 'FARE_RESPONSE_UNVERIFIED' });
const money = amount => Math.round(amount * 100) / 100;
const close = (a, b) => Math.abs(a - b) < 0.01;

export function isIxFlightNumber(value) {
  return /^IX\s?\d{1,4}$/i.test(String(value || '').trim());
}

export function routeDateMatches(record, query) {
  return record?.origin === query.origin && record?.destination === query.destination &&
    String(record?.departureDateTime || record?.travelDate || '').startsWith(query.travelDate);
}

function priceFare(availability, currency) {
  if (!availability?.fares?.length) throw fail('AIX fare availability has no passenger fares.');
  const charges = availability.fares.flatMap(fare => {
    const passengers = fare.passengerFares;
    if (!Array.isArray(passengers) || passengers.length !== 1 ||
        passengers[0].passengerType !== 'ADT' || passengers[0].multiplier !== 1)
      throw fail('AIX price is not for one adult.');
    const items = passengers[0].serviceCharges;
    if (!items?.length || items.some(c => ![0, 4, 5].includes(c.type) ||
        c.currencyCode !== currency || !Number.isFinite(c.amount) || c.amount < 0))
      throw fail('AIX service charge format, currency or amount is unverified.');
    if (!close(items.reduce((sum, c) => sum + c.amount, 0), passengers[0].fareAmount))
      throw fail('AIX passenger fare does not equal its service charges.');
    return items;
  });
  const total = money(charges.reduce((sum, c) => sum + c.amount, 0));
  const base = money(charges.filter(c => c.type === 0).reduce((sum, c) => sum + c.amount, 0));
  if (!(base > 0) || !(total > 0) || !close(total, availability.totals?.fareTotal))
    throw fail('AIX fare total does not equal its charge breakdown.');
  return { currency, base, includedTaxesAndFees: money(total - base), displayedTotal: total,
    charges: charges.map(({ type, code, detail, amount, currencyCode }) =>
      ({ type, code, detail, amount, currencyCode })) };
}

export function parseSearchResponse(body, query, { cards } = {}) {
  let payload;
  try { payload = typeof body === 'string' ? JSON.parse(body) : body; }
  catch { throw fail('AIX response was not valid JSON.'); }
  if (!query || !/^[A-Z]{3}$/.test(query.origin || '') ||
      !/^[A-Z]{3}$/.test(query.destination || '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(query.travelDate || '')) throw fail('Invalid AIX query context.');
  const data = payload?.data;
  if (!Array.isArray(data?.results) || !data?.faresAvailable ||
      Array.isArray(data.faresAvailable)) return null;
  if (data.currencyCode !== 'INR' || data.includeTaxesAndFees !== true ||
      payload.passengers?.totalCount !== 1 || payload.passengers.types?.length !== 1 ||
      payload.passengers.types[0].type !== 'ADT' || payload.passengers.types[0].count !== 1)
    throw fail('AIX search context is not one adult with included INR taxes/fees.');
  const market = `${query.origin}|${query.destination}`;
  const journeys = data.results.flatMap(result => result.trips || [])
    .filter(trip => trip.date?.slice(0, 10) === query.travelDate)
    .flatMap(trip => trip.journeysAvailableByMarket?.[market] || [])
    .filter(journey => journey.notForGeneralUser !== true);
  const fares = journeys.map(journey => {
    const designator = journey.designator;
    const flights = (journey.segments || []).map(segment =>
      `${segment.identifier?.carrierCode || ''}${segment.identifier?.identifier || ''}`);
    if (!routeDateMatches({ ...designator, departureDateTime: designator?.departure }, query) ||
        !flights.length || !flights.every(isIxFlightNumber) || !journey.journeyKey)
      throw fail('AIX journey route, date or IX flight identity does not match.');
    const options = (journey.fares || []).map(reference => {
      const availability = data.faresAvailable[reference.fareAvailabilityKey];
      const price = priceFare(availability, data.currencyCode);
      return { price, fareAvailabilityKey: reference.fareAvailabilityKey,
        brand: [...new Set(availability.fares.map(f => f.productClass))].join(' + ') };
    });
    const matchingCards = (cards || []).filter(card => card.journeyKey === journey.journeyKey &&
      card.origin === query.origin && card.destination === query.destination);
    if (matchingCards.length !== 1) throw fail('AIX journey has no unique exact-route rendered row.');
    const displayed = options.filter(option => close(option.price.displayedTotal, matchingCards[0].displayedTotal));
    if (displayed.length !== 1) throw fail('AIX rendered fare does not uniquely match an airline fare option.');
    return { origin: query.origin, destination: query.destination, travelDate: query.travelDate,
      flight: flights.join(' + '), flights, departureDateTime: designator.departure,
      arrivalDateTime: designator.arrival, departureTime: designator.departure.slice(11, 16),
      arrivalTime: designator.arrival.slice(11, 16), stops: journey.stops,
      journeyKey: journey.journeyKey, ...displayed[0] };
  });
  return { fares, expectedJourneys: fares.length, schema: 'aix-fsa-v4-navitaire' };
}

const decode = text => String(text).replace(/&#(x[\da-f]+|\d+);/gi, (_, value) =>
  String.fromCodePoint(value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const plain = html => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function classElements(html, name) {
  const found = [];
  const starts = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  let start;
  while ((start = starts.exec(html))) {
    const classes = /\bclass=["']([^"']*)["']/.exec(start[2])?.[1]?.split(/\s+/) || [];
    if (!classes.includes(name)) continue;
    const tags = new RegExp(`<(/?)${start[1]}\\b[^>]*>`, 'gi');
    tags.lastIndex = start.index;
    let tag, depth = 0;
    while ((tag = tags.exec(html))) {
      depth += tag[1] ? -1 : 1;
      if (depth === 0) { found.push(html.slice(start.index, tags.lastIndex)); break; }
    }
  }
  return found;
}

export function extractCardsFromHtml(html) {
  return classElements(String(html), 'flight-details-wrapper').map((row, index) => {
    const text = name => plain(classElements(row, name)[0] || '');
    const price = /(?:₹|INR)\s*([\d,]+(?:\.\d{1,2})?)/.exec(text('current-fare'));
    return { index, html: row, journeyKey: /\bid=["']([^"']+)["']/.exec(row)?.[1],
      origin: /^([A-Z]{3})\b/.exec(text('source-dest-det'))?.[1],
      destination: /^([A-Z]{3})\b/.exec(text('source-arr-det'))?.[1],
      flights: [...text('flight-det-number').matchAll(/\bIX\s?(\d{1,4})\b/g)].map(m => `IX${m[1]}`),
      times: classElements(row, 'inner-flight-time').map(value => /\b\d{2}:\d{2}\b/.exec(plain(value))?.[0]),
      displayedTotal: price ? Number(price[1].replaceAll(',', '')) : null };
  });
}

export function matchFaresToCards(fares, cards, query) {
  const exact = cards.filter(card => card.origin === query.origin && card.destination === query.destination);
  if (!fares.length || fares.length !== exact.length)
    throw fail(`AIX page/response coverage differs: ${exact.length} exact-route rows, ${fares.length} journeys.`);
  if (new Set(fares.map(fare => fare.journeyKey)).size !== fares.length)
    throw fail('AIX response contains duplicate journey identities.');
  for (const fare of fares) {
    const matches = exact.filter(card => card.journeyKey === fare.journeyKey);
    if (matches.length !== 1) throw fail(`AIX page row missing or ambiguous for ${fare.flight}.`);
    const card = matches[0];
    if (card.flights.join('|') !== fare.flights.join('|') || card.times[0] !== fare.departureTime ||
        card.times[1] !== fare.arrivalTime || !close(card.displayedTotal, fare.price.displayedTotal))
      throw fail(`AIX rendered flight, time or price differs for ${fare.flight}.`);
  }
  return { complete: true, captured: fares.length, expectedJourneys: fares.length,
    pageRows: exact.length, nearbyRowsExcluded: cards.length - exact.length };
}
