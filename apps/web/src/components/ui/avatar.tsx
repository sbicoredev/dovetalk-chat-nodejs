import { Users } from "lucide-react";
import type { CSSProperties } from "react";

import { cn, initials } from "@/lib/utils";

const sizes = {
  xs: "size-6 text-[10px]",
  sm: "size-9 text-xs",
  md: "size-11 text-sm",
  lg: "size-14 text-base",
  xl: "size-24 text-3xl",
} as const;

interface AvatarProps {
  className?: string;
  group?: boolean;
  hue: number;
  name: string;
  online?: boolean;
  /** Draws a story ring: marigold when there is something new to see. */
  ring?: "unseen" | "seen";
  size?: keyof typeof sizes;
  /** A profile photo (data URL or URL). Falls back to initials. */
  src?: string;
}

export function Avatar({
  name,
  hue,
  size = "md",
  group = false,
  src,
  ring,
  online,
  className,
}: AvatarProps) {
  const circle = (
    <span
      aria-hidden="true"
      className={cn(
        "font-display inline-grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold",
        "bg-[hsl(var(--h)_60%_88%)] text-[hsl(var(--h)_45%_26%)]",
        "dark:bg-[hsl(var(--h)_35%_28%)] dark:text-[hsl(var(--h)_70%_88%)]",
        sizes[size],
      )}
      style={{ "--h": hue } as CSSProperties}
    >
      {src ? (
        // biome-ignore lint/performance/noImgElement: attachments and profile photos are blob:, data: and presigned URLs that next/image cannot optimise.
        // biome-ignore lint/correctness/useImageSize: size-full fills the circle, whose size is a Tailwind class per variant; a pixel table here would duplicate it.
        <img alt="" className="size-full object-cover" src={src} />
      ) : group ? (
        <Users className="size-1/2" />
      ) : (
        initials(name)
      )}
    </span>
  );

  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      {ring ? (
        <span
          className={cn(
            "inline-flex rounded-full p-[3px]",
            ring === "unseen" ? "bg-accent" : "bg-border",
          )}
        >
          <span className="bg-surface rounded-full p-[2px]">{circle}</span>
        </span>
      ) : (
        circle
      )}
      {online ? (
        <span className="ring-surface absolute right-0 bottom-0 size-3 rounded-full bg-emerald-500 ring-2">
          <span className="sr-only">Online</span>
        </span>
      ) : null}
    </span>
  );
}
