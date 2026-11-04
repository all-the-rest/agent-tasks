// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog, Modal } from '../src/components/ui';
import { setLanguage } from '../src/i18n';

function StackedDialogs() {
  const [shareOpen, setShareOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setShareOpen(true)}>
        Open share
      </button>
      <Modal
        open={shareOpen}
        title="Share task"
        onClose={() => setShareOpen(false)}
        footer={<button type="button">Create link</button>}
      >
        <button type="button" onClick={() => setConfirmOpen(true)}>
          Revoke link
        </button>
      </Modal>
      <ConfirmDialog
        open={confirmOpen}
        title="Revoke link?"
        body="The link stops working immediately."
        confirmLabel="Revoke"
        onConfirm={() => setConfirmOpen(false)}
        onClose={() => setConfirmOpen(false)}
      />
    </>
  );
}

function ClosingStack() {
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open flow
      </button>
      <Modal open={open} title="Share task" onClose={() => setOpen(false)}>
        <button type="button" onClick={() => setConfirmOpen(true)}>
          Revoke link
        </button>
        <ConfirmDialog
          open={confirmOpen}
          title="Revoke link?"
          body="The link stops working immediately."
          confirmLabel="Revoke"
          onConfirm={() => {
            setConfirmOpen(false);
            setOpen(false);
          }}
          onClose={() => setConfirmOpen(false)}
        />
      </Modal>
    </>
  );
}

function SingleDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      <Modal
        open={open}
        title="Settings"
        description="Change the settings for this task."
        onClose={() => setOpen(false)}
        footer={<button type="button">Save</button>}
      >
        <input aria-label="Task name" />
        <button type="button">Advanced</button>
      </Modal>
    </>
  );
}

beforeEach(() => {
  setLanguage('en');
});

afterEach(() => {
  cleanup();
});

describe('Modal focus management', () => {
  it('traps Tab and Shift+Tab inside the dialog', async () => {
    const browser = userEvent.setup({ delay: null });
    render(<SingleDialog />);

    await browser.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const close = within(dialog).getByRole('button', { name: 'Close dialog' });
    const save = within(dialog).getByRole('button', { name: 'Save' });

    expect(document.activeElement).toBe(close);

    await browser.tab();
    await browser.tab();
    await browser.tab();
    expect(document.activeElement).toBe(save);

    await browser.tab();
    expect(document.activeElement).toBe(close);

    await browser.tab({ shift: true });
    expect(document.activeElement).toBe(save);
  });

  it('restores focus to the trigger when the dialog closes', async () => {
    const browser = userEvent.setup({ delay: null });
    render(<SingleDialog />);

    const trigger = screen.getByRole('button', { name: 'Open settings' });
    await browser.click(trigger);
    await browser.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('describes the dialog with its title and description', async () => {
    const browser = userEvent.setup({ delay: null });
    render(<SingleDialog />);

    await browser.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const descriptionId = dialog.getAttribute('aria-describedby');

    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? '')?.textContent).toBe(
      'Change the settings for this task.',
    );
  });
});

describe('stacked dialogs', () => {
  it('lets only the topmost dialog close on Escape and restores its trigger', async () => {
    const browser = userEvent.setup({ delay: null });
    render(<StackedDialogs />);

    await browser.click(screen.getByRole('button', { name: 'Open share' }));
    const revoke = within(screen.getByRole('dialog', { name: 'Share task' })).getByRole('button', {
      name: 'Revoke link',
    });
    await browser.click(revoke);

    expect(screen.getAllByRole('dialog')).toHaveLength(2);

    await browser.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Revoke link?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Share task' })).toBeTruthy();
    expect(document.activeElement).toBe(revoke);

    await browser.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open share' }));
  });

  it('keeps Tab inside the topmost dialog only', async () => {
    const browser = userEvent.setup({ delay: null });
    render(<StackedDialogs />);

    await browser.click(screen.getByRole('button', { name: 'Open share' }));
    await browser.click(
      within(screen.getByRole('dialog', { name: 'Share task' })).getByRole('button', {
        name: 'Revoke link',
      }),
    );

    const confirm = screen.getByRole('dialog', { name: 'Revoke link?' });
    const close = within(confirm).getByRole('button', { name: 'Close dialog' });
    const revoke = within(confirm).getByRole('button', { name: 'Revoke' });
    const share = screen.getByRole('dialog', { name: 'Share task' });

    await browser.tab();
    await browser.tab();
    expect(document.activeElement).toBe(revoke);

    await browser.tab();
    expect(document.activeElement).toBe(close);
    expect(share.contains(document.activeElement)).toBe(false);
  });

  it('exposes the confirm body as the dialog description', async () => {
    const browser = userEvent.setup({ delay: null });
    render(<StackedDialogs />);

    await browser.click(screen.getByRole('button', { name: 'Open share' }));
    await browser.click(
      within(screen.getByRole('dialog', { name: 'Share task' })).getByRole('button', {
        name: 'Revoke link',
      }),
    );

    const dialog = screen.getByRole('dialog', { name: 'Revoke link?' });
    const descriptionId = dialog.getAttribute('aria-describedby');

    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? '')?.textContent).toBe(
      'The link stops working immediately.',
    );
  });

  it('restores the outermost trigger when stacked dialogs unmount together', async () => {
    const browser = userEvent.setup({ delay: null });
    render(<ClosingStack />);

    const trigger = screen.getByRole('button', { name: 'Open flow' });
    await browser.click(trigger);
    await browser.click(
      within(screen.getByRole('dialog', { name: 'Share task' })).getByRole('button', {
        name: 'Revoke link',
      }),
    );
    await browser.click(
      within(screen.getByRole('dialog', { name: 'Revoke link?' })).getByRole('button', {
        name: 'Revoke',
      }),
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
