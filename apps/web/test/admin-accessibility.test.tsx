// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../src/components/ui';
import { api } from '../src/lib/api';
import type { AdminProvider, AdminUser, AuditEntry, ExecutionSummary, Invitation, Metrics } from '../src/lib/types';
import { AuthProvider } from '../src/lib/auth';
import { setLanguage } from '../src/i18n';
import { expectInteractiveControlsNamed } from './accessibility-helpers';
import { AdminAuditPage } from '../src/pages/AdminAuditPage';
import { AdminMonitoringPage } from '../src/pages/AdminMonitoringPage';
import { AdminProvidersPage } from '../src/pages/AdminProvidersPage';
import { AdminUsersPage } from '../src/pages/AdminUsersPage';

const adminUser: AdminUser = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  name: 'Admin User',
  role: 'ADMIN',
  banned: false,
  emailVerified: true,
  createdAt: '2026-11-04T09:00:00.000Z',
};

const user: AdminUser = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'user@example.test',
  name: 'Test User',
  role: 'USER',
  banned: false,
  emailVerified: true,
  createdAt: '2026-11-04T09:00:00.000Z',
};

const invitation: Invitation = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  email: 'invite@example.test',
  role: 'USER',
  createdAt: '2026-11-04T09:00:00.000Z',
  expiresAt: '2026-11-11T09:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
};

const provider: AdminProvider = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  name: 'Test provider',
  kind: 'openai-compatible',
  executable: true,
  enabled: true,
  isDefault: true,
  config: { baseUrl: 'https://provider.example.test/v1' },
  sharedCredential: true,
  personalCredentials: 0,
  models: [{ id: 'test-model', label: 'Test model', supportsTools: true, contextLength: 8_192 }],
};

const metrics: Metrics = {
  users: 2,
  tasks: 3,
  executionsLast24h: 4,
  active: 1,
  byStatus: { completed: 3, running: 1 },
};

const execution: ExecutionSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  taskTitle: 'Accessibility check',
  status: 'completed',
  trigger: 'schedule',
  startedAt: '2026-11-04T10:00:00.000Z',
  finishedAt: '2026-11-04T10:00:02.000Z',
  durationMs: 2_000,
  error: null,
};

const auditEntry: AuditEntry = {
  id: '33333333-3333-4333-8333-333333333333',
  actorId: 'administrator',
  action: 'task.created',
  targetType: 'task',
  targetId: execution.taskId,
  metadata: { model: 'test-model' },
  ip: '127.0.0.1',
  createdAt: '2026-11-04T10:00:00.000Z',
};

function renderAdminPage(page: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/admin']}>
          <AuthProvider>{page}</AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setLanguage('en');
  vi.spyOn(api.auth, 'session').mockResolvedValue({
    user: { id: adminUser.id, email: adminUser.email, name: adminUser.name, role: 'ADMIN' },
    session: { id: 'session-id', expiresAt: '2026-11-05T09:00:00.000Z' },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('admin page accessibility smoke checks', () => {
  it('keeps admin audit navigation named in the empty state', async () => {
    vi.spyOn(api.admin, 'audit').mockResolvedValue([]);

    renderAdminPage(<AdminAuditPage />);

    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('keeps monitoring controls and execution links named in the filled state', async () => {
    vi.spyOn(api.admin, 'metrics').mockResolvedValue(metrics);
    vi.spyOn(api.executions, 'list').mockResolvedValue([execution]);

    renderAdminPage(<AdminMonitoringPage />);

    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Accessibility check' })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('announces a monitoring load failure and leaves its navigation usable', async () => {
    const metricQuery = vi.spyOn(api.admin, 'metrics')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(metrics);
    vi.spyOn(api.executions, 'list').mockResolvedValue([]);

    renderAdminPage(<AdminMonitoringPage />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(metricQuery).toHaveBeenCalledTimes(2);
    expectInteractiveControlsNamed();
  });

  it('announces and retries recent-execution loading failures in monitoring', async () => {
    vi.spyOn(api.admin, 'metrics').mockResolvedValue(metrics);
    const executionsQuery = vi.spyOn(api.executions, 'list')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);

    renderAdminPage(<AdminMonitoringPage />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(executionsQuery).toHaveBeenCalledTimes(2);
    expectInteractiveControlsNamed();
  });

  it('renders audit rows with semantic table headers', async () => {
    vi.spyOn(api.admin, 'audit').mockResolvedValue([auditEntry]);

    renderAdminPage(<AdminAuditPage />);

    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(0);
    expectInteractiveControlsNamed();
  });

  it('keeps user administration controls named in the empty state', async () => {
    vi.spyOn(api.admin, 'users').mockResolvedValue([]);
    vi.spyOn(api.admin, 'invitations').mockResolvedValue([]);

    renderAdminPage(<AdminUsersPage />);

    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('names user and invitation controls and uses semantic table headers when filled', async () => {
    vi.spyOn(api.admin, 'users').mockResolvedValue([user]);
    vi.spyOn(api.admin, 'invitations').mockResolvedValue([invitation]);

    renderAdminPage(<AdminUsersPage />);

    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('combobox', { name: 'Role' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('announces an admin user load failure accessibly', async () => {
    const usersQuery = vi.spyOn(api.admin, 'users')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);
    vi.spyOn(api.admin, 'invitations').mockResolvedValue([]);

    renderAdminPage(<AdminUsersPage />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(usersQuery).toHaveBeenCalledTimes(2);
    expectInteractiveControlsNamed();
  });

  it('announces invitation loading failures and retries the invitation query', async () => {
    vi.spyOn(api.admin, 'users').mockResolvedValue([]);
    const invitationsQuery = vi.spyOn(api.admin, 'invitations')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);

    renderAdminPage(<AdminUsersPage />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(invitationsQuery).toHaveBeenCalledTimes(2);
    expectInteractiveControlsNamed();
  });

  it('keeps provider actions named in the empty state', async () => {
    vi.spyOn(api.admin, 'providers').mockResolvedValue([]);

    renderAdminPage(<AdminProvidersPage />);

    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expectInteractiveControlsNamed();
  });

  it('names provider actions and form controls in filled and edit states', async () => {
    vi.spyOn(api.admin, 'providers').mockResolvedValue([provider]);

    renderAdminPage(<AdminProvidersPage />);

    expect(await screen.findByRole('heading', { name: provider.name })).toBeTruthy();
    expectInteractiveControlsNamed();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByRole('textbox').length).toBeGreaterThan(0);
    expectInteractiveControlsNamed();
  });

  it('announces provider loading errors and retries accessibly', async () => {
    const providersQuery = vi.spyOn(api.admin, 'providers')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);

    renderAdminPage(<AdminProvidersPage />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(providersQuery).toHaveBeenCalledTimes(2);
    expectInteractiveControlsNamed();
  });

  it('announces audit loading failures and retries the audit query', async () => {
    const auditQuery = vi.spyOn(api.admin, 'audit')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);

    renderAdminPage(<AdminAuditPage />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(auditQuery).toHaveBeenCalledTimes(2);
    expectInteractiveControlsNamed();
  });
});
