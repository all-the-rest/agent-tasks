import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import { ConfirmDialog, ErrorAlert, Modal, Spinner, useToast } from './ui';

/**
 * Sharing distributes a frozen definition, not access to the task. The dialog
 * says so before a link is created, and it never shows a stored token: the
 * plaintext link exists only in the response that created it.
 */
export function ShareTaskDialog({
  open,
  taskId,
  title,
  prompt,
  onClose,
}: {
  open: boolean;
  taskId: string;
  title: string;
  prompt: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const shares = useQuery({
    queryKey: ['task-shares', taskId],
    queryFn: () => api.tasks.shares(taskId),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () => api.tasks.createShare(taskId),
    onMutate: () => setError(null),
    onSuccess: async (created) => {
      setLink(created.url);
      await queryClient.invalidateQueries({ queryKey: ['task-shares', taskId] });
      showToast(t('tasks.share.createdMsg'));
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const revoke = useMutation({
    mutationFn: (shareId: string) => api.tasks.revokeShare(taskId, shareId),
    onMutate: () => setError(null),
    onSuccess: async () => {
      setRevokeId(null);
      await queryClient.invalidateQueries({ queryKey: ['task-shares', taskId] });
      showToast(t('tasks.share.revokedMsg'));
    },
    onError: (cause) => {
      setRevokeId(null);
      setError(errorMessage(cause));
    },
  });

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      showToast(t('tasks.share.copied'));
    } catch {
      setError(t('errors.loadFailed'));
    }
  };

  const activeShares = (shares.data ?? []).filter((share) => share.revokedAt === null);
  const revokedShares = (shares.data ?? []).filter((share) => share.revokedAt !== null);

  return (
    <>
      <Modal
        open={open}
        title={t('tasks.share.title')}
        onClose={onClose}
        footer={
          <button
            type="button"
            className="btn btn-primary w-full"
            onClick={() => void create.mutate()}
            disabled={create.isPending}
            aria-busy={create.isPending}
          >
            {create.isPending ? t('tasks.share.creating') : t('tasks.share.create')}
          </button>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm opacity-80">{t('tasks.share.warning')}</p>

          <div className="rounded-box border border-base-300 bg-base-200/40 p-4">
            <span className="badge badge-ghost badge-sm">{t('tasks.share.typeLabel')}</span>
            <h3 className="mt-2 font-semibold">{title}</h3>
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm opacity-70">{prompt}</p>
          </div>

          {error ? <ErrorAlert message={error} /> : null}

          {link ? (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium" htmlFor="task-share-link">
                {t('tasks.share.copy')}
              </label>
              <div className="join w-full">
                <input
                  id="task-share-link"
                  className="input input-sm join-item w-full font-mono text-xs"
                  value={link}
                  readOnly
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button type="button" className="btn btn-sm btn-outline join-item" onClick={() => void copy()}>
                  {t('common.copy')}
                </button>
              </div>
            </div>
          ) : null}

          <section>
            <h3 className="mb-2 text-sm font-semibold">{t('tasks.share.links')}</h3>
            {shares.isPending ? (
              <Spinner />
            ) : shares.isError ? (
              <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void shares.refetch()} />
            ) : activeShares.length === 0 ? (
              <p className="text-sm opacity-60">{t('tasks.share.noLinks')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {activeShares.map((share) => (
                  <li key={share.id} className="flex flex-wrap items-center justify-between gap-2 rounded-box border border-base-300 px-3 py-2 text-xs">
                    <span>
                      <span className="badge badge-success badge-xs mr-2">{t('tasks.share.active')}</span>
                      {formatDate(share.createdAt, i18n.language)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs text-error"
                      onClick={() => setRevokeId(share.id)}
                      disabled={revoke.isPending}
                    >
                      {t('tasks.share.revoke')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {revokedShares.length > 0 ? (
              <p className="mt-2 text-xs opacity-50">
                {revokedShares.length} × {t('tasks.share.revoked')}
              </p>
            ) : null}
          </section>
        </div>
      </Modal>

      <ConfirmDialog
        open={revokeId !== null}
        title={t('tasks.share.revokeTitle')}
        body={t('tasks.share.revokeBody')}
        confirmLabel={t('tasks.share.revokeConfirm')}
        loading={revoke.isPending}
        onConfirm={() => {
          if (revokeId) revoke.mutate(revokeId);
        }}
        onClose={() => setRevokeId(null)}
      />
    </>
  );
}
