"use client";

import { useUi } from "@/lib/stores/ui";

export function ToastRegion() {
  const toast = useUi((s) => s.toast);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-36 z-[80] flex justify-center px-4 md:bottom-24"
      role="status"
    >
      {toast ? (
        <p
          className="animate-fade-in bg-foreground text-background max-w-md rounded-xl px-4 py-2.5 text-sm shadow-lg"
          key={toast.id}
        >
          {toast.text}
        </p>
      ) : null}
    </div>
  );
}
