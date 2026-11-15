"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { ArchivePanel } from "@/components/archive-panel";
import { AuthGate } from "@/components/auth/auth-gate";
import { CallOverlay } from "@/components/call-overlay";
import { ChatsPanel } from "@/components/chats-panel";
import { ContactsPanel } from "@/components/contacts-panel";
import { Dialogs } from "@/components/dialogs";
import { Rail, type Section } from "@/components/rail";
import { StatusViewer } from "@/components/status-viewer";
import { ToastRegion } from "@/components/toast-region";
import { isMockApi } from "@/lib/api";
import { useMe } from "@/lib/auth/me";
import { useRealtimeSync } from "@/lib/realtime/use-realtime-sync";
import { useUi } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";

function ConnectionBanner() {
  const connection = useUi((s) => s.connection);
  if (isMockApi || connection === "connected") {
    return null;
  }
  return (
    <div
      className="bg-muted text-muted-foreground px-4 py-1.5 text-center text-xs font-medium"
      role="status"
    >
      {connection === "connecting" ? "Connecting…" : "You're offline. Trying to reconnect…"}
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  useRealtimeSync(me.id);

  const pathname = usePathname();
  const section: Section = pathname.startsWith("/contacts")
    ? "contacts"
    : pathname.startsWith("/archive")
      ? "archive"
      : "chats";
  const detailOpen = !["/", "/contacts", "/archive"].includes(pathname);

  return (
    <div className="isolate flex h-dvh flex-col overflow-hidden">
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <Rail hideOnMobile={detailOpen} section={section} />

        <aside
          className={cn(
            "border-border bg-surface min-h-0 w-full flex-1 flex-col border-r md:w-[360px] md:flex-none md:shrink-0",
            detailOpen ? "hidden md:flex" : "flex",
          )}
        >
          {section === "contacts" ? (
            <ContactsPanel />
          ) : section === "archive" ? (
            <ArchivePanel />
          ) : (
            <ChatsPanel />
          )}
        </aside>

        <main
          className={cn(
            "bg-background min-h-0 min-w-0 flex-1 flex-col",
            detailOpen ? "flex" : "hidden md:flex",
          )}
        >
          {children}
        </main>
      </div>

      <Dialogs />
      <StatusViewer />
      <CallOverlay />
      <ToastRegion />
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <AuthGate signedOut={children}>
      <Shell>{children}</Shell>
    </AuthGate>
  );
}
