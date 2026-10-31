import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import type { TwoFactorSetupResult } from '../lib/api';
import { setLanguage } from '../i18n';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { timezonesWith } from '../lib/schedule';
import {
  ConfirmDialog,
  ErrorAlert,
  Field,
  Modal,
  PageHeader,
  Spinner,
  SuccessAlert,
  useToast,
} from '../components/ui';
import type { Locale, Provider, ThemePreference } from '../lib/types';

export function SettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { theme, setTheme } = useTheme();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers.list });

  const [timezone, setTimezone] = useState('UTC');
  const [locale, setLocale] = useState<Locale>('en');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [keyProvider, setKeyProvider] = useState<Provider | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [keyLabel, setKeyLabel] = useState('default');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [removeProvider, setRemoveProvider] = useState<Provider | null>(null);

  const { user, refresh: refreshSession } = useAuth();
  const twoFactorEnabled = user?.twoFactorEnabled === true;
  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaSetup, setMfaSetup] = useState<TwoFactorSetupResult | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const invalidateTwoFactor = async () => {
    await Promise.all([
      refreshSession(),
      queryClient.invalidateQueries({ queryKey: ['me'] }),
    ]);
  };

  const enableTwoFactor = useMutation({
    mutationFn: (password: string) => api.auth.enableTwoFactor(password),
    onSuccess: (result) => {
      setMfaPassword('');
      setMfaCode('');
      setMfaError(null);
      setMfaSetup(result);
    },
    onError: (cause) => setMfaError(errorMessage(cause) || t('settings.twoFactorSetupFailed')),
  });

  const confirmTwoFactor = useMutation({
    mutationFn: async (code: string) => {
      await api.auth.verifyTotp(code);
      await invalidateTwoFactor();
    },
    onSuccess: () => {
      setMfaSetup(null);
      setMfaCode('');
      setMfaError(null);
      showToast(t('settings.twoFactorEnabledMsg'));
    },
    onError: (cause) => setMfaError(errorMessage(cause) || t('settings.twoFactorCodeInvalid')),
  });

  const disableTwoFactor = useMutation({
    mutationFn: async (input: { password: string; code: string }) => {
      // Better Auth's `/two-factor/disable` body is `{ password }` only, so the
      // code is validated first with the matching verify endpoint; a wrong code
      // then never reaches the destructive call.
      if (/^\d{6}$/.test(input.code)) await api.auth.verifyTotp(input.code);
      else await api.auth.verifyBackupCode(input.code);
      await api.auth.disableTwoFactor(input.password);
    },
    onSuccess: async () => {
      setDisableOpen(false);
      setDisablePassword('');
      setDisableCode('');
      setMfaError(null);
      showToast(t('settings.twoFactorDisabledMsg'));
      await invalidateTwoFactor();
    },
    onError: (cause) => setMfaError(errorMessage(cause) || t('settings.twoFactorCodeInvalid')),
  });

  useEffect(() => {
    if (!me.data) return;
    setTimezone(me.data.preferences.timezone);
    setLocale(me.data.preferences.locale);
  }, [me.data]);

  const save = useMutation({
    mutationFn: () => api.updatePreferences({ timezone, locale, theme }),
    onSuccess: async () => {
      setSaved(true);
      setError(null);
      showToast(t('settings.saved'));
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (cause) => {
      setSaved(false);
      setError(errorMessage(cause));
    },
  });

  const saveKey = useMutation({
    mutationFn: (input: { id: string; apiKey: string; label: string }) =>
      api.providers.setCredential(input.id, { apiKey: input.apiKey, label: input.label }),
    onSuccess: async () => {
      setKeyProvider(null);
      setApiKey('');
      setKeyLabel('default');
      setKeyError(null);
      showToast(t('settings.keySaved'));
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
    },
    onError: (cause) => setKeyError(errorMessage(cause)),
  });

  const removeKey = useMutation({
    mutationFn: (id: string) => api.providers.removeCredential(id),
    onSuccess: async () => {
      setRemoveProvider(null);
      showToast(t('settings.keyRemoved'));
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  if (me.isLoading) return <Spinner label={t('common.loadingPage')} />;
  if (me.isError || !me.data) return <ErrorAlert message={t('errors.loadFailed')} />;

  const meData = me.data;
  const zones = timezonesWith(timezone);
  const localeChoices: Array<{ value: Locale; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'de', label: 'Deutsch' },
  ];
  const themeChoices: Array<{ value: ThemePreference; label: string }> = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ];

  return (
    <>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />

      {error ? (
        <div className="mb-4">
          <ErrorAlert message={error} />
        </div>
      ) : null}
      {saved ? (
        <div className="mb-4">
          <SuccessAlert message={t('settings.saved')} />
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-3">
        <section className="card border border-base-300 bg-base-100 shadow-sm xl:col-span-2">
          <form
            className="card-body gap-4 p-5"
            onSubmit={(event) => {
              event.preventDefault();
              setSaved(false);
              save.mutate();
            }}
          >
            <div>
              <h2 className="card-title text-base">{t('settings.preferences')}</h2>
              <p className="text-xs opacity-60">{t('settings.preferencesHint')}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('settings.timezone')} htmlFor="settings-timezone" hint={t('settings.timezoneHint')}>
                <select
                  id="settings-timezone"
                  className="select w-full"
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                >
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('settings.language')} htmlFor="settings-language" hint={t('settings.languageHint')}>
                <select
                  id="settings-language"
                  className="select w-full"
                  value={locale}
                  onChange={(event) => {
                    const next = event.target.value as Locale;
                    setLocale(next);
                    setLanguage(next);
                  }}
                >
                  {localeChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('settings.theme')} htmlFor="settings-theme">
                <select
                  id="settings-theme"
                  className="select w-full"
                  value={theme}
                  onChange={(event) => setTheme(event.target.value as ThemePreference)}
                >
                  {themeChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex justify-end">
              <button type="submit" className="btn btn-primary btn-sm" disabled={save.isPending}>
                {save.isPending ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
                {t('settings.savePreferences')}
              </button>
            </div>
          </form>
        </section>

        <section className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-3 p-5 text-sm">
            <h2 className="card-title text-base">{t('settings.account')}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
              <dt className="opacity-60">{t('common.name')}</dt>
              <dd className="truncate text-right font-medium">{meData.user.name}</dd>
              <dt className="opacity-60">{t('common.email')}</dt>
              <dd className="truncate text-right">{meData.user.email}</dd>
              <dt className="opacity-60">{t('common.role')}</dt>
              <dd className="text-right">
                <span className="badge badge-ghost badge-sm">{t(`roles.${meData.user.role}`)}</span>
              </dd>
            </dl>
            <div className="mt-2 rounded-lg bg-base-200 p-3 text-xs">
              <p className="font-semibold">{t('settings.limitsTitle')}</p>
              <p className="mt-1 opacity-70">
                {t('settings.limitConcurrent', { count: meData.limits.maxConcurrentExecutionsPerUser })}
              </p>
              <p className="opacity-70">
                {t('settings.limitDaily', { count: meData.limits.maxTaskExecutionsPerDay })}
              </p>
            </div>
          </div>
        </section>
      </div>

      <section className="card mt-5 border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="card-title text-base">{t('settings.twoFactor')}</h2>
              <p className="max-w-3xl text-xs opacity-60">{t('settings.twoFactorHint')}</p>
            </div>
            <span className={`badge badge-sm ${twoFactorEnabled ? 'badge-success' : 'badge-ghost'}`}>
              {twoFactorEnabled ? t('common.enabled') : t('common.disabled')}
            </span>
          </div>

          {mfaError ? <ErrorAlert message={mfaError} /> : null}

          {twoFactorEnabled ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-base-200 p-3">
              <p className="text-sm">{t('settings.twoFactorEnabledHint')}</p>
              <button
                type="button"
                className="btn btn-sm btn-outline btn-error"
                onClick={() => {
                  setDisableOpen(true);
                  setDisablePassword('');
                  setDisableCode('');
                  setMfaError(null);
                }}
              >
                {t('settings.disableTwoFactor')}
              </button>
            </div>
          ) : mfaSetup ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">{t('settings.totpSetupHint')}</p>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide opacity-60">{t('settings.totpUri')}</p>
                <code
                  data-testid="mfa-totp-uri"
                  className="mt-1 block break-all rounded-lg bg-base-200 p-2 font-mono text-xs"
                >
                  {mfaSetup.totpURI}
                </code>
              </div>
              {mfaSetup.backupCodes && mfaSetup.backupCodes.length > 0 ? (
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide opacity-60">{t('settings.backupCodes')}</p>
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost"
                      onClick={async () => {
                        try {
                          await navigator.clipboard?.writeText((mfaSetup.backupCodes ?? []).join('\n'));
                          showToast(t('common.copied'));
                        } catch {
                          showToast(t('settings.copyFailed'), 'error');
                        }
                      }}
                    >
                      {t('settings.copyBackupCodes')}
                    </button>
                  </div>
                  <ul
                    data-testid="mfa-backup-codes"
                    className="mt-1 grid grid-cols-2 gap-1 rounded-lg bg-base-200 p-2 font-mono text-xs sm:grid-cols-3"
                  >
                    {mfaSetup.backupCodes.map((backupCode) => (
                      <li key={backupCode}>{backupCode}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs opacity-60">{t('settings.backupCodesHint')}</p>
                </div>
              ) : null}
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = mfaCode.trim();
                  if (!value) {
                    setMfaError(t('validation.required'));
                    return;
                  }
                  confirmTwoFactor.mutate(value);
                }}
              >
                <Field
                  label={t('settings.twoFactorCode')}
                  htmlFor="mfa-confirm-code"
                  hint={t('settings.twoFactorCodeHint')}
                  required
                >
                  <input
                    id="mfa-confirm-code"
                    type="text"
                    className="input w-full font-mono tracking-widest"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={mfaCode}
                    onChange={(event) => setMfaCode(event.target.value)}
                    placeholder="123456"
                    required
                  />
                </Field>
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setMfaSetup(null);
                      setMfaCode('');
                      setMfaError(null);
                    }}
                  >
                    {t('common.cancel')}
                  </button>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={confirmTwoFactor.isPending}>
                    {confirmTwoFactor.isPending ? (
                      <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                    ) : null}
                    {t('settings.confirmTwoFactor')}
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <form
              className="flex flex-col gap-3 rounded-lg bg-base-200 p-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!mfaPassword) {
                  setMfaError(t('validation.required'));
                  return;
                }
                enableTwoFactor.mutate(mfaPassword);
              }}
            >
              <p className="text-sm">{t('settings.twoFactorDisabledHint')}</p>
              <Field
                label={t('settings.currentPassword')}
                htmlFor="mfa-password"
                hint={t('settings.currentPasswordHint')}
                required
              >
                <input
                  id="mfa-password"
                  type="password"
                  autoComplete="current-password"
                  className="input w-full"
                  value={mfaPassword}
                  onChange={(event) => setMfaPassword(event.target.value)}
                  required
                />
              </Field>
              <div className="flex justify-end">
                <button type="submit" className="btn btn-primary btn-sm" disabled={enableTwoFactor.isPending}>
                  {enableTwoFactor.isPending ? (
                    <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                  ) : null}
                  {t('settings.enableTwoFactor')}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>

      <Modal
        open={disableOpen}
        title={t('settings.disableTwoFactor')}
        onClose={() => {
          setDisableOpen(false);
          setMfaError(null);
        }}
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setDisableOpen(false);
                setMfaError(null);
              }}
              disabled={disableTwoFactor.isPending}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-error"
              disabled={disableTwoFactor.isPending}
              onClick={() => {
                if (!disablePassword) {
                  setMfaError(t('validation.required'));
                  return;
                }
                if (!disableCode.trim()) {
                  setMfaError(t('validation.required'));
                  return;
                }
                disableTwoFactor.mutate({ password: disablePassword, code: disableCode.trim() });
              }}
            >
              {disableTwoFactor.isPending ? (
                <span className="loading loading-spinner loading-xs" aria-hidden="true" />
              ) : null}
              {t('settings.disableTwoFactor')}
            </button>
          </>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disablePassword || !disableCode.trim()) {
              setMfaError(t('validation.required'));
              return;
            }
            disableTwoFactor.mutate({ password: disablePassword, code: disableCode.trim() });
          }}
        >
          <p className="text-sm opacity-80">{t('settings.disableTwoFactorBody')}</p>
          {mfaError ? <ErrorAlert message={mfaError} /> : null}
          <Field
            label={t('settings.currentPassword')}
            htmlFor="mfa-disable-password"
            hint={t('settings.currentPasswordHint')}
            required
          >
            <input
              id="mfa-disable-password"
              type="password"
              autoComplete="current-password"
              className="input w-full"
              value={disablePassword}
              onChange={(event) => setDisablePassword(event.target.value)}
              required
            />
          </Field>
          <Field
            label={t('settings.twoFactorCode')}
            htmlFor="mfa-disable-code"
            hint={t('settings.twoFactorCodeHint')}
            required
          >
            <input
              id="mfa-disable-code"
              type="text"
              className="input w-full font-mono tracking-widest"
              autoComplete="one-time-code"
              value={disableCode}
              onChange={(event) => setDisableCode(event.target.value)}
              placeholder="123456"
              required
            />
          </Field>
        </form>
      </Modal>

      <section className="card mt-5 border border-base-300 bg-base-100 shadow-sm">
        <div className="card-body gap-3 p-5">
          <div>
            <h2 className="card-title text-base">{t('settings.personalCredentials')}</h2>
            <p className="max-w-3xl text-xs opacity-60">{t('settings.credentialsHint')}</p>
          </div>
          {providers.isLoading ? (
            <Spinner />
          ) : providers.isError ? (
            <ErrorAlert message={t('errors.loadFailed')} />
          ) : !providers.data || providers.data.length === 0 ? (
            <p className="text-sm opacity-60">{t('settings.noProviders')}</p>
          ) : (
            <ul className="divide-y divide-base-200">
              {providers.data.map((provider) => (
                <li key={provider.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{provider.name}</p>
                    <p className="text-xs opacity-60">
                      {provider.kind}
                      {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`badge badge-sm ${
                        provider.hasPersonalCredential ? 'badge-success' : 'badge-ghost'
                      }`}
                    >
                      {provider.hasPersonalCredential ? t('settings.connected') : t('settings.notConnected')}
                    </span>
                    {!provider.hasPersonalCredential && provider.hasCredential ? (
                      <span className="badge badge-sm badge-info">{t('admin.sharedCredential')}</span>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-xs btn-outline"
                      onClick={() => {
                        setKeyProvider(provider);
                        setKeyError(null);
                      }}
                    >
                      {provider.hasPersonalCredential ? t('settings.saveKey') : t('settings.addKey')}
                    </button>
                    {provider.hasPersonalCredential ? (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost text-error"
                        onClick={() => setRemoveProvider(provider)}
                      >
                        {t('settings.removeKey')}
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <Modal
        open={keyProvider !== null}
        title={t('settings.addKey')}
        onClose={() => setKeyProvider(null)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setKeyProvider(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saveKey.isPending}
              onClick={() => {
                if (!keyProvider) return;
                if (apiKey.trim().length < 8) {
                  setKeyError(t('validation.required'));
                  return;
                }
                saveKey.mutate({ id: keyProvider.id, apiKey: apiKey.trim(), label: keyLabel.trim() || 'default' });
              }}
            >
              {saveKey.isPending ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
              {t('settings.saveKey')}
            </button>
          </>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!keyProvider) return;
            if (apiKey.trim().length < 8) {
              setKeyError(t('validation.required'));
              return;
            }
            saveKey.mutate({ id: keyProvider.id, apiKey: apiKey.trim(), label: keyLabel.trim() || 'default' });
          }}
        >
          {keyError ? <ErrorAlert message={keyError} /> : null}
          <Field label={t('settings.provider')} htmlFor="credential-provider">
            <input id="credential-provider" className="input w-full" value={keyProvider?.name ?? ''} readOnly />
          </Field>
          <Field label={t('settings.apiKey')} htmlFor="credential-key" required>
            <input
              id="credential-key"
              type="password"
              autoComplete="off"
              className="input w-full font-mono"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              required
            />
          </Field>
          <Field label={t('settings.keyLabel')} htmlFor="credential-label">
            <input
              id="credential-label"
              className="input w-full"
              value={keyLabel}
              onChange={(event) => setKeyLabel(event.target.value)}
            />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={removeProvider !== null}
        title={t('settings.removeKeyTitle')}
        body={t('settings.removeKeyBody', { name: removeProvider?.name ?? '' })}
        confirmLabel={t('settings.removeKey')}
        onConfirm={() => {
          if (removeProvider) removeKey.mutate(removeProvider.id);
        }}
        onClose={() => setRemoveProvider(null)}
        loading={removeKey.isPending}
      />
    </>
  );
}
