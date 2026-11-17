import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema } from "@dovetalk/db";

import { findBotCandidates } from "../src/index.js";
import { createWorld, type World } from "./support/world.js";

const { chatMembers, contacts } = schema;

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

/** A person, a bot they know, and their direct chat. */
async function directWithBot() {
  const me = await w.user();
  const bot = await w.bot({ name: "Bo Bot" });
  const [contactId] = await w.befriend(me, [bot]);
  const { chat } = await w.chats.create(me.id, { type: "direct", contactId: contactId! });
  return { me, bot, contactId: contactId!, chat };
}

describe("findBotCandidates", () => {
  it("names the bot in a direct chat", async () => {
    const { me, bot, chat } = await directWithBot();
    expect(await findBotCandidates(w.db, chat.id, me.id)).toEqual([{ id: bot.id, name: "Bo Bot" }]);
  });

  it("names nobody when the other person is a person", async () => {
    const [me, them] = await w.people(2);
    const [contactId] = await w.befriend(me!, [them!]);
    const { chat } = await w.chats.create(me!.id, { type: "direct", contactId: contactId! });
    expect(await findBotCandidates(w.db, chat.id, me!.id)).toEqual([]);
  });

  it("names nobody when a bot is the one who wrote, so bots never answer bots", async () => {
    const { bot, chat } = await directWithBot();
    expect(await findBotCandidates(w.db, chat.id, bot.id)).toEqual([]);
  });

  it("names nobody once the sender has blocked the bot", async () => {
    const { me, contactId, chat } = await directWithBot();
    await w.db.update(contacts).set({ blocked: true }).where(eq(contacts.id, contactId));
    expect(await findBotCandidates(w.db, chat.id, me.id)).toEqual([]);
  });

  it("names nobody once the sender deleted the chat, so a late reply does not bring it back", async () => {
    const { me, chat } = await directWithBot();
    await w.chats.remove(me.id, chat.id);
    expect(await findBotCandidates(w.db, chat.id, me.id)).toEqual([]);
  });

  it("names nobody for a person who is not in the chat", async () => {
    const { chat } = await directWithBot();
    const stranger = await w.user();
    expect(await findBotCandidates(w.db, chat.id, stranger.id)).toEqual([]);
  });

  it("names every unblocked bot of a group, in id order", async () => {
    const me = await w.user();
    const bots = await Promise.all([
      w.bot({ name: "A" }),
      w.bot({ name: "B" }),
      w.bot({ name: "C" }),
    ]);
    const contactIds = await w.befriend(me, bots);
    const { chat } = await w.chats.create(me.id, {
      type: "group",
      name: "Bots and me",
      memberIds: contactIds,
    });
    const all = await findBotCandidates(w.db, chat.id, me.id);
    expect(all.map((b) => b.id)).toEqual(bots.map((b) => b.id).sort());

    await w.db.update(contacts).set({ blocked: true }).where(eq(contacts.id, contactIds[1]!));
    const some = await findBotCandidates(w.db, chat.id, me.id);
    expect(some.map((b) => b.id)).toEqual(
      bots
        .filter((b) => b.id !== bots[1]!.id)
        .map((b) => b.id)
        .sort(),
    );
  });

  it("leaves out a bot that has left the group", async () => {
    const me = await w.user();
    const bots = await Promise.all([w.bot(), w.bot(), w.bot()]);
    const contactIds = await w.befriend(me, bots);
    const { chat } = await w.chats.create(me.id, {
      type: "group",
      name: "Trio",
      memberIds: contactIds,
    });
    await w.db
      .update(chatMembers)
      .set({ leftAt: new Date() })
      .where(eq(chatMembers.userId, bots[0]!.id));
    const found = await findBotCandidates(w.db, chat.id, me.id);
    expect(found.map((b) => b.id)).not.toContain(bots[0]!.id);
    expect(found).toHaveLength(2);
  });
});
