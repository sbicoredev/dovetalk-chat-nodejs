import { must } from "../invariant.js";
import { seededRandom } from "./waveform.js";

/**
 * What a new account starts with, written as data. It is a port of `createSeed` in
 * `apps/web/src/lib/api/mock/seed.ts`, so the real API opens on the same conversations the
 * prototype did. People are named by their prototype key (`c1` to `c14`); `planOnboarding`
 * turns the keys into real ids.
 *
 * It seeds contacts, chats, messages, the reactions on them and the statuses.
 */

export interface SeedPerson {
  about: string;
  hue: number;
  /** The prototype's contact id, `c1` to `c14`. Also what makes the bot's id (see `botId`). */
  key: string;
  name: string;
  /** The bot's presence until real presence arrives. */
  online: boolean;
  /** The number as the viewer's contact row shows it. It is not on the bot's own row. */
  phone: string;
}

const person = (
  key: string,
  name: string,
  phone: string,
  about: string,
  hue: number,
  online = false,
): SeedPerson => ({ key, name, phone, about, hue, online });

export const SEED_PEOPLE: readonly SeedPerson[] = [
  person("c1", "Imogen Varley", "(555) 010-0142", "Always up for pasta.", 262, true),
  person("c2", "Tobias Kellner", "(555) 010-0178", "In meetings until Friday.", 205),
  person("c3", "Priya Anand", "(555) 010-0119", "Product designer, tea drinker.", 335, true),
  person("c4", "Marcus Oyelaran", "(555) 010-0163", "Lunch is a serious topic.", 28),
  person("c5", "Linnea Hoff", "(555) 010-0127", "Plants over people, sometimes.", 150, true),
  person("c6", "Dario Bellamy", "(555) 010-0194", "Photographer, mostly on the road.", 12),
  person("c7", "Sana Qureshi", "(555) 010-0136", "Night shifts, day naps.", 180),
  person("c8", "Wren Castellano", "(555) 010-0155", "Freelance illustrator.", 300),
  person("c9", "Hugo Lindqvist", "(555) 010-0102", "Off the grid, back soon.", 95),
  person("c10", "Amara Okafor", "(555) 010-0187", "Trail maps and thermoses.", 48, true),
  person("c11", "Felix Moreau", "(555) 010-0171", "Ceramics studio, open daily.", 222),
  person("c12", "Noor Haddad", "(555) 010-0148", "Learning to bake sourdough.", 350, true),
  person("c13", "Elodie Brandt", "(555) 010-0113", "Reading three books at once.", 120),
  person("c14", "Jonas Petrov", "(555) 010-0199", "Cycling before breakfast.", 240),
];

/** Who says a message: the new account's owner, the system, or a person's key. */
export type SeedSender = "me" | "system" | string;

export interface SeedMessage {
  /** Minutes before the account was made. */
  ago: number;
  from: SeedSender;
  /** For `from: "system"`: the person who created the group. */
  groupCreatedBy?: string;
  /** Lets a later message in the same chat reply to this one. */
  key?: string;
  /** Emoji to the people (prototype keys) who reacted with it. */
  reactions?: Record<string, string[]>;
  /** The `key` of an earlier message in the same chat. */
  replyKey?: string;
  text?: string;
  /** A voice message of this many seconds. */
  voice?: number;
}

export interface SeedDirectChat {
  archived: boolean;
  messages: SeedMessage[];
  person: string;
  pinned: boolean;
  unread: number;
}

export interface SeedGroup {
  /** When the group was made, in minutes before now. Without it: the time of its first message. */
  createdAgo?: number;
  /** `me`, or the key of the person who made the group. Only the creator can remove members. */
  createdBy: "me" | string;
  hue: number;
  key: string;
  /** The other people, in the order the group lists them. */
  members: string[];
  messages: SeedMessage[];
  name: string;
  pinned: boolean;
  unread: number;
}

