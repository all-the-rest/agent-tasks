import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { checkReportLinks } from '@agent-tasks/shared/report';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { api, errorMessage } from '../lib/api';
import { formatDate, formatDuration, formatNumber } from '../lib/format';
import {
  ConfirmDialog,
  ErrorAlert,
  PageHeader,
  Spinner,
  StatusBadge,
  useToast,
} from '../components/ui';
import type { Execution, ExecutionSource, ExecutionStep } from '../lib/types';
import { EmailBlocksPreview } from '../components/EmailBlocksPreview';
import { useTablist } from '../lib/tablist';

type Tab = 'report' | 'timeline' | 'sources' | 'memory';
const EXECUTION_TABS = ['report', 'timeline', 'sources', 'memory'] as const;

interface VisitedSite {
  url: string;
  title?: string;
  tool: string;
  visitedAt: string;
}

function collectVisited(steps: ExecutionStep[], sources: ExecutionSource[]): VisitedSite[] {
  const seen = new Map<string, VisitedSite>();
  for (const step of steps) {
    if (!step.ok || !['open_url', 'click_element', 'navigate_back'].includes(step.tool)) continue;
    const raw = step.args?.url;
    if (typeof raw !== 'string' || !raw) continue;
    const known = sources.find((source) => source.url === raw);
    if (!known) continue;
    seen.set(raw, {
      url: raw,
      title: known?.title,
      tool: step.tool,
      visitedAt: step.startedAt,
    });
  }
  return [...seen.values()];
}

function StepCard({ step }: { step: ExecutionStep }) {
  const { t, i18n } = useTranslation();
  const args = Object.keys(step.args ?? {}).length > 0 ? JSON.stringify(step.args, null, 2) : '—';
  return (
    <li className="relative pl-8">
      <span
        className={`absolute left-0 top-1 grid size-5 place-items-center rounded-full text-[10px] font-bold ${
          step.ok ? 'bg-success/20 text-success' : 'bg-error/20 text-error'
        }`}
        aria-hidden="true"
      >
        {step.step}
      </span>
      <div className="rounded-lg border border-base-300 bg-base-100 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold">{step.tool}</span>
            <span className={`badge badge-xs ${step.ok ? 'badge-success' : 'badge-error'}`}>
              {step.ok ? t('common.success') : t('common.error')}
            </span>
          </div>
          <span className="text-xs opacity-60">
            {formatDate(step.startedAt, i18n.language)} · {formatDuration(step.durationMs)}
          </span>
        </div>
        {step.error ? <p className="mt-2 text-sm text-error">{step.error}</p> : null}
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer select-none opacity-70">{t('executions.arguments')}</summary>
          <pre className="mt-2 max-h-52 overflow-auto rounded bg-base-200 p-2 font-mono text-[11px]">{args}</pre>
        </details>
        {step.resultPreview ? (
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer select-none opacity-70">{t('executions.resultPreview')}</summary>
            <p className="mt-2 whitespace-pre-wrap rounded bg-base-200 p-2">{step.resultPreview}</p>
          </details>
        ) : null}
      </div>
    </li>
  );
}

