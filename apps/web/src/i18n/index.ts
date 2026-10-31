import { i18n } from '@lingui/core';
import { compileMessage } from '@lingui/message-utils/compileMessage';
import { useSyncExternalStore } from 'react';
import type { Locale } from '../lib/types';
import { messages as enMessages } from '../locales/en/messages';
import { messages as deMessages } from '../locales/de/messages';

/**
 * Translation runtime: Lingui core with gettext catalogs.
 *
 * `scripts/generate-catalogs.mjs` turns the shape-checked dictionaries in
 * `src/i18n/en.ts` / `de.ts` into PO files and compiled catalogs, so the message
 * ids are stable dot keys and translators work on `.po` files.
 */
const LANGUAGE_KEY = 'agent-tasks.lang';

const catalogs: Record<Locale, Record<string, string>> = { en: enMessages, de: deMessages };

i18n.load(catalogs);
// The catalogs are authored as plain ICU strings (see scripts/generate-catalogs.mjs).
// Lingui 6 expects compiled messages; compile them lazily at startup so
// interpolation, plural forms and dates work instead of rendering raw `{{...}}`.
i18n.setMessagesCompiler(compileMessage);
i18n.activate(initialLanguage());

const listeners = new Set<() => void>();

function initialLanguage(): Locale {
  try {
    const stored = localStorage.getItem(LANGUAGE_KEY);
    if (stored === 'de' || stored === 'en') return stored;
    const browser = navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en';
    return browser;
  } catch {
    return 'en';
  }
}

if (typeof document !== 'undefined') {
  document.documentElement.lang = i18n.locale || 'en';
}

export function setLanguage(locale: Locale): void {
  try {
    localStorage.setItem(LANGUAGE_KEY, locale);
  } catch {
    /* storage unavailable */
  }
  i18n.activate(locale);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}

export function currentLanguage(): Locale {
  return i18n.locale === 'de' ? 'de' : 'en';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface Translator {
  (id: string, values?: Record<string, unknown>): string;
}

/**
 * Drop-in shape for the former react-i18next hook: components use `t('key')`,
 * `i18n.language` and `i18n.resolvedLanguage`; the values are interpolated by Lingui.
 */
export function useTranslation(): { t: Translator; i18n: { language: Locale; resolvedLanguage: Locale } } {
  const locale = useSyncExternalStore(subscribe, currentLanguage, currentLanguage);
  const t: Translator = (id, values) => {
    const message = i18n._(id, values as never);
    return message ?? id;
  };
  const snapshot = { language: locale, resolvedLanguage: locale };
  return { t, i18n: snapshot };
}

export { i18n };
