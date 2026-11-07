export async function selectAirport(page, index, code) {
  const input = page.locator('input').nth(index);
  const confirmed = async () => (await input.inputValue()).includes(`(${code})`);
  if (await confirmed()) return;
  await input.click({ timeout: 15000 });
  await input.fill(code);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await confirmed()) return;
    const options = page.getByText(code, { exact: true }).filter({ visible: true });
    const count = await options.count();
    if (count > 1) throw new Error(`Airport ${code} has ambiguous visible choices`);
    if (count === 1) {
      await options.locator('xpath=ancestor-or-self::*[@data-focusable="true"][1]').click({ timeout: 10000 });
      await page.waitForFunction(({ index, code }) => document.querySelectorAll('input')[index]?.value.includes(`(${code})`), { index, code }, { timeout: 10000 });
      return;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`Airport ${code} was not confirmed`);
}
