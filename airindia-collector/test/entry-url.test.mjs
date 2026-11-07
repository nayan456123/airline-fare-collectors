import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyFailure, collect, isMainFrameNavigation, navigateToEntry, parseArgs,
  resolveEntryUrl } from '../src/collect.mjs';

const userEntry = 'https://www.airindia.com/?ai_pc=MYFLIGHTAIR';
const args = ['--search', 'DEL:BOM:2026-10-31'];

test('entry URL defaults to the campaign-free homepage and accepts explicit environment or CLI selection', () => {
  assert.equal(resolveEntryUrl(userEntry), userEntry);
  const previous = process.env.AIRINDIA_ENTRY_URL;
  try {
    delete process.env.AIRINDIA_ENTRY_URL;
    assert.equal(parseArgs(args).entryUrl, 'https://www.airindia.com/');
    process.env.AIRINDIA_ENTRY_URL = userEntry;
    assert.equal(parseArgs(args).entryUrl, userEntry);
    assert.equal(parseArgs([...args, '--entry-url', 'https://www.airindia.com/']).entryUrl,
      'https://www.airindia.com/');
  } finally {
    if (previous === undefined) delete process.env.AIRINDIA_ENTRY_URL;
    else process.env.AIRINDIA_ENTRY_URL = previous;
  }
  assert.equal(resolveEntryUrl('https://www.airindia.com:443/?ai_pc=MYFLIGHTAIR'), userEntry);
});

test('malformed AIRINDIA_ENTRY_URL is rejected before a CLI plan can launch', () => {
  const previous = process.env.AIRINDIA_ENTRY_URL;
  try {
    process.env.AIRINDIA_ENTRY_URL = 'https://not-air-india.example/';
    assert.throws(() => parseArgs(args), /AIRINDIA_ENTRY_URL/);
  } finally {
    if (previous === undefined) delete process.env.AIRINDIA_ENTRY_URL;
    else process.env.AIRINDIA_ENTRY_URL = previous;
  }
});

test('entry URL validation rejects non-Air-India hosts and unsafe URL components', () => {
  for (const value of [
    'http://www.airindia.com/?ai_pc=MYFLIGHTAIR',
    'https://airindia.com.attacker.test/?ai_pc=MYFLIGHTAIR',
    'https://elsewhere.example/?ai_pc=MYFLIGHTAIR',
    'https://user:password@www.airindia.com/?ai_pc=MYFLIGHTAIR',
    'https://www.airindia.com:8443/?ai_pc=MYFLIGHTAIR',
    'https://www.airindia.com/?ai_pc=MYFLIGHTAIR#fragment',
    'https://www.airindia.com/?next=https://elsewhere.example',
    'https://www.airindia.com/?ai_pc=one&ai_pc=two',
    `https://www.airindia.com/?ai_pc=${'x'.repeat(65)}`,
    'not a URL'
  ]) assert.throws(() => resolveEntryUrl(value), /--entry-url must be/);
  assert.throws(() => parseArgs([...args, '--entry-url', 'http://www.airindia.com']),
    /--entry-url must be/);
});

test('navigation passes the normalized selected URL and existing navigation options to Playwright', async () => {
  let call;
  const page = { goto: async (...args) => { call = args; return { status: () => 200 }; } };
  const result = await navigateToEntry(page, { entryUrl: userEntry });
  assert.equal(result.status(), 200);
  assert.deepEqual(call, [userEntry, { waitUntil: 'domcontentloaded', timeout: 45000 }]);
  await navigateToEntry(page);
  assert.equal(call[0], 'https://www.airindia.com/');
});

test('entry-page denials classify for the selected root or redirected Air India navigation', () => {
  const cases = [[401, 'SESSION_EXPIRED'], [403, 'ACCESS_DENIED'], [429, 'RATE_LIMITED']];
  for (const [status, expected] of cases) {
    const root = classifyFailure(new Error('navigation failed'), [
      { protocol: 'https:', host: 'www.airindia.com', path: '/', method: 'GET', status,
        navigationResponse: true, redirects: [] }
    ]);
    const redirectedPage = classifyFailure(new Error('navigation failed'), [
      { protocol: 'https:', host: 'www.airindia.com', path: '/in/en/book/search-flights.html',
        method: 'GET', status, navigationResponse: true,
        redirects: [{ protocol: 'https:', host: 'www.airindia.com', path: '/', status: 302 }] }
    ]);
    assert.equal(root.code, expected);
    assert.equal(redirectedPage.code, expected);
  }
  assert.equal(classifyFailure(new Error('asset failed'), [
    { path: '/image.svg', method: 'GET', status: 403, navigationResponse: false,
      fareResponse: false }
  ]).code, 'SEARCH_FAILED');
});

test('only main-frame navigation responses identify homepage denials', () => {
  const mainFrame = {};
  const page = { mainFrame: () => mainFrame };
  const request = (navigating, frame) => ({
    isNavigationRequest: () => navigating,
    frame: () => frame
  });
  assert.equal(isMainFrameNavigation(request(true, mainFrame), page), true);
  assert.equal(isMainFrameNavigation(request(true, {}), page), false);
  assert.equal(isMainFrameNavigation(request(false, mainFrame), page), false);
  assert.equal(isMainFrameNavigation({ isNavigationRequest: () => { throw new Error('detached'); } }, page), false);

  const iframeDenial = classifyFailure(new Error('subframe navigation failed'), [{
    path: '/in/en/book/search-flights.html', method: 'GET', status: 403,
    navigationResponse: isMainFrameNavigation(request(true, {}), page)
  }]);
  assert.equal(iframeDenial.code, 'SEARCH_FAILED');
});

test('collector records the selected entry URL before a browser launch failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-entry-manifest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'runs');
  const profile = path.join(root, 'profile');
  const previousPath = process.env.AIRINDIA_CHROME_PATH;
  process.env.AIRINDIA_CHROME_PATH = path.join(root, 'intentionally-missing-chrome');
  try {
    const result = await collect({
      searches: [{ origin: 'DEL', destination: 'BOM', travelDate: '2026-10-31' }],
      entryUrl: userEntry, output, profile, mode: 'headless',
      proxy: null, proxyUser: null, proxyPassword: null, browser: 'chrome',
      externalChrome: false, simpleCaptcha: false, localCaptchaSolver: false,
      audioCaptchaSolver: false, deferVerification: false,
      interactionDelayMs: 0, minIntervalMs: 0, retries: 0
    });
    assert.equal(result.manifest.source, userEntry);
    assert.equal(result.manifest.browserTransport, 'playwright-launch');
    assert.equal(result.manifest.status, 'failed');
    const searchResult = JSON.parse(await fs.readFile(path.join(result.runDir,
      '01-DEL-BOM-2026-10-31', 'result.json'), 'utf8'));
    assert.equal(searchResult.cause.code, 'BROWSER_START_FAILED');
    const events = (await fs.readFile(path.join(result.runDir, 'events.ndjson'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.event), ['browser_failure']);
  } finally {
    if (previousPath === undefined) delete process.env.AIRINDIA_CHROME_PATH;
    else process.env.AIRINDIA_CHROME_PATH = previousPath;
  }
});

test('collector rejects an empty direct search plan before creating a run', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-empty-direct-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'runs');
  await assert.rejects(collect({ searches: [], output, entryUrl: userEntry }), /Provide 1–54 searches/);
  await assert.rejects(fs.access(output), error => error.code === 'ENOENT');
});
