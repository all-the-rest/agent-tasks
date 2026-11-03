import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import {
  REDACTED_HEADER_VALUE,
  buildProviderUpdateConfig,
  disabledModelIds,
  providerBaseUrl,
  providerConfigNeedsUpdate,
  providerHeaderNames,
} from '../lib/provider-config';
import { AdminTabs } from '../components/AdminTabs';
import {
  ConfirmDialog,
  ErrorAlert,
  Field,
  Modal,
  PageHeader,
  Spinner,
  useToast,
} from '../components/ui';
import type { AdminProvider } from '../lib/types';

const KINDS = ['ollama', 'openai-compatible', 'openai', 'codex'] as const;

function kindLabel(kind: string, t: (key: string) => string): string {
  if (kind === 'ollama') return t('admin.kindOllama');
  if (kind === 'openai-compatible') return t('admin.kindOpenaiCompatible');
  if (kind === 'openai') return t('admin.kindOpenai');
  if (kind === 'codex') return t('admin.kindCodex');
  return kind;
}

interface ProviderForm {
  name: string;
  kind: string;
  baseUrl: string;
  enabled: boolean;
  isDefault: boolean;
}

const EMPTY_FORM: ProviderForm = {
  name: '',
  kind: 'openai-compatible',
  baseUrl: '',
  enabled: true,
  isDefault: false,
};

