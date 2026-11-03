// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { i18n, setLanguage, useTranslation } from '../src/i18n';
import { renderHook, act } from '@testing-library/react';

afterEach(() => {
  act(() => setLanguage('en'));
});

describe('translations (Lingui catalogs)', () => {
  it('renders English by default and German after switching', () => {
    const { result } = renderHook(() => useTranslation());
    expect(result.current.t('common.save')).toBe('Save');
    expect(result.current.i18n.language).toBe('en');

    act(() => setLanguage('de'));
    expect(result.current.t('common.save')).toBe('Speichern');
    expect(result.current.i18n.language).toBe('de');
    expect(document.documentElement.lang).toBe('de');
  });

  it('interpolates values from the message', () => {
    const { result } = renderHook(() => useTranslation());
    const rendered = result.current.t('executions.tokens', { total: '1,204' });
    expect(rendered).toContain('1,204');
  });

  it('translates end-condition validation errors in English and German', () => {
    const { result } = renderHook(() => useTranslation());
    expect(result.current.t('validation.endConditionInvalid')).toBe('Enter a valid end date or number of runs.');

    act(() => setLanguage('de'));
    expect(result.current.t('validation.endConditionInvalid')).toBe('Gib ein gültiges Enddatum oder eine gültige Laufanzahl ein.');
  });

  it('falls back to the id when a key is unknown instead of throwing', () => {
    const { result } = renderHook(() => useTranslation());
    expect(result.current.t('does.not.exist')).toBe('does.not.exist');
    expect(i18n.locale === 'en' || i18n.locale === 'de').toBe(true);
  });
});
