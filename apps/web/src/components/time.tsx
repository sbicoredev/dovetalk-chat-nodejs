import { formatClock } from "@/lib/utils";

/** Clock time for a message. */
export function Time({ ts }: { ts: number }) {
  return <>{formatClock(ts)}</>;
}
