export function hasEmptyResultText(html) {
  const text = String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  return text.includes('Unfortunately, there are no flights available.') && text.includes('Please search again with a different date.');
}

export function parseCardHtml(html) {
  const text = String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8377;|&#x20b9;/gi, '₹').replace(/&amp;/g, '&');
  const entries = [...String(html).matchAll(/<(?:div|span)\b([^>]*)>(\d{2}:\d{2})/g)]
    .map(([, attributes, time]) => ({ time, previous: /\br-142tt33\b|text-decoration(?:-line)?\s*:\s*line-through/i.test(attributes) }));
  const previousByField = [[], []], times = [];
  for (const entry of entries) {
    if (entry.previous) previousByField[Math.min(times.length, 1)].push(entry.time);
    else times.push(entry.time);
  }
  // Simple text-only fixtures have no time wrapper; real cards do.
  if (!entries.length) times.push(...[...text.matchAll(/\b\d{2}:\d{2}\b/g)].map(m => m[0]));
  const airports = [...text.matchAll(/\b[A-Z]{3}\b/g)].map(m => m[0]);
  const flights = [...text.matchAll(/\bSG\s*\d{2,4}\b/g)].map(m => m[0].replace(/\s+/, ' '));
  const prices = [...text.matchAll(/₹\s*([\d,]+)/g)].map(m => Number(m[1].replaceAll(',', '')));
  return { flight: flights.join(' + '), origin: airports[0], destination: airports[1], departureTime: times[0], arrivalTime: times[1], previousByField, prices };
}

// SpiceJet's availability response is reconciled with its rendered flight cards.
// Reject unknown shapes rather than interpreting errors as empty availability.
export function parseAvailability(payload, query) {
  const data = payload?.data;
  if (!data || !Array.isArray(data.trips))
    throw new Error('Unknown SpiceJet availability response');
  if (data.searchParams?.origin?.stationCode !== query.origin ||
      data.searchParams?.destination?.stationCode !== query.destination ||
      data.searchParams?.onWardDate?.slice(0, 10) !== query.travelDate)
    throw new Error('Availability response query mismatch');
  if (!data.trips.length) return [];
  if (!data.faresAvailable || data.currencyCode !== 'INR') throw new Error('Unknown SpiceJet fare response');
  const trips = data.trips.filter(t => t.origin === query.origin && t.destination === query.destination);
  if (trips.length !== 1 || !Array.isArray(trips[0].journeysAvailable))
    throw new Error('Missing or ambiguous route in availability response');
  return trips[0].journeysAvailable.map(journey => {
    const d = journey.designator;
    const flights = journey.segments?.map(s => `${s.identifier?.carrierCode || ''} ${s.identifier?.identifier || ''}`.trim());
    if (d?.origin !== query.origin || d?.destination !== query.destination ||
        d?.departure?.slice(0, 10) !== query.travelDate || !flights?.length ||
        flights.some(flight => !/^SG \d{2,4}$/.test(flight)))
      throw new Error('Invalid journey in availability response');
    const options = Object.values(journey.fares || {}).filter(f => f.availableCount > 0).map(f => {
      const fare = data.faresAvailable[f.fareAvailabilityKey];
      const adult = fare?.passengerFares?.find(p => p.passengerType === 'ADT' && p.multiplier === 1);
      if (!adult || !Number.isFinite(adult.fareAmount) || adult.fareAmount <= 0 ||
          !Array.isArray(adult.serviceCharges) || adult.serviceCharges.some(c => c.currencyCode !== 'INR' || !Number.isFinite(c.amount) || c.amount < 0)) return null;
      const total = adult.serviceCharges.reduce((sum, charge) => sum + charge.amount, 0);
      if (Math.abs(total - adult.fareAmount) > 0.01) return null;
      return { fareKey: f.fareAvailabilityKey, amount: adult.fareAmount, charges: adult.serviceCharges.map(c => ({ code: c.code, type: c.type, amount: c.amount, currency: c.currencyCode })) };
    }).filter(Boolean).sort((a, b) => a.amount - b.amount);
    if (!options.length) throw new Error('Journey has no verifiable adult fare');
    return { query, journeyKey: journey.journeyKey, flight: flights.join(' + '), departureTime: d.departure.slice(11, 16), arrivalTime: d.arrival.slice(11, 16), stops: journey.stops, currency: 'INR', ...options[0] };
  });
}

export function matchCards(journeys, cards) {
  if (!journeys.length || journeys.length !== cards.length) throw new Error('Journey and page card counts disagree');
  const remaining = new Set(cards.map((_, i) => i));
  return journeys.map(journey => {
    const found = [...remaining].filter(index => {
      const card = cards[index];
      return card.flight === journey.flight && card.origin === journey.query.origin && card.destination === journey.query.destination &&
        (card.departureTime === journey.departureTime || card.previousByField?.[0]?.includes(journey.departureTime)) &&
        (card.arrivalTime === journey.arrivalTime || card.previousByField?.[1]?.includes(journey.arrivalTime)) && Math.min(...card.prices) === journey.amount;
    });
    if (found.length !== 1) throw new Error(`Page evidence missing or ambiguous for ${journey.flight}`);
    remaining.delete(found[0]);
    const card = cards[found[0]];
    const changed = card.departureTime !== journey.departureTime || card.arrivalTime !== journey.arrivalTime;
    return { ...journey, ...(changed ? { airlineDepartureTime: journey.departureTime, airlineArrivalTime: journey.arrivalTime,
      departureTime: card.departureTime, arrivalTime: card.arrivalTime, scheduleDifference: 'PAGE_RESCHEDULED' } : {}), cardIndex: found[0] };
  });
}
