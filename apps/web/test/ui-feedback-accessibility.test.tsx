// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmptyState, ErrorAlert, Spinner, SuccessAlert } from '../src/components/ui';
import { setLanguage } from '../src/i18n';

beforeEach(() => {
  setLanguage('en');
});

afterEach(() => {
  cleanup();
});

describe('shared feedback accessibility', () => {
  it('keeps the loading status announced when its visible label is suppressed', () => {
    render(<Spinner label="" />);

    const status = screen.getByRole('status');

    expect(status.textContent?.trim()).not.toBe('');
    expect(status.querySelector('.sr-only')?.textContent?.trim()).not.toBe('');
    expect(status.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('exposes errors as alerts and makes retry available from the keyboard', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup({ delay: null });
    render(<ErrorAlert message="Could not load tasks." onRetry={onRetry} />);

    expect(screen.getByRole('alert').textContent).toContain('Could not load tasks.');
    const retry = screen.getByRole('button', { name: 'Retry' });

    await user.tab();
    expect(document.activeElement).toBe(retry);
    await user.keyboard('{Enter}');

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('exposes success feedback as a status', () => {
    render(<SuccessAlert message="Settings saved." />);

    expect(screen.getByRole('status').textContent).toContain('Settings saved.');
  });

  it('presents an empty state as a heading with a named action', () => {
    render(
      <EmptyState
        title="No tasks yet"
        description="Create a task to get started."
        action={<button type="button">Create task</button>}
      />,
    );

    expect(screen.getByRole('heading', { level: 3, name: 'No tasks yet' })).toBeTruthy();
    expect(screen.getByText('Create a task to get started.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create task' })).toBeTruthy();
  });
});