export function ExecutionDetailPage() {
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('report');
  const { tabProps, panelProps } = useTablist<Tab>(EXECUTION_TABS, tab, setTab, 'execution');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const execution = useQuery({
    queryKey: ['execution', id],
    queryFn: () => api.executions.get(id),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 5_000 : false;
    },
  });
  const previousExecutionId = execution.data?.report?.change?.previousExecutionId;
  const previousExecution = useQuery({
    queryKey: ['execution', previousExecutionId],
    queryFn: () => api.executions.get(previousExecutionId ?? ''),
    enabled: Boolean(previousExecutionId),
  });
  const memoryReview = useQuery({
    queryKey: ['execution-memory', id],
    queryFn: () => api.executions.memory(id),
    enabled: Boolean(id),
  });

  const cancel = useMutation({
    mutationFn: () => api.executions.cancel(id),
    onSuccess: async () => {
      setCancelOpen(false);
      showToast(t('executions.cancelledMsg'));
      await queryClient.invalidateQueries({ queryKey: ['execution', id] });
      await queryClient.invalidateQueries({ queryKey: ['executions'] });
    },
    onError: (cause) => setActionError(errorMessage(cause)),
  });

  const retry = useMutation({
    mutationFn: () => api.executions.retry(id),
    onSuccess: async (result) => {
      setRetryOpen(false);
      showToast(t('executions.retriedMsg'));
      await queryClient.invalidateQueries({ queryKey: ['executions'] });
      navigate(`/executions/${result.executionId}`);
    },
    onError: (cause) => setActionError(errorMessage(cause)),
  });

  const markRead = useMutation({
    mutationFn: () => api.executions.markRead(id),
    onSuccess: async ({ readAt }) => {
      queryClient.setQueryData<Execution>(['execution', id], (current) =>
        current ? { ...current, readAt } : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['task-executions'] }),
        queryClient.invalidateQueries({ queryKey: ['executions'] }),
      ]);
      showToast(t('executions.markedReadMsg'));
    },
    onError: (cause) => setActionError(errorMessage(cause)),
  });

  const data = execution.data;
  const visited = useMemo(
    () => collectVisited(data?.steps ?? [], data?.report?.sources ?? []),
    [data?.steps, data?.report?.sources],
  );
  const currentReportMarkdown = useMemo(
    () => data?.report ? checkReportLinks(data.report.markdown, data.report.sources).markdown : '',
    [data?.report?.markdown, data?.report?.sources],
  );
  const currentReportSummary = useMemo(
    () => data?.report ? checkReportLinks(data.report.summary, data.report.sources).markdown : '',
    [data?.report?.summary, data?.report?.sources],
  );
  const previousReportMarkdown = useMemo(() => {
    const report = previousExecution.data?.report;
    return report ? checkReportLinks(report.markdown, report.sources).markdown : '';
  }, [previousExecution.data?.report?.markdown, previousExecution.data?.report?.sources]);

  if (execution.isLoading) return <Spinner label={t('common.loadingPage')} />;
  if (execution.isError || !data) return <ErrorAlert message={t('errors.notFound')} />;

  const canCancel = data.status === 'queued' || data.status === 'running';
  const canRetry = data.status === 'failed' || data.status === 'timed_out' || data.status === 'cancelled';
  const steps = [...(data.steps ?? [])].sort((a, b) => a.step - b.step);
  const sources = data.report?.sources ?? [];

  return (
    <>
      <PageHeader
        title={data.taskTitle}
        subtitle={`${t('executions.detailTitle')} · ${data.id.slice(0, 8)}${
          data.attempt && data.attempt > 1 ? ` · ${t('executions.attempt', { attempt: data.attempt })}` : ''
        }`}
        actions={
          <>
            <Link className="btn btn-ghost btn-sm" to="/executions">
              ← {t('executions.back')}
            </Link>
            <a
              className="btn btn-sm btn-outline"
              href={`/api/executions/${data.id}/export?format=md`}
              download
            >
              {t('executions.exportMarkdown')}
            </a>
            <a
              className="btn btn-sm btn-outline"
              href={`/api/executions/${data.id}/export?format=json`}
              download
            >
              {t('executions.exportJson')}
            </a>
            {data.status === 'completed' && !data.readAt ? (
              <button
                type="button"
                className="btn btn-sm btn-outline"
                disabled={markRead.isPending}
                onClick={() => markRead.mutate()}
              >
                {markRead.isPending ? t('common.saving') : t('executions.markRead')}
              </button>
            ) : null}
            {canCancel ? (
              <button type="button" className="btn btn-sm btn-error" onClick={() => setCancelOpen(true)}>
                {t('executions.cancel')}
              </button>
            ) : null}
            {canRetry ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setRetryOpen(true)}>
                {t('executions.retry')}
              </button>
            ) : null}
          </>
        }
      />

      {actionError ? (
        <div className="mb-4">
          <ErrorAlert message={actionError} />
        </div>
      ) : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-1 p-4">
            <p className="text-xs uppercase tracking-wide opacity-60">{t('common.status')}</p>
            <div><StatusBadge status={data.status} /></div>
            <p className="text-xs opacity-60">{t(`trigger.${data.trigger}`)}</p>
          </div>
        </div>
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-1 p-4 text-sm">
            <p className="text-xs uppercase tracking-wide opacity-60">{t('executions.startedAt')}</p>
            <p>{formatDate(data.startedAt, i18n.language)}</p>
            <p className="text-xs opacity-60">{formatDate(data.finishedAt, i18n.language)}</p>
          </div>
        </div>
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-1 p-4 text-sm">
            <p className="text-xs uppercase tracking-wide opacity-60">{t('executions.duration')}</p>
            <p>{formatDuration(data.durationMs)}</p>
            <p className="text-xs opacity-60">{data.model ?? t('common.unknown')}</p>
          </div>
        </div>
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-1 p-4 text-sm">
            <p className="text-xs uppercase tracking-wide opacity-60">{t('executions.usage')}</p>
            <p>
              {data.usage?.totalTokens
                ? t('executions.tokens', { total: formatNumber(data.usage.totalTokens, i18n.language) })
                : t('common.notAvailable')}
            </p>
            {data.usage?.allowanceUsd !== undefined ? (
              <p className="text-xs opacity-60">${data.usage.allowanceUsd.toFixed(4)}</p>
            ) : null}
          </div>
        </div>
      </div>

      {data.error ? (
        <div className="mb-5">
          <ErrorAlert message={data.error} />
        </div>
      ) : null}

      <div className="tabs tabs-box mb-4 w-full flex-wrap sm:w-auto" role="tablist" aria-label={t('executions.detailTitle')}>
        {EXECUTION_TABS.map((value) => (
          <button
            key={value}
            type="button"
            {...tabProps(value)}
            className={`tab ${tab === value ? 'tab-active' : ''}`}
          >
            {value === 'report'
              ? t('executions.report')
              : value === 'timeline'
                ? t('executions.timeline')
                : value === 'sources'
                  ? t('executions.sources')
                  : t('memory.tab.memory')}
            {value === 'timeline' ? <span className="badge badge-xs ml-1">{steps.length}</span> : null}
            {value === 'sources' ? <span className="badge badge-xs ml-1">{sources.length}</span> : null}
          </button>
        ))}
      </div>

      <section
        {...panelProps('report')}
        className="card border border-base-300 bg-base-100 shadow-sm"
      >
          <div className="card-body p-5 sm:p-7">
            {data.report ? (
              <>
                <div className="mb-3 rounded-lg bg-base-200 p-3">
                  <div className="report-prose text-sm font-medium leading-relaxed">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                      {currentReportSummary}
                    </ReactMarkdown>
                  </div>
                </div>
                {previousExecutionId ? (
                  <section
                    aria-labelledby="report-comparison-title"
                    className="mb-5 rounded-lg border border-base-300 p-4"
                  >
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 id="report-comparison-title" className="text-base font-semibold">
                          {t('executions.comparison')}
                        </h2>
                        {data.report.change ? (
                          <p className="mt-1 text-xs opacity-70">
                            {t('executions.comparisonStatus')}:{' '}
                            {t(`executions.changeStatuses.${data.report.change.status}`)}
                          </p>
                        ) : null}
                      </div>
                      <Link className="link link-primary text-sm" to={`/executions/${previousExecutionId}`}>
                        {t('executions.openPreviousExecution', { id: previousExecutionId.slice(0, 8) })}
                      </Link>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <article className="min-w-0 rounded-lg bg-base-200/50 p-3">
                        <h3 className="mb-2 text-sm font-semibold">{t('executions.previousReport')}</h3>
                        {previousExecution.isLoading ? (
                          <Spinner label={t('executions.comparisonLoading')} />
                        ) : previousExecution.isError ? (
                          <ErrorAlert
                            message={t('executions.comparisonFailed')}
                            onRetry={() => void previousExecution.refetch()}
                          />
                        ) : previousExecution.data?.report ? (
                          <div className="report-prose text-sm leading-relaxed">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                              {previousReportMarkdown}
                            </ReactMarkdown>
                          </div>
                        ) : (
                          <p className="text-sm opacity-60">{t('executions.comparisonEmpty')}</p>
                        )}
                      </article>
                      <article className="min-w-0 rounded-lg bg-base-200/50 p-3">
                        <h3 className="mb-2 text-sm font-semibold">{t('executions.currentReport')}</h3>
                        <div className="report-prose text-sm leading-relaxed">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                            {currentReportMarkdown}
                          </ReactMarkdown>
                        </div>
                      </article>
                    </div>
                  </section>
                ) : (
                  <div className="report-prose text-sm leading-relaxed">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                      {currentReportMarkdown}
                    </ReactMarkdown>
                  </div>
                )}
                {data.report.uncertainty.length > 0 ? (
                  <div className="mt-5 rounded-lg border border-warning/40 bg-warning/10 p-3">
                    <h3 className="text-sm font-semibold">{t('executions.uncertainty')}</h3>
                    <ul className="mt-1 list-disc pl-5 text-sm opacity-80">
                      {data.report.uncertainty.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {data.report.email?.blocks.length ? (
                  <div className="mt-5 rounded-lg border border-base-300 bg-base-200/40 p-4">
                    <h3 className="text-sm font-semibold">{t('executions.emailPreview')}</h3>
                    <p className="mb-3 text-xs opacity-60">{t('executions.emailPreviewHint')}</p>
                    <EmailBlocksPreview blocks={data.report.email.blocks} />
                  </div>
                ) : null}
              </>
            ) : (
              <p className="py-10 text-center text-sm opacity-60">
                {canCancel ? t('executions.waiting') : t('executions.noReport')}
              </p>
            )}
          </div>
        </section>

      <section {...panelProps('timeline')} className="flex flex-col gap-5">
          {steps.length === 0 ? (
            <p className="rounded-box border border-dashed border-base-300 bg-base-100 p-8 text-center text-sm opacity-60">
              {canCancel ? t('executions.waiting') : t('executions.noSteps')}
            </p>
          ) : (
            <ol className="relative ml-2 flex flex-col gap-3 border-l border-base-300 pl-5">
              {steps.map((step) => (
                <StepCard key={step.id} step={step} />
              ))}
            </ol>
          )}

          <div className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body p-5">
              <h2 className="card-title text-base">{t('executions.visitedSites')}</h2>
              {visited.length === 0 ? (
                <p className="text-sm opacity-60">{t('executions.noVisitedSites')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {visited.map((site) => (
                    <li key={site.url} className="rounded-lg bg-base-200 p-3">
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="link link-primary break-all text-sm"
                      >
                        {site.title ?? site.url}
                      </a>
                      <p className="mt-1 break-all font-mono text-[11px] opacity-60">{site.url}</p>
                      <p className="text-[11px] opacity-50">
                        {site.tool} · {formatDate(site.visitedAt, i18n.language)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

      <section {...panelProps('sources')} className="flex flex-col gap-5">
          <div className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body p-5">
              <h2 className="card-title text-base">{t('executions.sources')}</h2>
              {sources.length === 0 ? (
                <p className="text-sm opacity-60">{t('executions.noSources')}</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {sources.map((source) => (
                    <li key={`${source.url}-${source.retrievedAt}`} className="rounded-lg border border-base-300 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="link link-primary break-all text-sm font-medium"
                        >
                          {source.title ?? source.url}
                        </a>
                        <span
                          className={`badge badge-sm ${
                            source.confidence === 'verified'
                              ? 'badge-success'
                              : source.confidence === 'secondary'
                                ? 'badge-info'
                                : 'badge-ghost'
                          }`}
                        >
                          {t(`confidence.${source.confidence}`)}
                        </span>
                      </div>
                      <p className="mt-1 break-all font-mono text-[11px] opacity-60">{source.url}</p>
                      <p className="text-[11px] opacity-50">
                        {t('executions.retrievedAt')}: {formatDate(source.retrievedAt, i18n.language)}
                      </p>
                      {source.excerpt ? <p className="mt-2 text-xs opacity-80">{source.excerpt}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

      <section {...panelProps('memory')} className="flex flex-col gap-5">
          <div className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-3 p-5">
              <h2 className="card-title text-base">{t('memory.executionChanges')}</h2>
              <p className="text-xs opacity-60">{t('memory.executionChangesHelp')}</p>
              {memoryReview.isLoading ? (
                <Spinner />
              ) : memoryReview.isError ? (
                <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void memoryReview.refetch()} />
              ) : (memoryReview.data?.changes.length ?? 0) === 0 ? (
                <p className="text-sm opacity-60">{t('memory.noExecutionChanges')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {memoryReview.data?.changes.map((change) => (
                    <li key={change.id} className="rounded-box border border-base-300 p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="badge badge-ghost badge-sm">{t(`memory.action.${change.action}`)}</span>
                        <span className="opacity-60">{formatDate(change.createdAt, i18n.language)}</span>
                      </div>
                      {change.summary ? <p className="mt-1 text-xs opacity-70">{change.summary}</p> : null}
                      {change.afterContent ? <p className="mt-1 whitespace-pre-wrap">{change.afterContent}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-3 p-5">
              <h2 className="card-title text-base">{t('memory.executionSuggestions')}</h2>
              {memoryReview.isLoading ? (
                <Spinner />
              ) : (memoryReview.data?.suggestions.length ?? 0) === 0 ? (
                <p className="text-sm opacity-60">{t('memory.noExecutionSuggestions')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {memoryReview.data?.suggestions.map((suggestion) => (
                    <li key={suggestion.id} className="rounded-box border border-warning/40 bg-warning/10 p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="badge badge-warning badge-sm">{t(`memory.suggestionStatus.${suggestion.status}`)}</span>
                        <span className="badge badge-ghost badge-sm">{t(`memory.category.${suggestion.category}`)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap">{suggestion.content}</p>
                      <Link className="link-hover mt-1 block text-xs" to={`/tasks/${data.taskId}`}>
                        {t('memory.reviewInTask')}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-3 p-5">
              <h2 className="card-title text-base">{t('memory.executionRecommendations')}</h2>
              {memoryReview.isLoading ? (
                <Spinner />
              ) : (memoryReview.data?.recommendationEvents.length ?? 0) === 0 ? (
                <p className="text-sm opacity-60">{t('memory.noExecutionRecommendations')}</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {memoryReview.data?.recommendationEvents.map((event) => (
                    <li key={event.id} className="flex flex-wrap items-center gap-2 border-b border-base-200 py-1 text-xs">
                      <span className="badge badge-ghost badge-xs">{event.action}</span>
                      <span>{event.title}</span>
                      {event.toStatus ? <span className="opacity-60">{event.toStatus}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

      <ConfirmDialog
        open={cancelOpen}
        title={t('executions.cancelTitle')}
        body={t('executions.cancelBody')}
        confirmLabel={t('executions.cancel')}
        onConfirm={() => cancel.mutate()}
        onClose={() => setCancelOpen(false)}
        loading={cancel.isPending}
      />
      <ConfirmDialog
        open={retryOpen}
        title={t('executions.retryTitle')}
        body={t('executions.retryBody', { title: data.taskTitle })}
        confirmLabel={t('executions.retry')}
        onConfirm={() => retry.mutate()}
        onClose={() => setRetryOpen(false)}
        loading={retry.isPending}
        danger={false}
      />
    </>
  );
}
