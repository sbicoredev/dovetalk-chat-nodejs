"use client";

import { useEffect, useState } from "react";

/** The current time, refreshed every 30 seconds so "10 min" labels stay accurate. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
