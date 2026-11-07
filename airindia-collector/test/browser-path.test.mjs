import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeExecutable } from '../src/browser-path.mjs';

test('Chrome discovery accepts Windows, macOS, Linux, and an explicit path', () => {
  assert.equal(chromeExecutable({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files' },
    exists: value => value === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(chromeExecutable({ platform: 'darwin', env: {},
    exists: value => value === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(chromeExecutable({ platform: 'linux', env: {},
    exists: value => value === '/usr/bin/google-chrome' }), '/usr/bin/google-chrome');
  assert.equal(chromeExecutable({ platform: 'linux', env: { AIRINDIA_CHROME_PATH: '/custom/chrome' },
    exists: value => value === '/custom/chrome' }), '/custom/chrome');
  assert.equal(chromeExecutable({ platform: 'linux', env: {}, chromiumExecutable: '/bundled/chrome',
    exists: value => value === '/bundled/chrome' }), '/bundled/chrome');
  assert.throws(() => chromeExecutable({ platform: 'linux', env: {}, exists: () => false }),
    /not found/);
});
