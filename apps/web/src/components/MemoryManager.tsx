import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GLOBAL_MEMORY_CATEGORIES, TASK_MEMORY_CATEGORIES } from '@agent-tasks/shared/memory';
import type { MemoryCategory, MemoryScope } from '@agent-tasks/shared/memory';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import type { Memory } from '../lib/types';
import { formatDate } from '../lib/format';
import {
  ConfirmDialog,
  EmptyState,
  ErrorAlert,
  Field,
  Modal,
  Spinner,
  useToast,
} from './ui';

interface MemoryManagerProps {
  scope: MemoryScope;
  taskId?: string;
  compact?: boolean;
}

interface EditorState {
  open: boolean;
  memory: Memory | null;
  category: MemoryCategory;
  content: string;
  semanticKey: string;
}

const emptyEditor = (scope: MemoryScope): EditorState => ({
  open: false,
  memory: null,
  category: scope === 'global' ? 'instruction' : 'finding',
  content: '',
  semanticKey: '',
});

export function MemoryManager({ scope, taskId, compact = false }: MemoryManagerProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const categories = scope === 'global' ? GLOBAL_MEMORY_CATEGORIES : TASK_MEMORY_CATEGORIES;

  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'' | MemoryCategory>('');
  const [editor, setEditor] = useState<EditorState>(() => emptyEditor(scope));
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Memory | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const memories = useQuery({
    queryKey: ['memories', scope, taskId ?? '', query, category],
    queryFn: () =>
      api.memory.list({
        scope,
        ...(taskId ? { taskId } : {}),
        ...(query ? { q: query } : {}),
        ...(category ? { category } : {}),
        limit: 100,
      }),
    enabled: true,
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['memories'] }),
      queryClient.invalidateQueries({ queryKey: ['memory-stats'] }),
      queryClient.invalidateQueries({ queryKey: ['task-memories', taskId ?? ''] }),
      queryClient.invalidateQueries({ queryKey: ['task-changes', taskId ?? ''] }),
      queryClient.invalidateQueries({ queryKey: ['task', taskId ?? ''] }),
    ]);
  };

  const save = useMutation({
    mutationFn: async (editing: boolean) => {
      const semanticKey = editor.semanticKey.trim();
      const payload = { category: editor.category, content: editor.content.trim() };
      if (editing && editor.memory) {
        return api.memory.update(editor.memory.id, { ...payload, semanticKey: semanticKey || null });
      }
      return api.memory.create({
        scope,
        ...(taskId ? { taskId } : {}),
        ...payload,
        ...(semanticKey ? { semanticKey } : {}),
      });
    },
    onMutate: () => setFormError(null),
    onSuccess: async (_saved, editing) => {
      setEditor(emptyEditor(scope));
      await invalidate();
      showToast(t(editing ? 'memory.updatedMsg' : 'memory.createdMsg'));
    },
    onError: (cause) => setFormError(errorMessage(cause)),
  });

  const remove = useMutation({
    mutationFn: (memory: Memory) => api.memory.remove(memory.id),
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      setToDelete(null);
      await invalidate();
      showToast(t('memory.deletedMsg'));
    },
    onError: (cause) => {
      setToDelete(null);
      setActionError(errorMessage(cause));
    },
  });

  const items = memories.data?.items ?? [];
  const total = memories.data?.total ?? 0;
  const editorCategories = useMemo(() => categories, [categories]);

  const canCreate = scope === 'global' || Boolean(taskId);
  const openCreate = () => {
    if (!canCreate) return;
    setFormError(null);
    setEditor({ ...emptyEditor(scope), open: true });
  };

  const openEdit = (memory: Memory) => {
    setFormError(null);
    setEditor({
      open: true,
      memory,
      category: memory.category,
      content: memory.content,
      semanticKey: memory.semanticKey ?? '',
    });
  };

  return (
    <section className={compact ? '' : 'card border border-base-300 bg-base-100 shadow-sm'}>
      <div className={compact ? 'flex flex-col gap-3' : 'card-body gap-4 p-5'}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className={compact ? 'text-base font-semibold' : 'card-title text-base'}>
              {scope === 'global' ? t('memory.globalTitle') : taskId ? t('memory.taskTitle') : t('memory.allTaskTitle')}
            </h2>
            <p className="text-xs opacity-60">
              {t(scope === 'global' ? 'memory.globalHelp' : taskId ? 'memory.taskHelp' : 'memory.allTaskHelp')}
            </p>
          </div>
          {canCreate ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={openCreate}>
              {t('memory.add')}
            </button>
          ) : null}
        </div>

        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(search.trim());
          }}
        >
          <input
            className="input input-sm w-full"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('memory.searchPlaceholder')}
            aria-label={t('memory.search')}
          />
          <select
            className="select select-sm w-full sm:w-48"
            value={category}
            onChange={(event) => setCategory(event.target.value as '' | MemoryCategory)}
            aria-label={t('memory.categoryLabel')}
          >
            <option value="">{t('memory.allCategories')}</option>
            {editorCategories.map((value) => (
              <option key={value} value={value}>
                {t(`memory.category.${value}`)}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-sm btn-outline">
            {t('memory.search')}
          </button>
        </form>

        {actionError ? <ErrorAlert message={actionError} /> : null}

        {memories.isLoading ? (
          <Spinner />
        ) : memories.isError ? (
          <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void memories.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title={query || category ? t('memory.noMatches') : t('memory.emptyTitle')}
            description={query || category ? t('memory.noMatchesHint') : t('memory.emptyHint')}
          />
        ) : (
          <>
            <p className="text-xs opacity-60">{t('memory.showing', { count: items.length, total })}</p>
            <ul className="flex flex-col gap-3">
              {items.map((memory) => (
                <li key={memory.id} className="rounded-box border border-base-300 bg-base-200/40 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="badge badge-sm badge-outline">{t(`memory.category.${memory.category}`)}</span>
                    {memory.semanticKey ? <span className="badge badge-ghost badge-sm font-mono">{memory.semanticKey}</span> : null}
                    <span className="badge badge-ghost badge-sm">{t(`memory.origin.${memory.origin}`)}</span>
                    {memory.userEdited ? <span className="badge badge-info badge-sm">{t('memory.userProtected')}</span> : null}
                    <span className="opacity-60">v{memory.revision}</span>
                    <span className="ml-auto break-all font-mono text-[11px] opacity-60" title={memory.id}>
                      {memory.id}
                    </span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{memory.content}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] opacity-60">
                    <span>
                      {t('memory.createdAt')}: {formatDate(memory.createdAt, i18n.language)}
                    </span>
                    <span>
                      {t('memory.updatedAt')}: {formatDate(memory.updatedAt, i18n.language)}
                    </span>
                    {memory.taskId ? <span className="font-mono">{t('memory.task')}: {memory.taskId.slice(0, 8)}</span> : null}
                    {memory.originRef ? (
                      <span className="min-w-0 truncate" title={memory.originRef}>
                        {t('memory.originRef')}:{' '}
                        {/^[0-9a-f-]{36}$/i.test(memory.originRef) ? (
                          <Link className="link-hover font-mono" to={`/executions/${memory.originRef}`}>
                            {memory.originRef.slice(0, 8)}
                          </Link>
                        ) : (
                          memory.originRef.slice(0, 80)
                        )}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => openEdit(memory)}>
                      {t('common.edit')}
                    </button>
                    <button type="button" className="btn btn-ghost btn-xs text-error" onClick={() => setToDelete(memory)}>
                      {t('common.delete')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <Modal
        open={editor.open}
        onClose={() => setEditor(emptyEditor(scope))}
        title={editor.memory ? t('memory.editTitle') : t('memory.createTitle')}
        wide
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditor(emptyEditor(scope))}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => save.mutate(Boolean(editor.memory))}
              disabled={save.isPending || editor.content.trim().length === 0}
            >
              {save.isPending ? t('common.saving') : t('common.save')}
            </button>
          </>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(Boolean(editor.memory));
          }}
        >
          {formError ? <ErrorAlert message={formError} /> : null}
          <Field label={t('memory.categoryLabel')} htmlFor="memory-category">
            <select
              id="memory-category"
              className="select w-full"
              value={editor.category}
              onChange={(event) => setEditor({ ...editor, category: event.target.value as MemoryCategory })}
            >
              {editorCategories.map((value) => (
                <option key={value} value={value}>
                  {t(`memory.category.${value}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('memory.content')} htmlFor="memory-content" hint={t('memory.contentHelp')} required>
            <textarea
              id="memory-content"
              className="textarea w-full"
              rows={6}
              value={editor.content}
              onChange={(event) => setEditor({ ...editor, content: event.target.value })}
            />
          </Field>
          <Field label={t('memory.semanticKey')} htmlFor="memory-key" hint={t('memory.semanticKeyHelp')}>
            <input
              id="memory-key"
              className="input w-full font-mono"
              value={editor.semanticKey}
              onChange={(event) => setEditor({ ...editor, semanticKey: event.target.value })}
            />
          </Field>
          <p className="text-xs opacity-60">{t(scope === 'global' ? 'memory.globalScopeNote' : 'memory.taskScopeNote')}</p>
        </form>
      </Modal>

      <ConfirmDialog
        open={toDelete !== null}
        title={t('memory.deleteTitle')}
        body={t('memory.deleteBody', { id: toDelete?.id.slice(0, 8) ?? '' })}
        confirmLabel={t('memory.deleteConfirm')}
        onConfirm={() => {
          if (toDelete) remove.mutate(toDelete);
        }}
        onClose={() => setToDelete(null)}
        loading={remove.isPending}
      />
    </section>
  );
}
