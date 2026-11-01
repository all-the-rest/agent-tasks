import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { setLanguage } from '../i18n';
import { MemoryCommandBar } from './MemoryCommandBar';
import type { Locale } from '../lib/types';

type IconName =
  | 'dashboard'
  | 'tasks'
  | 'executions'
  | 'memory'
  | 'settings'
  | 'admin'
  | 'users'
  | 'providers'
  | 'audit'
  | 'monitoring'
  | 'menu'
  | 'sun'
  | 'moon'
  | 'logout';

const paths: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  tasks: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17" />
    </>
  ),
  executions: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8 6 4-6 4Z" />
    </>
  ),
  memory: (
    <>
      <path d="M5 4h11a2 2 0 0 1 2 2v14l-4-2.5L10 20l-4-2.5Z" />
      <path d="M8 8h7M8 12h5" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  admin: (
    <>
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16 4.5a3 3 0 0 1 0 6M18 14c2 1 3 3 3 6" />
    </>
  ),
  providers: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  audit: (
    <>
      <path d="M6 3h9l4 4v14H6Z" />
      <path d="M15 3v4h4M9 12h7M9 16h7" />
    </>
  ),
  monitoring: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" />,
  logout: (
    <>
      <path d="M15 4h4v16h-4" />
      <path d="M11 8l-4 4 4 4M7 12h9" />
    </>
  ),
};

