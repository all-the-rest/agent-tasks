import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useNavigationType } from 'react-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { describeSchedule } from '../lib/describe';
import { formatRelative } from '../lib/format';
import {
  currentTaskPromptDraft,
  rememberTaskPromptDraft,
  TASK_PROMPT_MAX_LENGTH,
  taskPromptDraftFromState,
  taskPromptDraftState,
} from '../lib/task-prompt-draft';
import { TASK_SUGGESTION_IDS } from '../lib/task-suggestions';
import {
  ConfirmDialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Spinner,
  useToast,
} from '../components/ui';
import type { Task, TaskStatus } from '../lib/types';

type TaskAction = 'pause' | 'resume' | 'run' | 'duplicate';
const TASK_STATUSES: TaskStatus[] = ['active', 'paused', 'completed'];
const taskStatusClass: Record<TaskStatus, string> = {
  active: 'badge-success',
  paused: 'badge-ghost',
  completed: 'badge-info',
};

export function TasksPage() {
  const { user } = useAuth();
  const ownerId = user?.id ?? null;
  return <TasksPageForOwner key={ownerId ?? 'signed-out'} ownerId={ownerId} />;
}

function TasksPageForOwner({ ownerId }: { ownerId: string | null }) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [taskStatus, setTaskStatus] = useState<TaskStatus>('active');
  const [promptDraft, setPromptDraft] = useState(
    () => ownerId
      ? currentTaskPromptDraft(ownerId) ?? taskPromptDraftFromState(location.state, ownerId)
      : '',
  );
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const tasks = useInfiniteQuery({
    queryKey: ['tasks', taskStatus],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.tasks.listPage({ status: taskStatus, cursor: pageParam ?? undefined }),
    getNextPageParam: (page) => page.nextCursor ?? null,
  });

  const [filter, setFilter] = useState('');
  const [toDelete, setToDelete] = useState<Task | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    // A browser Back POP returns to the original list history entry. Refresh its
    // owner-scoped history-state snapshot with edits made in the review form.
    if (
      !ownerId ||
      navigationType !== 'POP' ||
      taskPromptDraftFromState(location.state, ownerId) === promptDraft
    ) return;
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: promptDraft ? taskPromptDraftState(ownerId, promptDraft) : null,
    });
  }, [location.hash, location.pathname, location.search, location.state, navigate, navigationType, ownerId, promptDraft]);

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
    const rows = tasks.data?.pages.flatMap((page) => page.items) ?? [];
    const needle = filter.trim().toLowerCase();
    return needle ? rows.filter((task) => task.title.toLowerCase().includes(needle)) : rows;
  }, [tasks.data, filter]);

  // Suggestions are discovery help for an established active list. A status
  // filter with no tasks keeps its empty state, and suggestions never appear
  // on paused or completed views.
  const showSuggestions = taskStatus === 'active' &&
    (tasks.data?.pages.some((page) => page.items.length > 0) ?? false);

  const updatePromptDraft = (nextPrompt: string) => {
    setPromptDraft(nextPrompt);
    if (!ownerId) return;
    // Suggestions and manual edits share one owner-scoped path: memory for the
    // current owner and router history state only, never storage or the URL.
    rememberTaskPromptDraft(ownerId, nextPrompt);
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: taskPromptDraftState(ownerId, nextPrompt),
    });
  };

  const applySuggestion = (suggestionPrompt: string) => {
    updatePromptDraft(suggestionPrompt);
    // Move the caret into the draft so a keyboard or touch selection can edit
    // the bracketed placeholder immediately.
    composerRef.current?.focus();
  };

  if (tasks.isPending) return <Spinner label={t('common.loadingPage')} />;
  if (tasks.isError && !tasks.data) {
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

      <section className="mb-5 rounded-box border border-base-300 bg-base-100 shadow-sm" aria-labelledby="task-prompt-composer-title">
        <div className="card-body gap-3 p-5">
          <div>
            <h2 id="task-prompt-composer-title" className="card-title text-base">
              {t('tasks.promptComposerTitle')}
            </h2>
            <p id="task-prompt-composer-help" className="mt-1 text-sm opacity-70">
              {t('tasks.promptComposerHelp')}
            </p>
          </div>
          <form
            className="flex flex-col items-start gap-3 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              const prompt = promptDraft.trim();
              if (!prompt || !ownerId) return;
              // Keep the list entry clean so successful creation cannot revive this
              // draft. The review entry rehydrates memory after reload; the POP
              // effect below then copies the latest edit onto the list entry.
              navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
              navigate('/tasks/new', { state: taskPromptDraftState(ownerId, prompt) });
            }}
          >
            <div className="w-full flex-1">
              <label className="label pb-1 text-sm font-medium" htmlFor="task-prompt-composer">
                {t('tasks.promptComposerLabel')}
              </label>
              <textarea
                ref={composerRef}
                id="task-prompt-composer"
                className="textarea min-h-24 w-full"
                rows={3}
                maxLength={TASK_PROMPT_MAX_LENGTH}
                aria-describedby="task-prompt-composer-help"
                value={promptDraft}
                onChange={(event) => updatePromptDraft(event.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary mt-6 w-full sm:w-auto" disabled={!promptDraft.trim()}>
              {t('tasks.continueToDetails')}
            </button>
          </form>
        </div>
      </section>

      {showSuggestions ? (
        <section
          className="mb-5 rounded-box border border-base-300 bg-base-100 shadow-sm"
          aria-labelledby="task-suggestions-title"
        >
          <div className="flex items-start justify-between gap-3 px-5 pt-4">
            <h2 id="task-suggestions-title" className="text-base font-semibold">
              {t('tasks.suggestionsTitle')}
            </h2>
            <button
              type="button"
              className="btn btn-ghost btn-xs shrink-0"
              aria-expanded={suggestionsOpen}
              aria-controls="task-suggestions-content"
              onClick={() => setSuggestionsOpen((open) => !open)}
            >
              {suggestionsOpen ? t('tasks.suggestionsHide') : t('tasks.suggestionsShow')}
            </button>
          </div>
          {suggestionsOpen ? (
            <div id="task-suggestions-content" className="px-5 pb-5">
              <p className="mt-1 text-sm opacity-70">{t('tasks.suggestionsHelp')}</p>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {TASK_SUGGESTION_IDS.map((id) => {
                  const title = t(`tasks.suggestions.${id}.title`);
                  const suggestionPrompt = t(`tasks.suggestions.${id}.prompt`);
                  return (
                    <li
                      key={id}
                      className="flex flex-col gap-2 rounded-box border border-base-200 p-3 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold">{title}</h3>
                        <p className="mt-1 text-xs opacity-70">{suggestionPrompt}</p>
                      </div>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm shrink-0 self-start"
                        aria-label={t('tasks.suggestionsUseLabel', { title })}
                        onClick={() => applySuggestion(suggestionPrompt)}
                      >
                        + {t('tasks.suggestionsUse')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {actionError ? (
        <div className="mb-4">
          <ErrorAlert message={actionError} />
        </div>
      ) : null}

      <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
        <div className="col-span-2 w-full max-w-xs sm:col-span-1">
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
        <label className="sr-only" htmlFor="task-status-filter">
          {t('tasks.filterStatus')}
        </label>
        <select
          id="task-status-filter"
          className="select select-sm w-full max-w-48"
          value={taskStatus}
          onChange={(event) => setTaskStatus(event.target.value as TaskStatus)}
        >
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`tasks.status.${status}`)}
            </option>
          ))}
        </select>
        <p className="text-xs opacity-60" aria-live="polite">
          {t('tasks.count', { count: visible.length })}
        </p>
      </div>

      {visible.length === 0 && tasks.data.pages.every((page) => page.items.length === 0) ? (
        <EmptyState
          title={t('tasks.noTasksForStatus')}
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
                    <span className={`badge badge-sm ${taskStatusClass[task.status ?? (task.completedAt ? 'completed' : task.enabled ? 'active' : 'paused')]}`}>
                      {t(`tasks.status.${task.status ?? (task.completedAt ? 'completed' : task.enabled ? 'active' : 'paused')}`)}
                    </span>
                  </div>
                  <p className="text-xs opacity-70">{describeSchedule(task.schedule, t)}</p>
                  <p className="text-xs opacity-60">
                    {t('tasks.nextRun')}: {task.status === 'active' || (!task.status && task.enabled && !task.completedAt)
                      ? formatRelative(task.nextRunAt, i18n.language)
                      : t('common.never')}
                  </p>
                  {(task.unreadCount ?? 0) > 0 ? (
                    <p className="text-xs font-medium text-primary" aria-label={t('tasks.unreadRuns', { count: task.unreadCount ?? 0 })}>
                      {t('tasks.unreadRuns', { count: task.unreadCount ?? 0 })}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-1 border-t border-base-200 pt-2">
                    {!task.completedAt ? (
                      <button
                        type="button"
                        className="btn btn-xs btn-outline"
                        disabled={pendingId === task.id}
                        onClick={() => action.mutate({ id: task.id, name: task.enabled ? 'pause' : 'resume' })}
                      >
                        {task.enabled ? t('tasks.pause') : t('tasks.resume')}
                      </button>
                    ) : null}
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
                        {(task.unreadCount ?? 0) > 0 ? (
                          <p className="text-xs font-medium text-primary">{t('tasks.unreadRuns', { count: task.unreadCount ?? 0 })}</p>
                        ) : null}
                    </td>
                    <td className="hidden max-w-64 text-xs opacity-70 md:table-cell">
                      {describeSchedule(task.schedule, t)}
                    </td>
                    <td className="hidden whitespace-nowrap text-xs opacity-70 sm:table-cell">
                        {task.status === 'active' || (!task.status && task.enabled && !task.completedAt)
                          ? formatRelative(task.nextRunAt, i18n.language)
                          : t('common.never')}
                      </td>
                      <td>
                      <span className={`badge badge-sm ${taskStatusClass[task.status ?? (task.completedAt ? 'completed' : task.enabled ? 'active' : 'paused')]}`}>
                        {t(`tasks.status.${task.status ?? (task.completedAt ? 'completed' : task.enabled ? 'active' : 'paused')}`)}
                      </span>
                    </td>
                    <td>
                      <div className="flex flex-wrap justify-end gap-1">
                        {!task.completedAt ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            disabled={pendingId === task.id}
                            onClick={() => action.mutate({ id: task.id, name: task.enabled ? 'pause' : 'resume' })}
                          >
                            {task.enabled ? t('tasks.pause') : t('tasks.resume')}
                          </button>
                        ) : null}
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}

      {tasks.isFetchNextPageError ? (
        <div className="mt-4">
          <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void tasks.fetchNextPage()} />
        </div>
      ) : null}
      {tasks.hasNextPage ? (
        <div className="mt-4 flex justify-center" aria-live="polite">
          <button
            type="button"
            className="btn btn-outline"
            disabled={tasks.isFetchingNextPage}
            aria-busy={tasks.isFetchingNextPage}
            onClick={() => void tasks.fetchNextPage()}
          >
            {tasks.isFetchingNextPage ? t('tasks.loadingMoreTasks') : t('tasks.loadMoreTasks')}
          </button>
        </div>
      ) : null}

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
