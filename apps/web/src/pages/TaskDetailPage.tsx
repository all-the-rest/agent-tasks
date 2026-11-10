import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { MemoryManager } from '../components/MemoryManager';
import { MemoryCommandBar } from '../components/MemoryCommandBar';
import { ShareTaskDialog } from '../components/ShareTaskDialog';
import { useTablist } from '../lib/tablist';

type ActionName = 'pause' | 'resume' | 'run' | 'duplicate';
type Tab = 'overview' | 'memory' | 'recommendations';

const TASK_TABS = ['overview', 'memory', 'recommendations'] as const;

const notificationKeys = { always: 'tasks.notificationEmail', on_change: 'tasks.notificationEmailOnChange' } as const;

export function TaskDetailPage() {
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const task = useQuery({ queryKey: ['task', id], queryFn: () => api.tasks.get(id), enabled: Boolean(id) });
  const conversation = useQuery({
    queryKey: ['task-conversation', id],
    queryFn: () => api.tasks.conversation(id),
    enabled: Boolean(id) && task.data?.conversationMode === 'conversation',
    refetchInterval: (query) => query.state.data?.items.some((item) => item.status === 'queued' || item.status === 'running') ? 3_000 : false,
  });
  const executions = useInfiniteQuery({
    queryKey: ['task-executions', id],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.tasks.executionsPage(id, { cursor: pageParam ?? undefined }),
    getNextPageParam: (page) => page.nextCursor ?? null,
    enabled: Boolean(id),
  });
  const executionRows = executions.data?.pages.flatMap((page) => page.items) ?? [];
  const [tab, setTab] = useState<Tab>('overview');
  const { tabProps, panelProps } = useTablist<Tab>(TASK_TABS, tab, setTab, 'task-detail');
  const suggestions = useQuery({
    queryKey: ['task-suggestions', id],
    queryFn: () => api.tasks.memorySuggestions(id),
    enabled: Boolean(id),
  });
  const changes = useQuery({
    queryKey: ['task-changes', id],
    queryFn: () => api.tasks.memoryChanges(id),
    enabled: Boolean(id),
  });
  const recommendations = useQuery({
    queryKey: ['task-recommendations', id],
    queryFn: () => api.recommendations.list(id),
    enabled: Boolean(id) && tab === 'recommendations',
  });
  const recommendationEvents = useQuery({
    queryKey: ['task-recommendation-events', id],
    queryFn: () => api.recommendations.events(id),
    enabled: Boolean(id) && tab === 'recommendations',
  });

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [followUpMessage, setFollowUpMessage] = useState('');

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['task', id] }),
      queryClient.invalidateQueries({ queryKey: ['task-executions', id] }),
      queryClient.invalidateQueries({ queryKey: ['task-suggestions', id] }),
      queryClient.invalidateQueries({ queryKey: ['task-changes', id] }),
      queryClient.invalidateQueries({ queryKey: ['task-recommendations', id] }),
      queryClient.invalidateQueries({ queryKey: ['task-recommendation-events', id] }),
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

  const followUp = useMutation({
    mutationFn: (message: string) => api.tasks.followUp(id, message),
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      setFollowUpMessage('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['task-conversation', id] }),
        queryClient.invalidateQueries({ queryKey: ['task-executions', id] }),
      ]);
      showToast(t('tasks.followUpQueued'));
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

  const reviewSuggestion = useMutation({
    mutationFn: async ({ suggestionId, decision }: { suggestionId: string; decision: 'accept' | 'reject' }) => {
      if (decision === 'accept') return api.memory.acceptSuggestion(suggestionId);
      await api.memory.rejectSuggestion(suggestionId);
      return { memory: null };
    },
    onSuccess: async (_result, variables) => {
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: ['memories'] });
      showToast(t(variables.decision === 'accept' ? 'memory.suggestionAccepted' : 'memory.suggestionRejected'));
    },
    onError: (cause) => setActionError(errorMessage(cause)),
  });

  const setRecommendationStatus = useMutation({
    mutationFn: ({ recommendationId, status }: { recommendationId: string; status: string }) =>
      api.recommendations.update(recommendationId, status as import('../lib/types').Recommendation['status']),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['task-recommendations', id] }),
        queryClient.invalidateQueries({ queryKey: ['task-recommendation-events', id] }),
      ]);
      showToast(t('memory.recommendationUpdated'));
    },
    onError: (cause) => setActionError(errorMessage(cause)),
  });

  if (task.isLoading) return <Spinner label={t('common.loadingPage')} />;
  if (task.isError || !task.data) {
    return <ErrorAlert message={t('errors.notFound')} onRetry={() => void task.refetch()} />;
  }

  const data = task.data;
  const conversationItems = [...(conversation.data?.items ?? [])].reverse();
  const conversationActive = conversation.data?.items.some((item) => item.status === 'queued' || item.status === 'running') ?? false;
  const followUpUnavailable = !data.enabled || Boolean(data.completedAt) || conversationActive || followUp.isPending;

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
            {!data.completedAt ? (
              <button
                type="button"
                className="btn btn-sm btn-outline"
                onClick={() => action.mutate(data.enabled ? 'pause' : 'resume')}
                disabled={action.isPending}
              >
                {data.enabled ? t('tasks.pause') : t('tasks.resume')}
              </button>
            ) : null}
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

      <div role="tablist" aria-label={t('tasks.detailTitle')} className="tabs tabs-box mb-5 w-fit">
        {TASK_TABS.map((value) => (
          <button
            key={value}
            type="button"
            {...tabProps(value)}
            className={`tab ${tab === value ? 'tab-active' : ''}`}
          >
            {t(`memory.tab.${value}`)}
            {value === 'memory' && (changes.data?.length ?? 0) > 0 ? (
              <span className="badge badge-ghost badge-xs ml-1">{changes.data?.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div {...panelProps('overview')}>
      {tab === 'overview' ? (
      <>
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="flex flex-col gap-5 xl:col-span-2">
          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-3 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${data.enabled ? 'badge-success' : data.completedAt ? 'badge-info' : 'badge-ghost'}`}>
                  {data.completedAt ? t('tasks.completed') : data.enabled ? t('common.enabled') : t('common.disabled')}
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

          {data.conversationMode === 'conversation' ? (
            <section className="card border border-base-300 bg-base-100 shadow-sm">
              <div className="card-body gap-4 p-5">
                <div>
                  <h2 className="card-title text-base">{t('tasks.conversationTitle')}</h2>
                  <p className="mt-1 text-sm opacity-70">{t('tasks.conversationHelp')}</p>
                </div>
                {conversation.isPending ? (
                  <Spinner />
                ) : conversation.isError ? (
                  <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void conversation.refetch()} />
                ) : conversationItems.length === 0 ? (
                  <p className="text-sm opacity-60">{t('tasks.conversationEmpty')}</p>
                ) : (
                  <ol className="flex flex-col gap-4">
                    {conversationItems.map((turn) => (
                      <li key={turn.id} className="rounded-box border border-base-300 p-4">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs opacity-60">{formatDate(turn.createdAt, i18n.language)}</span>
                          <StatusBadge status={turn.status} />
                        </div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide opacity-70">{t('tasks.conversationYou')}</h3>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{turn.input}</p>
                        {turn.assistantOutput ? (
                          <>
                            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide opacity-70">{t('tasks.conversationAssistant')}</h3>
                            <p className="mt-1 whitespace-pre-wrap text-sm">{turn.assistantOutput}</p>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
                <form
                  className="flex flex-col gap-3 border-t border-base-300 pt-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const message = followUpMessage.trim();
                    if (message && !followUpUnavailable) followUp.mutate(message);
                  }}
                >
                  <label className="text-sm font-medium" htmlFor="task-follow-up">{t('tasks.followUpLabel')}</label>
                  <textarea
                    id="task-follow-up"
                    className="textarea w-full"
                    rows={3}
                    maxLength={20_000}
                    value={followUpMessage}
                    onChange={(event) => setFollowUpMessage(event.target.value)}
                    disabled={followUpUnavailable}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs opacity-60">
                      {conversationActive ? t('tasks.followUpActive') : !data.enabled || data.completedAt ? t('tasks.followUpUnavailable') : t('tasks.followUpScheduleNote')}
                    </p>
                    <button
                      type="submit"
                      className="btn btn-sm btn-primary"
                      disabled={followUpUnavailable || !followUpMessage.trim()}
                    >
                      {followUp.isPending ? t('tasks.followUpSending') : t('tasks.followUpSend')}
                    </button>
                  </div>
                </form>
              </div>
            </section>
          ) : null}

          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body p-5">
              <h2 className="card-title text-base">{t('tasks.executionsTitle')}</h2>
              {executions.isPending ? (
                <Spinner />
              ) : executions.isError && !executions.data ? (
                <ErrorAlert
                  message={t('errors.loadFailed')}
                  onRetry={() => {
                    void executions.refetch();
                  }}
                />
              ) : executionRows.length === 0 ? (
                <p className="py-4 text-sm opacity-60">{t('tasks.noExecutions')}</p>
              ) : (
                <>
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
                        {executionRows.map((execution) => (
                          <tr key={execution.id}>
                            <td>
                              <Link to={`/executions/${execution.id}`} className="link-hover font-mono text-xs">
                                {execution.id.slice(0, 8)}
                              </Link>
                              <span className="ml-2 text-xs opacity-60">{t(`trigger.${execution.trigger}`)}</span>
                              {execution.status === 'completed' && !execution.readAt ? (
                                <span className="badge badge-warning badge-xs ml-2">{t('tasks.unread')}</span>
                              ) : null}
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
                  {executions.isError && executions.data ? (
                    <div className="mt-3">
                      <ErrorAlert
                        message={t('errors.loadFailed')}
                        onRetry={() => void (executions.isFetchNextPageError ? executions.fetchNextPage() : executions.refetch())}
                      />
                    </div>
                  ) : null}
                  {executions.hasNextPage ? (
                    <div className="mt-3 flex justify-center" aria-live="polite">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline"
                        disabled={executions.isFetchingNextPage}
                        aria-busy={executions.isFetchingNextPage}
                        onClick={() => void executions.fetchNextPage()}
                      >
                        {executions.isFetchingNextPage ? t('tasks.loadingMoreRuns') : t('tasks.loadMoreRuns')}
                      </button>
                    </div>
                  ) : null}
                </>
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
                <dd className="text-right">{data.enabled && !data.completedAt ? formatDate(data.nextRunAt, i18n.language) : t('common.never')}</dd>
                <dt className="opacity-60">{t('tasks.timezone')}</dt>
                <dd className="text-right">{data.timezone}</dd>
                <dt className="opacity-60">{t('tasks.endCondition')}</dt>
                <dd className="text-right">
                  {data.endCondition.type === 'never'
                    ? t('tasks.endNever')
                    : data.endCondition.type === 'on_date'
                      ? data.endCondition.date
                      : t('tasks.endAfterRunsSummary', { count: data.endCondition.runs })}
                </dd>
              </dl>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className={`badge badge-sm ${data.allowWebResearch ? 'badge-info' : 'badge-ghost'}`}>
                  {t('tasks.allowWebResearch')}
                </span>
                <span className="badge badge-ghost badge-sm">{data.notification.email.enabled ? t(notificationKeys[data.notification.email.when]) : t('tasks.notificationNone')}</span>
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
              <button type="button" className="btn btn-sm justify-start" onClick={() => setShareOpen(true)}>
                {t('tasks.share.open')}
              </button>
              <button type="button" className="btn btn-sm btn-error btn-outline justify-start" onClick={() => setDeleteOpen(true)}>
                {t('common.delete')}
              </button>
            </div>
          </section>
        </div>
      </div>

      {executions.data && executionRows.length === 0 ? (
        <div className="mt-5">
          <EmptyState title={t('tasks.noExecutions')} description={t('executions.emptyHint')} />
        </div>
      ) : null}
      </>
      ) : null}
      </div>

      <div {...panelProps('memory')}>
      {tab === 'memory' ? (
        <div className="flex flex-col gap-5">
          <MemoryCommandBar />
          <MemoryManager scope="task" taskId={data.id} compact />

          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="card-title text-base">{t('memory.suggestionsTitle')}</h2>
                <Link className="btn btn-ghost btn-xs" to={`/tasks/${data.id}/edit`}>
                  {t('memory.learningMode')}: {t(`memory.mode.${data.memorySettings?.mode ?? 'auto'}`)}
                </Link>
              </div>
              <p className="text-xs opacity-60">{t('memory.suggestionsHelp')}</p>
              {suggestions.isLoading ? (
                <Spinner />
              ) : suggestions.isError ? (
                <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void suggestions.refetch()} />
              ) : (suggestions.data ?? []).filter((item) => item.status === 'pending').length === 0 ? (
                <p className="text-sm opacity-60">{t('memory.noPendingSuggestions')}</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {(suggestions.data ?? [])
                    .filter((item) => item.status === 'pending')
                    .map((suggestion) => (
                      <li key={suggestion.id} className="rounded-box border border-warning/40 bg-warning/10 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="badge badge-warning badge-sm">{t('memory.pending')}</span>
                          <span className="badge badge-ghost badge-sm">{t(`memory.category.${suggestion.category}`)}</span>
                          {suggestion.semanticKey ? <span className="font-mono opacity-60">{suggestion.semanticKey}</span> : null}
                        </div>
                        <p className="mt-2 whitespace-pre-wrap text-sm">{suggestion.content}</p>
                        {suggestion.reason ? <p className="mt-1 text-xs opacity-60">{suggestion.reason}</p> : null}
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            className="btn btn-xs btn-primary"
                            disabled={reviewSuggestion.isPending}
                            onClick={() => reviewSuggestion.mutate({ suggestionId: suggestion.id, decision: 'accept' })}
                          >
                            {t('memory.acceptSuggestion')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-xs btn-ghost"
                            disabled={reviewSuggestion.isPending}
                            onClick={() => reviewSuggestion.mutate({ suggestionId: suggestion.id, decision: 'reject' })}
                          >
                            {t('memory.rejectSuggestion')}
                          </button>
                        </div>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </section>

          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-3 p-5">
              <h2 className="card-title text-base">{t('memory.changesTitle')}</h2>
              <p className="text-xs opacity-60">{t('memory.changesHelp')}</p>
              {changes.isLoading ? (
                <Spinner />
              ) : changes.isError ? (
                <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void changes.refetch()} />
              ) : (changes.data ?? []).length === 0 ? (
                <p className="text-sm opacity-60">{t('memory.noChanges')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {(changes.data ?? []).slice(0, 30).map((change) => (
                    <li key={change.id} className="rounded-box border border-base-300 p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="badge badge-ghost badge-sm">{t(`memory.action.${change.action}`)}</span>
                        <span className="opacity-60">{formatDate(change.createdAt, i18n.language)}</span>
                        {change.executionId ? (
                          <Link className="link-hover font-mono opacity-60" to={`/executions/${change.executionId}`}>
                            {change.executionId.slice(0, 8)}
                          </Link>
                        ) : null}
                      </div>
                      {change.summary ? <p className="mt-1 text-xs opacity-70">{change.summary}</p> : null}
                      {change.afterContent ? <p className="mt-1 whitespace-pre-wrap">{change.afterContent}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      ) : null}
      </div>

      <div {...panelProps('recommendations')}>
      {tab === 'recommendations' ? (
        <section className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-4 p-5">
            <div>
              <h2 className="card-title text-base">{t('memory.recommendationsTitle')}</h2>
              <p className="mt-1 text-xs opacity-60">{t('memory.recommendationsHelp')}</p>
            </div>
            {recommendations.isLoading ? (
              <Spinner />
            ) : recommendations.isError ? (
              <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void recommendations.refetch()} />
            ) : (recommendations.data ?? []).length === 0 ? (
              <EmptyState title={t('memory.noRecommendations')} description={t('memory.noRecommendationsHint')} />
            ) : (
              <ul className="flex flex-col gap-3">
                {(recommendations.data ?? []).map((recommendation) => (
                  <li key={recommendation.id} className="rounded-box border border-base-300 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-semibold">{recommendation.title}</h3>
                        <p className="mt-1 text-sm opacity-80">{recommendation.description}</p>
                        {recommendation.sourceUrl ? (
                          <a className="link mt-1 block truncate text-xs" href={recommendation.sourceUrl} target="_blank" rel="noreferrer noopener">
                            {recommendation.sourceUrl}
                          </a>
                        ) : null}
                        <p className="mt-1 font-mono text-[11px] opacity-50">{recommendation.semanticKey}</p>
                      </div>
                      <select
                        className="select select-sm w-40"
                        value={recommendation.status}
                        aria-label={t('memory.statusLabel')}
                        onChange={(event) =>
                          setRecommendationStatus.mutate({ recommendationId: recommendation.id, status: event.target.value })
                        }
                      >
                        {(['discovered', 'recommended', 'accepted', 'rejected', 'completed', 'unavailable'] as const).map((status) => (
                          <option key={status} value={status}>
                            {t(`memory.status.${status}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] opacity-60 sm:grid-cols-4">
                      <div>
                        <dt>{t('memory.firstObserved')}</dt>
                        <dd>{formatDate(recommendation.firstObservedAt, i18n.language)}</dd>
                      </div>
                      <div>
                        <dt>{t('memory.lastObserved')}</dt>
                        <dd>{formatDate(recommendation.lastObservedAt, i18n.language)}</dd>
                      </div>
                      <div>
                        <dt>{t('memory.lastChanged')}</dt>
                        <dd>{formatDate(recommendation.lastChangedAt, i18n.language)}</dd>
                      </div>
                      <div>
                        <dt>{t('memory.statusChanged')}</dt>
                        <dd>{formatDate(recommendation.statusChangedAt, i18n.language)}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}

            <div>
              <h3 className="text-sm font-semibold">{t('memory.recommendationHistory')}</h3>
              {recommendationEvents.isLoading ? (
                <Spinner />
              ) : recommendationEvents.isError ? (
                <ErrorAlert
                  message={t('errors.loadFailed')}
                  onRetry={() => void recommendationEvents.refetch()}
                />
              ) : (recommendationEvents.data ?? []).length === 0 ? (
                <p className="mt-2 text-xs opacity-60">{t('memory.noHistory')}</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1 text-xs">
                  {(recommendationEvents.data ?? []).slice(0, 40).map((event) => (
                    <li key={event.id} className="flex flex-wrap items-center gap-2 border-b border-base-200 py-1">
                      <span className="badge badge-ghost badge-xs">{event.action}</span>
                      <span className="truncate">{event.title}</span>
                      {event.fromStatus || event.toStatus ? (
                        <span className="opacity-60">
                          {event.fromStatus ?? '—'} → {event.toStatus ?? '—'}
                        </span>
                      ) : null}
                      <span className="ml-auto opacity-50">{formatDate(event.createdAt, i18n.language)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      ) : null}
      </div>

      <ShareTaskDialog
        open={shareOpen}
        taskId={data.id}
        title={data.title}
        prompt={data.prompt}
        onClose={() => setShareOpen(false)}
      />

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
