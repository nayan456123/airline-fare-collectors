import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCardsFromHtml, matchFaresToCards } from '../src/parse.mjs';

test('saved-page parsing checks the displayed fare and exact airport', () => {
  const html = `<html><body><div class="ai-pb-flight-item">
    <span class="ai-pb-flight-id">AI 123</span>
    <span class="ai-pb-departure-city-code">DEL</span>
    <span class="ai-pb-actual-arrival-city">BOM</span>
    <span class="ai-pb-departure-time">09:00</span>
    <span class="ai-pb-arrival-time">11:15</span>
    <span class="ai-pb-currency-code">INR</span>
    <span class="ai-pb-price">₹ 6,581</span>
  </div></body></html>`;
  const cards = extractCardsFromHtml(html);
  const query = { origin: 'DEL', destination: 'BOM' };
  const fare = { flight: 'AI 123', departureTime: '09:00', arrivalTime: '11:15',
    price: { currency: 'INR', displayedTotal: 6581 } };
  assert.equal(matchFaresToCards([fare], cards, query), true);
  assert.throws(() => matchFaresToCards([{ ...fare,
    price: { ...fare.price, displayedTotal: 6582 } }], cards, query),
  /Airline fare and page card differ/);
  assert.throws(() => matchFaresToCards([fare], cards,
    { origin: 'DEL', destination: 'NMI' }), /page showed 0/);
});

test('saved-page parsing rejects empty and decimal fare text', () => {
  for (const price of ['', '₹ 6,581.50']) {
    const html = `<div class="ai-pb-flight-item">
      <span class="ai-pb-price">${price}</span>
    </div>`;
    const card = extractCardsFromHtml(html)[0];
    assert.equal(card.displayedTotal, null);
    assert.throws(() => matchFaresToCards([{
      flight: '', departureTime: '', arrivalTime: '',
      price: { currency: 'INR', displayedTotal: 6581 }
    }], [card], { origin: '', destination: '' }), error => error.code === 'RESULTS_UNVERIFIED');
  }
});

test('a single matching page card cannot verify two fares', () => {
  const fare = { flight: 'AI 123', departureTime: '09:00', arrivalTime: '11:15',
    price: { currency: 'INR', displayedTotal: 6581 } };
  const matching = { flight: 'AI 123', origin: 'DEL', destination: 'BOM',
    departureTime: '09:00', arrivalTime: '11:15', currency: 'INR', displayedTotal: 6581 };
  const other = { ...matching, flight: 'AI 456' };
  assert.throws(() => matchFaresToCards([fare, fare], [matching, other],
    { origin: 'DEL', destination: 'BOM' }), error => error.code === 'RESULTS_UNVERIFIED');
});
