import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GROUP_MEMBERS_MAX } from "@dovetalk/contracts";
import { newId, schema } from "@dovetalk/db";
import { byCodeUnit } from "@dovetalk/testkit";

import { directKey } from "../src/conversations/ids.js";
import { codeOf } from "./support/helpers.js";
import { createWorld, type World } from "./support/world.js";

const { contacts, users, chats, chatMembers } = schema;

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

let phoneCounter = 0;
/** A fresh valid number that no other test uses. */
const nextPhone = () => {
  phoneCounter += 1;
  return `+1 555 ${String(phoneCounter).padStart(7, "0")}`;
};

const rowsOf = (ownerId: string) =>
  w.db.select().from(contacts).where(eq(contacts.ownerId, ownerId));

describe("ContactsService.create", () => {
  it("makes a ghost bot for a number nobody has, with the phone only on the contact row", async () => {
    const owner = await w.user();
    const phone = nextPhone();
    const { contact, created } = await w.contacts.create(owner.id, { name: "  Casey  ", phone });
    expect(created).toBe(true);
    expect(contact).toMatchObject({
      name: "Casey",
      phone,
      about: "Hey there, I am using Dovetalk.",
      online: false,
      blocked: false,
      avatarUrl: null,
      saved: true,
    });

    const [row] = await rowsOf(owner.id);
    const [ghost] = await w.db.select().from(users).where(eq(users.id, row!.linkedUserId));
    expect(ghost).toMatchObject({ isBot: true, ghostOwnerId: owner.id, phone: null, email: null });
  });

  it("lets two owners add the same unknown number, each with a ghost of their own", async () => {
    const a = await w.user();
    const b = await w.user();
    const phone = nextPhone();
    const first = await w.contacts.create(a.id, { name: "Casey", phone });
    const second = await w.contacts.create(b.id, { name: "Casey", phone });
    expect(second.created).toBe(true);
    expect(second.contact.id).not.toBe(first.contact.id);
  });

  it("links a number a registered person signed up with, and lets their profile show through", async () => {
    const owner = await w.user();
    const person = await w.user({
      name: "Priya Anand",
      phone: "+1 (555) 010-0119",
      about: "Tea.",
      hue: 335,
    });
    const { contact, created } = await w.contacts.create(owner.id, {
      name: "Priya",
      phone: "+1 555 010 0119",
    });
    expect(created).toBe(true);
    // The owner's name and number win; about and colour are the person's own.
    expect(contact).toMatchObject({
      name: "Priya",
      phone: "+1 555 010 0119",
      about: "Tea.",
      hue: 335,
    });
    const [row] = await rowsOf(owner.id);
    expect(row!.linkedUserId).toBe(person.id);
  });

  it("matches numbers on their digits, however they are written", async () => {
    const owner = await w.user();
    await w.user({ phone: "555-010-0120" });
    const a = await w.contacts.create(owner.id, { name: "A", phone: "(555) 010 0120" });
    const b = await w.contacts.create(owner.id, { name: "A again", phone: "+5550100120" });
    expect(b.created).toBe(false);
    expect(b.contact.id).toBe(a.contact.id);
  });

  it("returns the existing contact for a number the owner already has, without renaming it", async () => {
    const owner = await w.user();
    const phone = nextPhone();
    const first = await w.contacts.create(owner.id, { name: "Casey", phone });
    const again = await w.contacts.create(owner.id, { name: "Somebody else", phone });
    expect(again.created).toBe(false);
    expect(again.contact).toEqual(first.contact);
  });

  it("puts a deleted contact back, under the new name", async () => {
    const owner = await w.user();
    const phone = nextPhone();
    const first = await w.contacts.create(owner.id, { name: "Casey", phone });
    await w.contacts.remove(owner.id, first.contact.id);

    const back = await w.contacts.create(owner.id, { name: "Casey Jones", phone });
    expect(back.created).toBe(false);
    expect(back.contact).toMatchObject({ id: first.contact.id, name: "Casey Jones", saved: true });
  });

  it("saves a person who messaged first when the owner adds their number", async () => {
    const owner = await w.user();
    const stranger = await w.user({ name: "Stranger Danger", phone: "+1 555 010 0121" });
    await w.contacts.ensureContact(w.db, owner.id, stranger.id);
    const [unsaved] = await rowsOf(owner.id);
    expect(unsaved).toMatchObject({ saved: false, name: "Stranger Danger" });

    const { contact, created } = await w.contacts.create(owner.id, {
      name: "Stranger",
      phone: "+1 555 010 0121",
    });
    expect(created).toBe(false);
    expect(contact).toMatchObject({ id: unsaved!.id, name: "Stranger", saved: true });
  });

  it("refuses the owner's own number, in any spelling", async () => {
    const owner = await w.user({ phone: "+1 (555) 010-0122" });
    expect(
      await codeOf(() => w.contacts.create(owner.id, { name: "Me", phone: "+1 555 010 0122" })),
    ).toBe("VALIDATION_ERROR");
    expect(await rowsOf(owner.id)).toHaveLength(0);
  });

  it("validates the name and the number null by null", async () => {
    const owner = await w.user();
    const code = (name: string, phone: string) =>
      codeOf(() => w.contacts.create(owner.id, { name, phone }));
    expect(await code("", nextPhone())).toBe("VALIDATION_ERROR");
    expect(await code("   ", nextPhone())).toBe("VALIDATION_ERROR");
    expect(await code("x".repeat(61), nextPhone())).toBe("VALIDATION_ERROR");
    expect(await code("Casey", "12345")).toBe("VALIDATION_ERROR");
    expect(await code("Casey", "abcdefghij")).toBe("VALIDATION_ERROR");
    expect(await code("Casey", "1".repeat(16))).toBe("VALIDATION_ERROR");
    expect(await rowsOf(owner.id)).toHaveLength(0);
  });

  it("makes one contact, not two, when the same number is added at once", async () => {
    const owner = await w.user();
    const phone = nextPhone();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => w.contacts.create(owner.id, { name: "Casey", phone })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.contact.id)).size).toBe(1);
    expect(await rowsOf(owner.id)).toHaveLength(1);
  });

  it("does not link a bot's number: bots have no phone on users, so a number never reaches one", async () => {
    const owner = await w.user();
    const bot = await w.bot({ name: "Shared Bot" });
    const { contact } = await w.contacts.create(owner.id, { name: "Number", phone: nextPhone() });
    const [row] = await rowsOf(owner.id);
    expect(row!.linkedUserId).not.toBe(bot.id);
    expect(contact.saved).toBe(true);
  });
});

