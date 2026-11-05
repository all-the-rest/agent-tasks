import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { MemoryManager } from '../components/MemoryManager';
import { MemoryCommandBar } from '../components/MemoryCommandBar';
import { ConfirmDialog, ErrorAlert, PageHeader, useToast } from '../components/ui';
import type { MemoryScope } from '../lib/types';
import { useTablist } from '../lib/tablist';

const MEMORY_TABS = ['global', 'task'] as const;

export function MemoryPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [params, setParams] = useSearchParams();
  const taskId = params.get('taskId') ?? undefined;
  const scope: MemoryScope = params.get('scope') === 'task' ? 'task' : 'global';
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { tabProps, panelProps } = useTablist<MemoryScope>(
    MEMORY_TABS,
    scope,
    (nextScope) => {
      const next = new URLSearchParams(params);
      if (nextScope === 'task') next.set('scope', 'task');
      else next.delete('scope');
      setParams(next, { replace: true });
    },
    'memory-scope',
  );

  const stats = useQuery({ queryKey: ['memory-stats'], queryFn: api.memory.stats });

  const deleteAll = useMutation({
    mutationFn: () =>
      api.memory.deleteAll({
        scope: scope === 'task' ? 'task' : 'global',
        ...(taskId ? { taskId } : {}),
        confirm: true,
      }),
    onMutate: () => setError(null),
    onSuccess: async (result) => {
      setDeleteAllOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['memories'] }),
        queryClient.invalidateQueries({ queryKey: ['memory-stats'] }),
        queryClient.invalidateQueries({ queryKey: ['task-changes'] }),
      ]);
      showToast(t('memory.deletedCount', { count: result.deleted }));
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  return (
    <>
      <PageHeader
        title={t('memory.title')}
        subtitle={t('memory.subtitle')}
        actions={
          <>
            <a className="btn btn-sm btn-outline" href={api.memory.exportUrl} download>
              {t('memory.export')}
            </a>
            <Link className="btn btn-sm btn-ghost" to="/settings">
              {t('nav.settings')}
            </Link>
          </>
        }
      />

      <MemoryCommandBar className="mb-5 md:hidden" />

      {stats.isError ? (
        <div className="mb-4">
          <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void stats.refetch()} />
        </div>
      ) : null}

      {error ? (
        <div className="mb-4">
          <ErrorAlert message={error} />
        </div>
      ) : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <div className="stats border border-base-300 bg-base-100 shadow-sm">
          <div className="stat py-3">
            <div className="stat-title text-xs">{t('memory.globalCount')}</div>
            <div className="stat-value text-2xl">{stats.data?.global ?? '—'}</div>
          </div>
        </div>
        <div className="stats border border-base-300 bg-base-100 shadow-sm">
          <div className="stat py-3">
            <div className="stat-title text-xs">{t('memory.taskCount')}</div>
            <div className="stat-value text-2xl">{stats.data?.task ?? '—'}</div>
          </div>
        </div>
        <div className="stats border border-base-300 bg-base-100 shadow-sm">
          <div className="stat py-3">
            <div className="stat-title text-xs">{t('memory.totalCount')}</div>
            <div className="stat-value text-2xl">{stats.data?.total ?? '—'}</div>
          </div>
        </div>
      </div>

      <div role="tablist" aria-label={t('memory.title')} className="tabs tabs-box mb-5 w-fit">
        <button
          type="button"
          {...tabProps('global')}
          className={`tab ${scope === 'global' ? 'tab-active' : ''}`}
        >
          {t('memory.globalTitle')}
        </button>
        <button
          type="button"
          {...tabProps('task')}
          className={`tab ${scope === 'task' ? 'tab-active' : ''}`}
          title={!taskId ? t('memory.allTaskHint') : undefined}
        >
          {t('memory.taskTitle')}
        </button>
      </div>

      <div {...panelProps('global')}>
        {scope === 'global' ? <MemoryManager scope="global" /> : null}
      </div>

      <div {...panelProps('task')}>
        {scope === 'task' ? (
          taskId ? (
            <MemoryManager scope="task" taskId={taskId} />
          ) : (
            <MemoryManager scope="task" />
          )
        ) : null}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-box border border-base-300 bg-base-100 p-4">
        <div className="text-xs opacity-70">
          <p>{t('memory.retentionNote')}</p>
          <p className="mt-1">{t('memory.historyNote')}</p>
        </div>
        {scope === 'global' || taskId ? (
          <button type="button" className="btn btn-sm btn-error btn-outline" onClick={() => setDeleteAllOpen(true)}>
            {scope === 'task' ? t('memory.deleteAllTask') : t('memory.deleteAllGlobal')}
          </button>
        ) : null}
      </div>

      <ConfirmDialog
        open={deleteAllOpen}
        title={scope === 'task' ? t('memory.deleteAllTaskTitle') : t('memory.deleteAllGlobalTitle')}
        body={scope === 'task' ? t('memory.deleteAllTaskBody') : t('memory.deleteAllGlobalBody')}
        confirmLabel={t('memory.deleteConfirm')}
        onConfirm={() => deleteAll.mutate()}
        onClose={() => setDeleteAllOpen(false)}
        loading={deleteAll.isPending}
      />
    </>
  );
}
