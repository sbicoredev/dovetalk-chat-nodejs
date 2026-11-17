import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { MAINTENANCE_TASKS } from "@dovetalk/core";
import { schema } from "@dovetalk/db";

import { MaintenanceProcessor } from "../src/jobs/maintenance.processor.js";
import { ExpireGuests } from "../src/jobs/tasks/expire-guests.js";
import { ExpireStatuses } from "../src/jobs/tasks/expire-statuses.js";
import { SweepOrphanAttachments } from "../src/jobs/tasks/sweep-orphan-attachments.js";
import { SweepRefreshTokens } from "../src/jobs/tasks/sweep-refresh-tokens.js";
import {
  befriend,
  createInfra,
  eventually,
  type Infra,
  makeAttachment,
  makeBot,
  makeGuest,
  makePerson,
  makeStatus,
  makeToken,
  objectExists,
  servicesOf,
  startWorker,
} from "./support/harness.js";

const {
  attachments,
  chatMembers,
  chats,
  contacts,
  messages,
  refreshTokens,
  statusViews,
  statuses,
  users,
} = schema;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const WEEK_MS = "604800000";

let infra: Infra;
beforeAll(async () => {
  infra = await createInfra();
});
afterAll(() => infra.close());

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
  await infra.reset();
});

type Services = ReturnType<typeof servicesOf>;

async function boot(over: Record<string, string> = {}) {
  const worker = await startWorker(infra, over);
  open.push(worker.app);
  return { worker, s: servicesOf(worker.app) };
}

const idsOf = (rows: { id: string }[]) =>
  rows.map((row) => row.id).sort((a, b) => a.localeCompare(b));

