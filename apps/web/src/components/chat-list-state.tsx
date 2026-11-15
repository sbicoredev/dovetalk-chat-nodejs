"use client";

import { Button } from "@/components/ui/button";

export function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-1 px-3 py-2" role="status">
      {Array.from({ length: 7 }, (_, i) => (
        <div className="flex items-center gap-3 px-1 py-2.5" key={i}>
          <div className="bg-muted size-11 animate-pulse rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="bg-muted h-3.5 w-2/5 animate-pulse rounded" />
            <div className="bg-muted h-3 w-4/5 animate-pulse rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center" role="alert">
      <p className="text-muted-foreground text-sm">{message}</p>
      <Button onClick={onRetry} size="sm">
        Try again
      </Button>
    </div>
  );
}
