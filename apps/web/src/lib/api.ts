import type {
  AdminProvider,
  AdminUser,
  AppConfig,
  AuditEntry,
  Dashboard,
  Execution,
  ExecutionSummary,
  Invitation,
  InvitationPreview,
  Me,
  Memory,
  MemoryChange,
  MemoryCommandResult,
  MemorySuggestion,
  Metrics,
  Preferences,
  Recommendation,
  RecommendationEvent,
  Provider,
  ProviderHealth,
  SessionUser,
  SystemSettings,
  Task,
  TaskInput,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

/**
 * Raw response of Better Auth's `POST /api/auth/sign-in/email`.
 *
 * The endpoint's own type (`better-auth/dist/api/routes/sign-in.d.mts`) only
 * declares `{ redirect, token, user }`. When the account has TOTP enabled, the
 * two-factor plugin's `after` hook (`better-auth/dist/plugins/two-factor/index.d.mts`,
 * response `{ twoFactorRedirect: boolean; twoFactorMethods: string[] }`) adds
 * `twoFactorRedirect` and suppresses the session cookie. No session exists at
 * that point, so the caller must complete `/two-factor/verify-totp` first.
 */
export interface SignInResult {
  twoFactorRedirect?: boolean;
  twoFactorMethods?: string[];
  redirect?: boolean;
  token?: string;
  url?: string;
  user?: SessionUser;
}

/**
 * Session handed out by `/api/auth/two-factor/verify-totp` and
 * `/api/auth/two-factor/verify-backup-code`. Both endpoints call
 * `valid(ctx)` in `better-auth/dist/plugins/two-factor/verify-two-factor.mjs`,
 * which returns `{ token, user }` and sets the session cookie.
 */
export interface TwoFactorVerifyResult {
  token: string;
  user: SessionUser;
}

/**
 * `POST /api/auth/two-factor/enable` with `method: 'totp'`
 * (`better-auth/dist/plugins/two-factor/index.mjs`): the plugin stores an
 * unverified secret and returns the authenticator URI plus the plaintext backup
 * codes, which are shown exactly once.
 */
export interface TwoFactorSetupResult {
  method: 'totp' | 'otp';
  totpURI?: string;
  backupCodes?: string[];
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers,
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', 'The server could not be reached.');
  }

  // A wrong TOTP/backup code also answers 401, but it must not tear down the
  // authenticated UI (that happens when disabling 2FA from Settings). The
  // caller shows the typed error instead.
  const isTwoFactorVerification = path.startsWith('/api/auth/two-factor/');
  if (response.status === 401 && !isTwoFactorVerification && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('agent-tasks:unauthorized'));
  }

  if (!response.ok) {
    let code = 'http_error';
    let message = `Request failed (${response.status})`;
    let details: unknown;
    try {
      const payload = (await response.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
        code?: string;
        message?: string;
      };
      // Better Auth errors are `{ code, message }` at the top level; app errors
      // nest them under `error`.
      code = payload.error?.code ?? payload.code ?? code;
      message = payload.error?.message ?? payload.message ?? message;
      details = payload.error?.details;
    } catch {
      /* response had no JSON body */
    }
    throw new ApiError(response.status, code, message, details);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body });
const del = <T = void>(path: string) => request<T>(path, { method: 'DELETE' });

