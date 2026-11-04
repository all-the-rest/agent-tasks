import type { ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { useTheme } from '../lib/theme';
import { setLanguage } from '../i18n';
import type { Locale } from '../lib/types';

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { resolved, toggleTheme } = useTheme();
  const locale: Locale = i18n.resolvedLanguage === 'de' ? 'de' : 'en';

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-base-200 px-4 py-10">
      <div className="absolute right-3 top-3 flex items-center gap-1">
        <button
          type="button"
          className="btn btn-ghost btn-sm font-semibold"
          onClick={() => setLanguage(locale === 'de' ? 'en' : 'de')}
          aria-label={t('common.language')}
        >
          {locale === 'de' ? 'EN' : 'DE'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square"
          onClick={toggleTheme}
          aria-label={t('nav.toggleTheme')}
        >
          {resolved === 'dark' ? '☀' : '☾'}
        </button>
      </div>
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="grid size-12 place-items-center rounded-2xl bg-primary text-base font-black text-primary-content shadow-lg">
            AT
          </span>
          <div>
            <p className="text-lg font-bold tracking-tight">{t('app.name')}</p>
            <p className="text-xs opacity-60">{t('app.tagline')}</p>
          </div>
        </div>
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-4">
            <div>
              <h1 className="card-title text-xl">{title}</h1>
              <p className="mt-1 text-sm opacity-70">{subtitle}</p>
            </div>
            {children}
          </div>
        </div>
        {footer ? <div className="mt-4 text-center text-sm opacity-80">{footer}</div> : null}
      </div>
    </main>
  );
}
