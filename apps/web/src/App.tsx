import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Outlet, Route, Routes } from 'react-router';
import { AuthProvider, RequireAdmin, RequireAuth } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { ToastProvider } from './components/ui';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { InvitePage } from './pages/InvitePage';
import { SharePage } from './pages/SharePage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { TasksPage } from './pages/TasksPage';
import { TaskFormPage } from './pages/TaskFormPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { ExecutionsPage } from './pages/ExecutionsPage';
import { MemoryPage } from './pages/MemoryPage';
import { ExecutionDetailPage } from './pages/ExecutionDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminPage } from './pages/AdminPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { AdminProvidersPage } from './pages/AdminProvidersPage';
import { AdminAuditPage } from './pages/AdminAuditPage';
import { AdminMonitoringPage } from './pages/AdminMonitoringPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ApiError } from './lib/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        error instanceof ApiError && error.status === 401 ? false : failureCount < 1,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
    mutations: { retry: false },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <ToastProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/invite/:token" element={<InvitePage />} />
                <Route path="/share/:token" element={<SharePage />} />
                <Route path="/register" element={<RegisterPage />} />

                <Route
                  element={
                    <RequireAuth>
                      <Layout />
                    </RequireAuth>
                  }
                >
                  <Route index element={<DashboardPage />} />
                  <Route path="tasks" element={<TasksPage />} />
                  <Route path="tasks/new" element={<TaskFormPage />} />
                  <Route path="tasks/:id" element={<TaskDetailPage />} />
                  <Route path="tasks/:id/edit" element={<TaskFormPage />} />
                  <Route path="memory" element={<MemoryPage />} />
                  <Route path="executions" element={<ExecutionsPage />} />
                  <Route path="executions/:id" element={<ExecutionDetailPage />} />
                  <Route path="settings" element={<SettingsPage />} />

                  <Route element={<RequireAdmin><Outlet /></RequireAdmin>}>
                    <Route path="admin" element={<AdminPage />} />
                    <Route path="admin/users" element={<AdminUsersPage />} />
                    <Route path="admin/providers" element={<AdminProvidersPage />} />
                    <Route path="admin/audit" element={<AdminAuditPage />} />
                    <Route path="admin/monitoring" element={<AdminMonitoringPage />} />
                  </Route>

                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </ToastProvider>
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
