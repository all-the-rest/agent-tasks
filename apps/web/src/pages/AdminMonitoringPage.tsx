import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api } from '../lib/api';
import { formatDate, formatDuration, formatNumber } from '../lib/format';
import { AdminTabs } from '../components/AdminTabs';
import {
  ErrorAlert,
  PageHeader,
  Spinner,
  StatusBadge,
} from '../components/ui';
import type { ExecutionStatus } from '../lib/types';

export function AdminMonitoringPage() {
  const { t, i18n } = useTranslation();
  const [autoRefresh, setAutoRefresh] = useState(true);

  const metrics = useQuery({
    queryKey: ['admin', 'metrics'],
    queryFn: api.admin.metrics,
    refetchInterval: autoRefresh ? 15_000 : false,
  });
  const executions = useQuery({
    queryKey: ['executions', 'monitoring'],
    queryFn: () => api.executions.list({ limit: 15 }),
    refetchInterval: autoRefresh ? 15_000 : false,
  });

  const lastUpdated = Math.max(metrics.dataUpdatedAt, executions.dataUpdatedAt);

  if (metrics.isLoading) return <Spinner label={t('common.loadingPage')} />;
  if (metrics.isError || !metrics.data) return <ErrorAlert message={t('errors.loadFailed')} />;

  const statusEntries = Object.entries(metrics.data.byStatus) as Array<[string, number]>;

  return (
    <>
      <PageHeader title={t('admin.monitoring')} subtitle={t('admin.monitoringHint')} />
      <AdminTabs />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-box border border-base-300 bg-base-100 px-4 py-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm" htmlFor="monitoring-auto">
          <input
            id="monitoring-auto"
            type="checkbox"
            className="toggle toggle-sm"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          {t('admin.autoRefresh')}
        </label>
        <p className="text-xs opacity-60" aria-live="polite">
          {t('admin.lastUpdated')}: {lastUpdated ? formatDate(new Date(lastUpdated).toISOString(), i18n.language) : '—'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: t('admin.usersCount'), value: metrics.data.users },
          { label: t('admin.tasksCount'), value: metrics.data.tasks },
          { label: t('admin.executions24h'), value: metrics.data.executionsLast24h },
          { label: t('admin.activeExecutions'), value: metrics.data.active },
        ].map((metric) => (
          <div key={metric.label} className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-1 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">{metric.label}</p>
              <p className="text-3xl font-black tabular-nums">{formatNumber(metric.value, i18n.language)}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <section className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body p-5">
            <h2 className="card-title text-base">{t('admin.byStatus')}</h2>
            {statusEntries.length === 0 ? (
              <p className="text-sm opacity-60">{t('common.noData')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {statusEntries.map(([status, count]) => (
                  <li key={status} className="flex items-center justify-between rounded-lg bg-base-200 px-3 py-2 text-sm">
                    <StatusBadge status={status as ExecutionStatus} />
                    <span className="font-bold tabular-nums">{formatNumber(count, i18n.language)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="card border border-base-300 bg-base-100 shadow-sm xl:col-span-2">
          <div className="card-body p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="card-title text-base">{t('admin.recentExecutions')}</h2>
              <Link className="btn btn-ghost btn-xs" to="/executions">
                {t('dashboard.viewExecutions')}
              </Link>
            </div>
            {executions.isLoading ? (
              <Spinner />
            ) : executions.isError ? (
              <ErrorAlert message={t('errors.loadFailed')} />
            ) : !executions.data || executions.data.length === 0 ? (
              <p className="py-6 text-center text-sm opacity-60">{t('dashboard.noExecutions')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th scope="col">{t('executions.task')}</th>
                      <th scope="col">{t('common.status')}</th>
                      <th scope="col" className="hidden sm:table-cell">{t('executions.startedAt')}</th>
                      <th scope="col" className="text-right">{t('executions.duration')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {executions.data.map((execution) => (
                      <tr key={execution.id}>
                        <td className="max-w-56 truncate">
                          <Link className="link-hover" to={`/executions/${execution.id}`}>
                            {execution.taskTitle}
                          </Link>
                        </td>
                        <td><StatusBadge status={execution.status} /></td>
                        <td className="hidden whitespace-nowrap text-xs opacity-60 sm:table-cell">
                          {formatDate(execution.startedAt, i18n.language)}
                        </td>
                        <td className="whitespace-nowrap text-right text-xs opacity-60">
                          {formatDuration(execution.durationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
