import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { ApiError, api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AuthShell } from '../components/AuthShell';
import { ErrorAlert, Field, Spinner } from '../components/ui';

interface LocationState {
  from?: string;
}

type Step = 'credentials' | 'totp';

export function LoginPage() {
  const { t } = useTranslation();
  const { user, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState | null)?.from ?? '/';
  const redirectTo = from.startsWith('/') ? from : '/';

  const [step, setStep] = useState<Step>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const config = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 60_000 });
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus, staleTime: 60_000 });

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-200">
        <Spinner label={t('common.loadingPage')} />
      </div>
    );
  }
  if (user) return <Navigate to={redirectTo} replace />;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError(t('validation.required'));
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.auth.signIn(email.trim(), password);
      if (result.twoFactorRedirect) {
        // No session exists yet: Better Auth only set the short-lived
        // two-factor challenge cookie. Ask for the TOTP/backup code instead of
        // calling refresh(), which would report a bogus login failure.
        setPassword('');
        setCode('');
        setUseBackupCode(false);
        setStep('totp');
        return;
      }
      const current = await refresh();
      if (!current) throw new Error(t('auth.loginFailed'));
      navigate(redirectTo, { replace: true });
    } catch (cause) {
      setError(errorMessage(cause) || t('auth.loginFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const onVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const value = code.trim();
    if (!value) {
      setError(t('validation.required'));
      return;
    }
    setSubmitting(true);
    try {
      if (useBackupCode) await api.auth.verifyBackupCode(value);
      else await api.auth.verifyTotp(value);
      const current = await refresh();
      if (!current) throw new Error(t('auth.loginFailed'));
      navigate(redirectTo, { replace: true });
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        (cause.code === 'INVALID_CODE' || cause.code === 'INVALID_BACKUP_CODE')
      ) {
        setError(t('auth.twoFactorInvalid'));
      } else {
        setError(errorMessage(cause) || t('auth.twoFactorInvalid'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const backToCredentials = () => {
    setStep('credentials');
    setCode('');
    setUseBackupCode(false);
    setError(null);
  };

  const isTotpStep = step === 'totp';

  return (
    <AuthShell
      title={isTotpStep ? t('auth.twoFactorTitle') : t('auth.loginTitle')}
      subtitle={isTotpStep ? t('auth.twoFactorSubtitle') : t('auth.loginSubtitle')}
      footer={
        !isTotpStep ? (
          setup.data && !setup.data.configured ? (
            <span>
              {t('auth.setupRequired')}{' '}
              <Link className="link link-primary" to="/setup">
                {t('auth.setupTitle')}
              </Link>
            </span>
          ) : config.data?.allowRegistration ? (
            <span>
              {t('auth.noAccount')}{' '}
              <Link className="link link-primary" to="/register">
                {t('auth.register')}
              </Link>
            </span>
          ) : null
        ) : null
      }
    >
      {isTotpStep ? (
        <form className="flex flex-col gap-3" onSubmit={onVerify} noValidate>
          {error ? <ErrorAlert message={error} /> : null}
          <p className="text-sm opacity-70">
            {useBackupCode ? t('auth.backupCodeHint') : t('auth.totpCodeHint')}
          </p>
          <Field
            label={useBackupCode ? t('auth.backupCode') : t('auth.totpCode')}
            htmlFor="login-code"
            required
          >
            <input
              id="login-code"
              name="code"
              type="text"
              className="input w-full font-mono tracking-widest"
              inputMode={useBackupCode ? 'text' : 'numeric'}
              autoComplete={useBackupCode ? 'off' : 'one-time-code'}
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={useBackupCode ? 'abcde-12345' : '123456'}
              required
            />
          </Field>
          <button type="submit" className="btn btn-primary mt-2" disabled={submitting}>
            {submitting ? <span className="loading loading-spinner loading-sm" aria-hidden="true" /> : null}
            {submitting ? t('auth.twoFactorVerifying') : t('auth.twoFactorVerify')}
          </button>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <button
              type="button"
              className="link link-primary"
              onClick={() => {
                setUseBackupCode((current) => !current);
                setCode('');
                setError(null);
              }}
            >
              {useBackupCode ? t('auth.useTotpCode') : t('auth.useBackupCode')}
            </button>
            <button type="button" className="link" onClick={backToCredentials}>
              {t('auth.backToLogin')}
            </button>
          </div>
        </form>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
          {error ? <ErrorAlert message={error} /> : null}
          <Field label={t('common.email')} htmlFor="login-email" required>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="username"
              className="input w-full"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t('auth.emailPlaceholder')}
              required
            />
          </Field>
          <Field label={t('common.password')} htmlFor="login-password" required>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              className="input w-full"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </Field>
          <button type="submit" className="btn btn-primary mt-2" disabled={submitting}>
            {submitting ? <span className="loading loading-spinner loading-sm" aria-hidden="true" /> : null}
            {submitting ? t('auth.signingIn') : t('auth.signIn')}
          </button>
          {config.data ? (
            <p className="text-center text-xs opacity-50">
              {config.data.appName} · {t('common.version')} {config.data.version}
            </p>
          ) : null}
        </form>
      )}
    </AuthShell>
  );
}
