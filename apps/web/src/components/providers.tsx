"use client";

import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { getBackend } from "@/lib/api";
import { BackendProvider, useSessionManager } from "@/lib/api/context";
import { createQueryClient } from "@/lib/queries/client";
import { keys } from "@/lib/queries/keys";
import { useSession } from "@/lib/stores/session";
import { useUi } from "@/lib/stores/ui";

/**
 * Restores the sign-in when the page loads, and wipes everything tied to the signed-in person
 * when the token goes away (a sign-out, or a session the server will not renew).
 */
function SessionWatcher({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const session = useSessionManager();
  const token = useSession((s) => s.token);
  const hydrated = useSession((s) => s.hydrated);
  const hadToken = useRef(false);

  useEffect(() => session.onRestored((user) => qc.setQueryData(keys.me, user)), [session, qc]);

  useEffect(() => {
    void session.restore();
  }, [session]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    if (token) {
      hadToken.current = true;
    } else if (hadToken.current) {
      hadToken.current = false;
      useUi.getState().reset();
      qc.clear();
    }
  }, [token, hydrated, qc]);

  return <>{children}</>;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  const [backend] = useState(getBackend);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" disableTransitionOnChange enableSystem>
      <BackendProvider backend={backend}>
        <QueryClientProvider client={queryClient}>
          <SessionWatcher>{children}</SessionWatcher>
        </QueryClientProvider>
      </BackendProvider>
    </ThemeProvider>
  );
}
