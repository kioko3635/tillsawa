import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LoginInput, RegisterOrganizationInput } from '@pos/contracts';
import { api, clearSession, refreshSession } from '../lib/api/client';
import type { AuthMembership, Bootstrap } from '../lib/api/types';
import { AuthContext, type AuthState } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [membership, setMembership] = useState<AuthMembership | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);

  const loadBootstrap = useCallback(async (nextMembership?: AuthMembership) => {
    const data = await api.bootstrap();
    setBootstrap(data);
    if (nextMembership) setMembership(nextMembership);
    setStatus('authenticated');
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshSession()
      .then((bundle) => (cancelled ? undefined : loadBootstrap(bundle.membership)))
      .catch(() => {
        if (cancelled) return;
        clearSession();
        setMembership(null);
        setBootstrap(null);
        setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, [loadBootstrap]);

  const login = useCallback(async (input: LoginInput) => {
    const bundle = await api.login(input);
    await loadBootstrap(bundle.membership);
  }, [loadBootstrap]);

  const registerOrganization = useCallback(async (input: RegisterOrganizationInput, setupKey?: string) => {
    const bundle = await api.registerOrganization(input, setupKey);
    await loadBootstrap(bundle.membership);
  }, [loadBootstrap]);

  const logout = useCallback(async () => {
    await api.logout();
    setMembership(null);
    setBootstrap(null);
    setStatus('anonymous');
  }, []);

  const reload = useCallback(async () => {
    await loadBootstrap();
  }, [loadBootstrap]);

  const hasPermission = useCallback((permission: string) => Boolean(membership?.permissions.includes(permission)), [membership]);
  const value = useMemo<AuthState>(() => ({
    status,
    membership,
    bootstrap,
    login,
    registerOrganization,
    logout,
    reload,
    hasPermission
  }), [status, membership, bootstrap, login, registerOrganization, logout, reload, hasPermission]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
