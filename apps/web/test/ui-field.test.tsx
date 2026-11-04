// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Field } from '../src/components/ui';
import { setLanguage } from '../src/i18n';

beforeEach(() => {
  setLanguage('en');
});

afterEach(() => {
  cleanup();
});

describe('Field accessibility wiring', () => {
  it('links hint and error ids and flags the control as required and invalid', () => {
    render(
      <Field
        label="Password"
        htmlFor="new-password"
        hint="At least 12 characters."
        error="Too short."
        required
      >
        <input
          id="new-password"
          className="input w-full"
          placeholder="Choose a password"
          aria-describedby="password-rules"
        />
      </Field>,
    );

    const control = screen.getByLabelText(/^Password/);
    const describedBy = control.getAttribute('aria-describedby')?.split(/\s+/);

    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.getAttribute('aria-required')).toBe('true');
    expect(describedBy).toEqual(
      expect.arrayContaining(['password-rules', 'new-password-hint', 'new-password-error']),
    );

    expect(document.getElementById('new-password-hint')?.textContent).toBe(
      'At least 12 characters.',
    );
    expect(document.getElementById('new-password-error')?.textContent).toBe('Too short.');
    expect(control.className).toContain('input w-full');
    expect(control.getAttribute('placeholder')).toBe('Choose a password');
  });

  it('leaves a control without hint, error or required untouched', () => {
    render(
      <Field label="Nickname" htmlFor="nickname">
        <input id="nickname" aria-describedby="nickname-help" />
      </Field>,
    );

    const control = screen.getByLabelText('Nickname');

    expect(control.getAttribute('aria-describedby')).toBe('nickname-help');
    expect(control.getAttribute('aria-invalid')).toBeNull();
    expect(control.getAttribute('aria-required')).toBeNull();
  });

  it('references only the ids that actually exist', () => {
    render(
      <Field label="Email" htmlFor="contact-email" error="Enter a valid address.">
        <input id="contact-email" type="email" />
      </Field>,
    );

    const control = screen.getByLabelText('Email');

    expect(control.getAttribute('aria-describedby')).toBe('contact-email-error');
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.getAttribute('aria-required')).toBeNull();
  });
});
