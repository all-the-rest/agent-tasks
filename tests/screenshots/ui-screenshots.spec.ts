import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import process from 'node:process';
import { routes, uiReviewConfig } from './ui-review.config.js';
import type {
  UiReviewNavStep,
  UiReviewPrepareStep,
  UiReviewRoute,
  UiReviewState,
  UiReviewViewport,
} from './ui-review.config.js';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'local-admin-password';

function outputPath(state: UiReviewState, viewport: UiReviewViewport, file: string): string {
  return path.resolve(process.cwd(), uiReviewConfig.outputDir, state, viewport, file);
}

function viewportForProject(projectName: string): UiReviewViewport {
  return projectName === 'Mobile Chrome' ? 'mobile' : 'desktop';
}

function resolvePath(pattern: string, seed: Record<string, string>): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
    const value = seed[key];
    if (value === undefined) throw new Error(`Route value "${key}" was not resolved by the seed for "${pattern}"`);
    return value;
  });
}

async function waitForAppSettled(page: Page, expectedTitle?: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  if (expectedTitle) await expect(page).toHaveTitle(expectedTitle);
  await expect(page.getByRole('main')).toBeVisible();
  await page.waitForTimeout(250);
}

async function auditAccessibility(page: Page, route: UiReviewRoute, state: UiReviewState, viewport: UiReviewViewport) {
  const violations = await page.evaluate(() => {
    const visible = (element: Element): boolean => {
      if (element.closest('[hidden], [aria-hidden="true"]')) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const textName = (element: Element): string => {
      const clone = element.cloneNode(true) as Element;
      clone.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
      return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
    };
    const nameOf = (element: Element): string => {
      const labelledBy = element.getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
      if (labelledBy) return labelledBy;
      const ariaLabel = element.getAttribute('aria-label')?.trim();
      if (ariaLabel) return ariaLabel;
      if (element instanceof HTMLInputElement) {
        if (element.type === 'image') return element.alt.trim() || element.value.trim();
        if (['button', 'submit', 'reset'].includes(element.type)) return element.value.trim();
      }
      if (
        element instanceof HTMLInputElement || element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement
      ) {
        const labels = Array.from(element.labels ?? []).map((label) => textName(label)).filter(Boolean);
        if (labels.length > 0) return labels.join(' ');
      }
      if (element instanceof HTMLImageElement) return element.alt.trim();
      return textName(element) || element.getAttribute('title')?.trim() || '';
    };

    const issues: string[] = [];
    const mains = Array.from(document.querySelectorAll('main, [role="main"]')).filter(visible);
    if (mains.length !== 1) issues.push(`expected one visible main landmark, found ${mains.length}`);
    const headings = Array.from(document.querySelectorAll('h1')).filter(visible);
    if (headings.length !== 1 || !textName(headings[0] ?? document.createElement('span'))) {
      issues.push(`expected one named visible level-one heading, found ${headings.length}`);
    }

    const controls = document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="combobox"], [role="menuitem"], [role="radio"], [role="switch"], [role="tab"], [tabindex]:not([tabindex="-1"])',
    );
    for (const control of controls) {
      if (control.closest('[aria-hidden="true"]') && !control.closest('[hidden]')) {
        issues.push('focusable control inside aria-hidden content');
      }
      if (!visible(control)) continue;
      if (!nameOf(control)) {
        issues.push(`unnamed ${control.tagName.toLowerCase()}${control.getAttribute('role') ? `[role=${control.getAttribute('role')}]` : ''}`);
      }
    }

    for (const image of document.querySelectorAll('img')) {
      if (visible(image) && !image.hasAttribute('alt')) issues.push('visible image missing alt attribute');
    }
    for (const feedback of document.querySelectorAll('[role="alert"], [role="status"]')) {
      if (visible(feedback) && !textName(feedback)) issues.push(`empty ${feedback.getAttribute('role')} announcement`);
    }
    return issues;
  });
  expect(violations, `Accessibility audit failed for ${route.name} (${state}, ${viewport})`).toEqual([]);
}

