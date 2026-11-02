import type {
  ExecutionStatus,
  Limits,
  MemoryCategory,
  MemoryLearningMode,
  MemoryScope,
  MemorySettings,
  RecommendationStatus,
  Role,
  ScheduleTimePresets,
} from '@agent-tasks/shared';

export type {
  ExecutionStatus,
  Limits,
  MemoryCategory,
  MemoryLearningMode,
  MemoryScope,
  MemorySettings,
  RecommendationStatus,
  Role,
  ScheduleTimePresets,
};

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
  daysOfMonth?: number[];
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
  allowWebResearch: boolean;
  notification: Notification;
  memorySettings: MemorySettings;
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
  allowWebResearch: boolean;
  notification: Notification;
  memorySettings: MemorySettings;
}

export interface Memory {
  id: string;
  ownerId: string;
  taskId: string | null;
  scope: MemoryScope;
  category: MemoryCategory;
  content: string;
  semanticKey: string | null;
  origin: 'user' | 'slash_command' | 'agent' | 'system';
  originRef: string | null;
  provenance: Record<string, unknown>;
  revision: number;
  userEdited: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryChange {
  id: string;
  ownerId: string;
  taskId: string | null;
  memoryId: string | null;
  executionId: string | null;
  suggestionId: string | null;
  action: string;
  scope: MemoryScope;
  beforeContent: string | null;
  afterContent: string | null;
  summary: string | null;
  createdAt: string;
}

export interface MemorySuggestion {
  id: string;
  ownerId: string;
  taskId: string;
  executionId: string | null;
  targetMemoryId: string | null;
  operation: string;
  category: MemoryCategory;
  content: string;
  semanticKey: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  reason: string | null;
  provenance: Record<string, unknown>;
  createdAt: string;
  reviewedAt: string | null;
}

export interface Recommendation {
  id: string;
  ownerId: string;
  taskId: string;
  semanticKey: string;
  title: string;
  description: string;
  sourceUrl: string | null;
  status: RecommendationStatus;
  metadata: Record<string, unknown>;
  firstObservedAt: string;
  lastObservedAt: string;
  lastChangedAt: string;
  statusChangedAt: string;
  firstExecutionId: string | null;
  lastExecutionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecommendationEvent {
  id: string;
  recommendationId: string;
  executionId: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  changes: Record<string, unknown>;
  createdAt: string;
  title: string;
  semanticKey: string;
  taskId: string;
}

export interface MemoryCommandResult {
  kind: string;
  message?: string;
  memory?: Memory;
  scope?: MemoryScope | 'all' | null;
  memories?: Memory[];
  global?: Memory[];
  task?: Memory[];
  total?: number;
  globalTotal?: number;
  taskTotal?: number;
  taskId?: string | null;
  candidates?: Array<{
    id: string;
    scope: MemoryScope;
    taskId: string | null;
    category: MemoryCategory;
    content: string;
    semanticKey: string | null;
    score?: number;
    reason?: string;
    updatedAt: string;
  }>;
  id?: string;
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
  scheduleTimePresets: ScheduleTimePresets;
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
  agentLimits: Limits;
  browserAllowHttp: boolean;
  browserAllowedPorts: number[];
  searchProvider: 'searxng' | 'none';
  searchBaseUrl: string;
  smtpFrom?: string;
  publicBaseUrl?: string;
  scheduleTimePresets: ScheduleTimePresets;
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
