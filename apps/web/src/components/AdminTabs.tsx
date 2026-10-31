import { NavLink } from 'react-router';
import { useTranslation } from '../i18n';

const tabs = [
  { to: '/admin', labelKey: 'admin.metrics', end: true },
  { to: '/admin/users', labelKey: 'nav.users' },
  { to: '/admin/providers', labelKey: 'nav.providers' },
  { to: '/admin/audit', labelKey: 'nav.audit' },
  { to: '/admin/monitoring', labelKey: 'nav.monitoring' },
];

export function AdminTabs() {
  const { t } = useTranslation();
  return (
    <div className="tabs tabs-box mb-5 w-full flex-wrap sm:w-auto" role="navigation" aria-label={t('nav.administration')}>
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) => `tab ${isActive ? 'tab-active' : ''}`}
        >
          {t(tab.labelKey)}
        </NavLink>
      ))}
    </div>
  );
}
