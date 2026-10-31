import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
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
import type { ExecutionSource, ExecutionStep } from '../lib/types';

type Tab = 'report' | 'timeline' | 'sources';

interface VisitedSite {
  url: string;
  title?: string;
  tool: string;
  visitedAt: string;
}

function collectVisited(steps: ExecutionStep[], sources: ExecutionSource[]): VisitedSite[] {
  const seen = new Map<string, VisitedSite>();
  for (const step of steps) {
    const raw = step.args?.url;
    if (typeof raw !== 'string' || !raw) continue;
    const known = sources.find((source) => source.url === raw);
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

  const data = execution.data;
  const visited = useMemo(
    () => collectVisited(data?.steps ?? [], data?.report?.sources ?? []),
    [data?.steps, data?.report?.sources],
  );

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
        {(['report', 'timeline', 'sources'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            className={`tab ${tab === value ? 'tab-active' : ''}`}
            onClick={() => setTab(value)}
          >
            {value === 'report'
              ? t('executions.report')
              : value === 'timeline'
                ? t('executions.timeline')
                : t('executions.sources')}
            {value === 'timeline' ? <span className="badge badge-xs ml-1">{steps.length}</span> : null}
            {value === 'sources' ? <span className="badge badge-xs ml-1">{sources.length}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'report' ? (
        <section
          role="tabpanel"
          id="panel-report"
          aria-labelledby="tab-report"
          className="card border border-base-300 bg-base-100 shadow-sm"
        >
          <div className="card-body p-5 sm:p-7">
            {data.report ? (
              <>
                <p className="mb-3 rounded-lg bg-base-200 p-3 text-sm font-medium">{data.report.summary}</p>
                <div className="report-prose text-sm leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                    {data.report.markdown}
                  </ReactMarkdown>
                </div>
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
              </>
            ) : (
              <p className="py-10 text-center text-sm opacity-60">
                {canCancel ? t('executions.waiting') : t('executions.noReport')}
              </p>
            )}
          </div>
        </section>
      ) : null}

      {tab === 'timeline' ? (
        <section role="tabpanel" id="panel-timeline" aria-labelledby="tab-timeline" className="flex flex-col gap-5">
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
      ) : null}

      {tab === 'sources' ? (
        <section role="tabpanel" id="panel-sources" aria-labelledby="tab-sources" className="flex flex-col gap-5">
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
      ) : null}

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
