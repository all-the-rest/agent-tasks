import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { AdminTabs } from '../components/AdminTabs';
import { ErrorAlert, PageHeader, Spinner } from '../components/ui';

export function AdminAuditPage() {
  const { t, i18n } = useTranslation();
  const audit = useQuery({ queryKey: ['admin', 'audit'], queryFn: api.admin.audit });

  return (
    <>
      <PageHeader title={t('admin.audit')} subtitle={t('admin.auditHint')} />
      <AdminTabs />

      {audit.isLoading ? (
        <Spinner label={t('common.loading')} />
      ) : audit.isError ? (
        <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void audit.refetch()} />
      ) : !audit.data || audit.data.length === 0 ? (
        <div className="rounded-box border border-dashed border-base-300 bg-base-100 p-10 text-center text-sm opacity-60">
          {t('admin.noAudit')}
        </div>
      ) : (
        <div className="overflow-hidden rounded-box border border-base-300 bg-base-100 shadow-sm">
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th scope="col">{t('admin.action')}</th>
                  <th scope="col" className="hidden sm:table-cell">{t('admin.actor')}</th>
                  <th scope="col" className="hidden md:table-cell">{t('admin.target')}</th>
                  <th scope="col" className="hidden lg:table-cell">{t('admin.ip')}</th>
                  <th scope="col" className="hidden xl:table-cell">{t('admin.metadata')}</th>
                  <th scope="col" className="text-right">{t('admin.created')}</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <span className="badge badge-ghost badge-sm whitespace-nowrap font-mono text-[11px]">
                        {entry.action}
                      </span>
                    </td>
                    <td className="hidden max-w-40 truncate font-mono text-xs opacity-70 sm:table-cell">
                      {entry.actorId?.slice(0, 8) ?? '—'}
                    </td>
                    <td className="hidden max-w-48 truncate text-xs opacity-70 md:table-cell">
                      {entry.targetType ? `${entry.targetType}:${entry.targetId?.slice(0, 8) ?? ''}` : '—'}
                    </td>
                    <td className="hidden font-mono text-xs opacity-60 lg:table-cell">{entry.ip ?? '—'}</td>
                    <td className="hidden max-w-56 truncate font-mono text-[11px] opacity-60 xl:table-cell">
                      {entry.metadata ? JSON.stringify(entry.metadata) : '—'}
                    </td>
                    <td className="whitespace-nowrap text-right text-xs opacity-60">
                      {formatDate(entry.createdAt, i18n.language)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
