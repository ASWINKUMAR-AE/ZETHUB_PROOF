import * as React from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Bell,
  ChartNoAxesCombined,
  Database,
  DownloadCloud,
  FlaskConical,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { errorMessage, useInterval } from '../lib/hooks';
import { cn, initials, timeAgo } from '../lib/utils';
import type { NotificationItem } from '../types';
import { useAuth } from '../providers/AuthProvider';
import { useUpdates } from '../providers/UpdateProvider';
import { Badge, Button, EmptyState, LoadingBlock, Modal } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/runs', label: 'Verification runs', icon: FlaskConical },
  { to: '/evidence', label: 'Evidence passports', icon: ShieldCheck },
  { to: '/analytics', label: 'Analytics', icon: ChartNoAxesCombined },
  { to: '/database', label: 'Database', icon: Database },
  { to: '/integrations', label: 'Integrations', icon: Plug },
  { to: '/settings', label: 'Settings', icon: Settings },
];

const TITLES: Array<{ match: RegExp; title: string }> = [
  { match: /^\/projects\/[^/]+/, title: 'Project detail' },
  { match: /^\/projects/, title: 'Projects' },
  { match: /^\/runs\/[^/]+/, title: 'Run detail' },
  { match: /^\/runs/, title: 'Verification runs' },
  { match: /^\/evidence/, title: 'Evidence passports' },
  { match: /^\/analytics/, title: 'Analytics' },
  { match: /^\/database/, title: 'Database' },
  { match: /^\/integrations/, title: 'Integrations' },
  { match: /^\/settings/, title: 'Settings' },
  { match: /^\/$/, title: 'Dashboard' },
];

interface Health {
  ok: boolean;
  api: string;
  database: string;
  version: string;
}

const NAV_STATE_KEY = 'zethub:nav-collapsed';

