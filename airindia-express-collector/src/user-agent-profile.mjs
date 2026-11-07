import { chromium } from 'playwright';

export function chromeCompatibleUserAgent(nativeUserAgent, browserVersion) {
  const token = /\bHeadlessChrome\/(\d+(?:\.\d+){3})\b/;
  const match = token.exec(nativeUserAgent);
  if (!match || match[1].split('.')[0] !== String(browserVersion).split('.')[0])
    throw new Error('Installed Chrome version and native headless user agent do not agree.');
  // Preserve Chrome's own platform, version reduction and all other UA tokens.
  return nativeUserAgent.replace(token, `Chrome/${match[1]}`);
}

export async function resolveUserAgentProfile(executablePath) {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const nativeUserAgent = await page.evaluate(() => navigator.userAgent);
    return { userAgent: chromeCompatibleUserAgent(nativeUserAgent, browser.version()),
      installedBrowserVersion: browser.version(), nativeUserAgent };
  } finally { await browser.close(); }
}
