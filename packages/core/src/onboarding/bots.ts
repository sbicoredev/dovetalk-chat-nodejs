import { v5 } from "uuid";

import type { NewUser } from "@dovetalk/db";

import { SEED_PEOPLE } from "./seed-data.js";

/**
 * The namespace the shared bots' ids are made from. Never change it: every database that was
 * seeded has these ids, and an account made later has to find the same bots.
 */
export const BOT_NAMESPACE = "792d42e3-3db3-468a-b548-76ffd936d2da";

/**
 * The id of the shared bot for a seed person (`c1` to `c14`). It is derived, not random, so
 * every instance and every database agrees on it without asking anyone: onboarding can build
 * its rows in memory and the bots can be inserted `ON CONFLICT DO NOTHING`.
 */
export const botId = (key: string): string => v5(`bot:${key}`, BOT_NAMESPACE);

/**
 * The 14 shared bot users. A bot has no email, no password and no phone of its own: the number
 * people see is on each owner's contact row (docs/edge-cases.md, #2).
 */
export function seedBotRows(): NewUser[] {
  return SEED_PEOPLE.map((person) => ({
    id: botId(person.key),
    name: person.name,
    about: person.about,
    hue: person.hue,
    isBot: true,
    botOnlineDefault: person.online,
  }));
}
