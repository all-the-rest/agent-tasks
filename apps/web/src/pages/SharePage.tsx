import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { ApiError, api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { describeSchedule } from '../lib/describe';
import { preferredModelId } from '../lib/provider-config';
import { AuthShell } from '../components/AuthShell';
import { ErrorAlert, Spinner } from '../components/ui';

/**
 * A client-side navigation to `/share/<token>` does not reload the document, so
 * it inherits the referrer policy of whichever page was opened first. Add a
 * document-level `no-referrer` policy while this page is mounted; otherwise a
 * fetch or outgoing navigation can put the bearer token into a `Referer` header
 * that a proxy records.
 */
function installNoReferrer(): () => void {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector('meta[name="referrer"]');
  if (existing?.getAttribute('content') === 'no-referrer') return () => {};
  const previousContent = existing?.getAttribute('content') ?? null;
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'referrer');
  meta.setAttribute('content', 'no-referrer');
  if (existing) existing.replaceWith(meta);
  else document.head.appendChild(meta);
  return () => {
    if (!meta.isConnected) return;
    if (existing && previousContent !== null) {
      existing.setAttribute('content', previousContent);
      meta.replaceWith(existing);
    } else {
      meta.remove();
    }
  };
}

/**
 * Public share view. It renders the frozen snapshot only — there is no code
 * path from this page to memory, executions, credentials or the source task.
 * Adopting requires a session and the adopter's own provider selection.
 */
export function SharePage() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [referrerGuard, setReferrerGuard] = useState(false);

  useEffect(() => {
    const restore = installNoReferrer();
    setReferrerGuard(true);
    return restore;
  }, []);

  // Both queries carry the token in their Referer unless the policy is in place,
  // so they stay disabled for the first render.
  const share = useQuery({
    queryKey: ['share', token],
    queryFn: () => api.shares.get(token),
    enabled: token.length > 0 && referrerGuard,
    retry: false,
  });

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: api.providers.list,
    enabled: Boolean(user) && referrerGuard,
  });

  const executableProviders = (providers.data ?? []).filter(
    (provider) => provider.executable && provider.models.length > 0,
  );
  const selectedProvider = executableProviders.find((provider) => provider.id === providerId);
  const firstProviderId = executableProviders[0]?.id ?? '';

  useEffect(() => {
    if (!providerId && firstProviderId) setProviderId(firstProviderId);
  }, [providerId, firstProviderId]);

  useEffect(() => {
    if (!selectedProvider) {
      if (model) setModel('');
      return;
    }
    if (!selectedProvider.models.some((entry) => entry.id === model)) {
      setModel(preferredModelId(selectedProvider));
    }
  }, [selectedProvider, model]);

  const adopt = useMutation({
    mutationFn: () => api.shares.adopt(token, { providerId, model }),
    onMutate: () => setError(null),
    onSuccess: (task) => navigate(`/tasks/${task.id}`, { replace: true }),
    onError: (cause) => setError(errorMessage(cause)),
  });

  if (!referrerGuard || share.isLoading || authLoading) {
    return (
      <AuthShell title={t('tasks.share.publicTitle')} subtitle={t('common.loadingPage')}>
        <div className="flex justify-center py-6">
          <Spinner label="" />
        </div>
      </AuthShell>
    );
  }

  if (share.isError || !share.data) {
    const unavailable = share.error instanceof ApiError && share.error.status === 404;
    return (
      <AuthShell
        title={t('tasks.share.publicTitle')}
        subtitle={t('tasks.share.invalid')}
        footer={
          <Link className="link link-primary" to="/login">
            {t('auth.backToLogin')}
          </Link>
        }
      >
        {share.isError && !unavailable ? (
          <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void share.refetch()} />
        ) : !share.isError ? (
          <p className="text-sm opacity-70">{t('tasks.share.publicHint')}</p>
        ) : null}
      </AuthShell>
    );
  }

  const snapshot = share.data;
  const canAdopt = Boolean(selectedProvider && model);

  return (
    <AuthShell title={t('tasks.share.publicTitle')} subtitle={t('tasks.share.publicSubtitle')}>
      <div className="flex flex-col gap-4">
        <p className="text-xs opacity-70">{t('tasks.share.publicHint')}</p>

        <section className="rounded-box border border-base-300 bg-base-200/40 p-4">
          <span className="badge badge-ghost badge-sm">{t('tasks.share.typeLabel')}</span>
          <h2 className="mt-2 text-lg font-semibold">{snapshot.title}</h2>
          <p className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
            {snapshot.prompt}
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-base-300 pt-3 text-xs">
            <dt className="opacity-60">{t('tasks.schedule')}</dt>
            <dd className="text-right">{describeSchedule(snapshot.schedule, t)}</dd>
            <dt className="opacity-60">{t('tasks.timezone')}</dt>
            <dd className="text-right">{snapshot.timezone}</dd>
          </dl>
        </section>

        {error ? <ErrorAlert message={error} /> : null}

        {!user ? (
          <div className="flex flex-col gap-2">
            <Link className="btn btn-primary" to="/login" state={{ from: `/share/${token}` }}>
              {t('tasks.share.signIn')}
            </Link>
            <Link className="btn btn-ghost btn-sm" to="/login">
              {t('auth.backToLogin')}
            </Link>
          </div>
        ) : (
          <section className="rounded-box border border-base-300 p-4">
            <h3 className="font-semibold">{t('tasks.share.adoptTitle')}</h3>
            <p className="mt-1 text-xs opacity-70">{t('tasks.share.adoptHint')}</p>
            {providers.isLoading ? (
              <div className="mt-3">
                <Spinner />
              </div>
            ) : providers.isError ? (
              <div className="mt-3">
                <ErrorAlert message={t('errors.loadFailed')} onRetry={() => void providers.refetch()} />
              </div>
            ) : executableProviders.length === 0 ? (
              <p className="mt-3 text-sm opacity-70">
                {t('tasks.share.noProviders')}{' '}
                <Link className="link link-primary" to="/settings">
                  {t('nav.settings')}
                </Link>
              </p>
            ) : (
              <form
                className="mt-3 flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canAdopt && !adopt.isPending) adopt.mutate();
                }}
              >
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t('tasks.share.provider')}</span>
                  <select
                    className="select select-bordered select-sm"
                    value={providerId}
                    onChange={(event) => {
                      setProviderId(event.target.value);
                      setModel('');
                    }}
                  >
                    {executableProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{t('tasks.share.model')}</span>
                  <select
                    className="select select-bordered select-sm"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {(selectedProvider?.models ?? []).map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!canAdopt || adopt.isPending}
                  aria-busy={adopt.isPending}
                >
                  {adopt.isPending ? t('tasks.share.adopting') : t('tasks.share.adopt')}
                </button>
              </form>
            )}
          </section>
        )}
      </div>
    </AuthShell>
  );
}