describe("expiring guests", () => {
  /**
   * A guest whose time is up, with: a chat with a shared bot, a chat with a ghost they made, a
   * chat with a real person, a note, and a file in storage that one of their messages uses.
   */
  async function expiredGuestWithEverything(s: Services) {
    const guest = await makeGuest(s.db, -HOUR);
    const bot = await makeBot(s.db, { name: "Shared Bot" });
    const ghost = await makeBot(s.db, { name: "Ghost", ghostOwnerId: guest.id });
    const person = await makePerson(s.db, { name: "Real Rita" });
    const [botContact, ghostContact, personContact] = await befriend(s.db, guest, [
      bot,
      ghost,
      person,
    ]);

    const direct = async (contactId: string | undefined) =>
      (await s.chats.create(guest.id, { type: "direct", contactId: contactId as string })).chat;
    const botChat = await direct(botContact);
    const ghostChat = await direct(ghostContact);
    const personChat = await direct(personContact);

    await s.messages.send(guest.id, botChat.id, { kind: "text", text: "hi bot", clientId: "g1" });
    await s.messages.send(guest.id, personChat.id, {
      kind: "text",
      text: "hi rita",
      clientId: "g2",
    });
    const file = await makeAttachment(s.db, s.storage, guest);
    await s.messages.send(guest.id, botChat.id, {
      kind: "file",
      attachmentId: file.id,
      clientId: "g3",
    });
    const note = await makeStatus(s.db, guest, DAY);

    return { guest, bot, ghost, person, botChat, ghostChat, personChat, file, note };
  }

  it("removes an expired guest with their contacts, ghosts, notes, files and chats nobody else is in", async () => {
    const { worker, s } = await boot();
    const w = await expiredGuestWithEverything(s);
    expect(await objectExists(w.file)).toBe(true);

    const result = await worker.get(ExpireGuests).run();

    expect(result).toEqual({ guests: 1, chats: 2, files: 1, kept: 0 });
    expect(await s.db.select().from(users).where(eq(users.id, w.guest.id))).toHaveLength(0);
    // The ghost was theirs. The shared bot and the real person are not.
    expect(await s.db.select().from(users).where(eq(users.id, w.ghost.id))).toHaveLength(0);
    expect(
      idsOf(
        await s.db
          .select()
          .from(users)
          .where(inArray(users.id, [w.bot.id, w.person.id])),
      ),
    ).toEqual([w.bot.id, w.person.id].sort((a, b) => a.localeCompare(b)));
    expect(await s.db.select().from(contacts).where(eq(contacts.ownerId, w.guest.id))).toHaveLength(
      0,
    );
    expect(await s.db.select().from(statuses).where(eq(statuses.id, w.note.id))).toHaveLength(0);
    // Their file: the row and the object.
    expect(await s.db.select().from(attachments).where(eq(attachments.id, w.file.id))).toHaveLength(
      0,
    );
    expect(await objectExists(w.file)).toBe(false);
    // Chats with only bots left go, with their messages.
    expect(await s.db.select().from(chats).where(eq(chats.id, w.botChat.id))).toHaveLength(0);
    expect(await s.db.select().from(chats).where(eq(chats.id, w.ghostChat.id))).toHaveLength(0);
    expect(
      await s.db.select().from(messages).where(eq(messages.chatId, w.botChat.id)),
    ).toHaveLength(0);
    // The chat with a real person stays, for them. The guest's side of it is gone.
    expect(await s.db.select().from(chats).where(eq(chats.id, w.personChat.id))).toHaveLength(1);
    const members = await s.db
      .select()
      .from(chatMembers)
      .where(eq(chatMembers.chatId, w.personChat.id));
    expect(members.map((m) => m.userId)).toEqual([w.person.id]);
  });

  it("hands a file to the real person who forwarded it, and still deletes one nobody forwarded", async () => {
    const { worker, s } = await boot();
    const guest = await makeGuest(s.db, -HOUR);
    const person = await makePerson(s.db, { name: "Real Rita" });
    const friend = await makePerson(s.db, { name: "Fran Friend" });
    const [personContact] = await befriend(s.db, guest, [person]);
    const [friendContact] = await befriend(s.db, person, [friend]);
    const { chat: shared } = await s.chats.create(guest.id, {
      type: "direct",
      contactId: personContact as string,
    });
    const { chat: mine } = await s.chats.create(person.id, {
      type: "direct",
      contactId: friendContact as string,
    });
    const forwardedFile = await makeAttachment(s.db, s.storage, guest);
    const lonelyFile = await makeAttachment(s.db, s.storage, guest);
    const { message: original } = await s.messages.send(guest.id, shared.id, {
      kind: "file",
      attachmentId: forwardedFile.id,
      clientId: "f1",
    });
    await s.messages.send(guest.id, shared.id, {
      kind: "file",
      attachmentId: lonelyFile.id,
      clientId: "f2",
    });
    const [copy] = await s.messages.forward(person.id, original.id, [mine.id]);

    const result = await worker.get(ExpireGuests).run();

    // One file handed over, one deleted. The shared chat stays: Rita is still in it.
    expect(result).toEqual({ guests: 1, chats: 0, files: 1, kept: 1 });
    expect(await s.db.select().from(users).where(eq(users.id, guest.id))).toHaveLength(0);
    // The forwarded file is Rita's now: the row, the object, and the forward still shows it.
    const [kept] = await s.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, forwardedFile.id));
    expect(kept?.ownerId).toBe(person.id);
    expect(await objectExists(forwardedFile)).toBe(true);
    const [theCopy] = await s.db
      .select()
      .from(messages)
      .where(eq(messages.id, (copy as { id: string }).id));
    expect(theCopy?.attachmentId).toBe(forwardedFile.id);
    expect(theCopy?.senderId).toBe(person.id);
    // The guest's own message is gone with them, as it always was.
    expect(await s.db.select().from(messages).where(eq(messages.id, original.id))).toHaveLength(0);
    // The file nobody forwarded is deleted: the row and the object.
    expect(
      await s.db.select().from(attachments).where(eq(attachments.id, lonelyFile.id)),
    ).toHaveLength(0);
    expect(await objectExists(lonelyFile)).toBe(false);

    // A second run has nothing left to do, and the file stays.
    expect(await worker.get(ExpireGuests).run()).toEqual({
      guests: 0,
      chats: 0,
      files: 0,
      kept: 0,
    });
    expect(await objectExists(forwardedFile)).toBe(true);
  });

  it("gives a file that two people forwarded to the one who forwarded it first", async () => {
    const { worker, s } = await boot();
    const guest = await makeGuest(s.db, -HOUR);
    const first = await makePerson(s.db, { name: "First Fran" });
    const second = await makePerson(s.db, { name: "Second Sam" });
    const [toFirst, toSecond] = await befriend(s.db, guest, [first, second]);
    const { chat: crew } = await s.chats.create(guest.id, {
      type: "group",
      name: "Crew",
      memberIds: [toFirst as string, toSecond as string],
    });
    const file = await makeAttachment(s.db, s.storage, guest);
    const { message: original } = await s.messages.send(guest.id, crew.id, {
      kind: "file",
      attachmentId: file.id,
      clientId: "f1",
    });
    // Sam forwards it last, Fran first.
    await s.messages.forward(first.id, original.id, [crew.id]);
    await s.messages.forward(second.id, original.id, [crew.id]);

    const result = await worker.get(ExpireGuests).run();

    expect(result.kept).toBe(1);
    const [kept] = await s.db.select().from(attachments).where(eq(attachments.id, file.id));
    expect(kept?.ownerId).toBe(first.id);
    expect(await objectExists(file)).toBe(true);
    // Both forwards still show the file.
    const copies = await s.db.select().from(messages).where(eq(messages.attachmentId, file.id));
    expect(
      copies.map((m) => m.senderId).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([first.id, second.id].sort((a, b) => a.localeCompare(b)));
  });

  it.each([
    ["in the same batch", "50"],
    ["in a later batch", "1"],
  ])("does not hand a file to a guest whose time is up too (%s)", async (_label, batchSize) => {
    const { worker, s } = await boot({ CLEANUP_BATCH_SIZE: batchSize });
    const owner = await makeGuest(s.db, -2 * HOUR);
    const other = await makeGuest(s.db, -HOUR);
    const [toOther] = await befriend(s.db, owner, [other]);
    const { chat } = await s.chats.create(owner.id, {
      type: "direct",
      contactId: toOther as string,
    });
    const own = await makeAttachment(s.db, s.storage, owner);
    const { message } = await s.messages.send(owner.id, chat.id, {
      kind: "file",
      attachmentId: own.id,
      clientId: "f1",
    });
    await s.messages.forward(other.id, message.id, [chat.id]);

    const result = await worker.get(ExpireGuests).run();

    // Both are gone, and so is the file: nobody who stays has any claim to it.
    expect(result).toMatchObject({ guests: 2, files: 1, kept: 0 });
    expect(await s.db.select().from(attachments).where(eq(attachments.id, own.id))).toHaveLength(0);
    expect(await objectExists(own)).toBe(false);
  });

  it("leaves a guest whose time is not up, and real people with their files", async () => {
    const { worker, s } = await boot();
    const waiting = await makeGuest(s.db, HOUR);
    const bot = await makeBot(s.db);
    const [contactId] = await befriend(s.db, waiting, [bot]);
    const { chat } = await s.chats.create(waiting.id, {
      type: "direct",
      contactId: contactId as string,
    });
    const waitingFile = await makeAttachment(s.db, s.storage, waiting);
    const person = await makePerson(s.db);
    const personFile = await makeAttachment(s.db, s.storage, person, { ageMs: 3 * DAY });

    const result = await worker.get(ExpireGuests).run();

    expect(result.guests).toBe(0);
    expect(await s.db.select().from(users).where(eq(users.id, waiting.id))).toHaveLength(1);
    expect(await s.db.select().from(chats).where(eq(chats.id, chat.id))).toHaveLength(1);
    expect(await objectExists(waitingFile)).toBe(true);
    expect(await s.db.select().from(users).where(eq(users.id, person.id))).toHaveLength(1);
    expect(await objectExists(personFile)).toBe(true);
  });

  it("removes everything with a small batch, over several batches", async () => {
    const { worker, s } = await boot({ CLEANUP_BATCH_SIZE: "2" });
    const guests = await Promise.all(Array.from({ length: 5 }, () => makeGuest(s.db, -HOUR)));
    const bot = await makeBot(s.db);
    const rooms = await Promise.all(
      guests.map(async (guest) => {
        const [contactId] = await befriend(s.db, guest, [bot]);
        return (await s.chats.create(guest.id, { type: "direct", contactId: contactId as string }))
          .chat;
      }),
    );

    const result = await worker.get(ExpireGuests).run();

    expect(result).toMatchObject({ guests: 5, chats: 5 });
    expect(
      await s.db
        .select()
        .from(users)
        .where(
          inArray(
            users.id,
            guests.map((g) => g.id),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await s.db
        .select()
        .from(chats)
        .where(
          inArray(
            chats.id,
            rooms.map((r) => r.id),
          ),
        ),
    ).toHaveLength(0);
  });

  it("is safe to run twice, and two runs at once remove each guest once", async () => {
    const { worker, s } = await boot();
    await Promise.all(Array.from({ length: 6 }, () => makeGuest(s.db, -HOUR)));
    const task = worker.get(ExpireGuests);

    const [a, b] = await Promise.all([task.run(), task.run()]);

    expect(a.guests + b.guests).toBe(6);
    expect(await task.run()).toEqual({ guests: 0, chats: 0, files: 0, kept: 0 });
  });

  it("keeps every row when the files cannot be deleted, and succeeds on the next run", async () => {
    const { worker, s } = await boot();
    const w = await expiredGuestWithEverything(s);
    const task = worker.get(ExpireGuests);
    const realDelete = s.storage.delete.bind(s.storage);
    s.storage.delete = () => Promise.reject(new Error("storage is down"));

    await expect(task.run()).rejects.toThrow("storage is down");
    // The batch rolled back: the guest, their rows and their file are all still there.
    expect(await s.db.select().from(users).where(eq(users.id, w.guest.id))).toHaveLength(1);
    expect(await s.db.select().from(attachments).where(eq(attachments.id, w.file.id))).toHaveLength(
      1,
    );
    expect(await objectExists(w.file)).toBe(true);

    s.storage.delete = realDelete;
    expect((await task.run()).guests).toBe(1);
    expect(await objectExists(w.file)).toBe(false);
  });
});

describe("expiring statuses", () => {
  it("removes notes that have expired, with their views, and keeps fresh ones", async () => {
    const { worker, s } = await boot();
    const owner = await makePerson(s.db);
    const viewer = await makePerson(s.db);
    const old = await makeStatus(s.db, owner, -HOUR);
    const fresh = await makeStatus(s.db, owner, HOUR);
    await s.db.insert(statusViews).values({ statusId: old.id, viewerId: viewer.id });

    expect(await worker.get(ExpireStatuses).run()).toEqual({ statuses: 1 });

    expect(idsOf(await s.db.select().from(statuses).where(eq(statuses.ownerId, owner.id)))).toEqual(
      [fresh.id],
    );
    expect(
      await s.db.select().from(statusViews).where(eq(statusViews.statusId, old.id)),
    ).toHaveLength(0);
    expect(await worker.get(ExpireStatuses).run()).toEqual({ statuses: 0 });
  });

  it("removes them all with a small batch", async () => {
    const { worker, s } = await boot({ CLEANUP_BATCH_SIZE: "2" });
    const owner = await makePerson(s.db);
    await Promise.all(Array.from({ length: 5 }, () => makeStatus(s.db, owner, -HOUR)));
    const fresh = await makeStatus(s.db, owner, HOUR);

    expect(await worker.get(ExpireStatuses).run()).toEqual({ statuses: 5 });
    expect(idsOf(await s.db.select().from(statuses).where(eq(statuses.ownerId, owner.id)))).toEqual(
      [fresh.id],
    );
  });
});

describe("sweeping orphan attachments", () => {
  it("removes an old unused upload, row and object, and keeps what is in use or young", async () => {
    const { worker, s } = await boot();
    const owner = await makePerson(s.db);
    const bot = await makeBot(s.db);
    const [contactId] = await befriend(s.db, owner, [bot]);
    const { chat } = await s.chats.create(owner.id, {
      type: "direct",
      contactId: contactId as string,
    });

    const orphan = await makeAttachment(s.db, s.storage, owner, { ageMs: 2 * DAY });
    const young = await makeAttachment(s.db, s.storage, owner, { ageMs: HOUR });
    const inMessage = await makeAttachment(s.db, s.storage, owner, { ageMs: 2 * DAY });
    await s.messages.send(owner.id, chat.id, {
      kind: "file",
      attachmentId: inMessage.id,
      clientId: "o1",
    });
    const avatar = await makeAttachment(s.db, s.storage, owner, { ageMs: 2 * DAY });
    await s.db.update(users).set({ avatarAttachmentId: avatar.id }).where(eq(users.id, owner.id));

    expect(await worker.get(SweepOrphanAttachments).run()).toEqual({ attachments: 1 });

    expect(await s.db.select().from(attachments).where(eq(attachments.id, orphan.id))).toHaveLength(
      0,
    );
    expect(await objectExists(orphan)).toBe(false);
    for (const kept of [young, inMessage, avatar]) {
      expect(await s.db.select().from(attachments).where(eq(attachments.id, kept.id))).toHaveLength(
        1,
      );
      expect(await objectExists(kept)).toBe(true);
    }
    expect(await worker.get(SweepOrphanAttachments).run()).toEqual({ attachments: 0 });
  });

  it("removes them all with a small batch", async () => {
    const { worker, s } = await boot({ CLEANUP_BATCH_SIZE: "2" });
    const owner = await makePerson(s.db);
    const files = await Promise.all(
      Array.from({ length: 5 }, () => makeAttachment(s.db, s.storage, owner, { ageMs: 2 * DAY })),
    );

    expect(await worker.get(SweepOrphanAttachments).run()).toEqual({ attachments: 5 });
    expect(
      await s.db
        .select()
        .from(attachments)
        .where(
          inArray(
            attachments.id,
            files.map((f) => f.id),
          ),
        ),
    ).toHaveLength(0);
  });

  it("skips a file a send is claiming right now, and takes it on a later run if it stays unused", async () => {
    const { worker, s } = await boot();
    const owner = await makePerson(s.db);
    const file = await makeAttachment(s.db, s.storage, owner, { ageMs: 2 * DAY });
    const task = worker.get(SweepOrphanAttachments);

    // What `MessagesService.claimAttachment` does first: lock the attachment row.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const claiming = s.db.transaction(async (tx) => {
      await tx.select().from(attachments).where(eq(attachments.id, file.id)).for("update");
      locked();
      await held;
    });
    await isLocked;

    // The sweep does not wait for the lock and does not touch the row.
    expect(await task.run()).toEqual({ attachments: 0 });
    expect(await objectExists(file)).toBe(true);

    release();
    await claiming;
    expect(await task.run()).toEqual({ attachments: 1 });
    expect(await objectExists(file)).toBe(false);
  });
});

