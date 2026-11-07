import { parseHTML } from 'linkedom';

const fail = detail => { throw Object.assign(new Error(detail), { code: 'AIRLINE_SCHEMA_UNVERIFIED' }); };
const amount = value => Number.isSafeInteger(value) && value >= 0;
const cabinNames = { eco: 'economy', ecoPremium: 'premium economy', business: 'business', first: 'first' };
// Offset-free times in this domestic desk are interpreted in IST, rather
// than inheriting the computer's timezone. Explicit airline offsets are kept.
const timestamp = value => Date.parse(/[Zz]|[+-]\d{2}:\d{2}$/.test(value)
  ? value : `${value}+05:30`);
const validDateTime = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value) &&
  Number.isFinite(timestamp(value)) &&
  new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);

// null means this JSON is an unrelated request. [] means a valid flight reply
// contained no exact-airport offers for the requested route/date.
export function parseSearchResponse(body, query) {
  let data;
  try { data = JSON.parse(body); }
  catch { return null; }
  const payload = data?.responsePayload?.[0];
  if (!Array.isArray(payload?.airBoundGroups)) return null;
  if (data.status !== 'SUCCESS' || data.hasError !== false ||
      !data.dictionaries?.flight) fail('Air India flight reply was not a successful offer response');

  const fares = [];
  for (const group of payload.airBoundGroups) {
    const details = group?.boundDetails;
    if (details?.originLocationCode !== query.origin ||
        details?.destinationLocationCode !== query.destination) continue;
    if (!Array.isArray(details.segments) || !details.segments.length)
      fail('An exact-route offer has no segments');
    const segments = details.segments.map(item => data.dictionaries.flight[item?.flightId]);
    if (segments.some(segment => !validDateTime(segment?.departure?.dateTime) ||
        !validDateTime(segment?.arrival?.dateTime) ||
        !/^[A-Z]{3}$/.test(segment.departure.locationCode) ||
        !/^[A-Z]{3}$/.test(segment.arrival.locationCode)))
      fail('An offer segment has missing or invalid airport and timestamp details');
    for (const [index, segment] of segments.entries()) {
      if (timestamp(segment.arrival.dateTime) <= timestamp(segment.departure.dateTime))
        fail('An offer segment arrives before it departs');
      if (index && (segments[index - 1].arrival.locationCode !== segment.departure.locationCode ||
          timestamp(segment.departure.dateTime) < timestamp(segments[index - 1].arrival.dateTime)))
        fail('An offer connection has disconnected airports or invalid time order');
    }
    const first = segments[0];
    const last = segments.at(-1);
    if (first.departure.locationCode !== query.origin ||
        last.arrival.locationCode !== query.destination ||
        !first.departure.dateTime.startsWith(query.travelDate))
      fail('An offer segment does not match the requested airport and date');
    if (segments.some(segment => !['AI', 'IX'].includes(segment.marketingAirlineCode) ||
        !/^\d{1,4}$/.test(String(segment.marketingFlightNumber))))
      fail('An offer flight number is missing or unexpected');
    if (!Array.isArray(group.airBounds)) fail('An exact-route flight has no fare bounds');
    const bounds = group.airBounds.filter(bound =>
      amount(bound?.aiUnitPrice?.value) && bound?.aiUnitPrice?.currencyCode === 'INR');
    if (!bounds.length) fail('An exact-route flight has no INR fare');
    const best = bounds.reduce((left, right) =>
      right.aiUnitPrice.value < left.aiUnitPrice.value ? right : left);
    let cabin;
    if (best.availabilityDetails !== undefined) {
      const availability = best.availabilityDetails;
      if (!Array.isArray(availability) || availability.length !== details.segments.length ||
          details.segments.some(segment => !availability.some(item => item.flightId === segment.flightId)) ||
          availability.some(item => !cabinNames[item.cabin]) ||
          new Set(availability.map(item => item.cabin)).size !== 1)
        fail('The lowest fare has ambiguous or unmappable cabin availability');
      cabin = cabinNames[availability[0].cabin];
    }
    const prices = best.prices?.totalPrices;
    if (!Array.isArray(prices) || prices.length !== 1)
      fail('An exact-route fare has no single total-price breakdown');
    const price = prices[0];
    const displayedTotal = best.aiUnitPrice.value;
    if (price.currencyCode !== 'INR' || !amount(price.base) ||
        !amount(price.totalTaxes) || !amount(price.total) ||
        price.base + price.totalTaxes !== displayedTotal || price.total < displayedTotal)
      fail('Air India display amount does not reconcile with base fare and taxes');
    const taxComponents = Array.isArray(price.taxes) ? price.taxes.map(tax => {
      if (!amount(tax?.value) || tax.currencyCode !== 'INR') fail('A tax component is malformed');
      return { code: tax.code || null, amount: tax.value };
    }) : [];
    const itemized = taxComponents.reduce((sum, tax) => sum + tax.amount, 0);
    if (itemized > price.totalTaxes) fail('Itemized taxes exceed the reported total');
    fares.push({
      flight: segments.map(segment => `${segment.marketingAirlineCode} ${segment.marketingFlightNumber}`).join(' + '),
      origin: query.origin, destination: query.destination, travelDate: query.travelDate,
      departureTime: first.departure.dateTime.slice(11, 16),
      arrivalTime: last.arrival.dateTime.slice(11, 16),
      departureDateTime: first.departure.dateTime, arrivalDateTime: last.arrival.dateTime,
      operatingAirline: [...new Set(segments.map(segment => segment.operatingAirlineCode))].join(' + '),
      stops: segments.length - 1 + segments.reduce((count, segment) =>
        count + (Array.isArray(segment.stops) ? segment.stops.length : 0), 0),
      fareFamilyCode: best.fareFamilyCode || null,
      ...(cabin ? { cabin } : {}),
      price: { currency: 'INR', displayedTotal, base: price.base,
        taxesAndFees: price.totalTaxes, taxComponents,
        unitemizedTaxesAndFees: price.totalTaxes - itemized,
        fullTotal: price.total,
        additionalUnitemizedAmount: price.total - displayedTotal }
    });
  }
  const keys = fares.map(fare => `${fare.flight}|${fare.departureTime}`);
  if (new Set(keys).size !== keys.length) fail('Duplicate exact-route flight in airline response');
  return fares;
}

