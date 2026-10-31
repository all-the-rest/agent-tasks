#!/usr/bin/env node
/* global fetch */
/**
 * Renders the delivered reset mail in the Mailpit web UI with Playwright and
 * asserts what a human sees: the heading, the call-to-action button and a
 * working reset link. Writes a full-page screenshot for CI artifacts.
 *
 * Inputs: MAILPIT_URL, MAIL_TO, optional MAIL_MESSAGE_ID,
 *         MAIL_UI_SCREENSHOT (default mail-preview.png)
 */
import { createRequire } from 'node:module';

const mailpit = (process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025').replace(/\/$/, '');
const email = process.env.MAIL_TO;
const screenshot = process.env.MAIL_UI_SCREENSHOT ?? 'mail-preview.png';
const subject = 'Reset your Agent Tasks password';
const fixedMessageId = process.env.MAIL_MESSAGE_ID;
const require = createRequire(import.meta.url);

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

if (!email && !fixedMessageId) fail('MAIL_TO or MAIL_MESSAGE_ID is required');

let messageId = fixedMessageId;
if (!messageId) {
  const list = await fetch(`${mailpit}/api/v1/messages?limit=50`).then((response) => response.json());
  const message = (list.messages ?? []).find((entry) => {
    const to = (entry.To ?? []).map((address) => String(address.Address ?? '').toLowerCase());
    return entry.Subject === subject && to.includes(String(email).toLowerCase());
  });
  if (!message) fail(`no "${subject}" mail for ${email} in Mailpit`);
  messageId = message.ID;
}

const { chromium } = require('@playwright/test');
const browser = await chromium.launch({ chromiumSandbox: process.env.MAIL_UI_SANDBOX === 'true' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const response = await page.goto(`${mailpit}/view/${messageId}`, { waitUntil: 'networkidle' });
  if (!response?.ok()) fail(`Mailpit UI returned HTTP ${response?.status()}`);

  // Mailpit renders the message body inside an iframe.
  let frame = null;
  for (let attempt = 0; attempt < 20 && !frame; attempt += 1) {
    for (const candidate of page.frames()) {
      const text = await candidate.locator('body').innerText().catch(() => '');
      if (text.includes('Reset your password')) {
        frame = candidate;
        break;
      }
    }
    if (!frame) await page.waitForTimeout(250);
  }
  if (!frame) fail('the rendered mail did not appear in a frame');

  const text = await frame.locator('body').innerText();
  if (!text.includes('Use this single-use link to choose a new password.')) fail('body paragraph is missing');
  if (!text.includes('Choose a new password')) fail('call-to-action label is missing');
  if (!text.includes('If you did not request this mail')) fail('footer is missing');

  const links = await frame.locator('a[href*="reset-password"]').count();
  if (links < 2) fail(`expected the button and fallback link, found ${links} reset links`);

  // The header badge is Mailpit's own compatibility percentage.
  const badge = await page.locator('text=/HTML Check/').first().innerText().catch(() => '');
  await page.screenshot({ path: screenshot, fullPage: true });

  console.log(
    JSON.stringify(
      {
        ok: true,
        messageId,
        frames: page.frames().length,
        resetLinks: links,
        mailpitBadge: badge.replace(/\s+/g, ' ').trim(),
        screenshot,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
