import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api } from '../lib/api';
import { describeSchedule } from '../lib/describe';
import { formatDate, formatRelative } from '../lib/format';
import { EmptyState, ErrorAlert, PageHeader, Spinner, StatusBadge } from '../components/ui';
import type { DashboardTask } from '../lib/types';

function StatCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="card border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body gap-1 p-4 sm:p-5">
        <p className="text-xs font-semibold uppercase tracking-wide opacity-60">{label}</p>
        <p className={`text-3xl font-black tabular-nums ${accent}`}>{value}</p>
      </div>
    </div>
  );
}

function TaskList({ tasks, empty }: { tasks: DashboardTask[]; empty: string }) {
  const { t, i18n } = useTranslation();
  if (tasks.length === 0) return <p className="px-1 py-4 text-sm opacity-60">{empty}</p>;
  return (
    <ul className="divide-y divide-base-200">
      {tasks.slice(0, 5).map((task) => (
        <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div className="min-w-0">
            <Link to={`/tasks/${task.id}`} className="link-hover font-medium">
              {task.title}
            </Link>
            <p className="truncate text-xs opacity-60">{describeSchedule(task.schedule, t)}</p>
          </div>
          <div className="text-right text-xs">
            <p className="font-semibold">{t('dashboard.nextRun')}</p>
            <p className="opacity-70">
              {task.nextRunAt ? formatDate(task.nextRunAt, i18n.language) : t('common.never')}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard });

  if (dashboard.isLoading) return <Spinner label={t('common.loadingPage')} />;
  if (dashboard.isError || !dashboard.data) {
    return (
      <ErrorAlert
        message={t('errors.loadFailed')}
        onRetry={() => {
          void dashboard.refetch();
        }}
      />
    );
  }

  const data = dashboard.data;

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle')}
        actions={
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => {
              void dashboard.refetch();
            }}
            disabled={dashboard.isFetching}
          >
            {dashboard.isFetching ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
            {t('common.refresh')}
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('dashboard.activeTasks')} value={data.activeTasks.length} accent="text-success" />
        <StatCard label={t('dashboard.pausedTasks')} value={data.pausedTasks.length} accent="text-base-content/60" />
        <StatCard label={t('dashboard.recentExecutions')} value={data.recentExecutions.length} accent="text-info" />
        <StatCard label={t('dashboard.failures')} value={data.failures.length} accent="text-error" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <section className="card border border-base-300 bg-base-100 shadow-sm xl:col-span-2">
          <div className="card-body p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="card-title text-base">{t('dashboard.recentExecutions')}</h2>
              <Link className="btn btn-ghost btn-xs" to="/executions">
                {t('dashboard.viewExecutions')}
              </Link>
            </div>
            {data.recentExecutions.length === 0 ? (
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
                    {data.recentExecutions.slice(0, 8).map((execution) => (
                      <tr key={execution.id}>
                        <td className="max-w-48 truncate">
                          <Link className="link-hover" to={`/executions/${execution.id}`}>
                            {execution.taskTitle}
                          </Link>
                        </td>
                        <td><StatusBadge status={execution.status} /></td>
                        <td className="hidden whitespace-nowrap text-xs opacity-70 sm:table-cell">
                          {formatDate(execution.startedAt, i18n.language)}
                        </td>
                        <td className="whitespace-nowrap text-right text-xs opacity-70">
                          {formatRelative(execution.startedAt, i18n.language)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <div className="flex flex-col gap-5">
          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="card-title text-base">{t('dashboard.activeTasks')}</h2>
                <Link className="btn btn-ghost btn-xs" to="/tasks">
                  {t('dashboard.viewTasks')}
                </Link>
              </div>
              <TaskList tasks={data.activeTasks} empty={t('dashboard.noActive')} />
              {data.pausedTasks.length > 0 ? (
                <>
                  <h3 className="mt-2 text-xs font-semibold uppercase tracking-wide opacity-50">
                    {t('dashboard.pausedTasks')}
                  </h3>
                  <TaskList tasks={data.pausedTasks} empty={t('dashboard.noPaused')} />
                </>
              ) : null}
            </div>
          </section>

          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body p-5">
              <h2 className="card-title text-base">{t('dashboard.failures')}</h2>
              {data.failures.length === 0 ? (
                <div className="alert alert-success mt-1 py-2" role="status">
                  <span className="text-sm">{t('dashboard.noFailures')}</span>
                </div>
              ) : (
                <ul className="mt-1 flex flex-col gap-2">
                  {data.failures.slice(0, 4).map((failure) => (
                    <li key={failure.id}>
                      <Link to={`/executions/${failure.id}`} className="alert alert-error block px-3 py-2">
                        <span className="block truncate text-sm font-medium">{failure.taskTitle}</span>
                        <span className="block truncate text-xs opacity-80">
                          {failure.error ?? t('common.error')}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>

      {data.activeTasks.length === 0 && data.recentExecutions.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title={t('tasks.empty')}
            description={t('tasks.emptyHint')}
            action={
              <Link className="btn btn-primary btn-sm" to="/tasks/new">
                {t('tasks.createFirst')}
              </Link>
            }
          />
        </div>
      ) : null}
    </>
  );
}