export function AdminProvidersPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const providers = useQuery({ queryKey: ['admin', 'providers'], queryFn: api.admin.providers });

  const [formProvider, setFormProvider] = useState<AdminProvider | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const [credentialProvider, setCredentialProvider] = useState<AdminProvider | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [credentialLabel, setCredentialLabel] = useState('default');
  const [credentialError, setCredentialError] = useState<string | null>(null);

  const [deleteProvider, setDeleteProvider] = useState<AdminProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, { ok: boolean; text: string; checkedAt: string }>>({});

  useEffect(() => {
    if (!formOpen) return;
    if (formProvider) {
      setForm({
        name: formProvider.name,
        kind: formProvider.kind,
        baseUrl: typeof formProvider.config.baseUrl === 'string' ? formProvider.config.baseUrl : '',
        enabled: formProvider.enabled,
        isDefault: formProvider.isDefault,
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setFormError(null);
  }, [formOpen, formProvider]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'providers'] }),
      queryClient.invalidateQueries({ queryKey: ['providers'] }),
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    ]);
  };

  const saveProvider = useMutation({
    mutationFn: () => {
      const baseUrl = form.baseUrl.trim();
      if (!form.name.trim()) throw new Error(t('validation.required'));
      if (form.kind !== 'ollama' && !baseUrl) throw new Error(t('validation.required'));
      if (formProvider) {
        // Only send the config when the editable field changed. Otherwise the
        // stored headers (and every other server-side key) stay untouched.
        return api.admin.updateProvider(formProvider.id, {
          name: form.name.trim(),
          enabled: form.enabled,
          isDefault: form.isDefault,
          ...(providerConfigNeedsUpdate(formProvider.config, baseUrl)
            ? { config: buildProviderUpdateConfig(formProvider.config, baseUrl) }
            : {}),
        });
      }
      const config: Record<string, unknown> = {
        baseUrl: baseUrl || 'http://ollama:11434',
      };
      return api.admin.createProvider({
        name: form.name.trim(),
        kind: form.kind,
        config,
        enabled: form.enabled,
        isDefault: form.isDefault,
      });
    },
    onSuccess: async () => {
      setFormOpen(false);
      setFormError(null);
      showToast(formProvider ? t('admin.providerSaved') : t('admin.providerCreated'));
      await invalidate();
    },
    onError: (cause) => setFormError(errorMessage(cause)),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; changes: { enabled?: boolean; isDefault?: boolean } }) =>
      api.admin.updateProvider(input.id, input.changes),
    onSuccess: async () => {
      showToast(t('admin.providerSaved'));
      await invalidate();
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.admin.deleteProvider(id),
    onSuccess: async () => {
      setDeleteProvider(null);
      showToast(t('admin.providerDeleted'));
      await invalidate();
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const saveCredential = useMutation({
    mutationFn: () => api.admin.setCredential(credentialProvider?.id ?? '', { apiKey: apiKey.trim(), label: credentialLabel.trim() || 'default' }),
    onSuccess: async () => {
      setCredentialProvider(null);
      setApiKey('');
      setCredentialLabel('default');
      setCredentialError(null);
      showToast(t('admin.credentialSaved'));
      await invalidate();
    },
    onError: (cause) => setCredentialError(errorMessage(cause)),
  });

  const refreshModels = useMutation({
    mutationFn: (id: string) => api.admin.refreshModels(id),
    onSuccess: async (result) => {
      showToast(`${t('admin.modelsRefreshed')} (${result.models?.length ?? 0})`);
      await invalidate();
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  const checkHealth = useMutation({
    mutationFn: (id: string) => api.admin.health(id),
    onSuccess: (result, id) => {
      setHealth((current) => ({
        ...current,
        [id]: {
          ok: result.ok !== false,
          text: result.message ?? (result.ok === false ? t('admin.healthFail') : t('admin.healthOk')),
          checkedAt: new Date().toISOString(),
        },
      }));
    },
    onError: (cause, id) => {
      setHealth((current) => ({ ...current, [id]: { ok: false, text: errorMessage(cause), checkedAt: new Date().toISOString() } }));
    },
  });

  // Catalog policy (default model, hidden models) is part of the provider config so
  // the next task's preselection follows it without a redeploy. The config sent back
  // still carries the `***` header sentinel, which the API resolves server-side.
  const saveModelPolicy = useMutation({
    mutationFn: (input: { provider: AdminProvider; disabledModels?: string[]; defaultModel?: string }) => {
      const config = buildProviderUpdateConfig(input.provider.config, providerBaseUrl(input.provider.config));
      if (input.disabledModels !== undefined) config.disabledModels = input.disabledModels;
      if (input.defaultModel !== undefined) config.defaultModel = input.defaultModel;
      return api.admin.updateProvider(input.provider.id, { config });
    },
    onSuccess: async () => {
      showToast(t('admin.modelPolicySaved'));
      await invalidate();
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  return (
    <>
      <PageHeader
        title={t('admin.providers')}
        subtitle={t('admin.subtitle')}
        actions={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setFormProvider(null);
              setFormOpen(true);
            }}
          >
            + {t('admin.addProvider')}
          </button>
        }
      />
      <AdminTabs />

      {error ? (
        <div className="mb-4">
          <ErrorAlert message={error} />
        </div>
      ) : null}

      {providers.isLoading ? (
        <Spinner label={t('common.loading')} />
      ) : providers.isError ? (
        <ErrorAlert message={t('errors.loadFailed')} />
      ) : !providers.data || providers.data.length === 0 ? (
        <div className="rounded-box border border-dashed border-base-300 bg-base-100 p-10 text-center text-sm opacity-60">
          {t('admin.noProviders')}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {providers.data.map((provider) => {
            const result = health[provider.id];
            const hidden = disabledModelIds(provider.config);
            const defaultModel = typeof provider.config.defaultModel === 'string' ? provider.config.defaultModel : undefined;
            return (
              <section key={provider.id} className="card border border-base-300 bg-base-100 shadow-sm">
                <div className="card-body gap-3 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate font-bold">{provider.name}</h2>
                        <span className="badge badge-ghost badge-sm">{kindLabel(provider.kind, t)}</span>
                        {provider.isDefault ? (
                          <span className="badge badge-primary badge-sm">{t('admin.defaultProvider')}</span>
                        ) : null}
                        <span className={`badge badge-sm ${provider.enabled ? 'badge-success' : 'badge-ghost'}`}>
                          {provider.enabled ? t('common.enabled') : t('common.disabled')}
                        </span>
                        {result ? (
                          <span className={`badge badge-sm ${result.ok ? 'badge-success' : 'badge-error'}`}>
                            {result.ok ? t('admin.healthOkShort') : t('admin.healthFailShort')}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 break-all font-mono text-xs opacity-60">
                        {typeof provider.config.baseUrl === 'string' ? provider.config.baseUrl : '—'}
                      </p>
                      <p className="mt-1 text-xs opacity-60">
                        {provider.sharedCredential ? t('admin.sharedCredential') : t('settings.notConnected')} ·{' '}
                        {t('admin.personalCredentialCount', { count: provider.personalCredentials })}
                      </p>
                      <div className="mt-3 rounded-box border border-base-300 bg-base-200/40 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-semibold">{t('admin.modelCatalog')}</p>
                          <span className="badge badge-ghost badge-sm">{provider.models.length}</span>
                        </div>
                        {provider.models.length === 0 ? (
                          <p className="mt-1 text-xs opacity-70">{t('admin.modelCatalogEmpty')}</p>
                        ) : (
                          <ul className="mt-2 flex flex-col gap-1">
                            {provider.models.map((model) => {
                              const isDefault = defaultModel === model.id;
                              const isHidden = hidden.includes(model.id);
                              return (
                                <li key={model.id} className="flex flex-wrap items-center gap-2 text-xs">
                                  <code className="break-all">{model.id}</code>
                                  {model.label ? <span className="opacity-70">{model.label}</span> : null}
                                  {model.supportsTools ? (
                                    <span className="badge badge-ghost badge-xs">{t('admin.modelSupportsTools')}</span>
                                  ) : null}
                                  {model.contextLength ? (
                                    <span className="opacity-60">{t('admin.modelContext', { count: model.contextLength })}</span>
                                  ) : null}
                                  {isDefault ? <span className="badge badge-primary badge-xs">{t('admin.defaultModelBadge')}</span> : null}
                                  {isHidden ? <span className="badge badge-ghost badge-xs">{t('admin.modelHidden')}</span> : null}
                                  {!isDefault ? (
                                    <button
                                      type="button"
                                      className="btn btn-xs btn-ghost"
                                      disabled={saveModelPolicy.isPending}
                                      onClick={() => saveModelPolicy.mutate({ provider, defaultModel: model.id })}
                                    >
                                      {t('admin.setDefaultModel')}
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="btn btn-xs btn-ghost"
                                    disabled={saveModelPolicy.isPending}
                                    onClick={() =>
                                      saveModelPolicy.mutate({
                                        provider,
                                        disabledModels: isHidden
                                          ? hidden.filter((id) => id !== model.id)
                                          : [...hidden, model.id],
                                      })
                                    }
                                  >
                                    {isHidden ? t('admin.showModel') : t('admin.hideModel')}
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate({ id: provider.id, changes: { enabled: !provider.enabled } })}
                      >
                        {provider.enabled ? t('admin.disable') : t('admin.enable')}
                      </button>
                      {!provider.isDefault ? (
                        <button
                          type="button"
                          className="btn btn-xs btn-ghost"
                          disabled={toggle.isPending}
                          onClick={() => toggle.mutate({ id: provider.id, changes: { isDefault: true } })}
                        >
                          {t('admin.defaultProvider')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-xs btn-outline"
                        onClick={() => {
                          setCredentialProvider(provider);
                          setApiKey('');
                          setCredentialLabel('default');
                          setCredentialError(null);
                        }}
                      >
                        {t('admin.sharedCredential')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-outline"
                        disabled={refreshModels.isPending}
                        onClick={() => refreshModels.mutate(provider.id)}
                      >
                        {t('admin.refreshModels')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-outline"
                        disabled={checkHealth.isPending}
                        onClick={() => checkHealth.mutate(provider.id)}
                      >
                        {t('admin.health')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        onClick={() => {
                          setFormProvider(provider);
                          setFormOpen(true);
                        }}
                      >
                        {t('common.edit')}
                      </button>
                      <Link className="btn btn-xs btn-ghost" to="/admin/audit">
                        {t('admin.viewAudit')}
                      </Link>
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost text-error"
                        onClick={() => setDeleteProvider(provider)}
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  </div>
                  {result ? (
                    <div className={`alert py-1 ${result.ok ? 'alert-success' : 'alert-error'}`} role="status">
                      <span className="text-xs">{result.text}</span>
                      <span className="text-xs opacity-70">
                        {t('admin.checkedAt', { time: formatDate(result.checkedAt, i18n.language) })}
                      </span>
                    </div>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Modal
        open={formOpen}
        title={formProvider ? t('admin.providerEditTitle') : t('admin.providerDialogTitle')}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setFormOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saveProvider.isPending}
              onClick={() => saveProvider.mutate()}
            >
              {saveProvider.isPending ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
              {t('common.save')}
            </button>
          </>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            saveProvider.mutate();
          }}
        >
          {formError ? <ErrorAlert message={formError} /> : null}
          <Field label={t('admin.providerName')} htmlFor="provider-name" required>
            <input
              id="provider-name"
              className="input w-full"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              required
            />
          </Field>
          <Field label={t('admin.providerKind')} htmlFor="provider-kind">
            <select
              id="provider-kind"
              className="select w-full"
              value={form.kind}
              disabled={Boolean(formProvider)}
              onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value }))}
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(kind, t)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('admin.baseUrl')} htmlFor="provider-base-url">
            <input
              id="provider-base-url"
              type="url"
              className="input w-full"
              value={form.baseUrl}
              onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
            />
          </Field>
          {form.kind === 'openai-compatible' && !formProvider ? (
            <p className="text-xs opacity-70">
              {t('admin.openCodeGoHint')}{' '}
              <button
                type="button"
                className="link"
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    name: current.name || 'OpenCode Go',
                    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
                  }))
                }
              >
                {t('admin.useOpenCodeGo')}
              </button>
            </p>
          ) : null}
          {formProvider && providerHeaderNames(formProvider.config).length > 0 ? (
            <div className="rounded-box border border-base-300 bg-base-200/50 p-3">
              <p className="text-sm font-semibold">{t('admin.providerHeaders')}</p>
              <p className="mt-1 text-xs opacity-70">{t('admin.providerHeadersHint')}</p>
              <ul className="mt-2 flex flex-col gap-1 font-mono text-xs">
                {providerHeaderNames(formProvider.config).map((name) => (
                  <li key={name} className="break-all">
                    <span>{name}</span>
                    <span className="opacity-60">: {REDACTED_HEADER_VALUE}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-6">
            <label className="flex cursor-pointer items-center gap-2 text-sm" htmlFor="provider-enabled">
              <input
                id="provider-enabled"
                type="checkbox"
                className="toggle toggle-sm"
                checked={form.enabled}
                onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
              />
              {t('admin.providerEnabled')}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm" htmlFor="provider-default">
              <input
                id="provider-default"
                type="checkbox"
                className="toggle toggle-sm"
                checked={form.isDefault}
                onChange={(event) => setForm((current) => ({ ...current, isDefault: event.target.checked }))}
              />
              {t('admin.defaultProvider')}
            </label>
          </div>
        </form>
      </Modal>

      <Modal
        open={credentialProvider !== null}
        title={t('admin.credentialTitle', { name: credentialProvider?.name ?? '' })}
        onClose={() => setCredentialProvider(null)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setCredentialProvider(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saveCredential.isPending}
              onClick={() => {
                if (apiKey.trim().length < 8) {
                  setCredentialError(t('validation.required'));
                  return;
                }
                saveCredential.mutate();
              }}
            >
              {saveCredential.isPending ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
              {t('common.save')}
            </button>
          </>
        }
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (apiKey.trim().length < 8) {
              setCredentialError(t('validation.required'));
              return;
            }
            saveCredential.mutate();
          }}
        >
          {credentialError ? <ErrorAlert message={credentialError} /> : null}
          <Field label={t('admin.apiKey')} htmlFor="shared-api-key" required>
            <input
              id="shared-api-key"
              type="password"
              autoComplete="off"
              className="input w-full font-mono"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              required
            />
          </Field>
          <Field label={t('admin.credentialLabel')} htmlFor="shared-api-label">
            <input
              id="shared-api-label"
              className="input w-full"
              value={credentialLabel}
              onChange={(event) => setCredentialLabel(event.target.value)}
            />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteProvider !== null}
        title={t('admin.deleteProviderTitle')}
        body={t('admin.deleteProviderBody', { name: deleteProvider?.name ?? '' })}
        confirmLabel={t('admin.deleteProvider')}
        onConfirm={() => {
          if (deleteProvider) remove.mutate(deleteProvider.id);
        }}
        onClose={() => setDeleteProvider(null)}
        loading={remove.isPending}
      />
    </>
  );
}