describe("ContactsService.list", () => {
  it("returns only the viewer's own rows, saved or not, oldest first", async () => {
    const a = await w.user();
    const b = await w.user();
    const first = await w.contacts.create(a.id, { name: "First", phone: nextPhone() });
    const second = await w.contacts.create(a.id, { name: "Second", phone: nextPhone() });
    await w.contacts.create(b.id, { name: "Not yours", phone: nextPhone() });
    await w.contacts.remove(a.id, first.contact.id);

    const list = await w.contacts.list(a.id);
    expect(list.map((c) => c.id)).toEqual([first.contact.id, second.contact.id]);
    expect(list.map((c) => c.saved)).toEqual([false, true]);
    expect(await w.contacts.list(b.id)).toHaveLength(1);
  });

  it("is empty for somebody with no contacts", async () => {
    expect(await w.contacts.list((await w.user()).id)).toEqual([]);
  });
});

describe("ContactsService.update", () => {
  it("changes only the fields that were sent, and trims them", async () => {
    const owner = await w.user();
    const { contact } = await w.contacts.create(owner.id, { name: "Casey", phone: nextPhone() });
    const updated = await w.contacts.update(owner.id, contact.id, { about: "  Hi  " });
    expect(updated).toMatchObject({ name: "Casey", phone: contact.phone, about: "Hi" });

    const renamed = await w.contacts.update(owner.id, contact.id, {
      name: " Casey J ",
      phone: "+1 555 010 9999",
    });
    expect(renamed).toMatchObject({ name: "Casey J", phone: "+1 555 010 9999", about: "Hi" });
  });

  it("rejects empty names, bad numbers and long about text", async () => {
    const owner = await w.user();
    const { contact } = await w.contacts.create(owner.id, { name: "Casey", phone: nextPhone() });
    const code = (input: Parameters<typeof w.contacts.update>[2]) =>
      codeOf(() => w.contacts.update(owner.id, contact.id, input));
    expect(await code({ name: "  " })).toBe("VALIDATION_ERROR");
    expect(await code({ phone: "123" })).toBe("VALIDATION_ERROR");
    expect(await code({ about: "x".repeat(141) })).toBe("VALIDATION_ERROR");
    expect(await w.contacts.list(owner.id)).toEqual([contact]);
  });

  it("answers 409 PHONE_TAKEN for a number another saved contact has, but not for its own", async () => {
    const owner = await w.user();
    const a = await w.contacts.create(owner.id, { name: "A", phone: "555 010 3001" });
    const b = await w.contacts.create(owner.id, { name: "B", phone: "555 010 3002" });
    expect(
      await codeOf(() => w.contacts.update(owner.id, b.contact.id, { phone: "(555) 010-3001" })),
    ).toBe("PHONE_TAKEN");
    // Writing the same number again, differently spelled, is not a clash with itself.
    await expect(
      w.contacts.update(owner.id, a.contact.id, { phone: "+1 555 010 3001" }),
    ).resolves.toBeDefined();
  });

  it("does not count an unsaved row against the owner", async () => {
    const owner = await w.user();
    const stranger = await w.user({ phone: "555 010 3010" });
    await w.contacts.ensureContact(w.db, owner.id, stranger.id);
    const mine = await w.contacts.create(owner.id, { name: "Mine", phone: "555 010 3011" });
    // The unsaved copy of the stranger has this number, but is not in the address book.
    await expect(
      w.contacts.update(owner.id, mine.contact.id, { phone: "555 010 3010" }),
    ).resolves.toBeDefined();
  });

  it("refuses the owner's own number", async () => {
    const owner = await w.user({ phone: "555 010 3020" });
    const { contact } = await w.contacts.create(owner.id, { name: "A", phone: nextPhone() });
    expect(
      await codeOf(() => w.contacts.update(owner.id, contact.id, { phone: "555-010-3020" })),
    ).toBe("VALIDATION_ERROR");
  });

  it("is 404 for an unsaved contact, another person's contact, an unknown id and a malformed id", async () => {
    const a = await w.user();
    const b = await w.user();
    const mine = await w.contacts.create(a.id, { name: "Mine", phone: nextPhone() });
    const gone = await w.contacts.create(a.id, { name: "Gone", phone: nextPhone() });
    await w.contacts.remove(a.id, gone.contact.id);

    const code = (owner: string, id: string) =>
      codeOf(() => w.contacts.update(owner, id, { name: "X" }));
    expect(await code(a.id, gone.contact.id)).toBe("CONTACT_NOT_FOUND");
    expect(await code(b.id, mine.contact.id)).toBe("CONTACT_NOT_FOUND");
    expect(await code(a.id, newId())).toBe("CONTACT_NOT_FOUND");
    expect(await code(a.id, "not-a-uuid")).toBe("CONTACT_NOT_FOUND");
    // Another person's failed attempt changed nothing.
    expect((await w.contacts.list(a.id)).find((c) => c.id === mine.contact.id)?.name).toBe("Mine");
  });
});

