/** What one person's contact says about whether somebody is online. */
export interface OnlineInput {
  /** Either of the two has blocked the other. Blocked people lose presence from each other (docs/edge-cases.md, #19). */
  blockedEitherWay: boolean;
  /** A bot is as available as it was seeded, whoever looks. */
  botOnlineDefault: boolean;
  isBot: boolean;
  /** The person is connected, as announced. Not used for bots. */
  live: boolean;
}

/**
 * The one rule for `ContactDto.online` and `presence` events, so the list and the live updates
 * always agree.
 */
export function onlineFor(input: OnlineInput): boolean {
  if (input.isBot) {
    return input.botOnlineDefault;
  }
  return input.live && !input.blockedEitherWay;
}

/** Runs `work` over `items`, at most `limit` at a time. Failures are the callback's to handle. */
export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      // biome-ignore lint/performance/noAwaitInLoops: each lane takes one item after another so that no more than `limit` run at once.
      await work(item as T);
    }
  });
  await Promise.all(lanes);
}
