"use client";

import { createContext, type ReactNode, useContext } from "react";

import type { MeDto } from "@/lib/api/types";

const MeContext = createContext<MeDto | null>(null);

/** Provided by AuthGate once the signed-in user has loaded, so children can rely on it. */
export function MeProvider({ me, children }: { me: MeDto; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): MeDto {
  const me = useContext(MeContext);
  if (!me) {
    throw new Error("useMe must be used inside the signed-in app.");
  }
  return me;
}
