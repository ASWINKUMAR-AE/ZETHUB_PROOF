import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { ShieldCheck } from 'lucide-react';
import { AppShell } from './components/AppShell';
import { useAuth } from './providers/AuthProvider';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { RunsPage } from './pages/RunsPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { EvidencePage } from './pages/EvidencePage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { DatabasePage } from './pages/DatabasePage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { SettingsPage } from './pages/SettingsPage';
import { NotFoundPage } from './pages/NotFoundPage';

function BootScreen({ label }: { label: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-ink-950">
      <div className="flex flex-col items-center gap-4">
        <span className="logo-orb grid h-12 w-12 place-items-center rounded-2xl">
          <ShieldCheck className="h-6 w-6 text-white" />
        </span>
        <div className="text-sm text-muted">{label}</div>
        <span className="h-1 w-40 overflow-hidden rounded-full bg-white/[0.06]">
          <span className="block h-full w-1/2 animate-pulse rounded-full bg-gradient-to-r from-lavender to-accent" />
        </span>
      </div>
    </div>
  );
}

function ProtectedRoutes() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <BootScreen label="Connecting to the local API…" />;

  if (!user) {
    if (location.pathname === '/login') return <AuthPage />;
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (location.pathname === '/login') return <Navigate to="/" replace />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:id" element={<RunDetailPage />} />
        <Route path="evidence" element={<EvidencePage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="database" element={<DatabasePage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ProtectedRoutes />
      <Toaster
        theme="dark"
        position="bottom-right"
        closeButton
        richColors
        toastOptions={{
          style: {
            background: '#191924',
            border: '1px solid rgba(199,195,240,0.14)',
            color: '#e6e6f4',
          },
        }}
      />
    </BrowserRouter>
  );
}

export default App;
