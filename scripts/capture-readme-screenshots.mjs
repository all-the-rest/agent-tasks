/* eslint-disable no-undef -- Playwright utility run directly with Node */
/**
 * Capture the user-facing screens for the README and user guide.
 *
 * Prereqs: the API and web dev server are running and the seeded admin exists.
 *   BASE_URL=http://localhost:5173 ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/capture-readme-screenshots.mjs
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
const output = new URL('../docs/images/', import.meta.url);
const outputPath = fileURLToPath(output);

await mkdir(outputPath, { recursive: true });

const browser = await chromium.launch({ headless: true, chromiumSandbox: false });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  colorScheme: 'light',
  deviceScaleFactor: 1,
});
await context.addInitScript(() => {
  try {
    localStorage.setItem('agent-tasks.lang', 'en');
  } catch {
    /* storage unavailable */
  }
});

const page = await context.newPage();
const shots = [];

async function capture(name, path, options = {}) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  if (options.scrollTo) {
    await page.locator(options.scrollTo).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: `${outputPath}/${name}.png`, fullPage: options.fullPage ?? false });
  shots.push(name);
  console.log(`captured docs/images/${name}.png`);
}

// Logged-out login screen.
await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.screenshot({ path: `${outputPath}/login.png` });
shots.push('login');
console.log('captured docs/images/login.png');

await page.getByLabel(/^Email/).fill(email);
await page.getByLabel(/^Password/).fill(password);
await page.getByRole('button', { name: 'Sign in', exact: true }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
await page.waitForLoadState('networkidle');

await capture('dashboard', '/');
await capture('tasks', '/tasks');

const tasksResponse = await context.request.get(`${base}/api/tasks`);
const tasks = await tasksResponse.json();
if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('no task found; seed a task first');

let task = null;
let execution = null;
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
await capture('task-detail', `/tasks/${task.id}`);
await capture('execution-report', `/executions/${execution.id}`);

await capture('admin-settings', '/admin', { fullPage: true });
await capture('admin-users', '/admin/users');
await capture('admin-providers', '/admin/providers');
await capture('admin-audit', '/admin/audit');
await capture('settings', '/settings', { fullPage: true });

console.log(`DONE ${shots.length} screenshots`);
await browser.close();
