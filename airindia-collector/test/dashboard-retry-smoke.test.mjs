import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { chromium } from 'playwright';

const packageRoot = path.resolve(import.meta.dirname, '..');
const chromePath = process.env.AIRINDIA_TEST_CHROME_PATH || chromium.executablePath();
const fixtureRun = {
  id: 'saved-54', status: 'complete', stopReason: null, retryOf: null,
  startedAt: '2026-10-27T10:00:00.000Z', browserMode: 'headless', concurrency: 3,
  routes: ['DEL-BOM'], tasks: [
    ...Array.from({ length: 22 }, (_, index) => ({
      id: String(index + 1).padStart(3, '0'), status: 'ok', origin: 'DEL', destination: 'BOM',
      travelDate: '2099-12-01', offset: 1, stage: 'complete', fares: [], events: [], worker: 'A',
      evidenceVerified: true, cause: null
    })),
    ...Array.from({ length: 32 }, (_, index) => ({
      id: String(index + 23).padStart(3, '0'),
      status: ['failed', 'partial', 'skipped', 'interrupted'][index % 4],
      origin: 'DEL', destination: 'BOM', travelDate: '2099-12-01', offset: 1,
      stage: 'search_submitted', fares: [], events: [], worker: 'A', evidenceVerified: false,
      cause: { code: index % 4 === 2 ? 'BATCH_STOPPED' : 'TIMEOUT', detail: 'local fixture' }
    }))
  ]
};
let selectedFixture = fixtureRun;

async function unusedPort() {
  const server = (await import('node:net')).createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('served dashboard module loads and shows 32 eligible searches without sending requests', {
  skip: !existsSync(chromePath) && `Chromium executable not found: ${chromePath}`,
  timeout: 30000
}, async () => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const runRoot = await mkdtemp(path.join(tmpdir(), 'airindia-dashboard-runs-'));
  const server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: packageRoot,
    env: { ...process.env, AIRINDIA_PORT: String(port), AIRINDIA_RUN_ROOT: runRoot },
    stdio: 'ignore'
  });
  let browser;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error(`Local server exited with ${server.exitCode}`);
      try { ready = (await fetch(base)).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'local HTTP dashboard server should start');

    browser = await chromium.launch({ headless: true, executablePath: chromePath });
    const page = await browser.newPage();
    const externalRequests = [];
    const postRequests = [];
    const moduleResponses = [];
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET') postRequests.push(`${request.method()} ${url.pathname}`);
      if (['about:', 'data:'].includes(url.protocol)) return route.continue();
      if (url.origin !== base) {
        externalRequests.push(url.href);
        return route.abort();
      }
      if (url.pathname === '/api/config') return route.fulfill({ json: { audioHelperAvailable: false } });
      if (url.pathname === '/api/runs') return route.fulfill({ json: { runs: [selectedFixture] } });
      if (url.pathname === '/api/runs/latest' || url.pathname === '/api/runs/saved-54')
        return route.fulfill({ json: { run: selectedFixture } });
      if (url.pathname === '/api/runs/saved-54/events') return route.abort();
      return route.continue();
    });
    page.on('response', response => {
      if (response.url() === `${base}/retry-eligibility.js`) moduleResponses.push(response.status());
    });

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.locator('#retry-failed-button').waitFor({ state: 'visible' });
    assert.deepEqual(moduleResponses, [200], 'the imported eligibility module is served successfully');
    assert.equal(await page.locator('#run-count').textContent(), '54 / 54');
    assert.equal(await page.locator('#task-list .task-card.ok').count(), 22);
    assert.equal(await page.locator('#task-list .task-card.failed, #task-list .task-card.partial, #task-list .task-card.skipped, #task-list .task-card.interrupted').count(), 32);
    assert.equal(await page.locator('#retry-failed-button').textContent(), 'Retry 32 unfinished searches');
    assert.equal(await page.locator('#retry-failed-button').isEnabled(), true);
    assert.match(await page.locator('#retry-failed-help').textContent(), /Retry when Air India access is available/);
    assert.deepEqual(postRequests, [], 'the smoke test must not submit a retry or a new collection');
    assert.deepEqual(externalRequests, [], 'the dashboard smoke test must not contact Air India or other external hosts');

    selectedFixture = { ...fixtureRun, status: 'running' };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#run-status')?.textContent === 'Searching');
    assert.equal(await page.locator('[data-retry-task]').count(), 0,
      'failed cards in an active selected run must not offer single-search retries');
    assert.equal(await page.locator('#retry-failed-panel').isVisible(), false,
      'an active selected run must not offer batch retry');
    assert.deepEqual(postRequests, [], 'checking the active state must not submit a request');
    assert.deepEqual(externalRequests, []);
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit').catch(() => {});
    }
    await rm(runRoot, { recursive: true, force: true });
  }
});
