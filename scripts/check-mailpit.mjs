#!/usr/bin/env node
/* global fetch, setTimeout */
/**
 * Verifies transactional mail end to end against Mailpit:
 *   - the reset mail is delivered over SMTP
 *   - it is multipart/alternative with a non-empty HTML part
 *   - Mailpit's SpamAssassin check reports a low score
 *
 * Requires: API_BASE_URL, MAILPIT_URL, MAIL_TO (an existing account) and a
 * Mailpit started with MP_ENABLE_SPAMASSASSIN pointing at SpamAssassin.
 *
 * Exit code 0 only when every assertion passes; prints a JSON summary.
 */

const api = (process.env.API_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const mailpit = (process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025').replace(/\/$/, '');
const origin = process.env.MAIL_ORIGIN ?? api;
const email = process.env.MAIL_TO;
const subject = 'Reset your Agent Tasks password';
const maxScore = Number(process.env.MAIL_MAX_SPAM_SCORE ?? '5');
const requireSpam = process.env.MAIL_REQUIRE_SPAM !== '0';
const minSupported = Number(process.env.MAIL_MIN_HTML_SUPPORTED ?? '85');
const maxUnsupported = Number(process.env.MAIL_MAX_HTML_UNSUPPORTED ?? '2');
const maxWarnings = Number(process.env.MAIL_MAX_HTML_WARNINGS ?? '12');
const fixedMessageId = process.env.MAIL_MESSAGE_ID;

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!email) fail('MAIL_TO is required (an existing account address)');

const startedAt = Date.now();
if (!fixedMessageId) {
  const request = await fetch(`${api}/api/auth/request-password-reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, redirectTo: `${api}/login` }),
  });
  if (!request.ok) fail(`password reset request returned HTTP ${request.status}: ${await request.text()}`);
}

let message = fixedMessageId ? { ID: fixedMessageId } : null;
for (let attempt = 0; attempt < 40 && !message; attempt += 1) {
  const list = await fetch(`${mailpit}/api/v1/messages?limit=50`).then((response) => response.json());
  message = (list.messages ?? []).find((entry) => {
    const to = (entry.To ?? []).map((address) => String(address.Address ?? '').toLowerCase());
    const created = Date.parse(entry.Created);
    return entry.Subject === subject && to.includes(email.toLowerCase()) && (!Number.isFinite(created) || created >= startedAt - 10_000);
  });
  if (!message) await sleep(750);
}
if (!message) fail(`no "${subject}" mail for ${email} in Mailpit after 30 s`);

const detail = await fetch(`${mailpit}/api/v1/message/${message.ID}`).then((response) => response.json());
if (!detail.Text || !String(detail.Text).includes('http')) fail('plain-text part is missing or has no link');
if (!detail.HTML || String(detail.HTML).length < 200) fail('HTML part is missing or empty');
if (!String(detail.HTML).includes('<a href="http')) fail('HTML part has no action link');
if (!String(detail.HTML).includes('<!doctype html>')) fail('HTML part is not a complete document');

let spam = null;
if (requireSpam) {
  for (let attempt = 0; attempt < 20 && !spam; attempt += 1) {
    const response = await fetch(`${mailpit}/api/v1/message/${message.ID}/sa-check`);
    const body = await response.json();
    if (response.ok && typeof body.Score === 'number') spam = body;
    else await sleep(750);
  }
  if (!spam) fail('Mailpit returned no SpamAssassin score (is spamd running?)');
  if (spam.IsSpam) fail(`SpamAssassin marked the mail as spam (score ${spam.Score})`);
  if (spam.Score >= maxScore) fail(`SpamAssassin score ${spam.Score} is not below ${maxScore}`);
}

const htmlCheckResponse = await fetch(`${mailpit}/api/v1/message/${message.ID}/html-check`);
const htmlCheck = await htmlCheckResponse.json();
if (!htmlCheckResponse.ok || !htmlCheck.Total) fail('Mailpit returned no HTML compatibility report');
const total = htmlCheck.Total;
if (typeof total.Supported !== 'number' || total.Supported < minSupported) {
  fail(`HTML compatibility ${total.Supported}% is below ${minSupported}%`);
}
if (typeof total.Unsupported !== 'number' || total.Unsupported > maxUnsupported) {
  fail(`HTML unsupported share ${total.Unsupported}% exceeds ${maxUnsupported}%`);
}
const warnings = Array.isArray(htmlCheck.Warnings) ? htmlCheck.Warnings : [];
if (warnings.length > maxWarnings) fail(`${warnings.length} HTML compatibility warnings exceed ${maxWarnings}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      messageId: message.ID,
      to: email,
      subject: detail.Subject,
      htmlBytes: Buffer.byteLength(String(detail.HTML)),
      textBytes: Buffer.byteLength(String(detail.Text)),
      spamScore: spam?.Score ?? null,
      isSpam: spam?.IsSpam ?? null,
      threshold: maxScore,
      htmlCompatibility: {
        tests: total.Tests,
        nodes: total.Nodes,
        supported: total.Supported,
        partial: total.Partial,
        unsupported: total.Unsupported,
        warnings: warnings.length,
        warningSlugs: warnings.map((warning) => warning.Slug),
      },
    },
    null,
    2,
  ),
);