describe("sweeping refresh tokens", () => {
  it("removes expired tokens and ones revoked over a day ago, and keeps the rest", async () => {
    const { worker, s } = await boot();
    const user = await makePerson(s.db);
    const expired = await makeToken(s.db, user, { expiresInMs: -HOUR });
    const revokedLongAgo = await makeToken(s.db, user, {
      expiresInMs: 5 * DAY,
      revokedAgoMs: 2 * DAY,
    });
    const revokedJustNow = await makeToken(s.db, user, {
      expiresInMs: 5 * DAY,
      revokedAgoMs: HOUR,
    });
    // Rotated but not expired: a replay of it is how a stolen copy is noticed, so the row stays.
    const rotated = await makeToken(s.db, user, { expiresInMs: 5 * DAY, rotatedAgoMs: 3 * DAY });
    const active = await makeToken(s.db, user, { expiresInMs: 5 * DAY });

    expect(await worker.get(SweepRefreshTokens).run()).toEqual({ tokens: 2 });

    const left = idsOf(
      await s.db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id)),
    );
    expect(left).toEqual(
      [revokedJustNow.id, rotated.id, active.id].sort((a, b) => a.localeCompare(b)),
    );
    expect(left).not.toContain(expired.id);
    expect(left).not.toContain(revokedLongAgo.id);
    expect(await worker.get(SweepRefreshTokens).run()).toEqual({ tokens: 0 });
  });

  it("removes them all with a small batch", async () => {
    const { worker, s } = await boot({ CLEANUP_BATCH_SIZE: "2" });
    const user = await makePerson(s.db);
    await Promise.all(
      Array.from({ length: 5 }, () => makeToken(s.db, user, { expiresInMs: -HOUR })),
    );
    const active = await makeToken(s.db, user, { expiresInMs: DAY });

    expect(await worker.get(SweepRefreshTokens).run()).toEqual({ tokens: 5 });
    expect(
      idsOf(await s.db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id))),
    ).toEqual([active.id]);
  });
});

