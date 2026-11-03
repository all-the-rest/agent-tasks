import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useForm } from 'react-hook-form';
import type { FieldPath } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/ui';
import { ErrorAlert, Field, PageHeader, Spinner } from '../components/ui';
import {
  defaultSchedule,
  fromDateTimeLocal,
  monthlyDays,
  scheduleToCron,
  timeOfDayOptions,
  timeOfDayPreset,
  timezonesWith,
  toDateTimeLocal,
  WEEKDAYS,
} from '../lib/schedule';
import type { TimePreset } from '../lib/schedule';
import { describeSchedule } from '../lib/describe';
import { preferredModelId } from '../lib/provider-config';
import {
  clearTaskPromptDraft,
  isTaskPromptDraftState,
  rememberTaskPromptDraft,
  taskPromptDraftFromState,
  taskPromptDraftState,
} from '../lib/task-prompt-draft';
import { taskFormSchema, toTaskInput } from '../lib/task-schema';
import type { TaskFormValues } from '../lib/task-schema';
import type { Task } from '../lib/types';

const DEFAULT_MEMORY_SETTINGS = { mode: 'auto' as const, contextBytes: 12_000 };

function emptyValues(timezone: string, prompt = ''): TaskFormValues {
  return {
    title: '',
    description: '',
    prompt,
    systemInstructions: '',
    providerId: '',
    model: '',
    enabled: true,
    schedule: { ...defaultSchedule(timezone), timePreset: 'morning' },
    endCondition: { type: 'never', date: '', runs: 1 },
    allowWebResearch: true,
    notification: 'none',
    memorySettings: { ...DEFAULT_MEMORY_SETTINGS },
  };
}

function taskValues(task: Task, fallbackTimezone: string): TaskFormValues {
  return {
    title: task.title,
    description: task.description ?? '',
    prompt: task.prompt,
    systemInstructions: task.systemInstructions ?? '',
    providerId: task.providerId,
    model: task.model,
    enabled: task.enabled,
    schedule: {
      preset: task.schedule.preset,
      timezone: task.schedule.timezone || fallbackTimezone,
      runAt: task.schedule.runAt,
      hour: task.schedule.hour ?? 9,
      minute: task.schedule.minute ?? 0,
      weekdays: task.schedule.weekdays ?? [1],
      dayOfMonth: task.schedule.dayOfMonth ?? 1,
      daysOfMonth: task.schedule.daysOfMonth?.length
        ? task.schedule.daysOfMonth
        : task.schedule.dayOfMonth
          ? [task.schedule.dayOfMonth]
          : [1],
      cron: task.schedule.cron ?? '',
    },
    endCondition: {
      type: task.endCondition.type,
      date: task.endCondition.type === 'on_date' ? task.endCondition.date : '',
      runs: task.endCondition.type === 'after_runs' ? task.endCondition.runs : 1,
    },
    allowWebResearch: task.allowWebResearch,
    notification: task.notification,
    memorySettings: { ...DEFAULT_MEMORY_SETTINGS, ...(task.memorySettings ?? {}) },
  };
}

export function TaskFormPage() {
  const { user } = useAuth();
  const ownerId = user?.id ?? null;
  return <TaskFormPageForOwner key={ownerId ?? 'signed-out'} ownerId={ownerId} />;
}

