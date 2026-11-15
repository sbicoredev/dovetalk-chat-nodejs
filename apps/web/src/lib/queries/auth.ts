"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useApi, useSessionManager } from "@/lib/api/context";
import type { AuthResult, LoginInput, RegisterInput } from "@/lib/api/types";
import { useSession } from "@/lib/stores/session";

import { keys } from "./keys";

/** Starts the session from a sign-in, sign-up or guest result. */
function useStartSession() {
  const qc = useQueryClient();
  const session = useSessionManager();
  return ({ accessToken, user }: AuthResult) => {
    qc.setQueryData(keys.me, user);
    session.signIn({ accessToken, user });
  };
}

// The forms show their own errors, so the global toast is turned off for all three.

export function useLogin() {
  const api = useApi();
  const start = useStartSession();
  return useMutation({
    mutationFn: (input: LoginInput) => api.auth.login(input),
    meta: { silent: true },
    onSuccess: start,
  });
}

export function useRegister() {
  const api = useApi();
  const start = useStartSession();
  return useMutation({
    mutationFn: (input: RegisterInput) => api.auth.register(input),
    meta: { silent: true },
    onSuccess: start,
  });
}

/** "Try the demo": a throwaway account with the demo data, no form. */
export function useGuestLogin() {
  const api = useApi();
  const start = useStartSession();
  return useMutation({
    mutationFn: () => api.auth.guest(),
    meta: { silent: true },
    onSuccess: start,
  });
}

/**
 * Tells the server, which ends the refresh cookie, then signs out here even if that call fails.
 * The query cache is emptied by the session watcher once the token is gone.
 */
export function useLogout() {
  const api = useApi();
  return useMutation({
    mutationFn: () => api.auth.logout(),
    meta: { silent: true },
    onSettled: () => useSession.getState().clear(),
  });
}
