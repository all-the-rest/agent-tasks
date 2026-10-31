import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { describeSchedule } from '../lib/describe';
import { formatDate, formatRelative } from '../lib/format';
import {
  ConfirmDialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Spinner,
  useToast,
} from '../components/ui';
import type { Task } from '../lib/types';

type TaskAction = 'pause' | 'resume' | 'run' | 'duplicate';

export function TasksPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks.list });

  const [filter, setFilter] = useState('');
  const [toDelete, setToDelete] = useState<Task | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['executions'] }),
    ]);
  };

  const action = useMutation({
    mutationFn: ({ id, name }: { id: string; name: TaskAction }) => api.tasks.action(id, name),
    onMutate: ({ id }) => {
      setPendingId(id);
      setActionError(null);
    },
    onSuccess: async (_data, variables) => {
      await invalidate();
      const messages: Record<TaskAction, string> = {
        pause: t('tasks.pausedMsg'),
        resume: t('tasks.resumedMsg'),
        run: t('tasks.runQueued'),
        duplicate: t('tasks.duplicated'),
      };
      showToast(messages[variables.name]);
    },
    onError: (cause) => setActionError(errorMessage(cause)),
    onSettled: () => setPendingId(null),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.tasks.remove(id),
    onSuccess: async () => {
      setToDelete(null);
      await invalidate();
      showToast(t('tasks.deleted'));
    },
    onError: (cause) => setActionError(errorMessage(cause)),
  });

  const visible = useMemo(() => {
    const rows = tasks.data ?? [];
    const needle = filter.trim().toLowerCase();
    return needle ? rows.filter((task) => task.title.toLowerCase().includes(needle)) : rows;
  }, [tasks.data, filter]);

  if (tasks.isLoading) return <Spinner label={t('common.loadingPage')} />;
  if (tasks.isError) {
    return (
      <ErrorAlert
        message={t('errors.loadFailed')}
        onRetry={() => {
          void tasks.refetch();
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={t('tasks.title')}
        subtitle={t('tasks.subtitle')}
        actions={
          <Link className="btn btn-primary btn-sm" to="/tasks/new">
            + {t('tasks.newTask')}
          </Link>
        }
      />

      {actionError ? (
        <div className="mb-4">
          <ErrorAlert message={actionError} />
        </div>
      ) : null}

      {tasks.data && tasks.data.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div className="w-full max-w-xs">
            <label className="sr-only" htmlFor="task-filter">
              {t('tasks.searchPlaceholder')}
            </label>
            <input
              id="task-filter"
              type="search"
              className="input input-sm w-full"
              placeholder={t('tasks.searchPlaceholder')}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <p className="text-xs opacity-60" aria-live="polite">
            {t('tasks.count', { count: visible.length })}
          </p>
        </div>
      ) : null}

      {!tasks.data || tasks.data.length === 0 ? (
        <EmptyState
          title={t('tasks.empty')}
          description={t('tasks.emptyHint')}
          action={
            <Link className="btn btn-primary btn-sm" to="/tasks/new">
              {t('tasks.createFirst')}
            </Link>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState title={t('common.noData')} />
      ) : (
        <>
          <div className="flex flex-col gap-3 md:hidden">
            {visible.map((task) => (
              <article key={task.id} className="card border border-base-300 bg-base-100 shadow-sm">
                <div className="card-body gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link to={`/tasks/${task.id}`} className="font-semibold link-hover">
                        {task.title}
                      </Link>
                      <p className="text-xs opacity-60">{task.model}</p>
                    </div>
                    <span className={`badge badge-sm ${task.enabled ? 'badge-success' : 'badge-ghost'}`}>
                      {task.enabled ? t('common.enabled') : t('common.disabled')}
                    </span>
                  </div>
                  <p className="text-xs opacity-70">{describeSchedule(task.schedule, t)}</p>
                  <p className="text-xs opacity-60">
                    {t('tasks.nextRun')}: {task.enabled ? formatDate(task.nextRunAt, i18n.language) : t('common.never')}
                  </p>
                  <div className="flex flex-wrap items-center gap-1 border-t border-base-200 pt-2">
                    <button
                      type="button"
                      className="btn btn-xs btn-outline"
                      disabled={pendingId === task.id}
                      onClick={() => action.mutate({ id: task.id, name: task.enabled ? 'pause' : 'resume' })}
                    >
                      {task.enabled ? t('tasks.pause') : t('tasks.resume')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs btn-outline"
                      disabled={pendingId === task.id}
                      onClick={() => action.mutate({ id: task.id, name: 'run' })}
                    >
                      {t('tasks.runNow')}
                    </button>
                    <Link className="btn btn-xs btn-ghost" to={`/tasks/${task.id}/edit`}>
                      {t('common.edit')}
                    </Link>
                    <div className="dropdown dropdown-end ml-auto">
                      <button
                        type="button"
                        tabIndex={0}
                        className="btn btn-xs btn-ghost"
                        aria-label={`${t('common.actions')}: ${task.title}`}
                      >
                        ⋯
                      </button>
                      <ul
                        tabIndex={0}
                        className="dropdown-content menu z-20 mt-1 w-40 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
                      >
                        <li>
                          <button
                            type="button"
                            disabled={pendingId === task.id}
                            onClick={() => action.mutate({ id: task.id, name: 'duplicate' })}
                          >
                            {t('tasks.duplicate')}
                          </button>
                        </li>
                        <li>
                          <Link to={`/tasks/${task.id}`}>{t('common.details')}</Link>
                        </li>
                        <li>
                          <button type="button" className="text-error" onClick={() => setToDelete(task)}>
                            {t('common.delete')}
                          </button>
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-box border border-base-300 bg-base-100 shadow-sm md:block">
            <div className="overflow-x-auto">
              <table className="table table-sm">
              <thead>
                <tr>
                  <th scope="col">{t('tasks.titleLabel')}</th>
                  <th scope="col" className="hidden md:table-cell">{t('tasks.schedule')}</th>
                  <th scope="col" className="hidden sm:table-cell">{t('tasks.nextRun')}</th>
                  <th scope="col">{t('common.status')}</th>
                  <th scope="col" className="text-right">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((task) => (
                  <tr key={task.id} className="hover:bg-base-200/50">
                    <td className="max-w-64">
                      <Link to={`/tasks/${task.id}`} className="font-medium link-hover">
                        {task.title}
                      </Link>
                      <p className="truncate text-xs opacity-60">{task.model}</p>
                    </td>
                    <td className="hidden max-w-64 text-xs opacity-70 md:table-cell">
                      {describeSchedule(task.schedule, t)}
                    </td>
                    <td className="hidden whitespace-nowrap text-xs opacity-70 sm:table-cell">
                      {task.enabled ? formatDate(task.nextRunAt, i18n.language) : t('common.never')}
                    </td>
                    <td>
                      <span className={`badge badge-sm ${task.enabled ? 'badge-success' : 'badge-ghost'}`}>
                        {task.enabled ? t('common.enabled') : t('common.disabled')}
                      </span>
                    </td>
                    <td>
                      <div className="flex flex-wrap justify-end gap-1">
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          disabled={pendingId === task.id}
                          onClick={() => action.mutate({ id: task.id, name: task.enabled ? 'pause' : 'resume' })}
                        >
                          {task.enabled ? t('tasks.pause') : t('tasks.resume')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          disabled={pendingId === task.id}
                          onClick={() => action.mutate({ id: task.id, name: 'run' })}
                        >
                          {t('tasks.runNow')}
                        </button>
                        <Link className="btn btn-ghost btn-xs" to={`/tasks/${task.id}/edit`}>
                          {t('common.edit')}
                        </Link>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          disabled={pendingId === task.id}
                          onClick={() => action.mutate({ id: task.id, name: 'duplicate' })}
                        >
                          {t('tasks.duplicate')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-error"
                          onClick={() => setToDelete(task)}
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                      <p className="text-right text-[11px] opacity-40">
                        {t('tasks.lastRun')}: {formatRelative(task.updatedAt, i18n.language)}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title={t('tasks.deleteTitle')}
        body={t('tasks.deleteBody', { title: toDelete?.title ?? '' })}
        confirmLabel={t('tasks.deleteConfirm')}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete.id);
        }}
        onClose={() => setToDelete(null)}
        loading={remove.isPending}
      />
    </>
  );
}
