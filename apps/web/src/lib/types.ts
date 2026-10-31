import type { ExecutionStatus, Limits, Role } from '@agent-tasks/shared';

export type { ExecutionStatus, Limits, Role };

export type SchedulePreset = 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';
export type Locale = 'en' | 'de';
export type ThemePreference = 'system' | 'light' | 'dark';
export type Notification = 'none' | 'email';

export interface TaskSchedule {
  preset: SchedulePreset;
  timezone: string;
  runAt?: string;
  hour: number;
  minute: number;
  weekdays?: number[];
  dayOfMonth?: number;
  cron?: string;
}

export interface Task {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  prompt: string;
  systemInstructions: string | null;
  providerId: string;
  model: string;
  enabled: boolean;
  schedule: TaskSchedule;
  timezone: string;
  limits: Limits;
  allowWebResearch: boolean;
  notification: Notification;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  scheduleDescription?: string;
}

export interface TaskInput {
  title: string;
  description?: string;
  prompt: string;
  systemInstructions?: string;
  providerId: string;
  model: string;
  enabled: boolean;
  schedule: TaskSchedule;
  limits: Limits;
  allowWebResearch: boolean;
  notification: Notification;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** Present on Better Auth session responses; `/api/me` omits it. */
  twoFactorEnabled?: boolean;
}

export interface Preferences {
  timezone: string;
  locale: Locale;
  theme: ThemePreference;
}

export interface Me {
  user: SessionUser & { emailVerified?: boolean };
  preferences: Preferences;
  limits: { maxConcurrentExecutionsPerUser: number; maxTaskExecutionsPerDay: number };
}

export interface AppConfig {
  appName: string;
  allowRegistration: boolean;
  defaultTimezone: string;
  mailer: string;
  version: string;
}

export interface ProviderModel {
  id: string;
  label: string;
  supportsTools: boolean;
  contextLength: number | null;
}

export interface Provider {
  id: string;
  name: string;
  kind: string;
  isDefault: boolean;
  baseUrl?: string;
  hasCredential: boolean;
  hasPersonalCredential: boolean;
  models: ProviderModel[];
}

export interface DashboardTask {
  id: string;
  title: string;
  enabled: boolean;
  nextRunAt: string | null;
  schedule: TaskSchedule;
}

export interface ExecutionSummary {
  id: string;
  taskId: string;
  taskTitle: string;
  status: ExecutionStatus;
  trigger: 'schedule' | 'manual' | 'retry';
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  scheduledFor?: string | null;
}

export interface Dashboard {
  activeTasks: DashboardTask[];
  pausedTasks: DashboardTask[];
  recentExecutions: ExecutionSummary[];
  failures: ExecutionSummary[];
}

export interface ExecutionSource {
  url: string;
  title?: string;
  retrievedAt: string;
  confidence: 'verified' | 'secondary' | 'inference' | 'unknown';
  excerpt?: string;
}

export interface ExecutionReport {
  summary: string;
  markdown: string;
  sources: ExecutionSource[];
  uncertainty: string[];
}

export interface ExecutionStep {
  id: string;
  executionId: string;
  step: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  resultPreview: string | null;
}

export interface Execution extends Omit<ExecutionSummary, 'status'> {
  status: ExecutionStatus;
  ownerId: string;
  providerId: string | null;
  model: string | null;
  report: ExecutionReport | null;
  toolCalls: Array<Record<string, unknown>>;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    allowanceUsd?: number;
  } | null;
  steps: ExecutionStep[];
  attempt?: number;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  banned: boolean;
  emailVerified: boolean;
  createdAt: string;
  twoFactorEnabled?: boolean;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface InvitationPreview {
  email: string;
  role: Role;
  expiresAt: string;
}

export interface Metrics {
  users: number;
  tasks: number;
  executionsLast24h: number;
  active: number;
  byStatus: Partial<Record<ExecutionStatus, number>>;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface SystemSettings {
  allowRegistration: boolean;
  defaultTimezone: string;
  defaultModel?: string;
  maxConcurrentExecutionsPerUser: number;
  maxTaskExecutionsPerDay: number;
  browserAllowHttp: boolean;
  browserAllowedPorts: number[];
  searchProvider: 'searxng' | 'none';
  searchBaseUrl: string;
  smtpFrom?: string;
  publicBaseUrl?: string;
}

export interface AdminProvider {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  isDefault: boolean;
  config: Record<string, unknown>;
  sharedCredential: boolean;
  personalCredentials: number;
}

export interface ProviderHealth {
  ok: boolean;
  models?: string[];
  latencyMs?: number;
  message?: string;
  [key: string]: unknown;
}
