import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchBrowser } from '../src/collect.mjs';

const executable = process.env.AIRINDIA_TEST_CHROME_PATH;
async function removeProfile(profile) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try { await fs.rm(profile, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error.code) || attempt === 11) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

test('external Chrome startup reports a signal exit without waiting for CDP timeout', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-chrome-signal-'));
  t.after(() => removeProfile(profile));
  const wrapper = path.join(profile, 'signal-chrome.sh');
  await fs.writeFile(wrapper, '#!/bin/sh\nkill -TERM $$\n', { mode: 0o700 });
  const prior = process.env.AIRINDIA_CHROME_PATH;
  process.env.AIRINDIA_CHROME_PATH = wrapper;
  t.after(() => { if (prior === undefined) delete process.env.AIRINDIA_CHROME_PATH; else process.env.AIRINDIA_CHROME_PATH = prior; });
  const started = Date.now();
  await assert.rejects(launchBrowser({ profile }, {
    browser: 'chrome', mode: 'headless', externalChrome: true, userAgentProfile: 'native'
  }), /Chrome exited from signal SIGTERM/);
  assert.ok(Date.now() - started < 3000, 'signal exit should be detected promptly');
});

test('external native headless Chrome records the opt-in HTTP/2 flag with the compatible UA', { skip: !executable }, async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-native-headless-'));
  const prior = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, AIRINDIA_CHROME_PATH: process.env.AIRINDIA_CHROME_PATH };
  let session;
  let server;
  t.after(async () => {
    try { await session?.close(); }
    finally {
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await removeProfile(profile);
    }
  });
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY; process.env.AIRINDIA_CHROME_PATH = executable;
  let header;
  server = http.createServer((req, res) => { header = req.headers['user-agent']; res.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  session = await launchBrowser({ profile }, { browser: 'chrome', mode: 'headless', externalChrome: true,
    userAgentProfile: 'chrome-compatible', disableHttp2: true });
  assert.equal(session.processEvidence.observedHeadlessArgument, '--headless');
  assert.equal(session.processEvidence.displayPresent, false);
  assert.equal(session.processEvidence.waylandDisplayPresent, false);
  assert.equal(session.processEvidence.observedDisableHttp2Argument, '--disable-http2');
  assert.deepEqual(session.http2FlagEvidence, { requested: true, flag: '--disable-http2',
    observed: true, evidenceSource: 'linux-proc-cmdline' });
  const page = await session.context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const ua = await page.evaluate(() => navigator.userAgent);
  assert.equal(ua, header);
  assert.doesNotMatch(ua, /HeadlessChrome/);
  assert.match(ua, new RegExp(`Chrome/${session.browserVersion.split('.')[0]}\\.`));
});

test('Playwright Chrome launch records the opt-in HTTP/2 flag', { skip: !executable }, async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-managed-http1-'));
  const prior = process.env.AIRINDIA_CHROME_PATH;
  let session;
  t.after(async () => {
    try { await session?.close(); }
    finally {
      if (prior === undefined) delete process.env.AIRINDIA_CHROME_PATH;
      else process.env.AIRINDIA_CHROME_PATH = prior;
      await removeProfile(profile);
    }
  });
  process.env.AIRINDIA_CHROME_PATH = executable;
  session = await launchBrowser({ profile }, {
    browser: 'chrome', mode: 'headless', externalChrome: false, userAgentProfile: 'native', disableHttp2: true
  });
  assert.deepEqual(session.http2FlagEvidence, { requested: true, flag: '--disable-http2',
    observed: null, evidenceSource: 'Playwright launch option' });
});

