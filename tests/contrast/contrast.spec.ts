import { expect, test } from '@playwright/test';

const SEMANTIC_COLORS = ['neutral', 'primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'] as const;
const WCAG_AA_NORMAL_TEXT = 4.5;

interface ContrastMeasurement {
  label: string;
  ratio: number;
  foreground: string;
  background: string;
}

async function measureThemeContrast(
  page: import('@playwright/test').Page,
  theme: 'light' | 'dark',
): Promise<ContrastMeasurement[]> {
  await page.addInitScript((selectedTheme: string) => {
    window.localStorage.setItem('agent-tasks.theme', selectedTheme);
  }, theme);
  await page.goto('/login');
  await expect(page.getByRole('main')).toBeVisible();

  return page.evaluate((semanticColors) => {
    type Rgba = [number, number, number, number];

    const host = document.createElement('div');
    host.className = 'bg-base-100';
    host.style.position = 'fixed';
    host.style.left = '-10000px';
    host.style.top = '0';
    host.setAttribute('aria-hidden', 'true');
    document.body.append(host);

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D is unavailable for contrast measurement');

    const rgba = (color: string): Rgba => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = 'rgba(0, 0, 0, 0)';
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return [
        (pixel[0] ?? 0) / 255,
        (pixel[1] ?? 0) / 255,
        (pixel[2] ?? 0) / 255,
        (pixel[3] ?? 0) / 255,
      ];
    };

    const composite = (foreground: Rgba, background: Rgba): Rgba => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
        alpha,
      ];
    };

    const luminance = (color: Rgba): number => {
      const linear = color.slice(0, 3).map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
    };

    const contrast = (foreground: Rgba, background: Rgba): number => {
      const renderedBackground = composite(background, rgba(getComputedStyle(host).backgroundColor));
      const renderedForeground = composite(foreground, renderedBackground);
      const foregroundLuminance = luminance(renderedForeground);
      const backgroundLuminance = luminance(renderedBackground);
      const lighter = Math.max(foregroundLuminance, backgroundLuminance);
      const darker = Math.min(foregroundLuminance, backgroundLuminance);
      return (lighter + 0.05) / (darker + 0.05);
    };

    const addProbe = (tag: string, className: string, label: string): HTMLElement => {
      const probe = document.createElement(tag);
      probe.className = className;
      probe.textContent = 'Readable sample';
      probe.dataset.contrastLabel = label;
      host.append(probe);
      return probe;
    };

    const measurements: ContrastMeasurement[] = [];
    const record = (label: string, element: HTMLElement): void => {
      const style = getComputedStyle(element);
      measurements.push({
        label,
        ratio: contrast(rgba(style.color), rgba(style.backgroundColor)),
        foreground: style.color,
        background: style.backgroundColor,
      });
    };

    record('body text on base-100', addProbe('span', 'text-base-content', 'body text'));
    record('primary link on base-100', addProbe('a', 'link link-primary', 'primary link'));

    for (const color of semanticColors) {
      record(`badge-${color}`, addProbe('span', `badge badge-${color}`, `badge ${color}`));
      record(`alert-${color}`, addProbe('div', `alert alert-${color}`, `alert ${color}`));
    }

    host.remove();
    return measurements;
  }, SEMANTIC_COLORS);
}

for (const theme of ['light', 'dark'] as const) {
  test(`semantic text contrast meets WCAG AA in ${theme} theme`, async ({ page }) => {
    const measurements = await measureThemeContrast(page, theme);
    const failures = measurements.filter((measurement) => measurement.ratio < WCAG_AA_NORMAL_TEXT);

    expect(
      failures.map(({ label, ratio, foreground, background }) =>
        `${label}: ${ratio.toFixed(2)}:1 (${foreground} on ${background})`,
      ),
      `Contrast must be at least ${WCAG_AA_NORMAL_TEXT}:1 in the ${theme} theme`,
    ).toEqual([]);
  });
}
