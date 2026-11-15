"use client";

import { createContext, type ReactNode, useContext } from "react";

import type { SessionManager } from "@/lib/auth/session-manager";

import type { Api, RealtimeClient } from "./api";
import type { Backend } from "./index";

const BackendContext = createContext<Backend | null>(null);

export function BackendProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  return <BackendContext.Provider value={backend}>{children}</BackendContext.Provider>;
}

function useBackend(): Backend {
  const value = useContext(BackendContext);
  if (!value) {
    throw new Error("Wrap the app in <BackendProvider>.");
  }
  return value;
}

export const useApi = (): Api => useBackend().api;
export const useRealtime = (): RealtimeClient => useBackend().realtime;
/** The mock server controls (for example, reset). `null` when a real API is used. */
export const useMock = () => useBackend().mock;
/** Restores and renews the sign-in. See `lib/auth/session-manager.ts`. */
export const useSessionManager = (): SessionManager => useBackend().session;
