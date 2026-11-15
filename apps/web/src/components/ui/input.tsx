import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "border-border bg-surface text-foreground placeholder:text-muted-foreground h-10 w-full rounded-[10px] border px-3 text-sm",
        className,
      )}
      {...props}
    />
  );
}
