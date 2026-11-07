import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeExecutable } from '../src/browser-path.mjs';

test('browser selection prefers explicit path, system Chrome, then installed Chromium', () => {
  const installed = new Set(['/custom/chrome', '/usr/bin/google-chrome', '/pw/chromium']);
  const options = { platform: 'linux', env: { AIX_CHROME_PATH: '/custom/chrome' },
    chromiumExecutable: '/pw/chromium', exists: file => installed.has(file) };
  assert.equal(chromeExecutable(options), '/custom/chrome');
  options.env = {};
  assert.equal(chromeExecutable(options), '/usr/bin/google-chrome');
  installed.delete('/usr/bin/google-chrome');
  assert.equal(chromeExecutable(options), '/pw/chromium');
  installed.delete('/pw/chromium');
  assert.throws(() => chromeExecutable(options), /not found/);
  options.env.AIX_CHROME_PATH = '/missing';
  assert.throws(() => chromeExecutable(options), /AIX_CHROME_PATH does not exist/);
});
