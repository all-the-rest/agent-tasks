/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- standalone probe run inside the Playwright image */
/* Launch Chromium with the internal sandbox and report the result. */
const { chromium } = require('playwright-core');

const sandbox = process.env.EXPECT_SANDBOX !== '0';

(async () => {
  try {
    const browser = await chromium.launch({ chromiumSandbox: sandbox, headless: true });
    console.log(`LAUNCH_OK version=${browser.version()} sandbox=${sandbox}`);
    await browser.close();
    process.exit(0);
  } catch (error) {
    console.log(`LAUNCH_FAIL ${String(error && error.message ? error.message : error).split('\n')[0]}`);
    process.exit(1);
  }
})();
