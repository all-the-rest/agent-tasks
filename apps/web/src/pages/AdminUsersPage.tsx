import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate } from '../lib/format';
import { AdminTabs } from '../components/AdminTabs';
import {
  ErrorAlert,
  Field,
  PageHeader,
  Spinner,
  SuccessAlert,
  useToast,
} from '../components/ui';
import type { AdminUser, Invitation } from '../lib/types';

export function AdminUsersPage() {
  const { t, i18n } = useTranslation();
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: api.admin.users });
  const invitations = useQuery({ queryKey: ['admin', 'invitations'], queryFn: api.admin.invitations });

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'USER' | 'ADMIN'>('USER');
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateUser = useMutation({
    mutationFn: (input: { id: string; changes: { role?: string; banned?: boolean; name?: string } }) =>
      api.admin.updateUser(input.id, input.changes),
    onSuccess: async () => {
      setError(null);
      showToast(t('admin.userUpdated'));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'metrics'] }),
      ]);
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const invite = useMutation({
    mutationFn: () => api.admin.invite({ email: inviteEmail.trim(), role: inviteRole }),
    onSuccess: async (result) => {
      setInviteEmail('');
      setCreatedLink(result.link);
      setError(null);
      showToast(t('admin.inviteCreated'));
      await queryClient.invalidateQueries({ queryKey: ['admin', 'invitations'] });
    },
    onError: (cause) => setError(errorMessage(cause) || t('admin.inviteFailed')),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.admin.revokeInvitation(id),
    onSuccess: async () => {
      showToast(t('admin.revoked'));
      await queryClient.invalidateQueries({ queryKey: ['admin', 'invitations'] });
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const copyLink = async () => {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink);
      showToast(t('common.copied'));
    } catch {
      setError(t('errors.generic'));
    }
  };

  const activeInvitations = (invitations.data ?? []).filter(
    (entry: Invitation) => !entry.acceptedAt && !entry.revokedAt,
  );

  return (
    <>
      <PageHeader title={t('admin.users')} subtitle={t('admin.subtitle')} />
      <AdminTabs />

      {error ? (
        <div className="mb-4">
          <ErrorAlert message={error} />
        </div>
      ) : null}
      {createdLink ? (
        <div className="mb-4">
          <SuccessAlert message={t('admin.inviteCreated')} />
          <div className="mt-2 rounded-box border border-success/30 bg-base-100 p-3">
            <p className="text-xs font-semibold">{t('admin.inviteLink')}</p>
            <p className="mt-1 break-all font-mono text-xs">{createdLink}</p>
            <p className="mt-1 text-xs opacity-60">{t('admin.inviteLinkHint')}</p>
            <button type="button" className="btn btn-xs btn-outline mt-2" onClick={() => void copyLink()}>
              {t('admin.copyLink')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-3">
        <section className="card min-w-0 border border-base-300 bg-base-100 shadow-sm xl:col-span-2">
          <div className="card-body p-5">
            <h2 className="card-title text-base">{t('admin.users')}</h2>
            {users.isLoading ? (
              <Spinner />
            ) : users.isError ? (
              <ErrorAlert message={t('errors.loadFailed')} />
            ) : !users.data || users.data.length === 0 ? (
              <p className="py-4 text-sm opacity-60">{t('admin.noUsers')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th scope="col">{t('common.name')}</th>
                      <th scope="col">{t('common.role')}</th>
                      <th scope="col">{t('common.status')}</th>
                      <th scope="col" className="hidden sm:table-cell">{t('admin.created')}</th>
                      <th scope="col" className="text-right">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(users.data ?? []).map((entry: AdminUser) => {
                      const self = entry.id === currentUser?.id;
                      return (
                        <tr key={entry.id}>
                          <td className="max-w-32 sm:max-w-56">
                            <p className="truncate font-medium">{entry.name}</p>
                            <p className="truncate text-xs opacity-60">{entry.email}</p>
                          </td>
                          <td>
                            <label className="sr-only" htmlFor={`role-${entry.id}`}>
                              {t('common.role')}
                            </label>
                            <select
                              id={`role-${entry.id}`}
                              className="select select-xs"
                              value={entry.role}
                              disabled={self || updateUser.isPending}
                              onChange={(event) =>
                                updateUser.mutate({ id: entry.id, changes: { role: event.target.value } })
                              }
                            >
                              <option value="ADMIN">{t('roles.ADMIN')}</option>
                              <option value="USER">{t('roles.USER')}</option>
                            </select>
                          </td>
                          <td>
                            <span className={`badge badge-sm ${entry.banned ? 'badge-error' : 'badge-success'}`}>
                              {entry.banned ? t('admin.banned') : t('admin.active')}
                            </span>
                          </td>
                          <td className="hidden whitespace-nowrap text-xs opacity-60 sm:table-cell">
                            {formatDate(entry.createdAt, i18n.language)}
                          </td>
                          <td className="text-right">
                            <button
                              type="button"
                              className={`btn btn-xs ${entry.banned ? 'btn-outline' : 'btn-ghost text-error'}`}
                              disabled={self || updateUser.isPending}
                              onClick={() =>
                                updateUser.mutate({ id: entry.id, changes: { banned: !entry.banned } })
                              }
                            >
                              {entry.banned ? t('admin.enable') : t('admin.disable')}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <div className="flex min-w-0 flex-col gap-5">
          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <form
              className="card-body gap-3 p-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!inviteEmail.trim()) {
                  setError(t('validation.required'));
                  return;
                }
                invite.mutate();
              }}
            >
              <h2 className="card-title text-base">{t('admin.invitations')}</h2>
              <Field label={t('admin.inviteEmail')} htmlFor="invite-email" required>
                <input
                  id="invite-email"
                  type="email"
                  className="input w-full"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  required
                />
              </Field>
              <Field label={t('admin.inviteRole')} htmlFor="invite-role">
                <select
                  id="invite-role"
                  className="select w-full"
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.target.value as 'USER' | 'ADMIN')}
                >
                  <option value="USER">{t('roles.USER')}</option>
                  <option value="ADMIN">{t('roles.ADMIN')}</option>
                </select>
              </Field>
              <button type="submit" className="btn btn-primary btn-sm" disabled={invite.isPending}>
                {invite.isPending ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
                {invite.isPending ? t('admin.inviting') : t('admin.invite')}
              </button>
            </form>
          </section>

          <section className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body p-5">
              <h2 className="card-title text-base">{t('admin.invitations')}</h2>
              {invitations.isLoading ? (
                <Spinner />
              ) : activeInvitations.length === 0 ? (
                <p className="text-sm opacity-60">{t('admin.noInvitations')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {activeInvitations.map((invitation) => (
                    <li key={invitation.id} className="rounded-lg bg-base-200 p-3 text-sm">
                      <p className="truncate font-medium">{invitation.email}</p>
                      <p className="text-xs opacity-60">
                        {t(`roles.${invitation.role}`)} · {formatDate(invitation.expiresAt, i18n.language)}
                      </p>
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost mt-1 text-error"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(invitation.id)}
                      >
                        {t('admin.revoke')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