export function extractCardsFromHtml(html) {
  const { document } = parseHTML(html);
  return [...document.querySelectorAll('.ai-pb-flight-item')].map(item => {
    const value = selector => item.querySelector(selector)?.textContent?.trim() || '';
    const readPrice = text => /^[₹\s]*\d[\d,\s]*$/.test(text)
      ? Number(text.replace(/[^0-9]/g, '')) : null;
    const cabinCards = [...item.querySelectorAll('[aria-label^="SELECT_CABIN"]')];
    const selectable = cabinCards.filter(node => node.getAttribute('role') === 'button' &&
      node.getAttribute('aria-disabled') !== 'true').map(node => ({
        cabin: node.getAttribute('aria-label').replace(/^SELECT_CABIN\s+/, '').trim().toLowerCase(),
        currency: node.querySelector('.ai-pb-actual-price-currency-code')?.textContent?.trim() || '',
        displayedTotal: readPrice(node.querySelector('.ai-pb-actual-price')?.textContent?.trim() || '')
      }));
    const validCabins = Object.values(cabinNames);
    const lowest = selectable.length && selectable.every(card => validCabins.includes(card.cabin) &&
      card.currency === 'INR' && card.displayedTotal !== null && card.displayedTotal > 0)
      ? selectable.reduce((left, right) => right.displayedTotal < left.displayedTotal ? right : left) : null;
    return {
      flight: [...item.querySelectorAll('.ai-pb-flight-id')].map(node =>
        node.textContent.trim().replace(/\s+/g, ' ')).join(' + '),
      origin: value('.ai-pb-departure-city-code'),
      destination: value('.ai-pb-actual-arrival-city') || value('.ai-pb-arrival-city-code'),
      departureTime: value('.ai-pb-departure-time'),
      arrivalTime: value('.ai-pb-arrival-time'),
      currency: lowest ? lowest.currency : value('.ai-pb-currency-code'),
      displayedTotal: cabinCards.length ? lowest?.displayedTotal ?? null : readPrice(value('.ai-pb-price')),
      ...(lowest ? { cabin: lowest.cabin } : {})
    };
  });
}

export async function extractPageCards(page) {
  return extractCardsFromHtml(await page.content());
}

export function matchFaresToCards(fares, cards, query, { requireCabin = true } = {}) {
  const scoped = cards.filter(card => card.origin === query.origin &&
    card.destination === query.destination);
  if (scoped.length !== fares.length)
    throw Object.assign(new Error(`Airline returned ${fares.length} exact-route flights; page showed ${scoped.length}`),
      { code: 'RESULTS_UNVERIFIED' });
  for (const fare of fares) {
    const index = scoped.findIndex(item => item.flight === fare.flight &&
      item.departureTime === fare.departureTime &&
      item.arrivalTime === fare.arrivalTime && item.currency === fare.price.currency &&
      (!(fare.cabin || item.cabin) || (!requireCabin && !(fare.cabin && item.cabin)) || item.cabin === fare.cabin) &&
      item.displayedTotal === fare.price.displayedTotal);
    if (index < 0) throw Object.assign(new Error(`Airline fare and page card differ for ${fare.flight}`),
      { code: 'RESULTS_UNVERIFIED' });
    scoped.splice(index, 1);
  }
  return true;
}

// Several shopping replies can arrive during rendering. Only the reply that
// reconciles with every saved page card can be used as fare evidence.
export function selectMatchingResponse(responses, cards, query) {
  let lastError = null;
  let sawOffers = false;
  for (let index = responses.length - 1; index >= 0; index--) {
    const response = responses[index];
    try {
      const fares = parseSearchResponse(response.body, query);
      if (fares === null) continue;
      sawOffers = true;
      if (!fares.length) continue;
      matchFaresToCards(fares, cards, query);
      return { ...response, fares, index };
    } catch (error) { lastError ||= error; }
  }
  if (lastError) throw lastError;
  throw Object.assign(new Error(sawOffers
    ? 'No exact-route Air India flight offers match the displayed page'
    : 'No Air India flight-offer response was observed after submission'),
  { code: sawOffers ? 'EMPTY_RESULTS' : 'FARE_RESPONSE_UNVERIFIED' });
}