function Icon({ name, className = 'size-5' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

interface NavEntry {
  to: string;
  labelKey: string;
  icon: IconName;
  end?: boolean;
}

const mainNav: NavEntry[] = [
  { to: '/', labelKey: 'nav.dashboard', icon: 'dashboard', end: true },
  { to: '/tasks', labelKey: 'nav.tasks', icon: 'tasks' },
  { to: '/executions', labelKey: 'nav.executions', icon: 'executions' },
  { to: '/memory', labelKey: 'nav.memory', icon: 'memory' },
  { to: '/settings', labelKey: 'nav.settings', icon: 'settings' },
];

const adminNav: NavEntry[] = [
  { to: '/admin', labelKey: 'nav.admin', icon: 'admin', end: true },
  { to: '/admin/users', labelKey: 'nav.users', icon: 'users' },
  { to: '/admin/providers', labelKey: 'nav.providers', icon: 'providers' },
  { to: '/admin/audit', labelKey: 'nav.audit', icon: 'audit' },
  { to: '/admin/monitoring', labelKey: 'nav.monitoring', icon: 'monitoring' },
];

function NavItems({ entries, onNavigate }: { entries: NavEntry[]; onNavigate: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      {entries.map((entry) => (
        <li key={entry.to}>
          <NavLink
            to={entry.to}
            end={entry.end}
            onClick={onNavigate}
            className={({ isActive }) => (isActive ? 'menu-active font-semibold' : undefined)}
          >
            <Icon name={entry.icon} />
            <span>{t(entry.labelKey)}</span>
          </NavLink>
        </li>
      ))}
    </>
  );
}

export function Layout() {
  const { t, i18n } = useTranslation();
  const { user, signOut } = useAuth();
  const { resolved, toggleTheme, setTheme, theme } = useTheme();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const closeDrawer = () => setDrawerOpen(false);
  const currentLocale: Locale = i18n.resolvedLanguage === 'de' ? 'de' : 'en';

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const onSignOut = async () => {
    await signOut();
    queryClient.clear();
    navigate('/login', { replace: true });
  };

  const onToggleLanguage = () => {
    setLanguage(currentLocale === 'de' ? 'en' : 'de');
  };

  return (
    <div className="drawer lg:drawer-open">
      <input
        id="app-drawer"
        type="checkbox"
        className="drawer-toggle"
        checked={drawerOpen}
        onChange={(event) => setDrawerOpen(event.target.checked)}
        aria-label={t('nav.openMenu')}
      />
      <div className="drawer-content flex min-h-screen min-w-0 flex-col bg-base-200">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-content"
        >
          {t('common.skipToContent')}
        </a>
        <header className="sticky top-0 z-30 border-b border-base-300 bg-base-100/90 backdrop-blur">
          <div className="navbar min-h-14 gap-2 px-3 sm:px-5">
            <div className="flex-none lg:hidden">
              <button
                type="button"
                className="btn btn-square btn-ghost btn-sm"
                aria-label={t('nav.openMenu')}
                aria-expanded={drawerOpen}
                aria-controls="app-drawer"
                onClick={() => setDrawerOpen(true)}
              >
                <Icon name="menu" />
              </button>
            </div>
            <div className="hidden min-w-0 flex-1 md:block">
              <MemoryCommandBar />
            </div>
            <div className="min-w-0 flex-1 md:hidden">
              <Link to="/" className="flex items-center gap-2 lg:hidden" onClick={closeDrawer}>
                <span className="grid size-8 place-items-center rounded-lg bg-primary text-sm font-black text-primary-content">
                  AT
                </span>
                <span className="truncate font-bold">{t('app.name')}</span>
              </Link>
            </div>
            <div className="flex flex-none items-center gap-1">
              <button
                type="button"
                className="btn btn-ghost btn-sm font-semibold"
                onClick={onToggleLanguage}
                aria-label={t('common.language')}
                title={t('common.language')}
              >
                {currentLocale === 'de' ? 'EN' : 'DE'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-square"
                onClick={toggleTheme}
                aria-label={t('nav.toggleTheme')}
                title={theme === 'system' ? t('settings.themeSystem') : t('nav.toggleTheme')}
              >
                <Icon name={resolved === 'dark' ? 'sun' : 'moon'} />
              </button>
              {user ? (
                <div className="dropdown dropdown-end">
                  <button
                    type="button"
                    tabIndex={0}
                    className="btn btn-ghost btn-sm gap-2"
                    aria-label={t('nav.signedInAs')}
                  >
                    <span className="grid size-7 place-items-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                      {user.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="hidden max-w-32 truncate sm:inline">{user.name}</span>
                  </button>
                  <ul
                    tabIndex={0}
                    className="dropdown-content menu z-40 mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow-xl"
                  >
                    <li className="menu-title truncate px-2 text-xs">{user.email}</li>
                    <li>
                      <Link to="/settings" onClick={() => setDrawerOpen(false)}>
                        <Icon name="settings" />
                        {t('nav.settings')}
                      </Link>
                    </li>
                    <li>
                      <button type="button" onClick={onSignOut}>
                        <Icon name="logout" />
                        {t('nav.logout')}
                      </button>
                    </li>
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <main id="main-content" className="mx-auto w-full min-w-0 max-w-7xl flex-1 px-3 py-5 sm:px-6 sm:py-7 lg:px-8">
          <Outlet />
        </main>
        <footer className="border-t border-base-300 px-4 py-4 text-center text-xs opacity-60">
          {t('app.name')} · {t('app.tagline')}
        </footer>
      </div>

      <aside className="drawer-side z-40">
        <label htmlFor="app-drawer" aria-label={t('nav.closeMenu')} className="drawer-overlay" />
        <div className="flex min-h-full w-72 flex-col border-r border-base-300 bg-base-100">
          <div className="flex h-16 items-center gap-2 border-b border-base-300 px-5">
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-sm font-black text-primary-content">
              AT
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold leading-tight">{t('app.name')}</p>
              <p className="truncate text-xs opacity-60">{t('app.tagline')}</p>
            </div>
          </div>
          <nav className="flex-1 overflow-y-auto p-3" aria-label={t('nav.mainNavigation')}>
            <ul className="menu menu-md w-full gap-1">
              <NavItems entries={mainNav} onNavigate={closeDrawer} />
            </ul>
            {user?.role === 'ADMIN' ? (
              <>
                <p className="px-3 pb-1 pt-5 text-xs font-semibold uppercase tracking-wide opacity-50">
                  {t('nav.administration')}
                </p>
                <ul className="menu menu-md w-full gap-1">
                  <NavItems entries={adminNav} onNavigate={closeDrawer} />
                </ul>
              </>
            ) : null}
          </nav>
          <div className="border-t border-base-300 p-3">
            <button
              type="button"
              className="btn btn-ghost w-full justify-start gap-2"
              onClick={() => {
                setTheme(theme === 'dark' ? 'light' : 'dark');
                closeDrawer();
              }}
            >
              <Icon name={resolved === 'dark' ? 'sun' : 'moon'} />
              {resolved === 'dark' ? t('settings.themeLight') : t('settings.themeDark')}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
