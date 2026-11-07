import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { observeSearchPages } from '../src/collect.mjs';

class MockPage extends EventEmitter {
  constructor(name, opener = null) {
    super();
    this.name = name;
    this.parent = opener;
  }
  async opener() {
    if (this.parent instanceof Error) throw this.parent;
    return this.parent;
  }
}

const responseFor = page => ({ request: () => ({ frame: () => ({ page: () => page }) }) });
const failureFor = page => ({ frame: () => ({ page: () => page }) });
const flushEvents = () => new Promise(resolve => setImmediate(resolve));

test('observes same-attempt popup lineage, ignores unrelated or inaccessible pages, and disposes listeners', async () => {
  const context = new EventEmitter();
  const root = new MockPage('root');
  const unrelated = new MockPage('unrelated', new Error('opener is closed'));
  const seenPages = [];
  const seenResponses = [];
  const seenFailures = [];
  const observer = observeSearchPages(context, root, {
    onPage: page => seenPages.push(page.name),
    onResponse: (_response, page) => seenResponses.push(page.name),
    onRequestFailed: (_request, page) => seenFailures.push(page.name)
  });

  const popup = new MockPage('popup', root);
  root.emit('popup', popup);
  const nested = new MockPage('nested', popup);
  popup.emit('popup', nested);
  const unrelatedPopup = new MockPage('unrelated-popup', unrelated);

  context.emit('response', responseFor(root));
  context.emit('response', responseFor(popup));
  context.emit('response', responseFor(nested));
  context.emit('response', responseFor(unrelatedPopup));
  context.emit('requestfailed', failureFor(popup));
  context.emit('requestfailed', failureFor(unrelatedPopup));
  await flushEvents();

  assert.deepEqual([...observer.pages].map(page => page.name), ['root', 'popup', 'nested']);
  assert.deepEqual(seenPages, ['popup', 'nested']);
  assert.deepEqual(seenResponses.sort(), ['nested', 'popup', 'root']);
  assert.deepEqual(seenFailures, ['popup']);

  observer.dispose();
  context.emit('response', responseFor(root));
  root.emit('popup', new MockPage('after-dispose', root));
  await flushEvents();
  assert.deepEqual(seenResponses.sort(), ['nested', 'popup', 'root']);
  assert.deepEqual(seenPages, ['popup', 'nested']);
  assert.equal(context.listenerCount('response'), 0);
  assert.equal(context.listenerCount('requestfailed'), 0);
  assert.equal(root.listenerCount('popup'), 0);
  assert.equal(popup.listenerCount('popup'), 0);
});
