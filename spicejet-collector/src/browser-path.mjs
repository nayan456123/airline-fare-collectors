import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function chromeExecutable({ platform = process.platform, env = process.env,
  exists = fs.existsSync } = {}) {
  if (env.SPICEJET_CHROME_PATH) {
    if (!exists(env.SPICEJET_CHROME_PATH)) throw new Error(`SPICEJET_CHROME_PATH does not exist: ${env.SPICEJET_CHROME_PATH}`);
    return env.SPICEJET_CHROME_PATH;
  }
  const join = platform === 'win32' ? path.win32.join : path.join;
  const choices = platform === 'win32' ? [
    env.PROGRAMFILES && join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['PROGRAMFILES(X86)'] && join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ] : platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  const found = choices.filter(Boolean).find(exists);
  if (!found) throw new Error('Google Chrome was not found. Install it or set SPICEJET_CHROME_PATH.');
  return found;
}