describe("ContactsService.remove", () => {
  /** A direct chat between the owner and the contact's person, made by hand. */
  async function directChat(ownerId: string, otherId: string, lastSeq: number) {
    const [chat] = await w.db
      .insert(chats)
      .values({ type: "direct", directKey: directKey(ownerId, otherId), lastSeq })
      .returning();
    await w.db.insert(chatMembers).values([
      {
        chatId: chat!.id,
        userId: ownerId,
        unreadCount: 3,
        pinned: true,
        archived: true,
        muted: true,
      },
      { chatId: chat!.id, userId: otherId },
    ]);
    return chat!;
  }

  it("unsaves the contact, keeps the row and the block, and hides and resets the direct chat", async () => {
    const owner = await w.user();
    const { contact } = await w.contacts.create(owner.id, { name: "Casey", phone: nextPhone() });
    await w.contacts.setBlocked(owner.id, contact.id, true);
    const [row] = await rowsOf(owner.id);
    const chat = await directChat(owner.id, row!.linkedUserId, 7);

    await w.contacts.remove(owner.id, contact.id);

    const after = (await w.contacts.list(owner.id)).find((c) => c.id === contact.id);
    expect(after).toMatchObject({ saved: false, blocked: true });
    const [member] = await w.db
      .select()
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, owner.id)));
    expect(member).toMatchObject({
      clearedBeforeSeq: 7,
      unreadCount: 0,
      pinned: false,
      archived: false,
      muted: false,
    });
    expect(member!.hiddenAt).toBeInstanceOf(Date);
    // The other person's side is theirs and does not change.
    const [theirs] = await w.db
      .select()
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, row!.linkedUserId)));
    expect(theirs!.hiddenAt).toBeNull();
  });

  it("works for a contact with no chat, and is 404 the second time and for unsaved rows", async () => {
    const owner = await w.user();
    const { contact } = await w.contacts.create(owner.id, { name: "Casey", phone: nextPhone() });
    await expect(w.contacts.remove(owner.id, contact.id)).resolves.toBeUndefined();
    expect(await codeOf(() => w.contacts.remove(owner.id, contact.id))).toBe("CONTACT_NOT_FOUND");
    expect(await codeOf(() => w.contacts.remove(owner.id, "nope"))).toBe("CONTACT_NOT_FOUND");
  });

  it("cannot remove somebody else's contact", async () => {
    const a = await w.user();
    const b = await w.user();
    const { contact } = await w.contacts.create(a.id, { name: "Casey", phone: nextPhone() });
    expect(await codeOf(() => w.contacts.remove(b.id, contact.id))).toBe("CONTACT_NOT_FOUND");
    expect((await w.contacts.list(a.id))[0]).toMatchObject({ saved: true });
  });
});

