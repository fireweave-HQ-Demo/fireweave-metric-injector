'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, request } from '@/lib/api';
import type { Session, SessionUser } from '@/lib/types';

const STORAGE_KEY = 'fireweave.session';

type Status = 'loading' | 'anonymous' | 'ready';

type AuthContextValue = {
  status: Status;
  user: SessionUser | null;
  token: string | null;
  signIn: (session: Session) => void;
  signOut: () => Promise<void>;
  call: <T>(path: string, options?: { method?: string; body?: unknown }) => Promise<T>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function readStored(): Session | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

function store(session: Session | null) {
  if (!session) {
    sessionStorage.removeItem(STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [session, setSession] = useState<Session | null>(null);

  const apply = useCallback((next: Session | null) => {
    store(next);
    setSession(next);
    setStatus(next ? 'ready' : 'anonymous');
  }, []);

  useEffect(() => {
    const stored = readStored();
    if (stored) {
      apply(stored);
      return;
    }
    request<Session>('/auth/refresh', { method: 'POST' })
      .then((refreshed) => apply(refreshed))
      .catch(() => apply(null));
  }, [apply]);

  const refresh = useCallback(async () => {
    const refreshed = await request<Session>('/auth/refresh', { method: 'POST' });
    apply(refreshed);
    return refreshed;
  }, [apply]);

  const call = useCallback(
    async <T,>(path: string, options: { method?: string; body?: unknown } = {}) => {
      const token = session?.accessToken ?? readStored()?.accessToken ?? null;
      try {
        return await request<T>(path, { ...options, token });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401 || path.startsWith('/auth/')) {
          throw error;
        }
        const next = await refresh();
        return request<T>(path, { ...options, token: next.accessToken });
      }
    },
    [refresh, session?.accessToken],
  );

  const signOut = useCallback(async () => {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      apply(null);
    }
  }, [apply]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user: session?.user ?? null,
      token: session?.accessToken ?? null,
      signIn: apply,
      signOut,
      call,
    }),
    [apply, call, session, signOut, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return value;
}
