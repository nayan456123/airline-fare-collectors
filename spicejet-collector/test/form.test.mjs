import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromeExecutable } from '../src/browser-path.mjs';
import { selectAirport } from '../src/form.mjs';

test('selects the exact visible airport row when typing alone leaves an unconfirmed code', async () => {
  const browser = await chromium.launch({ headless:true, executablePath:chromeExecutable() });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input value="Mumbai (BOM)"><input value="Select Destination"><div style="display:none"><div data-focusable="true"><span>MAA</span></div></div><div id="choice" data-focusable="true" tabindex="0"><div>Chennai</div><div><span>MAA</span></div></div><script>document.querySelector('#choice').onclick=()=>{document.querySelectorAll('input')[1].value='Chennai (MAA)';document.querySelector('#choice').remove();}</script>`);
    await selectAirport(page, 1, 'MAA');
    assert.equal(await page.locator('input').nth(1).inputValue(), 'Chennai (MAA)');
    await selectAirport(page, 0, 'BOM');
    assert.equal(await page.locator('input').nth(0).inputValue(), 'Mumbai (BOM)');
  } finally { await browser.close(); }
});