describe("ContactsService.setBlocked", () => {
  it("blocks and unblocks, and works on an unsaved contact", async () => {
    const owner = await w.user();
    const stranger = await w.user();
    await w.contacts.ensureContact(w.db, owner.id, stranger.id);
    const [row] = await rowsOf(owner.id);

    expect(await w.contacts.setBlocked(owner.id, row!.id, true)).toMatchObject({
      blocked: true,
      saved: false,
    });
    expect(await w.contacts.setBlocked(owner.id, row!.id, false)).toMatchObject({ blocked: false });
  });

  it("is 404 for somebody else's contact and a malformed id", async () => {
    const a = await w.user();
    const b = await w.user();
    const { contact } = await w.contacts.create(a.id, { name: "Casey", phone: nextPhone() });
    expect(await codeOf(() => w.contacts.setBlocked(b.id, contact.id, true))).toBe(
      "CONTACT_NOT_FOUND",
    );
    expect(await codeOf(() => w.contacts.setBlocked(a.id, "x", true))).toBe("CONTACT_NOT_FOUND");
    expect((await w.contacts.list(a.id))[0]!.blocked).toBe(false);
  });
});

describe("ContactsService.ensureContact", () => {
  it("makes an unsaved row with the other person's name and number, once", async () => {
    const owner = await w.user();
    const other = await w.user({ name: "Pat Doe", phone: "555 010 4001" });
    await w.contacts.ensureContact(w.db, owner.id, other.id);
    await w.contacts.ensureContact(w.db, owner.id, other.id);
    expect(await w.contacts.list(owner.id)).toMatchObject([
      { name: "Pat Doe", phone: "555 010 4001", saved: false },
    ]);
  });

  it("leaves an existing row, saved under the owner's own name, exactly as it is", async () => {
    const owner = await w.user();
    const other = await w.user({ name: "Pat Doe", phone: "555 010 4002" });
    const { contact } = await w.contacts.create(owner.id, { name: "Patty", phone: "555 010 4002" });
    await w.contacts.ensureContact(w.db, owner.id, other.id);
    expect(await w.contacts.list(owner.id)).toEqual([contact]);
  });

  it("never makes a bot an owner, and never makes a contact for oneself", async () => {
    const bot = await w.bot();
    const person = await w.user();
    await w.contacts.ensureContact(w.db, bot.id, person.id);
    expect(await rowsOf(bot.id)).toHaveLength(0);
    await w.contacts.ensureContact(w.db, person.id, person.id);
    expect(await rowsOf(person.id)).toHaveLength(0);
  });
});