async function loginViaUi(page: Page, email: string, password: string): Promise<void> {
  // Login is a deliberate deep-link: the user is not authenticated yet.
  await page.goto('/login');
  await expect(page).toHaveURL(/\/login\/?$/);
  await page.getByLabel(/^(Email|E-Mail)\b/i).fill(email);
  await page.getByLabel(/^(Password|Passwort)\b/i).fill(password);
  await page.getByRole('button', { name: /^(Sign in|Anmelden)$/i }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/');
  // Wait for the auth redirect to finish before any route navigation or seeding.
  await waitForAppSettled(page);
}

async function applyNavStep(page: Page, step: UiReviewNavStep, seed: Record<string, string>): Promise<void> {
  if (step.kind === 'goto') {
    // Direct URL loads must be justified in the manifest (e.g. dynamic deep links).
    await page.goto(resolvePath(step.path, seed));
    await waitForAppSettled(page);
    return;
  }

  const region = page.getByRole(step.scope);
  const name = step.nameFrom === undefined ? step.name : seed[step.nameFrom];
  if (step.nameFrom !== undefined && name === undefined) {
    throw new Error(`Navigation seed value "${step.nameFrom}" is missing`);
  }

  const locator = step.href
    ? region.locator(`[href="${resolvePath(step.href, seed)}"]`)
    : region.getByRole(step.role, name === undefined ? undefined : { name, exact: true });
  await locator.click();
  await waitForAppSettled(page);
}

async function applyPrepareStep(page: Page, step: UiReviewPrepareStep, seed: Record<string, string>): Promise<void> {
  if (step.kind === 'fill') {
    await page.locator(step.selector).fill(step.value);
    return;
  }

  const value = step.valueFrom === undefined ? step.value : seed[step.valueFrom];
  if (value === undefined) throw new Error(`Select value "${step.valueFrom ?? ''}" is missing from the seed`);
  await page.locator(step.selector).selectOption(value);
}

async function captureSections(
  page: Page,
  state: UiReviewState,
  viewport: UiReviewViewport,
  name: string,
): Promise<void> {
  const scroller = await page.evaluate(() => {
    const documentScroller = document.scrollingElement;
    const viewportHeight = window.innerHeight;
    if (documentScroller && documentScroller.scrollHeight > viewportHeight + 4) {
      return { kind: 'window' as const, max: documentScroller.scrollHeight - viewportHeight, step: Math.round(viewportHeight * 0.8) };
    }

    const main = document.querySelector('main');
    if (main && main.scrollHeight > main.clientHeight + 4) {
      return { kind: 'main' as const, max: main.scrollHeight - main.clientHeight, step: Math.round(main.clientHeight * 0.8) };
    }
    return { kind: 'window' as const, max: 0, step: Math.round(viewportHeight * 0.8) };
  });

  const scrollTo = (y: number) =>
    page.evaluate(
      ({ kind, y: target }) => {
        if (kind === 'main') {
          const main = document.querySelector('main');
          if (main) main.scrollTop = target;
        } else {
          window.scrollTo(0, target);
        }
      },
      { kind: scroller.kind, y },
    );

  let y = 0;
  let index = 0;
  for (;;) {
    await scrollTo(y);
    await page.waitForTimeout(150);
    await page.screenshot({ path: outputPath(state, viewport, `${name}-sec${index}.png`) });
    if (y >= scroller.max) break;
    index += 1;
    y = Math.min(scroller.max, y + scroller.step);
  }
  await scrollTo(0);
}

async function settleAndCapture(
  page: Page,
  route: UiReviewRoute,
  state: UiReviewState,
  viewport: UiReviewViewport,
): Promise<void> {
  await waitForAppSettled(page, uiReviewConfig.expectedTitle);
  await auditAccessibility(page, route, state, viewport);
  await page.screenshot({ path: outputPath(state, viewport, `${route.name}.png`), fullPage: true });
  await captureSections(page, state, viewport, route.name);
}

for (const route of routes) {
  for (const state of route.states) {
    for (const viewport of route.viewports ?? ['desktop', 'mobile']) {
      test(
        `screenshot ${route.name} (${state}, ${viewport})`,
        { tag: ['@screenshot'] },
        async ({ page }, testInfo) => {
          test.skip(
            viewportForProject(testInfo.project.name) !== viewport,
            `project ${testInfo.project.name} renders the ${viewportForProject(testInfo.project.name)} viewport`,
          );

          let seed: Record<string, string> = {};

          if (route.auth === 'admin') {
            await loginViaUi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
            if (route.seeds?.[state]) {
              seed = await route.seeds[state]({ page, workerIndex: testInfo.workerIndex, projectName: testInfo.project.name });
            }
          } else if (route.auth === 'user') {
            if (route.seeds?.[state]) {
              seed = await route.seeds[state]({ page, workerIndex: testInfo.workerIndex, projectName: testInfo.project.name });
            }
            const email = seed.email;
            const password = seed.password;
            if (!email || !password) throw new Error(`User credentials are missing from the seed for ${route.name}`);
            await loginViaUi(page, email, password);
          } else {
            await page.goto('/');
            await waitForAppSettled(page);
            if (route.seeds?.[state]) {
              seed = await route.seeds[state]({ page, workerIndex: testInfo.workerIndex, projectName: testInfo.project.name });
            }
          }

          const needsSidebar = (route.nav ?? []).some((step) => step.kind === 'click' && step.scope === 'complementary');
          if (viewport === 'mobile' && needsSidebar) {
            await page.getByRole('banner').locator('button[aria-controls="app-drawer"]').click();
          }

          for (const step of route.nav ?? []) await applyNavStep(page, step, seed);
          for (const step of route.prepare?.[state] ?? []) await applyPrepareStep(page, step, seed);
          await settleAndCapture(page, route, state, viewport);
        },
      );
    }
  }
}
