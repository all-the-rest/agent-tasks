import { useId, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import type { MemoryCommandResult, MemoryScope } from '../lib/types';
import { ConfirmDialog, Modal, useToast } from './ui';

type Candidate = NonNullable<MemoryCommandResult['candidates']>[number];
type ForgetTarget = { id: string; scope: MemoryScope; content: string; category: string };

interface PendingDuplicate {
  scope: MemoryScope;
  text: string;
  candidates: Candidate[];
}

interface PendingAmbiguous {
  action: 'update' | 'forget';
  text?: string;
  candidates: Candidate[];
}

/** Task id from the route, so /learn task and /memory task work on a task page. */
export function taskIdFromPath(pathname: string): string | undefined {
  return /\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i.exec(pathname)?.[1];
}

export function MemoryCommandBar({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const taskId = taskIdFromPath(location.pathname);
  const commandInputId = useId();

  const [input, setInput] = useState('');
  const [duplicate, setDuplicate] = useState<PendingDuplicate | null>(null);
  const [ambiguous, setAmbiguous] = useState<PendingAmbiguous | null>(null);
  const [forgetCandidates, setForgetCandidates] = useState<Candidate[] | null>(null);
  const [forgetTarget, setForgetTarget] = useState<ForgetTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['memories'] }),
      queryClient.invalidateQueries({ queryKey: ['memory-stats'] }),
      queryClient.invalidateQueries({ queryKey: ['task-changes'] }),
      queryClient.invalidateQueries({ queryKey: ['task-memories'] }),
      queryClient.invalidateQueries({ queryKey: ['task', taskId ?? ''] }),
    ]);
  };

  const openMemoryView = (result: MemoryCommandResult) => {
    if (result.scope === 'task' && taskId) navigate(`/memory?scope=task&taskId=${taskId}`);
    else if (result.scope === 'all' && taskId) navigate(`/memory?taskId=${taskId}`);
    else navigate('/memory');
  };

  const command = useMutation({
    mutationFn: (variables: { input: string; confirm?: boolean }) =>
      api.memory.command(variables.input, { ...(taskId ? { taskId } : {}), ...(variables.confirm ? { confirm: true } : {}) }),
    onMutate: () => setError(null),
    onSuccess: async (result, variables) => {
      switch (result.kind) {
        case 'learned':
          setInput('');
          await invalidate();
          showToast(t('memory.saved'));
          return;
        case 'memory_list':
          openMemoryView(result);
          showToast(
            result.scope === 'all'
              ? t('memory.listedBoth', { global: result.globalTotal ?? 0, task: result.taskTotal ?? 0 })
              : t('memory.listed', { count: result.total ?? result.memories?.length ?? 0 }),
          );
          return;
        case 'duplicate': {
          const learnedText = /^\/learn\s+(?:global\s+|task\s+)?([\s\S]+)$/i.exec(variables.input.trim())?.[1]?.trim() ?? '';
          setDuplicate({ scope: result.scope as MemoryScope, text: learnedText, candidates: result.candidates ?? [] });
          return;
        }
        case 'ambiguous': {
          const isUpdate = /^\/update\b/i.test(variables.input.trim());
          const updateText = isUpdate
            ? variables.input.trim().replace(/^\/update\s+\S+\s+/i, '').trim()
            : undefined;
          setAmbiguous({ action: isUpdate ? 'update' : 'forget', text: updateText, candidates: result.candidates ?? [] });
          return;
        }
        case 'forget_candidates':
          setForgetCandidates(result.candidates ?? []);
          return;
        case 'confirm_forget':
          if (result.memory) {
            setForgetTarget({
              id: result.memory.id,
              scope: result.memory.scope,
              content: result.memory.content,
              category: result.memory.category,
            });
          }
          return;
        case 'forgotten':
          setInput('');
          await invalidate();
          showToast(t('memory.forgottenMsg'));
          return;
        case 'updated':
          setInput('');
          await invalidate();
          showToast(t('memory.updatedMsg'));
          return;
        default:
          await invalidate();
          showToast(result.message ?? t('memory.commandDone'));
      }
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const applyDuplicate = useMutation({
    mutationFn: (candidate: Candidate) => api.memory.update(candidate.id, { content: duplicate?.text ?? '' }),
    onSuccess: async () => {
      setDuplicate(null);
      setInput('');
      await invalidate();
      showToast(t('memory.updatedMsg'));
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const applyAmbiguousUpdate = useMutation({
    mutationFn: (candidate: Candidate) => api.memory.update(candidate.id, { content: ambiguous?.text ?? '' }),
    onSuccess: async () => {
      setAmbiguous(null);
      setInput('');
      await invalidate();
      showToast(t('memory.updatedMsg'));
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const forget = useMutation({
    mutationFn: (target: ForgetTarget) => api.memory.remove(target.id),
    onSuccess: async () => {
      setForgetTarget(null);
      setForgetCandidates(null);
      setInput('');
      await invalidate();
      showToast(t('memory.forgottenMsg'));
    },
    onError: (cause) => {
      setForgetTarget(null);
      setError(errorMessage(cause));
    },
  });

  const submit = () => {
    const value = input.trim();
    if (!value) return;
    command.mutate({ input: value });
  };

  return (
    <div className={`rounded-box border border-base-300 bg-base-100 p-3 shadow-sm ${className}`}>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="label py-0 text-xs font-semibold whitespace-nowrap" htmlFor={commandInputId}>
          {t('memory.commandLabel')}
        </label>
        <input
          id={commandInputId}
          className="input input-sm w-full font-mono"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={t('memory.commandPlaceholder')}
          autoComplete="off"
          aria-describedby={`${commandInputId}-hint`}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={command.isPending || !input.trim()}>
          {command.isPending ? t('common.loading') : t('memory.runCommand')}
        </button>
      </form>
      <p id={`${commandInputId}-hint`} className="mt-1 text-[11px] opacity-60">
        {t('memory.commandHint')}
      </p>
      {error ? (
        <p className="mt-2 text-xs font-medium text-error" role="alert">
          {error}
        </p>
      ) : null}

      <Modal
        open={duplicate !== null}
        title={t('memory.duplicateTitle')}
        onClose={() => setDuplicate(null)}
        wide
      >
        <p className="mb-3 text-sm opacity-80">{t('memory.duplicateBody')}</p>
        <ul className="flex flex-col gap-2">
          {(duplicate?.candidates ?? []).map((candidate) => (
            <li key={candidate.id} className="rounded-box border border-base-300 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="badge badge-sm">{t(`memory.category.${candidate.category}`)}</span>
                <span className="badge badge-ghost badge-sm">{candidate.scope}</span>
                <span className="font-mono opacity-60">{candidate.id.slice(0, 8)}</span>
                {candidate.score !== undefined ? (
                  <span className="opacity-60">{Math.round(candidate.score * 100)}%</span>
                ) : null}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm">{candidate.content}</p>
              <button
                type="button"
                className="btn btn-sm btn-primary mt-2"
                disabled={applyDuplicate.isPending}
                onClick={() => applyDuplicate.mutate(candidate)}
              >
                {t('memory.replaceExisting')}
              </button>
            </li>
          ))}
        </ul>
      </Modal>

      <Modal open={ambiguous !== null} title={t('memory.ambiguousTitle')} onClose={() => setAmbiguous(null)} wide>
        <p className="mb-3 text-sm opacity-80">{t('memory.ambiguousBody')}</p>
        <ul className="flex flex-col gap-2">
          {(ambiguous?.candidates ?? []).map((candidate) => (
            <li key={candidate.id} className="rounded-box border border-base-300 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="badge badge-sm">{candidate.scope}</span>
                <span className="font-mono opacity-60">{candidate.id}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm">{candidate.content}</p>
              <button
                type="button"
                className="btn btn-sm btn-outline mt-2"
                disabled={applyAmbiguousUpdate.isPending}
                onClick={() => {
                  if (ambiguous?.action === 'update') {
                    applyAmbiguousUpdate.mutate(candidate);
                    return;
                  }
                  setForgetTarget({ id: candidate.id, scope: candidate.scope, content: candidate.content, category: candidate.category });
                  setAmbiguous(null);
                }}
              >
                {ambiguous?.action === 'update' ? t('memory.selectUpdate') : t('memory.selectForget')}
              </button>
            </li>
          ))}
        </ul>
      </Modal>

      <Modal open={forgetCandidates !== null} title={t('memory.forgetCandidatesTitle')} onClose={() => setForgetCandidates(null)} wide>
        <p className="mb-3 text-sm opacity-80">{t('memory.forgetCandidatesBody')}</p>
        <ul className="flex flex-col gap-2">
          {(forgetCandidates ?? []).map((candidate) => (
            <li key={candidate.id} className="rounded-box border border-base-300 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="badge badge-sm">{candidate.scope}</span>
                <span className="badge badge-ghost badge-sm">{t(`memory.category.${candidate.category}`)}</span>
                <span className="font-mono opacity-60">{candidate.id.slice(0, 8)}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm">{candidate.content}</p>
              <button
                type="button"
                className="btn btn-sm btn-error btn-outline mt-2"
                onClick={() => {
                  setForgetTarget({ id: candidate.id, scope: candidate.scope, content: candidate.content, category: candidate.category });
                  setForgetCandidates(null);
                }}
              >
                {t('memory.selectForget')}
              </button>
            </li>
          ))}
        </ul>
      </Modal>

      <ConfirmDialog
        open={forgetTarget !== null}
        title={t('memory.forgetTitle')}
        body={t('memory.forgetBody', { content: forgetTarget?.content.slice(0, 200) ?? '' })}
        confirmLabel={t('memory.forgetConfirm')}
        onConfirm={() => {
          if (forgetTarget) forget.mutate(forgetTarget);
        }}
        onClose={() => setForgetTarget(null)}
        loading={forget.isPending}
      />
    </div>
  );
}
