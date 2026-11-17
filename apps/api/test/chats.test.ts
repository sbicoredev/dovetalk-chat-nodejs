import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ChatDto, type ContactDto, type MessagePage, PIN_LIMIT } from "@dovetalk/contracts";
import { schema } from "@dovetalk/db";

import { createTestApp, type TestAccount, type TestApp } from "./support/create-test-app.js";

const { chats } = schema;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const get = (a: TestAccount, path: string) => request(t.server).get(path).set(a.bearer);
const post = (a: TestAccount, path: string) => request(t.server).post(path).set(a.bearer);
const patch = (a: TestAccount, path: string) => request(t.server).patch(path).set(a.bearer);
const del = (a: TestAccount, path: string) => request(t.server).delete(path).set(a.bearer);

const chatsOf = async (a: TestAccount) => (await get(a, "/chats").expect(200)).body as ChatDto[];
const contactsOf = async (a: TestAccount) =>
  (await get(a, "/contacts").expect(200)).body as ContactDto[];

/** A fresh account with its seeded data, and handles for the people in it. */
async function setup() {
  const a = await t.signUp();
  const contacts = await contactsOf(a);
  const byName = (name: string) => contacts.find((c) => c.name === name)!;
  const chatList = await chatsOf(a);
  const direct = (name: string) =>
    chatList.find((c) => c.memberIds[0] === byName(name).id && c.type === "direct")!;
  const group = (name: string) => chatList.find((c) => c.name === name)!;
  return { a, contacts, byName, chatList, direct, group };
}

const messagesOf = async (a: TestAccount, chatId: string) =>
  (await get(a, `/chats/${chatId}/messages`).expect(200)).body as MessagePage;

describe("GET /chats", () => {
  it("needs a signed-in person", async () => {
    await request(t.server).get("/chats").expect(401);
  });

  it("lists the 11 seeded chats with the seeded flags", async () => {
    const { chatList, direct, group } = await setup();
    expect(chatList).toHaveLength(11);
    expect(chatList.filter((c) => c.type === "direct")).toHaveLength(9);
    expect(chatList.filter((c) => c.archived).map((c) => c.memberIds.length)).toEqual([1, 1]);
    expect(chatList.filter((c) => c.pinned).map((c) => c.name)).toEqual(["Studio crew"]);
    expect(direct("Imogen Varley").unread).toBe(2);
    expect(group("Weekend hikers")).toMatchObject({ unread: 3, type: "group", muted: false });
    expect(chatList.every((c) => c.lastMessage !== null)).toBe(true);
    expect(chatList[0]).toEqual({
      id: expect.any(String),
      type: expect.stringMatching(/^(direct|group)$/u),
      name: expect.toSatisfy((n) => n === null || typeof n === "string"),
      hue: expect.any(Number),
      memberIds: expect.any(Array),
      unread: expect.any(Number),
      archived: expect.any(Boolean),
      pinned: expect.any(Boolean),
      muted: false,
      createdAt: expect.any(Number),
      lastMessage: expect.any(Object),
    });
  });

  it("names members by the viewer's own contact ids", async () => {
    const { contacts, group } = await setup();
    const ids = new Set(contacts.map((c) => c.id));
    const hikers = group("Weekend hikers");
    expect(hikers.memberIds).toHaveLength(4);
    expect(hikers.memberIds.every((id) => ids.has(id))).toBe(true);
    expect(hikers.lastMessage!.senderId === "system" || ids.has(hikers.lastMessage!.senderId)).toBe(
      true,
    );
  });

  it("does not show one person's chats to another", async () => {
    const one = await setup();
    const two = await setup();
    const ids = new Set(one.chatList.map((c) => c.id));
    expect(two.chatList.some((c) => ids.has(c.id))).toBe(false);
  });
});

