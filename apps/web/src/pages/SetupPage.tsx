import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AuthShell } from '../components/AuthShell';
import { ErrorAlert, Field, Spinner, SuccessAlert } from '../components/ui';

export function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { refresh } = useAuth();
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus });

  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (setup.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-200">
        <Spinner label={t('common.loadingPage')} />
      </div>
    );
  }

  if (setup.data?.configured) {
    return (
      <AuthShell
        title={t('auth.alreadyConfigured')}
        subtitle={t('auth.setupSubtitle')}
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

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!token.trim() || !name.trim() || !email.trim()) {
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
      await api.setup({ token: token.trim(), email: email.trim(), password, name: name.trim() });
      queryClient.setQueryData(['setup-status'], { configured: true });
      setNotice(t('auth.setupDone'));
      try {
        await api.auth.signIn(email.trim(), password);
        await refresh();
        navigate('/', { replace: true });
      } catch {
        navigate('/login', { replace: true });
      }
    } catch (cause) {
      setError(errorMessage(cause) || t('auth.setupFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.setupTitle')}
      subtitle={t('auth.setupSubtitle')}
      footer={
        <Link className="link link-primary" to="/login">
          {t('auth.backToLogin')}
        </Link>
      }
    >
      <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
        {error ? <ErrorAlert message={error} /> : null}
        {notice ? <SuccessAlert message={notice} /> : null}
        <Field label={t('auth.setupToken')} htmlFor="setup-token" hint={t('auth.setupTokenHint')} required>
          <input
            id="setup-token"
            name="token"
            type="password"
            autoComplete="off"
            className="input w-full font-mono"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
          />
        </Field>
        <Field label={t('common.name')} htmlFor="setup-name" required>
          <input
            id="setup-name"
            name="name"
            autoComplete="name"
            className="input w-full"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label={t('common.email')} htmlFor="setup-email" required>
          <input
            id="setup-email"
            name="email"
            type="email"
            autoComplete="username"
            className="input w-full"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        <Field label={t('common.password')} htmlFor="setup-password" hint={t('auth.passwordHint')} required>
          <input
            id="setup-password"
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
        <Field label={t('auth.confirmPassword')} htmlFor="setup-confirm" required>
          <input
            id="setup-confirm"
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
          {submitting ? t('auth.creating') : t('auth.createAdmin')}
        </button>
      </form>
    </AuthShell>
  );
}