function TaskFormPageForOwner({ ownerId }: { ownerId: string | null }) {
  const { t } = useTranslation();
  const { id } = useParams();
  const location = useLocation();
  const editing = Boolean(id);
  const promptDraft = ownerId ? taskPromptDraftFromState(location.state, ownerId) : '';
  const promptFirst = Boolean(!editing && ownerId && isTaskPromptDraftState(location.state, ownerId));
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers.list });
  const config = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 60_000 });
  const task = useQuery({
    queryKey: ['task', id],
    queryFn: () => api.tasks.get(id as string),
    enabled: editing,
  });

  const fallbackTimezone = me.data?.preferences.timezone ?? 'UTC';
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    setError,
    clearErrors,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<TaskFormValues>({ defaultValues: emptyValues(fallbackTimezone, promptDraft) });

  const [formError, setFormError] = useState<string | null>(null);
  const initialised = useRef(false);

  useLayoutEffect(() => {
    // A reload drops module memory; restore it from this owner's history entry
    // before a browser Back can mount the task list.
    if (promptFirst && ownerId) rememberTaskPromptDraft(ownerId, promptDraft);
  }, [ownerId, promptDraft, promptFirst]);

  useEffect(() => {
    if (initialised.current) return;
    // Never overwrite what the user already typed while /api/me was still loading.
    if (isDirty) {
      initialised.current = true;
      return;
    }
    if (editing) {
      if (task.data) {
        reset(taskValues(task.data, fallbackTimezone));
        initialised.current = true;
      }
    } else if (me.data) {
      reset(emptyValues(me.data.preferences.timezone, promptDraft));
      initialised.current = true;
    }
  }, [editing, task.data, me.data, fallbackTimezone, isDirty, reset, promptDraft]);

  const providerId = watch('providerId');
  const formPrompt = watch('prompt');
  const schedule = watch('schedule');
  const endConditionType = watch('endCondition.type');
  const preset = schedule?.preset ?? 'daily';
  const weekdays = schedule?.weekdays ?? [];
  const daysOfMonth = monthlyDays({
    daysOfMonth: schedule?.daysOfMonth,
    dayOfMonth: schedule?.dayOfMonth,
  });
  const timeOptions = timeOfDayOptions(config.data?.scheduleTimePresets);
  const timePreset =
    schedule?.timePreset ??
    timeOfDayPreset(schedule?.hour ?? 9, schedule?.minute ?? 0, config.data?.scheduleTimePresets);
  const selectedProvider = providers.data?.find((provider) => provider.id === providerId);

  useEffect(() => {
    // New tasks start on a preset; align the stored clock with the configured time.
    if (editing || !config.data || !schedule || timePreset === 'custom') return;
    const option = timeOfDayOptions(config.data.scheduleTimePresets).find((item) => item.id === timePreset);
    if (!option) return;
    if (schedule.hour !== option.hour || schedule.minute !== option.minute) {
      setValue('schedule.hour', option.hour, { shouldValidate: true });
      setValue('schedule.minute', option.minute, { shouldValidate: true });
    }
  }, [editing, config.data, schedule, timePreset, setValue]);

  useEffect(() => {
    if (providerId || !providers.data?.length) return;
    const preferred = providers.data.find((provider) => provider.isDefault) ?? providers.data[0];
    if (!preferred) return;
    setValue('providerId', preferred.id, { shouldValidate: true });
    setValue('model', preferredModelId(preferred), { shouldValidate: true });
  }, [providerId, providers.data, setValue]);

  const save = useMutation({
    mutationFn: (values: TaskFormValues) => {
      const payload = toTaskInput(values);
      return editing ? api.tasks.update(id as string, payload) : api.tasks.create(payload);
    },
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['task', saved.id] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      showToast(editing ? t('tasks.saved') : t('tasks.createdMsg'));
      if (promptFirst) {
        if (ownerId) clearTaskPromptDraft(ownerId);
        navigate(`/tasks/${saved.id}`, { replace: true });
      } else {
        navigate(`/tasks/${saved.id}`);
      }
    },
    onError: (cause) => setFormError(errorMessage(cause)),
  });

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    clearErrors();
    const parsed = taskFormSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.');
        const message = issue.message.startsWith('validation.') ? issue.message : 'validation.range';
        setError(path as FieldPath<TaskFormValues>, { type: 'validation', message });
      }
      setFormError(t('tasks.formInvalid'));
      return;
    }
    save.mutate(parsed.data);
  });

  const tr = (message?: string) =>
    message ? t(message.startsWith('validation.') ? message : 'validation.range') : undefined;

  if (editing && task.isLoading) return <Spinner label={t('common.loadingPage')} />;
  if (editing && (task.isError || !task.data)) {
    return <ErrorAlert message={t('errors.notFound')} />;
  }

  const zones = timezonesWith(schedule?.timezone ?? fallbackTimezone);
  const controlledRunAt = toDateTimeLocal(schedule?.runAt);
  const preview = schedule
    ? describeSchedule(
        {
          preset,
          timezone: schedule.timezone,
          hour: schedule.hour,
          minute: schedule.minute,
          weekdays,
          dayOfMonth: schedule.dayOfMonth,
          daysOfMonth: schedule.daysOfMonth,
          cron: schedule.cron,
          runAt: schedule.runAt,
        },
        t,
      )
    : '';

  const toggleWeekday = (day: number) => {
    const next = weekdays.includes(day) ? weekdays.filter((value) => value !== day) : [...weekdays, day];
    setValue('schedule.weekdays', next.sort(), { shouldValidate: true });
  };

  const toggleDayOfMonth = (day: number) => {
    const next = daysOfMonth.includes(day)
      ? daysOfMonth.filter((value) => value !== day)
      : [...daysOfMonth, day];
    setValue('schedule.daysOfMonth', next.sort((a, b) => a - b), { shouldValidate: true });
  };

  const changeTimeOfDay = (value: TimePreset) => {
    setValue('schedule.timePreset', value, { shouldValidate: true });
    if (value === 'custom') return;
    const presetTime = timeOptions.find((item) => item.id === value);
    if (!presetTime) return;
    setValue('schedule.hour', presetTime.hour, { shouldValidate: true });
    setValue('schedule.minute', presetTime.minute, { shouldValidate: true });
  };

  const localTimezone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return '';
    }
  })();

  return (
    <>
      <PageHeader
        title={editing ? t('tasks.editTask') : t('tasks.newTask')}
        subtitle={t('tasks.subtitle')}
        actions={
          <Link
            className="btn btn-ghost btn-sm"
            to={editing && id ? `/tasks/${id}` : '/tasks'}
            state={promptFirst && ownerId ? taskPromptDraftState(ownerId, formPrompt ?? promptDraft) : undefined}
            replace={promptFirst}
          >
            {promptFirst ? t('tasks.backToPrompt') : t('common.cancel')}
          </Link>
        }
      />

      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        {formError ? <ErrorAlert message={formError} /> : null}
        {promptFirst ? <p className="rounded-lg bg-info/10 px-4 py-3 text-sm">{t('tasks.promptDraftReview')}</p> : null}

        <section className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-3 p-5">
            <h2 className="card-title text-base">{t('tasks.basicSection')}</h2>
            <Field label={t('tasks.titleLabel')} htmlFor="task-title" error={tr(errors.title?.message)} required>
              <input
                id="task-title"
                className="input w-full"
                placeholder={t('tasks.titlePlaceholder')}
                aria-invalid={Boolean(errors.title)}
                {...register('title')}
              />
            </Field>
            <Field label={t('tasks.description')} htmlFor="task-description" error={tr(errors.description?.message)}>
              <textarea id="task-description" className="textarea w-full" rows={2} {...register('description')} />
            </Field>
            <Field
              label={t('tasks.prompt')}
              htmlFor="task-prompt"
              hint={t('tasks.promptHelp')}
              error={tr(errors.prompt?.message)}
              required
            >
              <textarea
                id="task-prompt"
                className="textarea w-full"
                rows={5}
                maxLength={20_000}
                aria-invalid={Boolean(errors.prompt)}
                {...register('prompt', {
                  onChange: (event) => {
                    if (!promptFirst || !ownerId) return;
                    const nextPrompt = event.target.value;
                    rememberTaskPromptDraft(ownerId, nextPrompt);
                    navigate(`${location.pathname}${location.search}${location.hash}`, {
                      replace: true,
                      state: taskPromptDraftState(ownerId, nextPrompt),
                    });
                  },
                })}
              />
            </Field>
            <Field
              label={t('tasks.systemInstructions')}
              htmlFor="task-system"
              hint={t('tasks.systemHelp')}
              error={tr(errors.systemInstructions?.message)}
            >
              <textarea id="task-system" className="textarea w-full" rows={3} {...register('systemInstructions')} />
            </Field>
          </div>
        </section>

        <section className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-3 p-5">
            <h2 className="card-title text-base">{t('tasks.scheduleSection')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('tasks.preset')} htmlFor="task-preset" error={tr(errors.schedule?.preset?.message)}>
                <select id="task-preset" className="select w-full" {...register('schedule.preset')}>
                  {(['once', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'] as const).map((option) => (
                    <option key={option} value={option}>
                      {t(`tasks.preset${option.charAt(0).toUpperCase()}${option.slice(1)}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('tasks.timezone')} htmlFor="task-timezone" error={tr(errors.schedule?.timezone?.message)}>
                <select id="task-timezone" className="select w-full" {...register('schedule.timezone')}>
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs opacity-70">
              <span>{t('tasks.timezoneEffective', { timezone: schedule?.timezone ?? fallbackTimezone })}</span>
              {localTimezone && localTimezone !== (schedule?.timezone ?? fallbackTimezone) ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => setValue('schedule.timezone', localTimezone, { shouldValidate: true })}
                >
                  {t('tasks.useLocalTimezone', { timezone: localTimezone })}
                </button>
              ) : null}
            </div>

            {preset === 'once' ? (
              <Field
                label={t('tasks.runAt')}
                htmlFor="task-run-at"
                error={tr(errors.schedule?.runAt?.message)}
                required
              >
                <input
                  id="task-run-at"
                  type="datetime-local"
                  className="input w-full"
                  value={controlledRunAt}
                  aria-invalid={Boolean(errors.schedule?.runAt)}
                  onChange={(event) =>
                    setValue('schedule.runAt', fromDateTimeLocal(event.target.value), {
                      shouldValidate: true,
                    })
                  }
                />
              </Field>
            ) : null}

            {preset !== 'once' && preset !== 'custom' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('tasks.timeOfDay')} htmlFor="task-time-of-day">
                  <select
                    id="task-time-of-day"
                    className="select w-full"
                    value={timePreset}
                    onChange={(event) => changeTimeOfDay(event.target.value as TimePreset)}
                  >
                    {timeOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {t(`tasks.timeOfDay${option.id.charAt(0).toUpperCase()}${option.id.slice(1)}`, {
                          time: option.clock,
                        })}
                      </option>
                    ))}
                    <option value="custom">{t('tasks.timeOfDayCustom')}</option>
                  </select>
                </Field>
                {timePreset === 'custom' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('tasks.hour')} htmlFor="task-hour" error={tr(errors.schedule?.hour?.message)}>
                      <input
                        id="task-hour"
                        type="number"
                        min={0}
                        max={23}
                        className="input w-full"
                        {...register('schedule.hour', { valueAsNumber: true })}
                      />
                    </Field>
                    <Field label={t('tasks.minute')} htmlFor="task-minute" error={tr(errors.schedule?.minute?.message)}>
                      <input
                        id="task-minute"
                        type="number"
                        min={0}
                        max={59}
                        className="input w-full"
                        {...register('schedule.minute', { valueAsNumber: true })}
                      />
                    </Field>
                  </div>
                ) : (
                  <Field label={t('tasks.time')} htmlFor="task-time-preview">
                    <input
                      id="task-time-preview"
                      className="input w-full"
                      value={`${String(schedule?.hour ?? 9).padStart(2, '0')}:${String(schedule?.minute ?? 0).padStart(2, '0')}`}
                      readOnly
                    />
                  </Field>
                )}
              </div>
            ) : null}

            {preset === 'weekdays' || preset === 'weekly' ? (
              <fieldset>
                <legend className="mb-2 text-sm font-medium">{t('tasks.weekdays')}</legend>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((day) => (
                    <label
                      key={day}
                      className={`btn btn-sm ${weekdays.includes(day) ? 'btn-primary' : 'btn-outline'}`}
                      htmlFor={`weekday-${day}`}
                    >
                      <input
                        id={`weekday-${day}`}
                        type="checkbox"
                        className="sr-only"
                        checked={weekdays.includes(day)}
                        onChange={() => toggleWeekday(day)}
                      />
                      {t(`weekdays.short.${day}`)}
                    </label>
                  ))}
                </div>
                {errors.schedule?.weekdays?.message ? (
                  <p className="mt-1 text-sm text-error" role="alert">
                    {tr(errors.schedule.weekdays.message)}
                  </p>
                ) : null}
              </fieldset>
            ) : null}

            {preset === 'monthly' ? (
              <fieldset>
                <legend className="mb-2 text-sm font-medium">{t('tasks.daysOfMonth')}</legend>
                <div className="flex flex-wrap gap-1.5">
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                    <label
                      key={day}
                      className={`btn btn-xs min-w-9 ${daysOfMonth.includes(day) ? 'btn-primary' : 'btn-outline'}`}
                      htmlFor={`day-of-month-${day}`}
                    >
                      <input
                        id={`day-of-month-${day}`}
                        type="checkbox"
                        className="sr-only"
                        checked={daysOfMonth.includes(day)}
                        onChange={() => toggleDayOfMonth(day)}
                      />
                      {day}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs opacity-60">{t('tasks.daysOfMonthHelp')}</p>
                {errors.schedule?.daysOfMonth?.message ? (
                  <p className="mt-1 text-sm text-error" role="alert">
                    {tr(errors.schedule.daysOfMonth.message)}
                  </p>
                ) : null}
              </fieldset>
            ) : null}

            {preset === 'custom' ? (
              <Field
                label={t('tasks.cron')}
                htmlFor="task-cron"
                hint={t('tasks.cronHelp')}
                error={tr(errors.schedule?.cron?.message)}
                required
              >
                <input
                  id="task-cron"
                  className="input w-full font-mono"
                  placeholder="0 9 * * 1-5"
                  aria-invalid={Boolean(errors.schedule?.cron)}
                  {...register('schedule.cron')}
                />
              </Field>
            ) : null}

            <div className="rounded-lg bg-base-200 px-3 py-2 text-xs">
              <span className="opacity-60">{t('tasks.schedule')}: </span>
              <span className="font-medium">{preview}</span>
              {preset === 'custom' ? (
                <span className="ml-2 font-mono opacity-50">{scheduleToCron({
                  preset,
                  timezone: schedule?.timezone ?? fallbackTimezone,
                  hour: schedule?.hour ?? 9,
                  minute: schedule?.minute ?? 0,
                  cron: schedule?.cron,
                })}</span>
              ) : null}
            </div>

            <Field label={t('tasks.endCondition')} htmlFor="task-end-condition">
              <select id="task-end-condition" className="select w-full" {...register('endCondition.type')}>
                <option value="never">{t('tasks.endNever')}</option>
                <option value="on_date">{t('tasks.endOnDate')}</option>
                <option value="after_runs">{t('tasks.endAfterRuns')}</option>
              </select>
            </Field>
            {endConditionType === 'on_date' ? (
              <Field
                label={t('tasks.endDate')}
                htmlFor="task-end-date"
                error={tr(errors.endCondition?.date?.message)}
                required
              >
                <input
                  id="task-end-date"
                  type="date"
                  className="input w-full"
                  aria-invalid={Boolean(errors.endCondition?.date)}
                  {...register('endCondition.date')}
                />
              </Field>
            ) : null}
            {endConditionType === 'after_runs' ? (
              <Field
                label={t('tasks.endRuns')}
                htmlFor="task-end-runs"
                error={tr(errors.endCondition?.runs?.message)}
                required
              >
                <input
                  id="task-end-runs"
                  type="number"
                  min={1}
                  max={2_147_483_647}
                  className="input w-full"
                  aria-invalid={Boolean(errors.endCondition?.runs)}
                  {...register('endCondition.runs', { valueAsNumber: true })}
                />
              </Field>
            ) : null}
          </div>
        </section>

        <section className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-3 p-5">
            <h2 className="card-title text-base">{t('tasks.advancedSection')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={t('tasks.provider')}
                htmlFor="task-provider"
                error={tr(errors.providerId?.message)}
                required
              >
                <select
                  id="task-provider"
                  className="select w-full"
                  value={providerId}
                  onChange={(event) => {
                    const next = providers.data?.find((provider) => provider.id === event.target.value);
                    setValue('providerId', event.target.value, { shouldValidate: true });
                    setValue('model', next ? preferredModelId(next) : '', { shouldValidate: true });
                  }}
                >
                  <option value="">{t('tasks.selectProvider')}</option>
                  {(providers.data ?? []).map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('tasks.model')} htmlFor="task-model" error={tr(errors.model?.message)} required>
                <select
                  id="task-model"
                  className="select w-full"
                  disabled={!selectedProvider || selectedProvider.models.length === 0}
                  value={watch('model')}
                  onChange={(event) => setValue('model', event.target.value, { shouldValidate: true })}
                >
                  <option value="">{t('tasks.selectModel')}</option>
                  {(selectedProvider?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {providers.data && providers.data.length === 0 ? (
              <div className="alert alert-warning py-2" role="status">
                <span className="text-sm">{t('tasks.noProviders')}</span>
              </div>
            ) : null}
            {selectedProvider && selectedProvider.models.length === 0 ? (
              <div className="alert alert-warning py-2" role="status">
                <span className="text-sm">{t('tasks.noModels')}</span>
              </div>
            ) : null}
            {selectedProvider && selectedProvider.kind !== 'ollama' && !selectedProvider.hasCredential ? (
              <div className="alert alert-warning py-2" role="status">
                <span className="text-sm">{t('tasks.providerCredentialHint')}</span>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('memory.learningMode')} htmlFor="task-memory-mode" hint={t('memory.learningModeHelp')}>
                <select id="task-memory-mode" className="select w-full" {...register('memorySettings.mode')}>
                  <option value="auto">{t('memory.modeAuto')}</option>
                  <option value="suggest">{t('memory.modeSuggest')}</option>
                  <option value="off">{t('memory.modeOff')}</option>
                </select>
              </Field>
              <Field label={t('memory.contextBudget')} htmlFor="task-memory-budget" hint={t('memory.contextBudgetHelp')}>
                <input
                  id="task-memory-budget"
                  type="number"
                  min={1000}
                  max={100000}
                  step={1000}
                  className="input w-full"
                  {...register('memorySettings.contextBytes', { valueAsNumber: true })}
                />
              </Field>
              <Field label={t('tasks.notification')} htmlFor="task-notification">
                <select id="task-notification" className="select w-full" {...register('notification')}>
                  <option value="none">{t('tasks.notificationNone')}</option>
                  <option value="email">{t('tasks.notificationEmail')}</option>
                </select>
              </Field>
              <div className="flex flex-col gap-2 pt-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm" htmlFor="task-enabled">
                  <input id="task-enabled" type="checkbox" className="toggle toggle-sm" {...register('enabled')} />
                  <span>{t('tasks.enabled')}</span>
                </label>
                <p className="text-xs opacity-60">{t('tasks.enabledHelp')}</p>
                <label className="flex cursor-pointer items-center gap-2 text-sm" htmlFor="task-web">
                  <input id="task-web" type="checkbox" className="toggle toggle-sm" {...register('allowWebResearch')} />
                  <span>{t('tasks.allowWebResearch')}</span>
                </label>
              </div>
            </div>
          </div>
        </section>

        <div className="flex flex-wrap justify-end gap-2">
          <Link
            className="btn btn-ghost"
            to={editing && id ? `/tasks/${id}` : '/tasks'}
            state={promptFirst && ownerId ? taskPromptDraftState(ownerId, formPrompt ?? promptDraft) : undefined}
            replace={promptFirst}
          >
            {promptFirst ? t('tasks.backToPrompt') : t('common.cancel')}
          </Link>
          <button type="submit" className="btn btn-primary" disabled={isSubmitting || save.isPending}>
            {save.isPending ? <span className="loading loading-spinner loading-sm" aria-hidden="true" /> : null}
            {save.isPending ? t('common.saving') : promptFirst ? t('tasks.confirmCreate') : t('tasks.save')}
          </button>
        </div>
      </form>
    </>
  );
}