const SMALL_TALK_ME = [
  "Sounds good.",
  "Let me check my calendar.",
  "Thanks for sending that over.",
  "Can we do tomorrow instead?",
  "Just saw this, sorry for the delay.",
  "That works for me.",
  "I will bring snacks.",
  "Ha, no way.",
  "Almost there, five more minutes.",
  "Did you see the weather forecast?",
  "Remind me to call them back.",
  "Good idea, let us do that.",
];

const SMALL_TALK_THEM = [
  "Are you around later?",
  "I found the receipt, sending a photo.",
  "Did you get my last message?",
  "Perfect, thank you!",
  "Let me know when you are free.",
  "I will be there around six.",
  "That was a great evening.",
  "Do you need anything from the shop?",
  "I will text you when I leave.",
  "Not yet, still working on it.",
  "Happy to help with that.",
  "See you soon!",
];

/** One item of a non-empty list, drawn with the seeded generator (one draw per call). */
function pick<T>(items: readonly T[], next: () => number): T {
  return must(items[Math.floor(next() * items.length)], "a seed item");
}

/**
 * Older small talk, so long chats have enough history to page through. The draws must happen in
 * this order: the same seed has to give the same conversation as the prototype.
 */
export function backlog(
  others: string[],
  count: number,
  startAgo: number,
  seed: number,
): SeedMessage[] {
  const next = seededRandom(seed);
  const out: SeedMessage[] = [];
  let ago = startAgo;
  for (let i = 0; i < count; i += 1) {
    ago += Math.round(30 + next() * 420);
    const mine = next() < 0.45;
    const pool = mine ? SMALL_TALK_ME : SMALL_TALK_THEM;
    out.push({
      from: mine ? "me" : pick(others, next),
      text: pick(pool, next),
      ago,
    });
  }
  return out;
}

const direct = (
  personKey: string,
  messages: SeedMessage[],
  extra: { unread?: number; archived?: boolean; pinned?: boolean } = {},
): SeedDirectChat => ({
  person: personKey,
  messages,
  unread: extra.unread ?? 0,
  archived: extra.archived ?? false,
  pinned: extra.pinned ?? false,
});

/** The nine direct chats, in the order the prototype built them. c8 and c9 are archived. */
export const SEED_DIRECT_CHATS: readonly SeedDirectChat[] = [
  direct(
    "c1",
    [
      ...backlog(["c1"], 70, 260, 11),
      { from: "c1", text: "This is the start of your conversation with Imogen.", ago: 9000 },
      { from: "c1", text: "Are we still on for dinner tonight?", ago: 200 },
      { from: "me", text: "Yes. How about 7 at the new pasta place?", ago: 195 },
      { from: "c1", text: "Perfect. I will book a table by the window.", ago: 190 },
      { from: "me", text: "Great, see you there.", ago: 185, reactions: { "❤️": ["c1"] } },
      { from: "c1", text: "Running ten minutes late, sorry!", ago: 14 },
      { from: "c1", text: "Save me a seat and order the burrata.", ago: 10 },
    ],
    { unread: 2 },
  ),
  direct("c2", [
    { from: "c2", text: "Did you get a chance to look at the handoff doc?", ago: 1500 },
    { from: "me", text: "Reading it now. The migration section is clear.", ago: 1490 },
    { from: "c2", text: "Nice. Shout if anything is unclear before Friday.", ago: 1480 },
    { key: "handoff", from: "me", text: "Will do. I added two comments on page 3.", ago: 45 },
    { from: "c2", text: "Saw them. Fixing both this afternoon.", ago: 40, replyKey: "handoff" },
  ]),
  direct(
    "c3",
    [
      { from: "me", text: "How did the interview go?", ago: 300 },
      { from: "c3", text: "Better than I expected!", ago: 290 },
      { from: "c3", voice: 14, ago: 285 },
      {
        from: "c3",
        text: "Told you in the voice note, they asked about the pricing project.",
        ago: 284,
      },
      { from: "me", text: "That is such good news. Celebrate this weekend?", ago: 182 },
      { from: "c3", text: "Definitely. I will send options tomorrow.", ago: 180 },
    ],
    { unread: 1 },
  ),
  direct("c4", [
    {
      from: "c4",
      text: "Lunch tomorrow? There is a new ramen counter near the office.",
      ago: 1900,
    },
    { from: "me", text: "In. Noon works for me.", ago: 1850 },
    { from: "c4", text: "Noon it is. I will grab us a spot.", ago: 1800 },
  ]),
  direct("c5", [
    { from: "me", text: "Your monstera is thriving, by the way.", ago: 3000 },
    { from: "c5", text: "Haha, thanks. I finally moved it next to the east window.", ago: 2950 },
    { from: "c5", text: "Want a cutting? It has grown a lot.", ago: 2900 },
  ]),
  direct("c6", [
    { from: "c6", text: "What time should we meet on Saturday?", ago: 19_600 },
    { from: "me", text: "Ten works. I will bring the camera.", ago: 19_500 },
  ]),
  direct("c7", [
    { from: "c7", text: "Thanks for covering my shift, I owe you one.", ago: 7300 },
    { from: "me", text: "No problem at all. Get some rest.", ago: 7200 },
  ]),
  direct(
    "c8",
    [
      { from: "c8", text: "Invoice sent. Let me know if the totals look off.", ago: 20_000 },
      { from: "me", text: "Got it, paying on the first.", ago: 19_900 },
    ],
    { archived: true },
  ),
  direct(
    "c9",
    [
      { from: "c9", text: "Photos from the trip are in the shared album.", ago: 30_000 },
      { from: "me", text: "Amazing, looking through them now.", ago: 29_900 },
    ],
    { archived: true },
  ),
];

