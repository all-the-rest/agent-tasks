/* eslint-disable no-undef -- Playwright utility run directly with Node */
/**
 * Capture the user-facing screens for the README and user guide.
 *
 * Prereqs: the API (which serves the built SPA) is running and the seeded admin
 * exists.
 *   BASE_URL=http://localhost:8080 ADMIN_EMAIL=... ADMIN_PASSWORD=... \
 *     node scripts/capture-readme-screenshots.mjs
 *
 * Optional environment:
 *   DOC_LANGUAGE=en|de   UI language; non-English files get a `.<lang>` suffix.
 *   DOC_SHOTS=a,b        Capture only these shots (default: all).
 *
 * The script logs in, resolves the first task/execution through the API and
 * writes viewport-sized PNGs to docs/images/. The images are committed so the
 * README renders on GitHub without external assets.
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const base = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
const email = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const password = process.env.ADMIN_PASSWORD ?? 'admin-password-1234';
const language = process.env.DOC_LANGUAGE === 'de' ? 'de' : 'en';
const suffix = language === 'en' ? '' : `.${language}`;
const only = new Set(
  (process.env.DOC_SHOTS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);
const shouldCapture = (name) => only.size === 0 || only.has(name);
const output = new URL('../docs/images/', import.meta.url);
const outputPath = fileURLToPath(output);

await mkdir(outputPath, { recursive: true });

const browser = await chromium.launch({ headless: true, chromiumSandbox: false });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: language === 'de' ? 'de-DE' : 'en-US',
  colorScheme: 'light',
  deviceScaleFactor: 1,
});
await context.addInitScript((lang) => {
  try {
    localStorage.setItem('agent-tasks.lang', lang);
  } catch {
    /* storage unavailable */
  }
}, language);

const page = await context.newPage();
const shots = [];

async function capture(name, path, options = {}) {
  if (!shouldCapture(name)) return;
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  if (options.scrollTo) {
    await page.locator(options.scrollTo).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
  }
  const file = `${name}${suffix}.png`;
  await page.screenshot({ path: `${outputPath}/${file}`, fullPage: options.fullPage ?? false });
  shots.push(name);
  console.log(`captured docs/images/${file}`);
}

// Logged-out login screen; the form is also the entry point for every capture.
await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
if (shouldCapture('login')) {
  const file = `login${suffix}.png`;
  await page.screenshot({ path: `${outputPath}/${file}` });
  shots.push('login');
  console.log(`captured docs/images/${file}`);
}

// Stable ids beat translated labels: the same script captures every language.
await page.locator('#login-email').fill(email);
await page.locator('#login-password').fill(password);
await page.locator('form button[type="submit"]').first().click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
await page.waitForLoadState('networkidle');

await capture('dashboard', '/');
await capture('tasks', '/tasks');

let task = null;
let execution = null;
if (shouldCapture('task-detail') || shouldCapture('execution-report')) {
  const tasksResponse = await context.request.get(`${base}/api/tasks`);
  const tasks = await tasksResponse.json();
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('no task found; seed a task first');

  // Prefer the seeded funding report: it contains a Markdown table and three sources.
  const ordered = [
    ...tasks.filter((candidate) => String(candidate.title).includes('Weekly AI funding')),
    ...tasks.filter((candidate) => !String(candidate.title).includes('Weekly AI funding')),
  ];
  for (const candidate of ordered) {
    const executionsResponse = await context.request.get(`${base}/api/tasks/${candidate.id}/executions`);
    const executions = await executionsResponse.json();
    const completed = (Array.isArray(executions) ? executions : []).find((item) => item.status === 'completed');
    if (completed) {
      task = candidate;
      execution = completed;
      break;
    }
  }
  if (!task || !execution) throw new Error('no completed execution found for any task');
}
if (task) await capture('task-detail', `/tasks/${task.id}`);
if (execution) await capture('execution-report', `/executions/${execution.id}`);

await capture('admin-settings', '/admin', { fullPage: true });
await capture('admin-users', '/admin/users');
await capture('admin-providers', '/admin/providers');
await capture('admin-audit', '/admin/audit');
await capture('settings', '/settings', { fullPage: true });

console.log(`DONE ${shots.length} screenshots`);
await browser.close();
