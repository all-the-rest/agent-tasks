// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { setLanguage } from '../src/i18n';
import { NotFoundPage } from '../src/pages/NotFoundPage';
import { expectInteractiveControlsNamed } from './accessibility-helpers';

afterEach(() => {
  cleanup();
  setLanguage('en');
});

describe('not-found page accessibility', () => {
  it('provides a named page heading and dashboard recovery link', () => {
    setLanguage('en');
    render(
      <MemoryRouter initialEntries={['/unknown-route']}>
        <Routes>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'The requested resource was not found.' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('href')).toBe('/');
    expectInteractiveControlsNamed();
  });
});
