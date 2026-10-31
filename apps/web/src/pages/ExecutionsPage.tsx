import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api } from '../lib/api';
import { formatDate, formatDuration } from '../lib/format';
import { EmptyState, ErrorAlert, PageHeader, Spinner, StatusBadge } from '../components/ui';
import type { ExecutionStatus } from '../lib/types';

const STATUS_FILTERS: Array<ExecutionStatus | ''> = [
  '',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
];

export function ExecutionsPage() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<ExecutionStatus | ''>('');
  const executions = useQuery({
    queryKey: ['executions', status],
    queryFn: () => api.executions.list({ limit: 50, status: status || undefined }),
    refetchInterval: status === 'running' ? 10_000 : false,
  });

  return (
    <>
      <PageHeader
        title={t('executions.title')}
        subtitle={t('executions.subtitle')}
        actions={
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => {
              void executions.refetch();
            }}
            disabled={executions.isFetching}
          >
            {executions.isFetching ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
            {t('common.refresh')}
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide opacity-60">{t('executions.filterStatus')}</span>
        <div className="tabs tabs-box tabs-sm flex-wrap" role="group" aria-label={t('executions.filterStatus')}>
          {STATUS_FILTERS.map((value) => (
            <button
              key={value || 'all'}
              type="button"
              className={`tab ${status === value ? 'tab-active' : ''}`}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {value ? t(`status.${value}`) : t('executions.allStatuses')}
            </button>
          ))}
        </div>
      </div>

      {executions.isLoading ? (
        <Spinner label={t('common.loading')} />
      ) : executions.isError ? (
        <ErrorAlert
          message={t('errors.loadFailed')}
          onRetry={() => {
            void executions.refetch();
          }}
        />
      ) : !executions.data || executions.data.length === 0 ? (
        <EmptyState title={t('executions.empty')} description={t('executions.emptyHint')} />
      ) : (
        <div className="overflow-hidden rounded-box border border-base-300 bg-base-100 shadow-sm">
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th scope="col">{t('executions.task')}</th>
                  <th scope="col">{t('common.status')}</th>
                  <th scope="col" className="hidden md:table-cell">{t('executions.trigger')}</th>
                  <th scope="col" className="hidden sm:table-cell">{t('executions.startedAt')}</th>
                  <th scope="col" className="text-right">{t('executions.duration')}</th>
                </tr>
              </thead>
              <tbody>
                {executions.data.map((execution) => (
                  <tr key={execution.id} className="hover:bg-base-200/50">
                    <td className="max-w-72">
                      <Link to={`/executions/${execution.id}`} className="font-medium link-hover">
                        {execution.taskTitle}
                      </Link>
                      {execution.error ? (
                        <p className="truncate text-xs text-error">{execution.error}</p>
                      ) : (
                        <p className="font-mono text-xs opacity-50">{execution.id.slice(0, 8)}</p>
                      )}
                    </td>
                    <td><StatusBadge status={execution.status} /></td>
                    <td className="hidden text-xs opacity-70 md:table-cell">{t(`trigger.${execution.trigger}`)}</td>
                    <td className="hidden whitespace-nowrap text-xs opacity-70 sm:table-cell">
                      {formatDate(execution.startedAt, i18n.language)}
                    </td>
                    <td className="whitespace-nowrap text-right text-xs opacity-70">
                      {formatDuration(execution.durationMs)}
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