describe("POST /chats, direct", () => {
  it("opens a chat with a contact that has none: 201, then 200 with the same chat", async () => {
    const { a, byName } = await setup();
    const amara = byName("Amara Okafor");
    const first = await post(a, "/chats").send({ type: "direct", contactId: amara.id }).expect(201);
    expect(first.body).toMatchObject({
      type: "direct",
      name: null,
      memberIds: [amara.id],
      lastMessage: null,
      unread: 0,
    });
    const again = await post(a, "/chats").send({ type: "direct", contactId: amara.id }).expect(200);
    expect(again.body).toEqual(first.body);
    expect(await chatsOf(a)).toHaveLength(12);
  });

  it("returns the existing chat for a contact you already talk to, as it is", async () => {
    const { a, byName, direct } = await setup();
    const existing = direct("Imogen Varley");
    const res = await post(a, "/chats")
      .send({ type: "direct", contactId: byName("Imogen Varley").id })
      .expect(200);
    expect(res.body).toEqual(existing);
  });

  it("brings back a chat you deleted, empty, with a 200", async () => {
    const { a, direct, byName } = await setup();
    const existing = direct("Imogen Varley");
    await del(a, `/chats/${existing.id}`).expect(204);
    const res = await post(a, "/chats")
      .send({ type: "direct", contactId: byName("Imogen Varley").id })
      .expect(200);
    expect(res.body).toMatchObject({ id: existing.id, lastMessage: null, unread: 0 });
    expect((await messagesOf(a, existing.id)).items).toEqual([]);
  });

  it("is 404 CONTACT_NOT_FOUND for somebody else's contact and for a malformed id", async () => {
    const { a, contacts } = await setup();
    const other = await t.signUp();
    for (const contactId of [contacts[0]!.id, "zzz", "", "%00", "0".repeat(400)]) {
      const res = await post(other, "/chats")
        .send({ type: "direct", contactId })
        .expect(contactId === "" ? 422 : 404);
      expect(res.body.code).toBe(contactId === "" ? "VALIDATION_ERROR" : "CONTACT_NOT_FOUND");
    }
    expect(await chatsOf(a)).toHaveLength(11);
  });

  it("makes one chat when two people open it at the same moment, in both directions", async () => {
    const a = await t.signUp({ phone: "+1 555 020 1001" });
    const b = await t.signUp({ phone: "+1 555 020 1002" });
    const aSeesB = (
      await post(a, "/contacts").send({ name: "Bea", phone: "+1 555 020 1002" }).expect(201)
    ).body;
    const bSeesA = (
      await post(b, "/contacts").send({ name: "Al", phone: "+1 555 020 1001" }).expect(201)
    ).body;

    const results = await Promise.all([
      post(a, "/chats").send({ type: "direct", contactId: aSeesB.id }),
      post(b, "/chats").send({ type: "direct", contactId: bSeesA.id }),
      post(a, "/chats").send({ type: "direct", contactId: aSeesB.id }),
      post(b, "/chats").send({ type: "direct", contactId: bSeesA.id }),
    ]);
    expect(results.map((r) => r.status).filter((s) => s !== 200 && s !== 201)).toEqual([]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    const rows = await t.db
      .select()
      .from(chats)
      .where(eq(chats.id, [...ids][0]!));
    expect(rows).toHaveLength(1);
    // And each person has it exactly once.
    expect((await chatsOf(a)).filter((c) => c.id === [...ids][0])).toHaveLength(1);
  });

  it("validates the shape", async () => {
    const { a } = await setup();
    for (const body of [
      {},
      { type: "channel" },
      { type: "direct" },
      { type: "direct", contactId: 5 },
    ]) {
      const res = await post(a, "/chats").send(body).expect(422);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    }
    await post(a, "/chats").expect(422);
  });
});

describe("POST /chats, group", () => {
  it("creates a group with a note that you created it", async () => {
    const { a, byName } = await setup();
    const members = ["Amara Okafor", "Felix Moreau", "Noor Haddad"].map((n) => byName(n).id);
    const res = await post(a, "/chats")
      .send({ type: "group", name: "  Climbing  ", memberIds: members })
      .expect(201);
    expect(res.body).toMatchObject({
      type: "group",
      name: "Climbing",
      memberIds: members,
      unread: 0,
      pinned: false,
      archived: false,
      muted: false,
    });
    expect(res.body.lastMessage).toMatchObject({
      kind: "system",
      senderId: "system",
      text: "You created this group",
    });
    expect(await chatsOf(a)).toHaveLength(12);
  });

  it("is always a new group, even with the same name and people", async () => {
    const { a, byName } = await setup();
    const body = {
      type: "group",
      name: "Twice",
      memberIds: [byName("Amara Okafor").id, byName("Felix Moreau").id],
    };
    const one = await post(a, "/chats").send(body).expect(201);
    const two = await post(a, "/chats").send(body).expect(201);
    expect(two.body.id).not.toBe(one.body.id);
  });

  it("needs a name and at least two people of your own", async () => {
    const { a, byName, contacts } = await setup();
    const other = await t.signUp();
    const two = [byName("Amara Okafor").id, byName("Felix Moreau").id];
    const cases: [object, string][] = [
      [{ type: "group", name: "  ", memberIds: two }, "Group name can't be empty."],
      [
        { type: "group", name: "x".repeat(61), memberIds: two },
        "Group name is too long. The limit is 60 characters.",
      ],
      [
        { type: "group", name: "Solo", memberIds: [two[0]] },
        "A group needs at least two other people.",
      ],
      [
        { type: "group", name: "Dupes", memberIds: [two[0], two[0]] },
        "A group needs at least two other people.",
      ],
      [
        { type: "group", name: "Junk", memberIds: [two[0], "zzz", "%00"] },
        "A group needs at least two other people.",
      ],
      [{ type: "group", name: "None", memberIds: [] }, "A group needs at least two other people."],
      [{ type: "group", name: 5, memberIds: two }, "Group name can't be empty."],
      [{ type: "group", name: "Shape", memberIds: "nope" }, "Choose the people to add."],
      [{ type: "group", name: "Shape", memberIds: [1, 2] }, "Choose the people to add."],
    ];
    for (const [body, message] of cases) {
      const res = await post(a, "/chats").send(body).expect(422);
      expect(res.body).toEqual({ statusCode: 422, code: "VALIDATION_ERROR", message: [message] });
    }
    // Somebody else's contact ids are not yours to use.
    const res = await post(other, "/chats")
      .send({ type: "group", name: "Mine now", memberIds: contacts.slice(0, 3).map((c) => c.id) })
      .expect(422);
    expect(res.body.message).toEqual(["A group needs at least two other people."]);
    expect(await chatsOf(a)).toHaveLength(11);
  });

  it("refuses more than 255 other people before looking at any of them", async () => {
    const { a } = await setup();
    const res = await post(a, "/chats")
      .send({
        type: "group",
        name: "Huge",
        memberIds: Array.from({ length: 256 }, (_, i) => `x${i}`),
      })
      .expect(422);
    expect(res.body.message).toEqual(["A group can have at most 255 other people."]);
  });

  it("refuses a NUL in the name", async () => {
    const { a, byName } = await setup();
    const members = [byName("Amara Okafor").id, byName("Felix Moreau").id];
    await post(a, "/chats")
      .send({ type: "group", name: "Bad\u0000", memberIds: members })
      .expect(422);
  });
});

describe("PATCH /chats/:id", () => {
  it("changes your own flags and nobody else's", async () => {
    const one = await setup();
    const two = await setup();
    const { id } = one.direct("Tobias Kellner");
    const res = await patch(one.a, `/chats/${id}`)
      .send({ archived: true, muted: true, pinned: true })
      .expect(200);
    expect(res.body).toMatchObject({ id, archived: true, muted: true, pinned: true });
    expect((await chatsOf(two.a)).every((c) => !c.muted)).toBe(true);
    await patch(one.a, `/chats/${id}`).send({ muted: false }).expect(200);
    expect((await chatsOf(one.a)).find((c) => c.id === id)).toMatchObject({
      muted: false,
      pinned: true,
    });
  });

  it("allows 3 pinned chats and says PIN_LIMIT for a fourth, archived ones counting", async () => {
    const { a, direct } = await setup(); // Studio crew is pinned already.
    await patch(a, `/chats/${direct("Tobias Kellner").id}`)
      .send({ pinned: true })
      .expect(200);
    // An archived chat counts toward the limit.
    await patch(a, `/chats/${direct("Wren Castellano").id}`)
      .send({ pinned: true })
      .expect(200);
    const res = await patch(a, `/chats/${direct("Imogen Varley").id}`)
      .send({ pinned: true })
      .expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      code: "PIN_LIMIT",
      message: `You can pin up to ${PIN_LIMIT} chats. Unpin one first.`,
    });
    // Pinning what is already pinned is not "one more".
    await patch(a, `/chats/${direct("Tobias Kellner").id}`)
      .send({ pinned: true })
      .expect(200);
    // Unpinning frees a place.
    await patch(a, `/chats/${direct("Tobias Kellner").id}`)
      .send({ pinned: false })
      .expect(200);
    await patch(a, `/chats/${direct("Imogen Varley").id}`)
      .send({ pinned: true })
      .expect(200);
  });

  it("never lets simultaneous pins go past the limit", async () => {
    const { a, chatList } = await setup(); // One pinned already.
    const candidates = chatList.filter((c) => !c.pinned);
    const results = await Promise.all(
      candidates.map((c) => patch(a, `/chats/${c.id}`).send({ pinned: true })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(PIN_LIMIT - 1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(
      candidates.length - (PIN_LIMIT - 1),
    );
    expect((await chatsOf(a)).filter((c) => c.pinned)).toHaveLength(PIN_LIMIT);
  });

  it("renames a group, with a note, and ignores saying the same name again", async () => {
    const { a, group } = await setup();
    const studio = group("Studio crew");
    const res = await patch(a, `/chats/${studio.id}`).send({ name: "  Studio 2  " }).expect(200);
    expect(res.body.name).toBe("Studio 2");
    expect(res.body.lastMessage).toMatchObject({
      kind: "system",
      text: "You renamed the group to “Studio 2”",
    });
    const again = await patch(a, `/chats/${studio.id}`).send({ name: "Studio 2" }).expect(200);
    expect(again.body.lastMessage.id).toBe(res.body.lastMessage.id);
  });

  it("does not rename a direct chat, and checks the name and the types", async () => {
    const { a, direct, group } = await setup();
    const res = await patch(a, `/chats/${direct("Tobias Kellner").id}`)
      .send({ name: "Nope" })
      .expect(422);
    expect(res.body.message).toEqual(["Only groups can be renamed."]);
    const { id } = group("Studio crew");
    await patch(a, `/chats/${id}`).send({ name: "" }).expect(422);
    await patch(a, `/chats/${id}`).send({ name: null }).expect(422);
    await patch(a, `/chats/${id}`)
      .send({ name: "x".repeat(61) })
      .expect(422);
    await patch(a, `/chats/${id}`).send({ name: "Bad\u0000" }).expect(422);
    for (const body of [{ pinned: "yes" }, { archived: 1 }, { muted: null }]) {
      await patch(a, `/chats/${id}`).send(body).expect(422);
    }
    expect((await chatsOf(a)).find((c) => c.id === id)!.name).toBe("Studio crew");
  });

  it("with an empty body changes nothing and answers 200", async () => {
    const { a, group } = await setup();
    const studio = group("Studio crew");
    const res = await patch(a, `/chats/${studio.id}`).send({}).expect(200);
    expect(res.body).toEqual(studio);
  });
});

describe("DELETE /chats/:id, POST read, POST clear", () => {
  it("delete answers 204, takes the chat off the list and ends access to it", async () => {
    const { a, direct } = await setup();
    const { id } = direct("Tobias Kellner");
    const res = await del(a, `/chats/${id}`).expect(204);
    expect(res.text).toBe("");
    expect((await chatsOf(a)).some((c) => c.id === id)).toBe(false);
    for (const run of [
      () => del(a, `/chats/${id}`),
      () => get(a, `/chats/${id}/messages`),
      () => post(a, `/chats/${id}/read`),
      () => post(a, `/chats/${id}/clear`),
      () => patch(a, `/chats/${id}`).send({ muted: true }),
    ]) {
      expect((await run().expect(404)).body.code).toBe("CHAT_NOT_FOUND");
    }
  });

  it("delete is only for you: the other person keeps the chat", async () => {
    const a = await t.signUp({ phone: "+1 555 020 2001" });
    const b = await t.signUp({ phone: "+1 555 020 2002" });
    const toB = (
      await post(a, "/contacts").send({ name: "Bea", phone: "+1 555 020 2002" }).expect(201)
    ).body;
    const toA = (
      await post(b, "/contacts").send({ name: "Al", phone: "+1 555 020 2001" }).expect(201)
    ).body;
    const chat = (await post(a, "/chats").send({ type: "direct", contactId: toB.id }).expect(201))
      .body;
    // B has not seen the chat yet: it starts hidden for them.
    expect((await chatsOf(b)).some((c) => c.id === chat.id)).toBe(false);
    await del(a, `/chats/${chat.id}`).expect(204);
    const reopened = await post(b, "/chats")
      .send({ type: "direct", contactId: toA.id })
      .expect(200);
    expect(reopened.body.id).toBe(chat.id);
    expect((await chatsOf(b)).some((c) => c.id === chat.id)).toBe(true);
  });

  it("read answers 204 with no body, with and without a JSON content type, and zeroes unread", async () => {
    const { a, direct } = await setup();
    const { id } = direct("Imogen Varley");
    expect(direct("Imogen Varley").unread).toBe(2);
    const bare = await post(a, `/chats/${id}/read`).expect(204);
    expect(bare.text).toBe("");
    expect((await chatsOf(a)).find((c) => c.id === id)!.unread).toBe(0);
    await post(a, `/chats/${id}/read`).set("Content-Type", "application/json").send("").expect(204);
    await post(a, `/chats/${id}/read`).set("Content-Type", "application/json").send({}).expect(204);
  });

  it("clear empties the chat for you, keeps it listed, and keeps its flags", async () => {
    const { a, group } = await setup();
    const studio = group("Studio crew");
    expect((await messagesOf(a, studio.id)).items.length).toBeGreaterThan(0);
    const res = await post(a, `/chats/${studio.id}/clear`).expect(204);
    expect(res.text).toBe("");
    expect((await messagesOf(a, studio.id)).items).toEqual([]);
    const after = (await chatsOf(a)).find((c) => c.id === studio.id)!;
    expect(after).toMatchObject({ pinned: true, lastMessage: null, unread: 0 });
  });

  it("read and clear are not 404 for a chat that is simply quiet", async () => {
    const { a, byName } = await setup();
    const chat = (
      await post(a, "/chats")
        .send({ type: "direct", contactId: byName("Amara Okafor").id })
        .expect(201)
    ).body;
    await post(a, `/chats/${chat.id}/read`).expect(204);
    await post(a, `/chats/${chat.id}/clear`).expect(204);
  });
});

describe("members", () => {
  it("any member can add people, who are listed after the others", async () => {
    const { a, byName, group } = await setup();
    const hikers = group("Weekend hikers"); // Made by a bot, and the viewer can still add.
    const res = await post(a, `/chats/${hikers.id}/members`)
      .send({ memberIds: [byName("Noor Haddad").id, byName("Felix Moreau").id] })
      .expect(200);
    expect(res.body.memberIds).toEqual([
      ...hikers.memberIds,
      byName("Noor Haddad").id,
      byName("Felix Moreau").id,
    ]);
    expect(res.body.lastMessage.text).toBe("You added Noor and Felix");
  });

  it("ignores people already in the group and ids that are not yours", async () => {
    const { a, group } = await setup();
    const studio = group("Studio crew");
    const other = await t.signUp();
    const foreign = (await contactsOf(other))[0]!.id;
    const res = await post(a, `/chats/${studio.id}/members`)
      .send({ memberIds: [studio.memberIds[0], foreign, "zzz", "%00"] })
      .expect(200);
    expect(res.body).toEqual(studio);
  });

  it("needs a list, and only works on groups", async () => {
    const { a, direct, group, byName } = await setup();
    const studio = group("Studio crew");
    for (const body of [{}, { memberIds: "x" }, { memberIds: [1] }]) {
      await post(a, `/chats/${studio.id}/members`).send(body).expect(422);
    }
    const res = await post(a, `/chats/${direct("Tobias Kellner").id}/members`)
      .send({ memberIds: [byName("Noor Haddad").id] })
      .expect(422);
    expect(res.body.message).toEqual(["Only groups have members."]);
  });

  it("only the creator removes people, and the group keeps two others", async () => {
    const { a, group, byName } = await setup();
    // Weekend hikers was made by somebody else.
    const hikers = group("Weekend hikers");
    const refused = await del(a, `/chats/${hikers.id}/members/${hikers.memberIds[0]}`).expect(403);
    expect(refused.body).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    const studio = group("Studio crew"); // Three others, made by the viewer.
    const removed = await del(a, `/chats/${studio.id}/members/${studio.memberIds[2]}`).expect(200);
    expect(removed.body.memberIds).toEqual(studio.memberIds.slice(0, 2));
    expect(removed.body.lastMessage.kind).toBe("system");
    expect(removed.body.lastMessage.text).toMatch(/^You removed /u);

    const last = await del(a, `/chats/${studio.id}/members/${studio.memberIds[0]}`).expect(422);
    expect(last.body.message).toEqual(["A group keeps at least two other members."]);

    const gone = await del(a, `/chats/${studio.id}/members/${studio.memberIds[2]}`).expect(404);
    expect(gone.body.code).toBe("MEMBER_NOT_FOUND");
    const stranger = await del(a, `/chats/${studio.id}/members/${byName("Noor Haddad").id}`).expect(
      404,
    );
    expect(stranger.body.code).toBe("MEMBER_NOT_FOUND");
    for (const id of ["zzz", "%00", "0".repeat(300)]) {
      const res = await del(a, `/chats/${studio.id}/members/${encodeURIComponent(id)}`).expect(404);
      expect(res.body.code).toBe("MEMBER_NOT_FOUND");
    }
  });

  it("is 422 on a direct chat, 404 for a chat that is not yours", async () => {
    const { a, direct } = await setup();
    const other = await t.signUp();
    const { id } = direct("Tobias Kellner");
    await del(a, `/chats/${id}/members/${direct("Tobias Kellner").memberIds[0]}`).expect(422);
    await post(other, `/chats/${id}/members`).send({ memberIds: [] }).expect(404);
    await del(other, `/chats/${id}/members/x`).expect(404);
  });
});

describe("chats belong to the people in them", () => {
  it("answers 404 CHAT_NOT_FOUND, never 403, to everybody else, with the same message as an unknown id", async () => {
    const { chatList } = await setup();
    const other = await t.signUp();
    const mine = chatList[0]!.id;
    const unknown = "0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c";

    const attempts = (id: string) => [
      () => patch(other, `/chats/${id}`).send({ muted: true }),
      () => del(other, `/chats/${id}`),
      () => post(other, `/chats/${id}/read`),
      () => post(other, `/chats/${id}/clear`),
      () => post(other, `/chats/${id}/members`).send({ memberIds: [] }),
      () => del(other, `/chats/${id}/members/${unknown}`),
      () => get(other, `/chats/${id}/messages`),
    ];
    const foreign = await Promise.all(attempts(mine).map((run) => run()));
    const missing = await Promise.all(attempts(unknown).map((run) => run()));
    for (const res of foreign) {
      expect(res.status).toBe(404);
    }
    expect(foreign.map((r) => r.body)).toEqual(missing.map((r) => r.body));
    expect(foreign[0]!.body).toMatchObject({ code: "CHAT_NOT_FOUND" });
  });

  it("never answers 500 for an id that is not an id", async () => {
    const a = await t.signUp();
    for (const raw of ["zzz", "1", "not-a-uuid", "%00", "' OR 1=1 --", "0".repeat(300)]) {
      const id = encodeURIComponent(raw);
      for (const res of [
        await patch(a, `/chats/${id}`).send({ muted: true }),
        await del(a, `/chats/${id}`),
        await post(a, `/chats/${id}/read`),
        await post(a, `/chats/${id}/clear`),
        await post(a, `/chats/${id}/members`).send({ memberIds: [] }),
        await del(a, `/chats/${id}/members/${id}`),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe("CHAT_NOT_FOUND");
      }
    }
  });
});

describe("every chat route needs a signed-in person", () => {
  // A well-formed id, so that nothing but the missing sign-in can explain the answer.
  const id = "00000000-0000-4000-8000-000000000000";
  type Method = "get" | "post" | "patch" | "delete";
  const routes: [Method, string, object?][] = [
    ["post", "/chats", { type: "direct", contactId: id }],
    ["patch", `/chats/${id}`, { muted: true }],
    ["delete", `/chats/${id}`],
    ["post", `/chats/${id}/read`],
    ["post", `/chats/${id}/clear`],
    ["post", `/chats/${id}/members`, { memberIds: [id] }],
    ["delete", `/chats/${id}/members/${id}`],
    ["get", `/chats/${id}/messages`],
  ];

  it.each(routes)("%s %s", async (method, path, body) => {
    const anonymous = await request(t.server)[method](path).send(body).expect(401);
    expect(anonymous.body).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    const call = request(t.server)[method](path);
    const forged = await call.set({ Authorization: "Bearer not-a-token" }).send(body).expect(401);
    expect(forged.body).toMatchObject({ code: "UNAUTHORIZED" });
  });
});