/**
 * The two groups. The hikers were made by a bot, so the new account can add people but not
 * remove them. The studio crew was made by the new account, so it can do both.
 */
export const SEED_GROUPS: readonly SeedGroup[] = [
  {
    key: "hikers",
    name: "Weekend hikers",
    hue: 160,
    members: ["c1", "c3", "c5", "c10"],
    createdBy: "c1",
    unread: 3,
    pinned: false,
    messages: [
      ...backlog(["c1", "c3", "c5", "c10"], 40, 8100, 29),
      { from: "system", groupCreatedBy: "c1", ago: 20_000 },
      { from: "c1", text: "Saturday hike, who is in?", ago: 7900 },
      { from: "me", text: "In!", ago: 7890, reactions: { "🎉": ["c1", "c3"] } },
      { from: "c3", text: "Count me in too.", ago: 7880 },
      { from: "c10", text: "Forecast looks clear until noon.", ago: 95 },
      { from: "c5", text: "Then we start at 8 and finish before the clouds.", ago: 92 },
      { from: "c10", text: "I will bring a thermos of tea.", ago: 88 },
    ],
  },
  {
    key: "studio",
    name: "Studio crew",
    hue: 20,
    members: ["c2", "c4", "c6"],
    createdBy: "me",
    unread: 0,
    pinned: true,
    createdAgo: 400,
    messages: [
      { from: "c4", text: "Moodboard is updated, take a look when you can.", ago: 400 },
      { from: "c2", text: "Love the green palette.", ago: 380 },
      { from: "me", text: "Agreed. Let us lock the type this week.", ago: 300 },
      { from: "c6", text: "I can present the options on Thursday.", ago: 290 },
    ],
  },
];

/** A status the shared bots have up when an account is made. */
export interface SeedStatus {
  /** Minutes before the account was made. */
  ago: number;
  color: number;
  /** The person's prototype key. */
  person: string;
  /** The prototype marks one as already seen. */
  seen?: boolean;
  text: string;
}

/** The six statuses of the prototype, oldest in the list first as it builds them. */
export const SEED_STATUSES: readonly SeedStatus[] = [
  { person: "c1", text: "Booked the window table.", color: 1, ago: 25 },
  { person: "c1", text: "Pasta night, finally.", color: 3, ago: 12 },
  { person: "c3", text: "Got the call back. Thank you all.", color: 0, ago: 130 },
  { person: "c11", text: "Studio is open until six today.", color: 2, ago: 300 },
  { person: "c5", text: "New cutting, day one.", color: 4, ago: 600 },
  { person: "c9", text: "Back from the coast.", color: 5, ago: 900, seen: true },
];