export const api = {
  auth: {
    signIn: (email: string, password: string) =>
      post<SignInResult>('/api/auth/sign-in/email', { email, password }),
    signUp: (input: { name: string; email: string; password: string }) =>
      post<{ user?: { id: string } }>('/api/auth/sign-up/email', input),
    signOut: () => post<void>('/api/auth/sign-out'),
    session: () =>
      get<{ user: SessionUser; session: { id: string; expiresAt: string } } | null>(
        '/api/auth/get-session',
      ),
    verifyTotp: (code: string) =>
      post<TwoFactorVerifyResult>('/api/auth/two-factor/verify-totp', { code }),
    verifyBackupCode: (code: string) =>
      post<TwoFactorVerifyResult>('/api/auth/two-factor/verify-backup-code', { code }),
    enableTwoFactor: (password: string) =>
      post<TwoFactorSetupResult>('/api/auth/two-factor/enable', { method: 'totp', password }),
    disableTwoFactor: (password: string) =>
      post<{ status: boolean }>('/api/auth/two-factor/disable', { password }),
  },
  config: () => get<AppConfig>('/api/config'),
  setupStatus: () => get<{ configured: boolean }>('/api/setup/status'),
  setup: (input: { token: string; email: string; password: string; name: string }) =>
    post<{ ok: boolean }>('/api/setup', input),
  invitation: (token: string) => get<InvitationPreview>(`/api/invitations/${encodeURIComponent(token)}`),
  acceptInvitation: (input: { token: string; name: string; password: string }) =>
    post<{ ok: boolean }>('/api/invitations/accept', input),
  me: () => get<Me>('/api/me'),
  updatePreferences: (input: Partial<Preferences>) => patch<Me['preferences']>('/api/me/preferences', input),
  dashboard: () => get<Dashboard>('/api/dashboard'),

  tasks: {
    list: () => get<Task[]>('/api/tasks'),
    get: (id: string) => get<Task>(`/api/tasks/${id}`),
    create: (input: TaskInput) => post<Task>('/api/tasks', input),
    update: (id: string, input: Partial<TaskInput>) => patch<Task>(`/api/tasks/${id}`, input),
    remove: (id: string) => del(`/api/tasks/${id}`),
    action: (id: string, action: 'pause' | 'resume' | 'run' | 'duplicate') =>
      post<Task | { executionId?: string }>(`/api/tasks/${id}/${action}`),
    executions: (id: string) => get<ExecutionSummary[]>(`/api/tasks/${id}/executions`),
    memoryChanges: (id: string) => get<MemoryChange[]>(`/api/tasks/${id}/memory-changes`),
    memorySuggestions: (id: string) => get<MemorySuggestion[]>(`/api/tasks/${id}/memory-suggestions`),
    recommendationEvents: (id: string) => get<RecommendationEvent[]>(`/api/tasks/${id}/recommendation-events`),
  },

  memory: {
    list: (params: {
      scope?: Memory['scope'];
      taskId?: string;
      category?: Memory['category'];
      q?: string;
      limit?: number;
      offset?: number;
    } = {}) => {
      const query = new URLSearchParams();
      if (params.scope) query.set('scope', params.scope);
      if (params.taskId) query.set('taskId', params.taskId);
      if (params.category) query.set('category', params.category);
      if (params.q) query.set('q', params.q);
      if (params.limit) query.set('limit', String(params.limit));
      if (params.offset) query.set('offset', String(params.offset));
      const suffix = query.toString();
      return get<{ items: Memory[]; total: number; limit: number; offset: number }>(`/api/memory${suffix ? `?${suffix}` : ''}`);
    },
    get: (id: string) => get<Memory>(`/api/memory/${id}`),
    create: (input: {
      scope: Memory['scope'];
      taskId?: string;
      category: Memory['category'];
      content: string;
      semanticKey?: string;
    }) => post<Memory>('/api/memory', input),
    update: (id: string, input: { category?: Memory['category']; content?: string; semanticKey?: string | null }) =>
      patch<Memory>(`/api/memory/${id}`, input),
    remove: (id: string) => del(`/api/memory/${id}`),
    deleteAll: (input: { scope: 'all' | Memory['scope']; taskId?: string; confirm: true }) =>
      post<{ deleted: number }>('/api/memory/delete-all', input),
    stats: () => get<{ global: number; task: number; total: number }>('/api/memory/stats'),
    command: (input: string, options: { taskId?: string; confirm?: boolean } = {}) =>
      post<MemoryCommandResult>('/api/memory/commands', { input, ...options }),
    exportUrl: '/api/memory/export',
    acceptSuggestion: (id: string) => post<{ memory: Memory | null }>(`/api/memory-suggestions/${id}/accept`),
    rejectSuggestion: (id: string) => post<{ ok: boolean }>(`/api/memory-suggestions/${id}/reject`),
  },

  recommendations: {
    list: (taskId: string) => get<Recommendation[]>(`/api/tasks/${taskId}/recommendations`),
    update: (id: string, status: Recommendation['status']) =>
      patch<Recommendation>(`/api/recommendations/${id}`, { status }),
    events: (taskId: string) => get<RecommendationEvent[]>(`/api/tasks/${taskId}/recommendation-events`),
  },

  executions: {
    list: (params: { limit?: number; status?: string } = {}) => {
      const query = new URLSearchParams();
      if (params.limit) query.set('limit', String(params.limit));
      if (params.status) query.set('status', params.status);
      const suffix = query.toString();
      return get<ExecutionSummary[]>(`/api/executions${suffix ? `?${suffix}` : ''}`);
    },
    get: (id: string) => get<Execution>(`/api/executions/${id}`),
    cancel: (id: string) => post<{ ok: boolean }>(`/api/executions/${id}/cancel`),
    retry: (id: string) => post<{ executionId: string }>(`/api/executions/${id}/retry`),
    memory: (id: string) =>
      get<{
        changes: MemoryChange[];
        suggestions: MemorySuggestion[];
        recommendationEvents: RecommendationEvent[];
      }>(`/api/executions/${id}/memory`),
  },

  providers: {
    list: () => get<Provider[]>('/api/providers'),
    setCredential: (id: string, input: { apiKey: string; label: string }) =>
      post<{ id: string }>(`/api/providers/${id}/credentials`, input),
    removeCredential: (id: string) => del(`/api/providers/${id}/credentials`),
  },

  admin: {
    users: () => get<AdminUser[]>('/api/admin/users'),
    updateUser: (id: string, input: { role?: string; banned?: boolean; name?: string }) =>
      patch<AdminUser>(`/api/admin/users/${id}`, input),
    invitations: () => get<Invitation[]>('/api/admin/invitations'),
    invite: (input: { email: string; role: string }) =>
      post<{ id: string; token: string; expiresAt: string; link: string }>('/api/admin/invitations', input),
    revokeInvitation: (id: string) => del(`/api/admin/invitations/${id}`),
    settings: () => get<SystemSettings>('/api/admin/settings'),
    saveSettings: (input: SystemSettings) => put<SystemSettings>('/api/admin/settings', input),
    audit: () => get<AuditEntry[]>('/api/admin/audit'),
    metrics: () => get<Metrics>('/api/admin/metrics'),
    providers: () => get<AdminProvider[]>('/api/admin/providers'),
    createProvider: (input: {
      name: string;
      kind: string;
      config: Record<string, unknown>;
      enabled?: boolean;
      isDefault?: boolean;
    }) => post<AdminProvider>('/api/admin/providers', input),
    updateProvider: (id: string, input: Partial<AdminProvider> & { config?: unknown }) =>
      patch<AdminProvider>(`/api/admin/providers/${id}`, input),
    deleteProvider: (id: string) => del(`/api/admin/providers/${id}`),
    setCredential: (id: string, input: { apiKey: string; label: string }) =>
      post<{ ok: boolean }>(`/api/admin/providers/${id}/credentials`, input),
    removeCredential: (id: string) => del(`/api/admin/providers/${id}/credentials`),
    refreshModels: (id: string) =>
      post<{ models: Array<{ id: string; label: string }> }>(`/api/admin/providers/${id}/models/refresh`),
    health: (id: string) => post<ProviderHealth>(`/api/admin/providers/${id}/health`),
  },
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
