import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, isFareResponsePath } from '../src/collect.mjs';

const search = ['--search', 'DEL:BOM:2026-10-03'];

test('Firefox uses a separate browser engine and cannot enter Chrome CDP mode', () => {
  assert.equal(parseArgs(search).browser, 'chrome');
  assert.equal(parseArgs(search).externalChrome, true);
  assert.equal(parseArgs(search).userAgentProfile, 'chrome-compatible');
  assert.equal(parseArgs(search).disableHttp2, false, 'HTTP/2 remains enabled by default');
  assert.equal(parseArgs([...search, '--disable-http2']).disableHttp2, true);
  assert.throws(() => parseArgs([...search, '--browser', 'firefox', '--disable-http2']),
    /available for Chrome only/);
  assert.equal(parseArgs([...search, '--proxy', 'http://localhost:8080']).externalChrome, false);
  assert.equal(parseArgs([...search, '--browser', 'firefox', '--headed']).browser, 'firefox');
  assert.throws(() => parseArgs([...search, '--browser', 'firefox', '--headed', '--external-chrome']),
    /requires --browser chrome/);
  assert.equal(parseArgs([...search, '--headless', '--external-chrome']).externalChrome, true);
  assert.throws(() => parseArgs([...search, '--headless', '--external-chrome', '--audio-captcha-solver']), /require --headed/);
  assert.throws(() => parseArgs([...search, '--headless', '--external-chrome', '--local-captcha-solver']), /require --headed/);
  assert.throws(() => parseArgs([...search, '--browser', 'unknown']), /--browser must be/);
  assert.throws(() => parseArgs([...search, '--local-captcha-solver']),
    /require --headed/);
  assert.equal(parseArgs([...search, '--headed', '--external-chrome', '--local-captcha-solver'])
    .localCaptchaSolver, true);
  assert.equal(parseArgs([...search, '--headed', '--external-chrome', '--audio-captcha-solver'])
    .audioCaptchaSolver, true);
  assert.throws(() => parseArgs([...search, '--headed', '--external-chrome',
    '--audio-captcha-solver', '--local-captcha-solver']), /cannot combine/);
});

test('observed fare endpoint remains classified on non-JSON denial responses', () => {
  assert.equal(isFareResponsePath({ host: 'api.airindia.com', path: '/cbiz-booking/v2/prime/search/air-bounds' }, 'text/html'), true);
  assert.equal(isFareResponsePath({ host: 'www.airindia.com', path: '/assets/logo.svg' }, 'text/html'), false);
});
