import { DEMO_EMAIL, DEMO_PASSWORD } from "@/lib/constants";
import { makeBars, seededRandom } from "@/lib/waveform";

import type { AttachmentDto, ChatDto, ContactDto, MeDto, MessageDto, StatusDto } from "../types";

export const ME_ID = "u_me";

export type StoredMessage = Omit<MessageDto, "replyTo"> & { replyToId: string | null };

export type StoredChat = Omit<ChatDto, "lastMessage"> & { messages: StoredMessage[] };

export interface MockDb {
  chats: StoredChat[];
  contacts: ContactDto[];
  me: MeDto;
  password: string;
  /** Counter used to make ids that sort in creation order. */
  seq: number;
  statuses: StatusDto[];
  /** Uploaded files waiting to be attached to a message. Not saved between visits. */
  uploads: Record<string, AttachmentDto>;
}

const person = (
  id: string,
  name: string,
  phone: string,
  about: string,
  hue: number,
  online = false,
): ContactDto => ({
  id,
  name,
  phone,
  about,
  hue,
  online,
  blocked: false,
  avatarUrl: null,
  saved: true,
});

const contacts: ContactDto[] = [
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

interface Spec {
  /** Minutes before now. */
  ago: number;
  /** "me", "system", or a contact id. */
  from: string;
  key?: string;
  reactions?: Record<string, string[]>;
  replyKey?: string;
  text?: string;
  voice?: number;
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

/** Older small talk, used so long chats have enough history to page through. */
function backlog(others: string[], count: number, startAgo: number, seed: number): Spec[] {
  const next = seededRandom(seed);
  const out: Spec[] = [];
  let ago = startAgo;
  for (let i = 0; i < count; i += 1) {
    ago += Math.round(30 + next() * 420);
    const mine = next() < 0.45;
    const pool = mine ? SMALL_TALK_ME : SMALL_TALK_THEM;
    out.push({
      from: mine ? "me" : others[Math.floor(next() * others.length)],
      text: pool[Math.floor(next() * pool.length)],
      ago,
    });
  }
  return out;
}

export function createSeed(now: number): MockDb {
  const db: MockDb = {
    seq: 0,
    me: {
      id: ME_ID,
      email: DEMO_EMAIL,
      name: "Alex Rivera",
      about: "Hey there, I am using Dovetalk.",
      avatarUrl: null,
      hue: 40,
      phone: null,
      preferences: { sounds: true, previews: true, enterToSend: true },
    },
    password: DEMO_PASSWORD,
    contacts: structuredClone(contacts),
    chats: [],
    statuses: [],
    uploads: {},
  };

  const ago = (minutes: number) => now - minutes * 60_000;
  const sender = (from: string) => (from === "me" ? ME_ID : from);

  /** Turns specs into stored messages, oldest first, with ids that sort in time order. */
  const build = (chatId: string, specs: Spec[]): StoredMessage[] => {
    const sorted = [...specs].sort((a, b) => b.ago - a.ago);
    const ids = new Map<string, string>();
    const messages = sorted.map((spec): StoredMessage => {
      db.seq += 1;
      const id = `m${String(db.seq).padStart(6, "0")}`;
      if (spec.key) {
        ids.set(spec.key, id);
      }
      const isVoice = spec.voice !== undefined;
      return {
        id,
        chatId,
        clientId: null,
        senderId: spec.from === "system" ? "system" : sender(spec.from),
        kind: spec.from === "system" ? "system" : isVoice ? "voice" : "text",
        text: spec.text ?? null,
        duration: spec.voice ?? null,
        bars: isVoice ? makeBars(db.seq * 7919) : null,
        attachment: null,
        createdAt: ago(spec.ago),
        replyToId: null,
        reactions: Object.fromEntries(
          Object.entries(spec.reactions ?? {}).map(([emoji, who]) => [emoji, who.map(sender)]),
        ),
        edited: false,
        deleted: false,
        forwarded: false,
        ...(spec.replyKey ? { replyToId: spec.replyKey } : {}),
      };
    });
    // Replace reply keys with the real ids.
    for (const m of messages) {
      if (m.replyToId) {
        m.replyToId = ids.get(m.replyToId) ?? null;
      }
    }
    return messages;
  };

  const addDirect = (
    contactId: string,
    specs: Spec[],
    extra: { unread?: number; archived?: boolean; pinned?: boolean } = {},
  ) => {
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact) {
      throw new Error(`Unknown seed contact ${contactId}.`);
    }
    const id = `chat-${contactId}`;
    const messages = build(id, specs);
    db.chats.push({
      id,
      type: "direct",
      name: null,
      hue: contact.hue,
      memberIds: [contactId],
      unread: extra.unread ?? 0,
      archived: extra.archived ?? false,
      pinned: extra.pinned ?? false,
      muted: false,
      createdAt: messages[0]?.createdAt ?? now,
      messages,
    });
  };

  addDirect(
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
  );
  addDirect("c2", [
    { from: "c2", text: "Did you get a chance to look at the handoff doc?", ago: 1500 },
    { from: "me", text: "Reading it now. The migration section is clear.", ago: 1490 },
    { from: "c2", text: "Nice. Shout if anything is unclear before Friday.", ago: 1480 },
    { key: "handoff", from: "me", text: "Will do. I added two comments on page 3.", ago: 45 },
    { from: "c2", text: "Saw them. Fixing both this afternoon.", ago: 40, replyKey: "handoff" },
  ]);
  addDirect(
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
  );
  addDirect("c4", [
    {
      from: "c4",
      text: "Lunch tomorrow? There is a new ramen counter near the office.",
      ago: 1900,
    },
    { from: "me", text: "In. Noon works for me.", ago: 1850 },
    { from: "c4", text: "Noon it is. I will grab us a spot.", ago: 1800 },
  ]);
  addDirect("c5", [
    { from: "me", text: "Your monstera is thriving, by the way.", ago: 3000 },
    { from: "c5", text: "Haha, thanks. I finally moved it next to the east window.", ago: 2950 },
    { from: "c5", text: "Want a cutting? It has grown a lot.", ago: 2900 },
  ]);
  addDirect("c6", [
    { from: "c6", text: "What time should we meet on Saturday?", ago: 19_600 },
    { from: "me", text: "Ten works. I will bring the camera.", ago: 19_500 },
  ]);
  addDirect("c7", [
    { from: "c7", text: "Thanks for covering my shift, I owe you one.", ago: 7300 },
    { from: "me", text: "No problem at all. Get some rest.", ago: 7200 },
  ]);
  addDirect(
    "c8",
    [
      { from: "c8", text: "Invoice sent. Let me know if the totals look off.", ago: 20_000 },
      { from: "me", text: "Got it, paying on the first.", ago: 19_900 },
    ],
    { archived: true },
  );
  addDirect(
    "c9",
    [
      { from: "c9", text: "Photos from the trip are in the shared album.", ago: 30_000 },
      { from: "me", text: "Amazing, looking through them now.", ago: 29_900 },
    ],
    { archived: true },
  );

  const hikers = "group-hikers";
  const hikerMessages = build(hikers, [
    ...backlog(["c1", "c3", "c5", "c10"], 40, 8100, 29),
    { from: "system", text: "Imogen created this group", ago: 20_000 },
    { from: "c1", text: "Saturday hike, who is in?", ago: 7900 },
    { from: "me", text: "In!", ago: 7890, reactions: { "🎉": ["c1", "c3"] } },
    { from: "c3", text: "Count me in too.", ago: 7880 },
    { from: "c10", text: "Forecast looks clear until noon.", ago: 95 },
    { from: "c5", text: "Then we start at 8 and finish before the clouds.", ago: 92 },
    { from: "c10", text: "I will bring a thermos of tea.", ago: 88 },
  ]);
  db.chats.push({
    id: hikers,
    type: "group",
    name: "Weekend hikers",
    hue: 160,
    memberIds: ["c1", "c3", "c5", "c10"],
    unread: 3,
    archived: false,
    pinned: false,
    muted: false,
    createdAt: hikerMessages[0].createdAt,
    messages: hikerMessages,
  });

  const studio = "group-studio";
  db.chats.push({
    id: studio,
    type: "group",
    name: "Studio crew",
    hue: 20,
    memberIds: ["c2", "c4", "c6"],
    unread: 0,
    archived: false,
    pinned: true,
    muted: false,
    createdAt: ago(400),
    messages: build(studio, [
      { from: "c4", text: "Moodboard is updated, take a look when you can.", ago: 400 },
      { from: "c2", text: "Love the green palette.", ago: 380 },
      { from: "me", text: "Agreed. Let us lock the type this week.", ago: 300 },
      { from: "c6", text: "I can present the options on Thursday.", ago: 290 },
    ]),
  });

  const status = (ownerId: string, text: string, color: number, minutes: number, seen = false) => {
    db.seq += 1;
    db.statuses.push({
      id: `s${db.seq}`,
      ownerId,
      text,
      color,
      createdAt: ago(minutes),
      seen,
    });
  };
  status("c1", "Booked the window table.", 1, 25);
  status("c1", "Pasta night, finally.", 3, 12);
  status("c3", "Got the call back. Thank you all.", 0, 130);
  status("c11", "Studio is open until six today.", 2, 300);
  status("c5", "New cutting, day one.", 4, 600);
  status("c9", "Back from the coast.", 5, 900, true);

  return db;
}