describe("the maintenance schedule", () => {
  const everything = {
    CLEANUP_GUESTS_EVERY_MS: "111000",
    CLEANUP_STATUSES_EVERY_MS: "222000",
    CLEANUP_ATTACHMENTS_EVERY_MS: "333000",
    CLEANUP_TOKENS_EVERY_MS: "444000",
  };

  it("leaves exactly one schedule per task, with the configured interval, however many workers start", async () => {
    // Its own prefix, so the schedule of the other tests in this file does not count.
    const own = { ...infra, prefix: `${infra.prefix}-sched` };
    const first = await startWorker(own, everything);
    open.push(first.app);
    const second = await startWorker(own, everything);
    open.push(second.app);

    const schedulers = await servicesOf(first.app).queues.maintenance.getJobSchedulers();

    expect(schedulers).toHaveLength(4);
    expect(Object.fromEntries(schedulers.map((sch) => [sch.key, sch.every]))).toEqual({
      "expire-guests": 111_000,
      "expire-statuses": 222_000,
      "sweep-orphan-attachments": 333_000,
      "sweep-refresh-tokens": 444_000,
    });
    expect(schedulers.map((sch) => sch.key).sort((a, b) => a.localeCompare(b))).toEqual(
      [...MAINTENANCE_TASKS].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("takes the newest interval when a worker starts with a changed setting", async () => {
    const own = { ...infra, prefix: `${infra.prefix}-resched` };
    const before = await startWorker(own, everything);
    await before.app.close();
    const after = await startWorker(own, { ...everything, CLEANUP_STATUSES_EVERY_MS: "555000" });
    open.push(after.app);

    const schedulers = await servicesOf(after.app).queues.maintenance.getJobSchedulers();

    expect(schedulers).toHaveLength(4);
    expect(schedulers.find((sch) => sch.key === "expire-statuses")?.every).toBe(555_000);
  });

  it("actually runs a scheduled task, through the queue", async () => {
    const own = { ...infra, prefix: `${infra.prefix}-fires` };
    // Seed before the worker starts, so the first run it makes already has work.
    const seed = await startWorker(own, { CLEANUP_STATUSES_EVERY_MS: WEEK_MS });
    const owner = await makePerson(servicesOf(seed.app).db);
    const old = await makeStatus(servicesOf(seed.app).db, owner, -HOUR);
    const fresh = await makeStatus(servicesOf(seed.app).db, owner, HOUR);
    await seed.app.close();

    const { s } = await boot2(own, { CLEANUP_STATUSES_EVERY_MS: "300" });

    await eventually(
      async () => (await s.db.select().from(statuses).where(eq(statuses.id, old.id))).length === 0,
      { message: "The scheduled run never removed the expired note." },
    );
    expect(await s.db.select().from(statuses).where(eq(statuses.id, fresh.id))).toHaveLength(1);
  });

  async function boot2(own: Infra, over: Record<string, string>) {
    const worker = await startWorker(own, over);
    open.push(worker.app);
    return { worker, s: servicesOf(worker.app) };
  }

  it("runs the right task for each queue job name", async () => {
    const { worker } = await boot();
    const processor = worker.get(MaintenanceProcessor);

    for (const task of MAINTENANCE_TASKS) {
      await expect(processor.run(task)).resolves.toBeDefined();
    }
    await expect(processor.run("nope" as never)).rejects.toThrow(/Unknown maintenance job/u);
  });
});
