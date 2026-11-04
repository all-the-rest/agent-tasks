import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AuthShell } from '../components/AuthShell';
import { ErrorAlert, Field, Spinner, SuccessAlert } from '../components/ui';

/**
 * Open registration. Only reachable as a usable form when the instance setting
 * `allowRegistration` is on; the API enforces the same rule, so a direct POST
 * cannot bypass a disabled setting.
 */
export function RegisterPage() {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const config = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 60_000 });

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-200">
        <Spinner label={t('common.loadingPage')} />
      </div>
    );
  }
  if (user) return <Navigate to="/" replace />;

  if (config.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-200">
        <Spinner label={t('common.loadingPage')} />
      </div>
    );
  }

  if (config.data && !config.data.allowRegistration) {
    return (
      <AuthShell
        title={t('auth.registerDisabled')}
        subtitle={t('auth.registerDisabledHint')}
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
    if (!name.trim() || !email.trim() || !password) {
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
      const address = email.trim();
      await api.auth.signUp({ name: name.trim(), email: address, password });
      // Public sign-ups must prove the mailbox before a session is issued.
      setNotice(t('auth.verificationSent', { email: address }));
      setName('');
      setEmail('');
      setPassword('');
      setConfirm('');
    } catch (cause) {
      setError(errorMessage(cause) || t('auth.registerFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.registerTitle')}
      subtitle={t('auth.registerSubtitle')}
      footer={
        <Link className="link link-primary" to="/login">
          {t('auth.hasAccount')} {t('auth.signIn')}
        </Link>
      }
    >
      <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
        {error ? <ErrorAlert message={error} /> : null}
        {notice ? <SuccessAlert message={notice} /> : null}
        <Field label={t('common.name')} htmlFor="register-name" required>
          <input
            id="register-name"
            name="name"
            autoComplete="name"
            className="input w-full"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label={t('common.email')} htmlFor="register-email" required>
          <input
            id="register-email"
            name="email"
            type="email"
            autoComplete="email"
            className="input w-full"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t('auth.emailPlaceholder')}
            required
          />
        </Field>
        <Field label={t('common.password')} htmlFor="register-password" hint={t('auth.passwordHint')} required>
          <input
            id="register-password"
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
        <Field label={t('auth.confirmPassword')} htmlFor="register-confirm" required>
          <input
            id="register-confirm"
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
          {submitting ? t('auth.registering') : t('auth.register')}
        </button>
      </form>
    </AuthShell>
  );
}
