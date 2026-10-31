import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { describeSchedule } from '../lib/describe';
import { formatDate, formatDuration } from '../lib/format';
import {
  ConfirmDialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Spinner,
  StatusBadge,
  useToast,
} from '../components/ui';

type ActionName = 'pause' | 'resume' | 'run' | 'duplicate';

export function TaskDetailPage() {
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const task = useQuery({ queryKey: ['task', id], queryFn: () => api.tasks.get(id), enabled: Boolean(id) });
  const executions = useQuery({
    queryKey: ['task-executions', id],
    queryFn: () => api.tasks.executions(id),
    enabled: Boolean(id),
  });

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['task', id] }),
      queryClient.invalidateQueries({ queryKey: ['task-executions', id] }),
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);
  };

  const action = useMutation({
    mutationFn: (name: ActionName) => api.tasks.action(id, name),
    onMutate: () => setActionError(null),
    onSuccess: async (_result, name) => {
      await invalidate();
      const messages: Record<ActionName, string> = {
        pause: t('tasks.pausedMsg'),
        resume: t('tasks.resumedMsg'),
        run: t('tasks.runQueued'),
        duplicate: t('tasks.duplicated'),
      };
      showToast(messages[name]);
    },
    onError: (cause) => setActionError(errorMessage(cause)),
  });

  const remove = useMutation({
    mutationFn: () => api.tasks.remove(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      showToast(t('tasks.deleted'));
      navigate('/tasks', { replace: true });
    },
    onError: (cause) => setActionError(errorMessage(cause)),
  });

  if (task.isLoading) return <Spinner label={t('common.loadingPage')} />;
  if (task.isError || !task.data) return <ErrorAlert message={t('errors.notFound')} />;

  const data = task.data;
  const limits = data.limits;

  return (
    <>
      <PageHeader
        title={data.title}
        subtitle={data.description ?? undefined}
        actions={
          <>
            <Link className="btn btn-ghost btn-sm" to="/tasks">
              ← {t('nav.tasks')}
            </Link>
            <Link className="btn btn-sm btn-outline" to={`/tasks/${data.id}/edit`}>
              {t('common.edit')}
            </Link>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={() => action.mutate(data.enabled ? 'pause' : 'resume')}
              disabled={action.isPending}
            >
              {data.enabled ? t('tasks.pause') : t('tasks.resume')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => action.mutate('run')}
              disabled={action.isPending}
            >
              {t('tasks.runNow')}
            </button>
          </>
        }
      />

      {actionError ? (
        <div className="mb-4">
          <ErrorAlert message={actionError} />
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="flex flex-col gap-5 xl:col-span-2">
          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-3 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${data.enabled ? 'badge-success' : 'badge-ghost'}`}>
                  {data.enabled ? t('common.enabled') : t('common.disabled')}
                </span>
                <span className="badge badge-ghost">{data.model}</span>
                <span className="text-xs opacity-60">
                  {t('tasks.created')}: {formatDate(data.createdAt, i18n.language)}
                </span>
              </div>
              <h2 className="card-title text-base">{t('tasks.prompt')}</h2>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{data.prompt}</p>
              {data.systemInstructions ? (
                <>
                  <h3 className="mt-2 text-sm font-semibold">{t('tasks.systemInstructions')}</h3>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed opacity-80">
                    {data.systemInstructions}
                  </p>
                </>
              ) : null}
            </div>
          </section>

          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body p-5">
              <h2 className="card-title text-base">{t('tasks.executionsTitle')}</h2>
              {executions.isLoading ? (
                <Spinner />
              ) : executions.isError ? (
                <ErrorAlert
                  message={t('errors.loadFailed')}
                  onRetry={() => {
                    void executions.refetch();
                  }}
                />
              ) : !executions.data || executions.data.length === 0 ? (
                <p className="py-4 text-sm opacity-60">{t('tasks.noExecutions')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th scope="col">{t('executions.execution')}</th>
                        <th scope="col">{t('common.status')}</th>
                        <th scope="col" className="hidden sm:table-cell">{t('executions.startedAt')}</th>
                        <th scope="col" className="text-right">{t('executions.duration')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {executions.data.map((execution) => (
                        <tr key={execution.id}>
                          <td>
                            <Link to={`/executions/${execution.id}`} className="link-hover font-mono text-xs">
                              {execution.id.slice(0, 8)}
                            </Link>
                            <span className="ml-2 text-xs opacity-60">{t(`trigger.${execution.trigger}`)}</span>
                          </td>
                          <td><StatusBadge status={execution.status} /></td>
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
              )}
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-5">
          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-2 p-5 text-sm">
              <h2 className="card-title text-base">{t('tasks.schedule')}</h2>
              <p>{describeSchedule(data.schedule, t)}</p>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="opacity-60">{t('tasks.nextRun')}</dt>
                <dd className="text-right">{data.enabled ? formatDate(data.nextRunAt, i18n.language) : t('common.never')}</dd>
                <dt className="opacity-60">{t('tasks.timezone')}</dt>
                <dd className="text-right">{data.timezone}</dd>
              </dl>
            </div>
          </section>

          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-2 p-5 text-sm">
              <h2 className="card-title text-base">{t('tasks.limitsSection')}</h2>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
                <dt className="opacity-60">{t('tasks.limitsDuration')}</dt>
                <dd>{limits.maxDurationSec}</dd>
                <dt className="opacity-60">{t('tasks.limitsSteps')}</dt>
                <dd>{limits.maxAgentSteps}</dd>
                <dt className="opacity-60">{t('tasks.limitsPages')}</dt>
                <dd>{limits.maxPageVisits}</dd>
                <dt className="opacity-60">{t('tasks.limitsOutput')}</dt>
                <dd>{limits.maxOutputBytes}</dd>
                <dt className="opacity-60">{t('tasks.limitsToolCalls')}</dt>
                <dd>{limits.maxToolCalls}</dd>
                <dt className="opacity-60">{t('tasks.limitsSearches')}</dt>
                <dd>{limits.maxSearchQueries}</dd>
              </dl>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className={`badge badge-sm ${data.allowWebResearch ? 'badge-info' : 'badge-ghost'}`}>
                  {t('tasks.allowWebResearch')}
                </span>
                <span className="badge badge-ghost badge-sm">{t(`tasks.notification${data.notification === 'email' ? 'Email' : 'None'}`)}</span>
              </div>
            </div>
          </section>

          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-2 p-5">
              <h2 className="card-title text-base">{t('common.actions')}</h2>
              <button
                type="button"
                className="btn btn-sm justify-start"
                onClick={() => action.mutate('duplicate')}
                disabled={action.isPending}
              >
                {t('tasks.duplicate')}
              </button>
              <button type="button" className="btn btn-sm btn-error btn-outline justify-start" onClick={() => setDeleteOpen(true)}>
                {t('common.delete')}
              </button>
            </div>
          </section>
        </div>
      </div>

      {executions.data && executions.data.length === 0 ? (
        <div className="mt-5">
          <EmptyState title={t('tasks.noExecutions')} description={t('executions.emptyHint')} />
        </div>
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        title={t('tasks.deleteTitle')}
        body={t('tasks.deleteBody', { title: data.title })}
        confirmLabel={t('tasks.deleteConfirm')}
        onConfirm={() => remove.mutate()}
        onClose={() => setDeleteOpen(false)}
        loading={remove.isPending}
      />
    </>
  );
}