describe("ContactsService.ensureContacts", () => {
  async function chatOf(userIds: string[]) {
    const [chat] = await w.db
      .insert(chats)
      .values({ type: "group", name: "Group", hue: 1 })
      .returning();
    await w.db.insert(chatMembers).values(userIds.map((userId) => ({ chatId: chat!.id, userId })));
    return chat!;
  }

  it("gives every real member a contact for every other member, and bots none", async () => {
    const [a, b, c] = await Promise.all([w.user(), w.user(), w.user()]);
    const bot = await w.bot();
    const chat = await chatOf([a!.id, b!.id, c!.id, bot.id]);

    await w.contacts.ensureContacts(w.db, chat.id);

    for (const owner of [a!, b!, c!]) {
      const linked = (await rowsOf(owner.id)).map((r) => r.linkedUserId).sort(byCodeUnit);
      const expected = [a!, b!, c!, bot]
        .filter((u) => u.id !== owner.id)
        .map((u) => u.id)
        .sort(byCodeUnit);
      expect(linked).toEqual(expected);
    }
    expect(await rowsOf(bot.id)).toHaveLength(0);
  });

  it("is safe to run again and does not touch a saved contact", async () => {
    const [a, b] = await Promise.all([w.user(), w.user({ phone: "555 010 4010" })]);
    const mine = await w.contacts.create(a!.id, { name: "Bee", phone: "555 010 4010" });
    const chat = await chatOf([a!.id, b!.id]);
    await w.contacts.ensureContacts(w.db, chat.id);
    await w.contacts.ensureContacts(w.db, chat.id);
    expect(await w.contacts.list(a!.id)).toEqual([mine.contact]);
    expect(await rowsOf(b!.id)).toHaveLength(1);
  });

  it("ignores people who have left as owners, so a removed member gets no new rows", async () => {
    const [a, b, gone] = await Promise.all([w.user(), w.user(), w.user()]);
    const chat = await chatOf([a!.id, b!.id, gone!.id]);
    await w.db
      .update(chatMembers)
      .set({ leftAt: sql`now()` })
      .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, gone!.id)));
    await w.contacts.ensureContacts(w.db, chat.id);
    expect(await rowsOf(gone!.id)).toHaveLength(0);
    // ... but the others can still name them, for what they said before.
    expect((await rowsOf(a!.id)).map((r) => r.linkedUserId)).toContain(gone!.id);
  });

  it("copes with the largest group in one statement (65,000 rows is over the parameter limit)", async () => {
    const size = GROUP_MEMBERS_MAX + 1;
    const rows = await w.db
      .insert(users)
      .values(
        Array.from({ length: size }, (_, i) => ({
          email: `big-${i}-${newId()}@example.com`,
          passwordHash: "$argon2id$stub",
          name: `Member ${i}`,
          hue: 5,
        })),
      )
      .returning({ id: users.id });
    const chat = await chatOf(rows.map((r) => r.id));

    await w.contacts.ensureContacts(w.db, chat.id);

    const [{ count }] = (
      await w.db.execute(
        sql`select count(*)::int as count from contacts where owner_id = any(${sql.raw(
          `array[${rows.map((r) => `'${r.id}'::uuid`).join(",")}]`,
        )})`,
      )
    ).rows as { count: number }[];
    expect(count).toBe(size * (size - 1));
  }, 60_000);
});
