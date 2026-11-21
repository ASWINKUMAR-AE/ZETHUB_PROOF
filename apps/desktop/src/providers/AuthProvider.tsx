import * as React from 'react';
import type { UserSettings } from '@zethub/shared-types';
import { api, setCsrfToken } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import type { AuthMe, AuthStatus, User } from '../types';

interface AuthContextValue {
  user: User | null;
  settings: UserSettings | null;
  loading: boolean;
  error: string | null;
  initialized: boolean;
  login: (email: string, password: string, remember: boolean) => Promise<void>;
  bootstrap: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  applySettings: (settings: UserSettings) => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<User | null>(null);
  const [settings, setSettings] = React.useState<UserSettings | null>(null);
  const [initialized, setInitialized] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const loadMe = React.useCallback(async () => {
    try {
      const me = await api.get<AuthMe>('/api/v1/auth/me');
      setCsrfToken(me.csrfToken);
      setUser(me.user);
      setSettings(me.settings);
      setError(null);
    } catch (caught) {
      const status = (caught as { status?: number }).status;
      if (status === 401) {
        setCsrfToken(null);
        setUser(null);
        setSettings(null);
        setError(null);
      } else {
        setError(errorMessage(caught));
      }
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await api.get<AuthStatus>('/api/v1/auth/status');
        if (!cancelled) setInitialized(status.initialized);
      } catch {
        /* the status probe is best-effort; auth/me still determines the session */
      }
      await loadMe();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe]);

  React.useEffect(() => {
    const onUnauthorized = () => {
      setUser(null);
      setSettings(null);
      setCsrfToken(null);
    };
    window.addEventListener('zethub:unauthorized', onUnauthorized);
    return () => window.removeEventListener('zethub:unauthorized', onUnauthorized);
  }, []);

  const login = React.useCallback(
    async (email: string, password: string, remember: boolean) => {
      const result = await api.post<{ user: User; csrfToken: string }>('/api/v1/auth/login', {
        email,
        password,
        remember,
      });
      setCsrfToken(result.csrfToken);
      setUser(result.user);
      await loadMe();
    },
    [loadMe],
  );

  const bootstrap = React.useCallback(
    async (name: string, email: string, password: string) => {
      const result = await api.post<{ user: User; csrfToken: string }>('/api/v1/auth/bootstrap', {
        name,
        email,
        password,
      });
      setCsrfToken(result.csrfToken);
      setUser(result.user);
      setInitialized(true);
      await loadMe();
    },
    [loadMe],
  );

  const logout = React.useCallback(async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } finally {
      setUser(null);
      setSettings(null);
      setCsrfToken(null);
    }
  }, []);

  const refresh = React.useCallback(async () => {
    await loadMe();
  }, [loadMe]);

  const applySettings = React.useCallback((next: UserSettings) => setSettings(next), []);

  const value = React.useMemo<AuthContextValue>(
    () => ({ user, settings, loading, error, initialized, login, bootstrap, logout, refresh, applySettings }),
    [user, settings, loading, error, initialized, login, bootstrap, logout, refresh, applySettings],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider.');
  return context;
}
