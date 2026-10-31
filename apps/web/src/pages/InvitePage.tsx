import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AuthShell } from '../components/AuthShell';
import { ErrorAlert, Field, Spinner, SuccessAlert } from '../components/ui';
import { formatDate } from '../lib/format';

export function InvitePage() {
  const { t, i18n } = useTranslation();
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.invitation(token),
    enabled: token.length > 0,
    retry: false,
  });

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (invitation.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-200">
        <Spinner label={t('common.loadingPage')} />
      </div>
    );
  }

  if (invitation.isError || !invitation.data) {
    return (
      <AuthShell
        title={t('auth.inviteInvalid')}
        subtitle={t('auth.inviteInvalidHint')}
        footer={
          <Link className="link link-primary" to="/login">
            {t('auth.backToLogin')}
          </Link>
        }
      >
        <Link className="btn btn-primary" to="/login">
          {t('auth.backToLogin')}
        </Link>
      </AuthShell>
    );
  }

  const data = invitation.data;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!name.trim()) {
      setError(t('validation.required'));
      return;
    }
    if (password.length < 12) {
      setError(t('validation.passwordLength'));
      return;
    }
    if (password !== confirm) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    setSubmitting(true);
    try {
      await api.acceptInvitation({ token, name: name.trim(), password });
      setNotice(t('auth.accountCreated'));
      try {
        await api.auth.signIn(data.email, password);
        await refresh();
        navigate('/', { replace: true });
      } catch {
        navigate('/login', { replace: true });
      }
    } catch (cause) {
      setError(errorMessage(cause) || t('auth.acceptFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.inviteTitle')}
      subtitle={t('auth.inviteSubtitle')}
      footer={
        <Link className="link link-primary" to="/login">
          {t('auth.hasAccount')} {t('auth.signIn')}
        </Link>
      }
    >
      <div className="rounded-lg bg-base-200 px-3 py-2 text-sm">
        <p className="font-medium">{t('auth.invitedAs', { email: data.email })}</p>
        <p className="text-xs opacity-70">
          {t('auth.inviteExpires', { date: formatDate(data.expiresAt, i18n.language) })}
        </p>
      </div>
      <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
        {error ? <ErrorAlert message={error} /> : null}
        {notice ? <SuccessAlert message={notice} /> : null}
        <Field label={t('common.name')} htmlFor="invite-name" required>
          <input
            id="invite-name"
            name="name"
            autoComplete="name"
            className="input w-full"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label={t('common.password')} htmlFor="invite-password" hint={t('auth.passwordHint')} required>
          <input
            id="invite-password"
            name="password"
            type="password"
            autoComplete="new-password"
            className="input w-full"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={12}
            required
          />
        </Field>
        <Field label={t('auth.confirmPassword')} htmlFor="invite-confirm" required>
          <input
            id="invite-confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            className="input w-full"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            minLength={12}
            required
          />
        </Field>
        <button type="submit" className="btn btn-primary mt-2" disabled={submitting}>
          {submitting ? <span className="loading loading-spinner loading-sm" aria-hidden="true" /> : null}
          {submitting ? t('auth.accepting') : t('auth.acceptInvite')}
        </button>
      </form>
    </AuthShell>
  );
}
