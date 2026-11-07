import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { backgroundDisplay } from '../src/background-display.mjs';
import { chromeExecutable } from '../src/browser-path.mjs';

test('headed Chrome renders on an isolated virtual display without changing the desktop display', async () => {
  const original = process.env.DISPLAY;
  const display = await backgroundDisplay({ env:{ ...process.env, SPICEJET_BACKGROUND_DISPLAY:undefined } });
  let browser;
  try {
    assert.match(display.display, /^:\d+$/);
    const env={ ...process.env, DISPLAY:display.display }; delete env.WAYLAND_DISPLAY;
    browser=await chromium.launch({ headless:false, executablePath:chromeExecutable(), env, args:['--ozone-platform=x11'] });
    const page=await browser.newPage();await page.setContent('<title>Background rendering check</title><h1>Background browser</h1>');
    assert.equal(await page.title(), 'Background rendering check');
    const shot=await page.screenshot();assert.equal(shot.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(process.env.DISPLAY, original);
  } finally { await browser?.close(); await display.close(); }
});
