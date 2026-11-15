import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const WHITESPACE = /\s+/u;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Short label for the chat list, e.g. "10 min", "3 h", "Yesterday". */
export function formatRelative(ts: number, now: number) {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / MIN);
  if (min < 1) {
    return "Now";
  }
  if (min < 60) {
    return `${min} min`;
  }
  const hours = Math.floor(diff / HOUR);
  if (hours < 24) {
    return `${hours} h`;
  }
  const days = Math.floor(diff / DAY);
  if (days === 1) {
    return "Yesterday";
  }
  if (days <= 30) {
    return `${days} days`;
  }
  return `${Math.floor(days / 30)} mo`;
}

/** Longer label for statuses, e.g. "Just now", "25 min ago". */
export function formatAgo(ts: number, now: number) {
  const label = formatRelative(ts, now);
  if (label === "Now") {
    return "Just now";
  }
  if (label === "Yesterday") {
    return label;
  }
  return `${label} ago`;
}

/** Whole days between a timestamp and now, used to group messages by day. */
export function dayBucket(ts: number, now: number) {
  return Math.floor(Math.max(0, now - ts) / DAY);
}

export function dayLabel(bucket: number) {
  if (bucket === 0) {
    return "Today";
  }
  if (bucket === 1) {
    return "Yesterday";
  }
  return `${bucket} days ago`;
}

/** Local clock time. Only call this after mount, since the server timezone differs. */
export function formatClock(ts: number) {
  const d = new Date(ts);
  let h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function formatDuration(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function initials(name: string) {
  const parts = name.trim().split(WHITESPACE).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function firstName(name: string) {
  return name.trim().split(WHITESPACE)[0] ?? name;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Splits text into pieces, flagging the ones that match the query (case-insensitive). */
export function splitMatches(value: string, query: string) {
  const q = query.trim();
  if (!q) {
    return [{ text: value, match: false }];
  }
  const lower = value.toLowerCase();
  const needle = q.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let from = 0;
  while (true) {
    const at = lower.indexOf(needle, from);
    if (at === -1) {
      break;
    }
    if (at > from) {
      parts.push({ text: value.slice(from, at), match: false });
    }
    parts.push({ text: value.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < value.length) {
    parts.push({ text: value.slice(from), match: false });
  }
  return parts;
}