export function AppShell() {
  const { user, logout } = useAuth();
  const { status: updateStatus, check: updateCheck, openPanel: openUpdatePanel } = useUpdates();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(() => {
    try {
      return window.localStorage.getItem(NAV_STATE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [health, setHealth] = React.useState<Health | null>(null);
  const [healthError, setHealthError] = React.useState(false);
  const [profileOpen, setProfileOpen] = React.useState(false);
  const [notificationsOpen, setNotificationsOpen] = React.useState(false);
  const [notifications, setNotifications] = React.useState<NotificationItem[]>([]);
  const [notificationsLoading, setNotificationsLoading] = React.useState(false);
  const [notificationsError, setNotificationsError] = React.useState<string | null>(null);
  const [unread, setUnread] = React.useState(0);
  const [loggingOut, setLoggingOut] = React.useState(false);

  const refreshHealth = React.useCallback(async () => {
    try {
      const result = await api.get<Health>('/api/v1/system/health');
      setHealth(result);
      setHealthError(false);
    } catch {
      setHealthError(true);
    }
  }, []);

  const refreshUnread = React.useCallback(async () => {
    try {
      const result = await api.get<{ unread: number }>('/api/v1/notifications');
      setUnread(result.unread);
    } catch {
      /* notification badges are best-effort */
    }
  }, []);

  React.useEffect(() => {
    void refreshHealth();
    void refreshUnread();
  }, [refreshHealth, refreshUnread]);

  useInterval(() => {
    void refreshHealth();
    void refreshUnread();
  }, 30_000);

  React.useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(NAV_STATE_KEY, next ? '1' : '0');
      } catch {
        /* preference is best-effort */
      }
      return next;
    });
  }

  const title = TITLES.find((entry) => entry.match.test(location.pathname))?.title ?? 'ZetHub Proof';

  async function openNotifications() {
    setNotificationsOpen(true);
    setNotificationsLoading(true);
    setNotificationsError(null);
    try {
      const result = await api.get<{ items: NotificationItem[]; unread: number }>('/api/v1/notifications');
      setNotifications(result.items);
      setUnread(result.unread);
    } catch (error) {
      setNotificationsError(errorMessage(error));
    } finally {
      setNotificationsLoading(false);
    }
  }

  async function markAllRead() {
    const unreadItems = notifications.filter((item) => !item.readAt);
    for (const item of unreadItems) {
      try {
        await api.post(`/api/v1/notifications/${encodeURIComponent(item.id)}/read`);
      } catch {
        /* keep the remaining items untouched */
      }
    }
    setNotifications((current) =>
      current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })),
    );
    setUnread(0);
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
      navigate('/');
    } finally {
      setLoggingOut(false);
      setProfileOpen(false);
    }
  }

  const dbOk = health?.database === 'ok';
  const updateAvailable = Boolean(updateCheck?.updateAvailable);

  return (
    <div className="app-ambient min-h-screen lg:flex">
      {mobileOpen ? (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/65 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[272px] flex-col border-r border-white/[0.07] bg-ink-950/95 px-3 py-3 backdrop-blur-xl transition-[width,transform] duration-300 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          collapsed ? 'lg:w-[92px]' : 'lg:w-[272px]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className={cn('flex h-14 items-center gap-2', collapsed ? 'lg:justify-center' : 'justify-between')}>
          <NavLink to="/" className="flex min-w-0 items-center gap-3" title="ZetHub Proof">
            <span className="logo-orb grid h-10 w-10 shrink-0 place-items-center rounded-[15px]">
              <ShieldCheck className="h-5 w-5 text-white" />
            </span>
            <span className={cn('min-w-0 leading-tight', collapsed && 'lg:hidden')}>
              <span className="block truncate text-[15px] font-semibold tracking-tight text-white">ZetHub Proof</span>
              <span className="block truncate text-[9px] font-semibold uppercase tracking-[0.2em] text-lavender/55">
                Proof, not promises
              </span>
            </span>
          </NavLink>
          <button
            className="rounded-full p-1.5 text-muted transition hover:bg-white/5 hover:text-white lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <button
          onClick={toggleCollapsed}
          className={cn(
            'mt-3 hidden h-8 items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.03] px-3 text-[11px] text-muted transition hover:border-white/15 hover:text-white lg:flex',
            collapsed ? 'justify-center' : 'justify-between',
          )}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          {collapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
          {!collapsed ? <span>Collapse</span> : null}
        </button>

        <div
          className={cn(
            'mt-5 px-3 text-[9px] font-semibold uppercase tracking-[0.22em] text-lavender/35',
            collapsed && 'lg:hidden',
          )}
        >
          Workspace
        </div>
        <nav className="mt-2 flex-1 space-y-1 overflow-y-auto overflow-x-hidden pb-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center rounded-full py-2.5 text-[12.5px] font-medium transition-all duration-200',
                  collapsed ? 'lg:justify-center lg:px-0' : 'gap-3 px-3',
                  isActive
                    ? 'nav-pill-active text-white'
                    : 'text-slate-400 hover:bg-white/[0.045] hover:text-slate-100',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      'grid h-7 w-7 shrink-0 place-items-center rounded-full border transition',
                      isActive
                        ? 'border-white/15 bg-white/10 text-lavender shadow-[0_0_20px_-6px_rgba(199,195,240,.55)]'
                        : 'border-transparent text-slate-500 group-hover:text-slate-300',
                    )}
                  >
                    <item.icon className="h-3.5 w-3.5" />
                  </span>
                  <span className={cn('truncate', collapsed && 'lg:hidden')}>{item.label}</span>
                  {isActive && !collapsed ? (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-ember-soft shadow-[0_0_10px_rgba(216,90,74,.8)]" />
                  ) : null}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-white/[0.06] pt-3">
          <button
            className={cn(
              'flex w-full items-center rounded-2xl border border-white/[0.06] bg-white/[0.025] p-2 text-left transition hover:border-white/15 hover:bg-white/[0.05]',
              collapsed ? 'lg:justify-center' : 'gap-2',
            )}
            onClick={() => setProfileOpen(true)}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent/35 to-accent-deep/30 text-[11px] font-semibold text-lavender">
              {initials(user?.name ?? 'ZP')}
            </span>
            <span className={cn('min-w-0 flex-1', collapsed && 'lg:hidden')}>
              <span className="block truncate text-[12px] font-medium text-slate-200">
                {user?.name ?? 'Local owner'}
              </span>
              <span className="block truncate text-[10px] text-slate-500">{user?.role.toLowerCase() ?? 'owner'}</span>
            </span>
            <LogOut
              className={cn('h-3.5 w-3.5 shrink-0 text-muted', collapsed && 'lg:hidden')}
              onClick={(event) => {
                event.stopPropagation();
                void handleLogout();
              }}
            />
          </button>
          <div
            className={cn(
              'mt-2 flex items-center gap-1.5 px-2 text-[10px] text-slate-500',
              collapsed ? 'lg:justify-center' : 'justify-between',
            )}
          >
            <span className={cn(collapsed && 'lg:hidden')}>
              v{health?.version ?? updateStatus?.currentVersion ?? '0.1.0'}
            </span>
            <span
              className="inline-flex items-center gap-1.5"
              title={healthError ? 'API offline' : dbOk ? 'Database online' : 'Database degraded'}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  healthError ? 'bg-negative' : dbOk ? 'bg-positive' : 'bg-warning',
                )}
              />
              <span className={cn(collapsed && 'lg:hidden')}>
                {healthError ? 'API offline' : dbOk ? 'Database online' : 'Database degraded'}
              </span>
            </span>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 px-3 pt-3 md:px-5">
          <div className="topbar-glass flex h-14 items-center gap-3 rounded-2xl px-3 md:px-4">
            <button
              className="rounded-full border border-white/10 bg-white/[0.04] p-2 text-slate-300 transition hover:bg-white/10 lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-semibold text-white">{title}</div>
              <p className="truncate text-[10px] text-slate-500">Local-first verification · 127.0.0.1</p>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => navigate('/database')}
                className="hidden items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[11px] text-slate-300 transition hover:border-white/20 hover:bg-white/[0.06] sm:flex"
                title="Database status"
              >
                <Database className="h-3.5 w-3.5 text-lavender/60" />
                <span className="max-w-[160px] truncate">
                  {healthError
                    ? 'API unreachable'
                    : health
                      ? health.database === 'ok'
                        ? 'DB ready'
                        : 'DB unavailable'
                      : 'Checking…'}
                </span>
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    healthError ? 'bg-negative' : dbOk ? 'bg-positive' : 'bg-warning',
                  )}
                />
              </button>

              <button
                onClick={openUpdatePanel}
                className={cn(
                  'relative flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-[11px] transition',
                  updateAvailable
                    ? 'border-ember/35 bg-ember/10 text-white hover:bg-ember/15'
                    : 'border-white/[0.08] bg-white/[0.03] text-slate-300 hover:border-white/20 hover:bg-white/[0.06]',
                )}
                title={updateAvailable ? `Update ${updateCheck?.latestVersion} available` : 'Software updates'}
              >
                <DownloadCloud className="h-3.5 w-3.5" />
                <span className="hidden xl:inline">
                  {updateAvailable ? `v${updateCheck?.latestVersion} available` : 'Updates'}
                </span>
                {updateAvailable ? (
                  <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-ember shadow-[0_0_10px_rgba(216,90,74,.9)]" />
                ) : null}
              </button>

              <button
                className="relative rounded-full border border-white/[0.08] bg-white/[0.03] p-2 text-slate-300 transition hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
                onClick={() => void openNotifications()}
                title="Notifications"
              >
                <Bell className="h-4 w-4" />
                {unread > 0 ? (
                  <span className="absolute -right-1 -top-1 grid min-w-[16px] place-items-center rounded-full bg-ember px-1 text-[9px] font-bold text-white">
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : null}
              </button>

              <button
                className="grid h-8 w-8 place-items-center rounded-full border border-white/10 bg-gradient-to-br from-accent/30 to-accent-deep/25 text-[10.5px] font-semibold text-lavender transition hover:border-lavender/40"
                onClick={() => setProfileOpen(true)}
                title="Account"
              >
                {initials(user?.name ?? 'ZP')}
              </button>
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-3 py-5 md:px-5 lg:px-7">
          <div className="mx-auto w-full max-w-[1500px]">
            <Outlet />
          </div>
        </main>
      </div>

      <Modal
        open={profileOpen}
        onOpenChange={setProfileOpen}
        title="Local account"
        description="ZetHub Proof runs on this machine. No account data leaves it."
        width="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setProfileOpen(false)}>
              Close
            </Button>
            <Button variant="danger" onClick={handleLogout} loading={loggingOut}>
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </>
        }
      >
        {user ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-gradient-to-br from-accent/35 to-accent-deep/30 text-sm font-semibold text-lavender">
                {initials(user.name)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white">{user.name}</div>
                <div className="truncate text-xs text-muted">{user.email}</div>
                <Badge tone="accent" className="mt-1">
                  {user.role.toLowerCase()}
                </Badge>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setProfileOpen(false);
                  navigate('/settings');
                }}
              >
                <Settings className="h-3.5 w-3.5" /> Settings
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setProfileOpen(false);
                  navigate('/settings?tab=system');
                }}
              >
                <Activity className="h-3.5 w-3.5" /> System info
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">No active session.</p>
        )}
      </Modal>

      <Modal
        open={notificationsOpen}
        onOpenChange={setNotificationsOpen}
        title="Notifications"
        description="Local notifications generated by verification runs and database maintenance."
        width="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNotificationsOpen(false)}>
              Close
            </Button>
            <Button
              variant="outline"
              onClick={() => void markAllRead()}
              disabled={notifications.every((item) => item.readAt)}
            >
              Mark all read
            </Button>
          </>
        }
      >
        {notificationsLoading ? (
          <LoadingBlock />
        ) : notificationsError ? (
          <p className="text-sm text-negative">{notificationsError}</p>
        ) : notifications.length === 0 ? (
          <EmptyState
            title="No notifications"
            description="Completed runs and database events will show up here."
            icon={<Bell className="h-5 w-5" />}
          />
        ) : (
          <div className="space-y-2">
            {notifications.map((item) => (
              <div
                key={item.id}
                className={cn(
                  'rounded-2xl border px-3.5 py-3',
                  item.readAt ? 'border-white/[0.06] bg-white/[0.02]' : 'border-accent/25 bg-accent/[0.07]',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-slate-200">{item.title}</div>
                    {item.body ? (
                      <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{item.body}</div>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-[10px] text-slate-500">{timeAgo(item.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
