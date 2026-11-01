import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { DEFAULT_TIME_OF_DAY, parseClock, timezonesWith } from '../lib/schedule';
import { formatNumber } from '../lib/format';
import { AdminTabs } from '../components/AdminTabs';
import {
  ErrorAlert,
  Field,
  PageHeader,
  Spinner,
  SuccessAlert,
  useToast,
} from '../components/ui';
import type { SystemSettings } from '../lib/types';

const FALLBACK: SystemSettings = {
  allowRegistration: false,
  defaultTimezone: 'UTC',
  maxConcurrentExecutionsPerUser: 2,
  maxTaskExecutionsPerDay: 50,
  browserAllowHttp: true,
  browserAllowedPorts: [80, 443],
  searchProvider: 'searxng',
  searchBaseUrl: 'http://searxng:8080',
  scheduleTimePresets: DEFAULT_TIME_OF_DAY,
};

export function AdminPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const metrics = useQuery({ queryKey: ['admin', 'metrics'], queryFn: api.admin.metrics });
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: api.admin.settings });

  const [draft, setDraft] = useState<SystemSettings>(FALLBACK);
  const [portsText, setPortsText] = useState('80, 443');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    // Tolerate an older API during a rolling upgrade without crashing the form.
    setDraft({
      ...FALLBACK,
      ...settings.data,
      scheduleTimePresets: settings.data.scheduleTimePresets ?? DEFAULT_TIME_OF_DAY,
    });
    setPortsText(settings.data.browserAllowedPorts.join(', '));
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (payload: SystemSettings) => api.admin.saveSettings(payload),
    onSuccess: async () => {
      setSaved(true);
      setError(null);
      showToast(t('admin.settingsSaved'));
      await queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError: (cause) => {
      setSaved(false);
      setError(errorMessage(cause));
    },
  });

  const update = <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const submit = () => {
    setSaved(false);
    const ports = portsText
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65_535);
    const rawParts = portsText.split(',').filter((part) => part.trim().length > 0);
    if (ports.length !== rawParts.length) {
      setError(t('admin.portInvalid'));
      return;
    }
    if (Object.values(draft.scheduleTimePresets).some((value) => !parseClock(value))) {
      setError(t('admin.scheduleTimeInvalid'));
      return;
    }
    const payload: SystemSettings = {
      ...draft,
      browserAllowedPorts: ports,
      defaultModel: draft.defaultModel?.trim() || undefined,
      smtpFrom: draft.smtpFrom?.trim() || undefined,
      publicBaseUrl: draft.publicBaseUrl?.trim() || undefined,
    };
    save.mutate(payload);
  };

  if (metrics.isLoading || settings.isLoading) return <Spinner label={t('common.loadingPage')} />;
  if (metrics.isError || settings.isError || !metrics.data) {
    return <ErrorAlert message={t('errors.loadFailed')} />;
  }

  const statusEntries = Object.entries(metrics.data.byStatus) as Array<[string, number]>;
  const zones = timezonesWith(draft.defaultTimezone);

  return (
    <>
      <PageHeader title={t('admin.title')} subtitle={t('admin.subtitle')} />
      <AdminTabs />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: t('admin.usersCount'), value: metrics.data.users, accent: 'text-primary' },
          { label: t('admin.tasksCount'), value: metrics.data.tasks, accent: 'text-info' },
          { label: t('admin.executions24h'), value: metrics.data.executionsLast24h, accent: 'text-success' },
          { label: t('admin.activeExecutions'), value: metrics.data.active, accent: 'text-warning' },
        ].map((metric) => (
          <div key={metric.label} className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-1 p-4 sm:p-5">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-60">{metric.label}</p>
              <p className={`text-3xl font-black tabular-nums ${metric.accent}`}>
                {formatNumber(metric.value, i18n.language)}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <section className="card border border-base-300 bg-base-100 shadow-sm xl:col-span-2">
          <div className="card-body gap-4 p-5">
            <div>
              <h2 className="card-title text-base">{t('admin.settingsTitle')}</h2>
              <p className="text-xs opacity-60">{t('admin.settingsHint')}</p>
            </div>
            {error ? <ErrorAlert message={error} /> : null}
            {saved ? <SuccessAlert message={t('admin.settingsSaved')} /> : null}

            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('admin.defaultTimezone')} htmlFor="admin-timezone">
                  <select
                    id="admin-timezone"
                    className="select w-full"
                    value={draft.defaultTimezone}
                    onChange={(event) => update('defaultTimezone', event.target.value)}
                  >
                    {zones.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('admin.defaultModel')} htmlFor="admin-default-model">
                  <input
                    id="admin-default-model"
                    className="input w-full"
                    value={draft.defaultModel ?? ''}
                    onChange={(event) => update('defaultModel', event.target.value)}
                  />
                </Field>
                <Field label={t('admin.maxConcurrent')} htmlFor="admin-concurrent">
                  <input
                    id="admin-concurrent"
                    type="number"
                    min={1}
                    max={10}
                    className="input w-full"
                    value={draft.maxConcurrentExecutionsPerUser}
                    onChange={(event) => update('maxConcurrentExecutionsPerUser', Number(event.target.value))}
                  />
                </Field>
                <Field label={t('admin.maxPerDay')} htmlFor="admin-per-day">
                  <input
                    id="admin-per-day"
                    type="number"
                    min={1}
                    max={500}
                    className="input w-full"
                    value={draft.maxTaskExecutionsPerDay}
                    onChange={(event) => update('maxTaskExecutionsPerDay', Number(event.target.value))}
                  />
                </Field>
                <Field label={t('admin.searchProvider')} htmlFor="admin-search-provider">
                  <select
                    id="admin-search-provider"
                    className="select w-full"
                    value={draft.searchProvider}
                    onChange={(event) => update('searchProvider', event.target.value as SystemSettings['searchProvider'])}
                  >
                    <option value="searxng">SearXNG</option>
                    <option value="none">{t('common.none')}</option>
                  </select>
                </Field>
                <Field label={t('admin.searchBaseUrl')} htmlFor="admin-search-url">
                  <input
                    id="admin-search-url"
                    type="url"
                    className="input w-full"
                    value={draft.searchBaseUrl}
                    onChange={(event) => update('searchBaseUrl', event.target.value)}
                  />
                </Field>
                <Field label={t('admin.smtpFrom')} htmlFor="admin-smtp">
                  <input
                    id="admin-smtp"
                    type="email"
                    className="input w-full"
                    value={draft.smtpFrom ?? ''}
                    onChange={(event) => update('smtpFrom', event.target.value)}
                  />
                </Field>
                <Field label={t('admin.publicBaseUrl')} htmlFor="admin-public-url">
                  <input
                    id="admin-public-url"
                    type="url"
                    className="input w-full"
                    value={draft.publicBaseUrl ?? ''}
                    onChange={(event) => update('publicBaseUrl', event.target.value)}
                  />
                </Field>
                <Field
                  label={t('admin.browserAllowedPorts')}
                  htmlFor="admin-ports"
                  hint={t('admin.portsHint')}
                >
                  <input
                    id="admin-ports"
                    className="input w-full"
                    value={portsText}
                    onChange={(event) => setPortsText(event.target.value)}
                  />
                </Field>
              </div>

              <fieldset className="rounded-lg border border-base-300 p-3">
                <legend className="px-1 text-sm font-medium">{t('admin.schedulePresetsTitle')}</legend>
                <p className="mb-2 text-xs opacity-60">{t('admin.schedulePresetsHint')}</p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {(
                    [
                      ['morning', 'presetMorning'],
                      ['afternoon', 'presetAfternoon'],
                      ['evening', 'presetEvening'],
                      ['night', 'presetNight'],
                    ] as const
                  ).map(([key, labelKey]) => (
                    <Field key={key} label={t(`admin.${labelKey}`)} htmlFor={`admin-preset-${key}`}>
                      <input
                        id={`admin-preset-${key}`}
                        type="time"
                        className="input w-full"
                        value={draft.scheduleTimePresets[key]}
                        onChange={(event) =>
                          update('scheduleTimePresets', {
                            ...draft.scheduleTimePresets,
                            [key]: event.target.value,
                          })
                        }
                      />
                    </Field>
                  ))}
                </div>
              </fieldset>

              <div className="flex flex-wrap gap-6">
                <label className="flex cursor-pointer items-center gap-2 text-sm" htmlFor="admin-registration">
                  <input
                    id="admin-registration"
                    type="checkbox"
                    className="toggle toggle-sm"
                    checked={draft.allowRegistration}
                    onChange={(event) => update('allowRegistration', event.target.checked)}
                  />
                  {t('admin.allowRegistration')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm" htmlFor="admin-http">
                  <input
                    id="admin-http"
                    type="checkbox"
                    className="toggle toggle-sm"
                    checked={draft.browserAllowHttp}
                    onChange={(event) => update('browserAllowHttp', event.target.checked)}
                  />
                  {t('admin.browserAllowHttp')}
                </label>
              </div>

              <div className="flex justify-end">
                <button type="submit" className="btn btn-primary btn-sm" disabled={save.isPending}>
                  {save.isPending ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
                  {t('admin.saveSettings')}
                </button>
              </div>
            </form>
          </div>
        </section>

        <section className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body p-5">
            <h2 className="card-title text-base">{t('admin.byStatus')}</h2>
            {statusEntries.length === 0 ? (
              <p className="text-sm opacity-60">{t('common.noData')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {statusEntries.map(([status, count]) => (
                  <li key={status} className="flex items-center justify-between gap-2 rounded-lg bg-base-200 px-3 py-2 text-sm">
                    <span>{t(`status.${status}`, { defaultValue: status })}</span>
                    <span className="font-bold tabular-nums">{formatNumber(count, i18n.language)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
