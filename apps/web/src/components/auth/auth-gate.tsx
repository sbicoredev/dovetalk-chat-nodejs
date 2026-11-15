"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { useApi, useSessionManager } from "@/lib/api/context";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { MeProvider } from "@/lib/auth/me";
import { useLogout } from "@/lib/queries/auth";
import { keys } from "@/lib/queries/keys";
import { useSession } from "@/lib/stores/session";

function Splash({ children }: { children?: ReactNode }) {
  return (
    <div className="bg-background grid h-dvh place-items-center">
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="bg-accent font-display text-accent-foreground grid size-12 animate-pulse place-items-center rounded-2xl text-3xl leading-none font-bold">
          d
        </span>
        {children}
      </div>
    </div>
  );
}

/**
 * Decides what the visitor sees: the login page, a loading screen, or the app.
 * Children render only once the signed-in user is known, and they receive it through `useMe()`.
 */
export function AuthGate({ children, signedOut }: { children: ReactNode; signedOut: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const api = useApi();
  const qc = useQueryClient();
  const session = useSessionManager();
  const logout = useLogout();
  const token = useSession((s) => s.token);
  const hydrated = useSession((s) => s.hydrated);
  const restoreError = useSession((s) => s.restoreError);
  const onLogin = pathname === "/login";

  const me = useQuery({
    queryKey: keys.me,
    queryFn: () => api.me.get(),
    enabled: hydrated && !!token,
    staleTime: Number.POSITIVE_INFINITY,
    retry: (count, error) => count < 2 && !isApiError(error),
  });

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    if (!(token || onLogin)) {
      router.replace("/login");
    }
    if (token && onLogin) {
      router.replace("/");
    }
  }, [hydrated, token, onLogin, router]);

  // A rejected token means the session is over.
  useEffect(() => {
    if (isApiError(me.error) && me.error.status === 401) {
      useSession.getState().clear();
      qc.clear();
    }
  }, [me.error, qc]);

  if (!hydrated) {
    return <Splash />;
  }
  if (restoreError) {
    // The server could not be reached, so it is not known whether anybody is signed in.
    return (
      <Splash>
        <p className="text-muted-foreground max-w-xs text-sm">{restoreError}</p>
        <Button onClick={() => void session.restore()} variant="primary">
          Try again
        </Button>
      </Splash>
    );
  }
  if (onLogin) {
    return token ? <Splash /> : signedOut;
  }
  if (!token) {
    return <Splash />;
  }

  if (me.data) {
    return <MeProvider me={me.data}>{children}</MeProvider>;
  }

  if (me.isError && !(isApiError(me.error) && me.error.status === 401)) {
    return (
      <Splash>
        <p className="text-muted-foreground max-w-xs text-sm">{errorMessage(me.error)}</p>
        <div className="flex gap-2">
          <Button onClick={() => void me.refetch()} variant="primary">
            Try again
          </Button>
          <Button disabled={logout.isPending} onClick={() => logout.mutate()}>
            Sign out
          </Button>
        </div>
      </Splash>
    );
  }
  return <Splash />;
}