test('headless external Chrome suppresses restored tabs while preserving profile cookies', { skip: !executable }, async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-no-startup-window-'));
  const prior = process.env.AIRINDIA_CHROME_PATH;
  let session;
  let server;
  t.after(async () => {
    try { await session?.close(); }
    finally {
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      if (prior === undefined) delete process.env.AIRINDIA_CHROME_PATH;
      else process.env.AIRINDIA_CHROME_PATH = prior;
      await removeProfile(profile);
    }
  });
  const wrapper = path.join(profile, 'chrome-local-only.sh');
  await fs.writeFile(wrapper, `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' --disable-background-networking --disable-component-update --disable-sync --disable-default-apps --no-proxy-server '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1' "$@"\n`, { mode: 0o700 });
  process.env.AIRINDIA_CHROME_PATH = wrapper;

  const requests = [];
  server = http.createServer((req, res) => {
    requests.push({ path: new URL(req.url, 'http://127.0.0.1').pathname, cookie: req.headers.cookie || '' });
    if (req.url === '/seed-cookie') res.setHeader('Set-Cookie', 'collector_test=preserved; Path=/; HttpOnly; SameSite=Lax');
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(`<title>${req.url}</title><body>local fixture</body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const seed = await chromium.launchPersistentContext(profile, {
    executablePath: wrapper, headless: true, viewport: { width: 800, height: 600 }
  });
  try {
    const first = seed.pages()[0] || await seed.newPage();
    await first.goto(`${origin}/seed-cookie`, { waitUntil: 'domcontentloaded' });
    await (await seed.newPage()).goto(`${origin}/saved-tab`, { waitUntil: 'domcontentloaded' });
    assert.equal((await seed.cookies(origin)).find(cookie => cookie.name === 'collector_test')?.value, 'preserved');
  } finally {
    await seed.close();
  }

  const preferencesPath = path.join(profile, 'Default', 'Preferences');
  const preferences = JSON.parse(await fs.readFile(preferencesPath, 'utf8'));
  preferences.session = { ...preferences.session, restore_on_startup: 1 };
  await fs.writeFile(preferencesPath, JSON.stringify(preferences));
  requests.length = 0;

  session = await launchBrowser({ profile }, {
    browser: 'chrome', mode: 'headless', externalChrome: true, userAgentProfile: 'chrome-compatible'
  });
  assert.equal(session.processEvidence.observedHeadlessArgument, '--headless');
  assert.deepEqual(session.context.pages(), [], 'startup must not restore or create a page');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(requests, [], 'no saved local page may issue a request during startup');

  const ownedPage = await session.context.newPage();
  await ownedPage.goto(`${origin}/cookie-check`, { waitUntil: 'domcontentloaded' });
  const cookieCheck = requests.find(request => request.path === '/cookie-check');
  assert.ok(cookieCheck, 'the explicitly created page should navigate to the fixture');
  assert.match(cookieCheck.cookie, /collector_test=preserved/);
});

for (const signal of ['SIGTERM', 'SIGINT']) test(`${signal} cleans up external Chrome`, { skip: !executable }, async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-signal-'));
  let child;
  t.after(async () => {
    if (child) await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGKILL');
    });
    await removeProfile(profile);
  });
  const source = `import { launchBrowser } from ${JSON.stringify(new URL('../src/collect.mjs', import.meta.url).href)}; const s = await launchBrowser({profile: process.argv[1]}, {browser:'chrome',mode:'headless',externalChrome:true,userAgentProfile:'chrome-compatible'}); console.log(s.processEvidence.pid); setInterval(() => {}, 1000);`;
  const env = { ...process.env, AIRINDIA_CHROME_PATH: executable }; delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
  child = spawn(process.execPath, ['--input-type=module', '-e', source, profile], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = await new Promise((resolve, reject) => {
    let data = ''; const timer = setTimeout(() => reject(new Error('launcher timeout')), 20000);
    child.stdout.on('data', chunk => { data += chunk; if (data.includes('\n')) { clearTimeout(timer); resolve(Number(data.trim())); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`launcher exited ${code}`)); });
  });
  assert.ok(pid > 0);
  child.kill(signal);
  await new Promise(resolve => child.once('exit', resolve));
  await assert.rejects(fs.access(`/proc/${pid}`));
});
