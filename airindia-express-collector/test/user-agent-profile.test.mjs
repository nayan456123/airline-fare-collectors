import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { chromeExecutable } from '../src/browser-path.mjs';
import { chromeCompatibleUserAgent, resolveUserAgentProfile } from '../src/user-agent-profile.mjs';
import { parseArgs, launchBrowser } from '../src/collect.mjs';

test('compatible UA replaces only HeadlessChrome and retains native version reduction', () => {
  const original = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36';
  assert.equal(chromeCompatibleUserAgent(original, '149.0.7831.20'), original.replace('HeadlessChrome/', 'Chrome/'));
  assert.throws(() => chromeCompatibleUserAgent(original, '148.0.1.1'), /do not agree/);
  assert.throws(() => chromeCompatibleUserAgent(original.replace('HeadlessChrome/', 'Chrome/'), '149.0.1.1'));
});

test('native UA remains explicit and compatible UA requires native headless Chrome', () => {
  const base = ['--search', 'DEL:BOM:2027-01-01', '--headed'];
  assert.equal(parseArgs(base).userAgentProfile, 'native');
  assert.equal(parseArgs([...base, '--headless', '--user-agent-profile', 'chrome-compatible']).userAgentProfile, 'chrome-compatible');
  assert.throws(() => parseArgs([...base, '--user-agent-profile', 'chrome-compatible']), /native headless Chrome/);
  assert.throws(() => parseArgs([...base, '--headless', '--browser', 'firefox', '--user-agent-profile', 'chrome-compatible']), /native headless Chrome/);
  assert.throws(() => parseArgs([...base, '--headless', '--user-agent-profile', 'invented']), /must be/);
});

for (const browserLauncher of ['playwright', 'cdp']) test(`actual ${browserLauncher} Chrome keeps headless process and same-version normal UA and client hints`, async () => {
  const executablePath = chromeExecutable({ chromiumExecutable: chromium.executablePath() });
  const profile = await resolveUserAgentProfile(executablePath);
  assert.equal(profile.userAgent, profile.nativeUserAgent.replace('HeadlessChrome/', 'Chrome/'));
  let observed;
  const server = http.createServer((request, response) => { observed = request.headers; response.end('<html>local</html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aix-ua-profile-'));
  let context;
  let browserSession;
  try {
    const savedDisplay = process.env.DISPLAY;
    delete process.env.DISPLAY;
    try {
      browserSession = await launchBrowser(directory, browserLauncher === 'cdp' ?
        parseArgs(['--search', 'DEL:BOM:2027-01-01']) :
        { mode: 'headless', browser: 'chrome', userAgentProfile: 'chrome-compatible', browserLauncher });
    } finally { if (savedDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = savedDisplay; }
    context = browserSession.context;
    assert.equal(browserSession.userAgentProfile.userAgent, profile.userAgent);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const actual = await page.evaluate(() => ({ ua: navigator.userAgent, webdriver: navigator.webdriver,
      brands: navigator.userAgentData.brands }));
    assert.equal(actual.ua, profile.userAgent);
    assert.equal(typeof actual.webdriver, 'boolean');

    assert.equal(observed['user-agent'], profile.userAgent);
    const major = profile.installedBrowserVersion.split('.')[0];
    assert.ok(actual.brands.some(brand => /Chromium|Google Chrome/.test(brand.brand) && brand.version === major));
    assert.match(observed['sec-ch-ua'], new RegExp(`"(?:Chromium|Google Chrome)";v="${major}"`));
    assert.equal(observed['sec-ch-ua-platform'], '"Linux"');
    const processes = await Promise.all((await fs.readdir('/proc')).filter(name => /^\d+$/.test(name))
      .map(name => fs.readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')));
    const command = processes.find(value => value.split(/[\0\s]+/).includes(`--user-data-dir=${directory}`));
    assert.ok(command, 'persistent browser process should be running');
    const args = command.split(/[\0\s]+/);
    assert.ok(args.some(argument => /^--headless(?:=|$)/.test(argument)), args.join(' '));
    assert.ok(!args.some(argument => /ignore-certificate-errors|disable-blink-features=AutomationControlled/.test(argument)));
    if (browserLauncher === 'cdp') {
      assert.equal(browserSession.processEvidence.evidenceSource, 'linux-proc-cmdline');
      assert.equal(browserSession.processEvidence.observedHeadlessArgument, '--headless');
      assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
      assert.ok(!args.includes('--enable-automation'));
    }
  } finally { await browserSession?.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
});


test('headless defaults select CDP and incompatible configurations are rejected', () => {
  const base = ['--search', 'DEL:BOM:2027-01-01', '--headed'];
  assert.equal(parseArgs(base).browserLauncher, 'playwright');
  assert.equal(parseArgs([...base, '--headless']).browserLauncher, 'cdp');
  assert.equal(parseArgs([...base, '--headless']).userAgentProfile, 'chrome-compatible');
  assert.equal(parseArgs([...base, '--headless', '--browser-launcher', 'playwright', '--user-agent-profile', 'native']).browserLauncher, 'playwright');
  assert.equal(parseArgs([...base, '--headless', '--browser-launcher', 'playwright', '--user-agent-profile', 'native']).userAgentProfile, 'native');
  const proxied = parseArgs([...base, '--headless', '--proxy', 'http://localhost:8080']);
  assert.equal(proxied.browserLauncher, 'playwright'); assert.equal(proxied.userAgentProfile, 'native');
  assert.throws(() => parseArgs([...base, '--headless', '--proxy', 'http://localhost:8080', '--user-agent-profile', 'chrome-compatible']), /without a proxy/);
  for (const extra of [[], ['--headless', '--browser', 'firefox'], ['--headless', '--proxy', 'http://localhost:8080']])
    assert.throws(() => parseArgs([...base, ...extra, '--browser-launcher', 'cdp']), /native headless Chrome without a proxy/);
  assert.throws(() => parseArgs([...base, '--headless', '--browser-launcher', 'invalid']), /must be/);
});


test('external headless Chrome exits with its collector on SIGTERM', async () => {
  const { spawn } = await import('node:child_process');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aix-cdp-signal-'));
  let child;
  try {
    const program = `import { launchBrowser } from ${JSON.stringify(new URL('../src/collect.mjs', import.meta.url).href)};
      await launchBrowser(${JSON.stringify(directory)}, { mode: 'headless', browser: 'chrome', browserLauncher: 'cdp' });
      console.log('READY'); setInterval(() => {}, 1000);`;
    child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: { ...process.env, DISPLAY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP child startup exceeded local test deadline')), 25000);
      child.stdout.on('data', data => { if (data.toString().includes('READY')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`CDP child exited early: ${code}`)); });
    });
    const ended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP signal cleanup exceeded deadline')), 6000);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    child.kill('SIGTERM'); assert.equal(await ended, 143);
    const processes = await Promise.all((await fs.readdir('/proc')).filter(name => /^\d+$/.test(name))
      .map(name => fs.readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')));
    assert.equal(processes.some(value => value.includes(`--user-data-dir=${directory}`)), false);
  } finally { if (child?.exitCode === null) child.kill('SIGKILL'); await fs.rm(directory, { recursive: true, force: true }); }
});
