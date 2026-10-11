"use client";

import type { AuthResult, CurrentUserView, LoginInput, RegisterInput } from "@gg/sdk";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";

export type SessionStatus = "loading" | "authenticated" | "anonymous";

interface SessionContextValue {
  status: SessionStatus;
  user: CurrentUserView | null;
  login: (input: LoginInput) => Promise<AuthResult>;
  register: (input: RegisterInput) => Promise<AuthResult>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  /** True when actions must send the user to /login first. */
  requireAuth: () => boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Session state for the browser app. The access token stays in memory
 * inside the SDK client; on load we rotate the refresh token (httpOnly
 * cookie and/or in-memory pair) and fetch /users/me to restore the session.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [user, setUser] = useState<CurrentUserView | null>(null);
  const router = useRouter();
  const bootstrapped = useRef(false);

  const refreshUser = useCallback(async () => {
    const me = await api.me();
    setUser(me);
    setStatus("authenticated");
  }, []);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      try {
        await api.refresh();
        await refreshUser();
      } catch {
        setUser(null);
        setStatus("anonymous");
      }
    })();
  }, [refreshUser]);

  const login = useCallback(
    async (input: LoginInput) => {
      const result = await api.login(input);
      if (result.user) {
        setUser(result.user);
        setStatus("authenticated");
      } else if (result.tokens) {
        await refreshUser();
      }
      return result;
    },
    [refreshUser],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const result = await api.register(input);
      if (result.user) {
        setUser(result.user);
        setStatus("authenticated");
      } else if (result.tokens) {
        await refreshUser();
      }
      return result;
    },
    [refreshUser],
  );

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    setStatus("anonymous");
    router.replace("/login");
  }, [router]);

  const requireAuth = useCallback(() => {
    if (status === "authenticated") return true;
    router.push("/login");
    return false;
  }, [router, status]);

  const value = useMemo<SessionContextValue>(
    () => ({ status, user, login, register, logout, refreshUser, requireAuth }),
    [status, user, login, register, logout, refreshUser, requireAuth],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside <SessionProvider>");
  return context;
}

/**
 * Route guard: renders children only for authenticated users; everyone else
 * is redirected to /login once the session check settles.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading your session">
        <div className="h-40 rounded-lg bg-[var(--skeleton)]" />
        <div className="h-40 rounded-lg bg-[var(--skeleton)]" />
      </div>
    );
  }
  return <>{children}</>;
}
