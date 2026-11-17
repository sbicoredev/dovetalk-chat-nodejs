import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ChatDto,
  FORWARD_CHATS_MAX,
  MAX_MESSAGE_TEXT,
  type MessageDto,
} from "@dovetalk/contracts";
import { newId } from "@dovetalk/db";

import { createTestApp, type TestApp } from "./support/create-test-app.js";
import { http, PNG } from "./support/http.js";
import { objectBehind } from "./support/storage.js";

let t: TestApp;
let h: ReturnType<typeof http>;
beforeAll(async () => {
  t = await createTestApp();
  h = http(t);
});
afterAll(() => t.close());

const ROUTES: [string, string][] = [
  ["post", "/chats/x/messages"],
  ["patch", "/messages/x"],
  ["delete", "/messages/x?scope=me"],
  ["put", "/messages/x/reaction"],
  ["post", "/messages/x/forward"],
];

describe("the message write routes", () => {
  it.each(ROUTES)("%s %s needs a signed-in person", async (method, path) => {
    const res = await (request(t.server) as unknown as Record<string, (p: string) => request.Test>)[
      method
    ]!(path)
      .send({})
      .expect(401);
    expect(res.body).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
  });
});

describe("POST /chats/:chatId/messages", () => {
  it("sends a text message: 201 with the message, and the chat's last message updates", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const clientId = randomUUID();
    const res = await h
      .as(a)
      .post(`/chats/${chat.id}/messages`)
      .send({ clientId, kind: "text", text: "  hi there  " })
      .expect(201);
    expect(res.body).toMatchObject({
      chatId: chat.id,
      clientId,
      senderId: a.user.id,
      kind: "text",
      text: "hi there",
      attachment: null,
      replyTo: null,
      reactions: {},
      edited: false,
      deleted: false,
      forwarded: false,
    });
    const chats = (await h.as(a).get("/chats").expect(200)).body as ChatDto[];
    expect(chats.find((c) => c.id === chat.id)!.lastMessage!.id).toBe(res.body.id);
    expect((await h.history(a, chat.id)).at(-1)!.id).toBe(res.body.id);
  });

  it("is idempotent: the same clientId answers 200 with the first message and adds nothing", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const clientId = randomUUID();
    const first = await h.send(a, chat.id, { clientId, text: "once" }).expect(201);
    const before = (await h.history(a, chat.id)).length;
    // A retry with different text still returns the stored message.
    const again = await h.send(a, chat.id, { clientId, text: "changed" }).expect(200);
    expect(again.body).toEqual(first.body);
    expect((await h.history(a, chat.id)).length).toBe(before);
    // Many at once: one message, one 201.
    const id = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.send(a, chat.id, { clientId: id, text: "race" })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(4);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
  });

  it("refuses empty, blank and over-long text with 422", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    for (const text of ["", "   ", "\n"]) {
      const res = await h.send(a, chat.id, { text }).expect(422);
      expect(res.body).toMatchObject({
        code: "VALIDATION_ERROR",
        message: ["Message can't be empty."],
      });
    }
    const long = await h.send(a, chat.id, { text: "x".repeat(MAX_MESSAGE_TEXT + 1) }).expect(422);
    expect(long.body.code).toBe("VALIDATION_ERROR");
    await h.send(a, chat.id, { text: "x".repeat(MAX_MESSAGE_TEXT) }).expect(201);
  });

  it("checks the shape of the body", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const post = (body: unknown) =>
      h
        .as(a)
        .post(`/chats/${chat.id}/messages`)
        .send(body as object);
    await post({}).expect(422);
    await post({ kind: "text", text: "x" }).expect(422);
    await post({ clientId: "", kind: "text", text: "x" }).expect(422);
    await post({ clientId: "x".repeat(101), kind: "text", text: "x" }).expect(422);
    await post({ clientId: randomUUID(), kind: "system", text: "x" }).expect(422);
    await post({ clientId: randomUUID(), kind: "sticker" }).expect(422);
    await post({ clientId: randomUUID(), kind: "text", text: 5 }).expect(422);
    await post({ clientId: randomUUID(), kind: "voice", duration: "long" }).expect(422);
    await post({ clientId: randomUUID(), kind: "voice", duration: 5, bars: "no" }).expect(422);
    await post({ clientId: randomUUID(), kind: "voice", duration: 5, bars: [1, 200] }).expect(422);
    await post([1]).expect(422);
    // A NUL anywhere in the body is refused like on every route.
    await post({ clientId: randomUUID(), kind: "text", text: "a\u0000b" }).expect(422);
  });

  it("treats null optional fields as not sent, and drops fields it does not know", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const res = await h
      .send(a, chat.id, {
        replyToId: null,
        attachmentId: null,
        duration: null,
        bars: null,
        senderId: "x",
        id: "y",
        seq: 99,
      })
      .expect(201);
    expect(res.body.senderId).toBe(a.user.id);
    expect(res.body.id).not.toBe("y");
  });

  it("sends a voice message with its length and bars", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const res = await h
      .send(a, chat.id, { kind: "voice", text: "ignored", duration: 13.6, bars: [10, 20, 30] })
      .expect(201);
    expect(res.body).toMatchObject({ kind: "voice", duration: 14, bars: [10, 20, 30], text: null });
    const none = await h
      .send(a, chat.id, { kind: "voice", text: undefined, duration: 0 })
      .expect(422);
    expect(none.body.message).toEqual(["A voice message needs a length."]);
  });

  it("embeds a reply preview, and refuses a reply to a message that is not in this chat", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const other = await h.directWith(a, "Tobias Kellner");
    const first = await h.say(a, chat.id, "question?");
    const reply = await h.send(a, chat.id, { text: "answer", replyToId: first.id }).expect(201);
    expect(reply.body.replyTo).toMatchObject({
      id: first.id,
      text: "question?",
      deleted: false,
      senderId: a.user.id,
    });
    const elsewhere = await h.say(a, other.chat.id, "another chat");
    await h.send(a, chat.id, { replyToId: elsewhere.id }).expect(422);
    await h.send(a, chat.id, { replyToId: "zzz" }).expect(422);
    await h.send(a, chat.id, { replyToId: newId() }).expect(422);
  });

  it("answers 404 CHAT_NOT_FOUND for a malformed, unknown or somebody else's chat", async () => {
    const [a, b] = [await t.signUp(), await t.signUp()];
    const { chat } = await h.directWith(a, "Priya Anand");
    const before = (await h.history(a, chat.id)).length;
    for (const id of ["zzz", newId(), chat.id]) {
      const res = await h.send(b, id).expect(404);
      expect(res.body).toMatchObject({ statusCode: 404, code: "CHAT_NOT_FOUND" });
    }
    // Nothing was written into Ann's chat by the failed attempts.
    expect((await h.history(a, chat.id)).length).toBe(before);
  });

  it("answers 403 CONTACT_BLOCKED when you blocked the contact, until you unblock", async () => {
    const a = await t.signUp();
    const { chat, contact } = await h.directWith(a, "Priya Anand");
    await h.as(a).put(`/contacts/${contact.id}/block`).send({ blocked: true }).expect(200);
    const res = await h.send(a, chat.id).expect(403);
    expect(res.body).toMatchObject({ statusCode: 403, code: "CONTACT_BLOCKED" });
    await h.as(a).put(`/contacts/${contact.id}/block`).send({ blocked: false }).expect(200);
    await h.send(a, chat.id).expect(201);
  });
});

describe("messages between two people", () => {
  it("delivers to the other person under their own ids, with unread, and hides nothing", async () => {
    const { a, b, chat } = await h.pair();
    const sent = await h.say(a, chat.id, "hello Ben");
    const theirChats = (await h.as(b).get("/chats").expect(200)).body as ChatDto[];
    const theirs = theirChats.find((c) => c.lastMessage?.id === sent.id)!;
    expect(theirs.unread).toBe(1);
    const [theirView] = (await h.history(b, theirs.id)).slice(-1);
    expect(theirView).toMatchObject({ id: sent.id, text: "hello Ben", clientId: null });
    // For Ben the sender is his contact for Ann, not Ann's user id.
    expect(theirView!.senderId).not.toBe(a.user.id);
    expect(theirs.memberIds).toContain(theirView!.senderId);
  });

  it("stores but never shows a message to someone who blocked the sender", async () => {
    const { a, b, chat } = await h.pair();
    const first = await h.say(a, chat.id, "before the block");
    const theirs = ((await h.as(b).get("/chats").expect(200)).body as ChatDto[]).find(
      (c) => c.lastMessage?.id === first.id,
    )!;
    const contactOfAnn = theirs.memberIds[0]!;
    await h.as(b).put(`/contacts/${contactOfAnn}/block`).send({ blocked: true }).expect(200);
    const hidden = await h.send(a, chat.id, { text: "you cannot see this" }).expect(201);
    expect((await h.history(b, theirs.id)).some((m) => m.id === hidden.body.id)).toBe(false);
    await h.as(b).put(`/contacts/${contactOfAnn}/block`).send({ blocked: false }).expect(200);
    // Still not there after the unblock.
    expect((await h.history(b, theirs.id)).some((m) => m.id === hidden.body.id)).toBe(false);
    expect((await h.history(a, chat.id)).some((m) => m.id === hidden.body.id)).toBe(true);
  });
});

describe("pictures, files and uploads in messages", () => {
  it("sends a picture with an upload, and the link loads the same bytes", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const up = await h.upload(a, PNG, "dot.png", "image/png").expect(201);
    const res = await h
      .send(a, chat.id, { kind: "image", attachmentId: up.body.id, text: " the dot " })
      .expect(201);
    expect(res.body).toMatchObject({ kind: "image", text: "the dot" });
    expect(res.body.attachment).toMatchObject({
      id: up.body.id,
      name: "dot.png",
      mime: "image/png",
      size: PNG.length,
    });
    const bytes = Buffer.from(await (await fetch(res.body.attachment.url)).arrayBuffer());
    expect(bytes.equals(PNG)).toBe(true);
  });

  it("uses an upload once, and only for its owner", async () => {
    const [a, b] = [await t.signUp(), await t.signUp()];
    const { chat } = await h.directWith(a, "Priya Anand");
    const { chat: bChat } = await h.directWith(b, "Priya Anand");
    const up = await h.upload(a, Buffer.from("notes"), "notes.txt", "text/plain").expect(201);
    // Somebody else's upload is the same as an unknown one.
    const stolen = await h
      .send(b, bChat.id, { kind: "file", attachmentId: up.body.id })
      .expect(422);
    expect(stolen.body.code).toBe("ATTACHMENT_NOT_FOUND");
    await h.send(a, chat.id, { kind: "file", attachmentId: up.body.id }).expect(201);
    const reused = await h.send(a, chat.id, { kind: "file", attachmentId: up.body.id }).expect(422);
    expect(reused.body.code).toBe("ATTACHMENT_NOT_FOUND");
    for (const attachmentId of ["nope", newId(), undefined]) {
      const res = await h.send(a, chat.id, { kind: "file", attachmentId }).expect(422);
      expect(res.body.code).toBe("ATTACHMENT_NOT_FOUND");
    }
  });

  it("refuses an image message whose file is not a picture, and keeps the upload usable", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const up = await h.upload(a, Buffer.from("plain"), "a.txt", "text/plain").expect(201);
    const res = await h.send(a, chat.id, { kind: "image", attachmentId: up.body.id }).expect(422);
    expect(res.body).toMatchObject({
      code: "VALIDATION_ERROR",
      message: ["That file isn't an image."],
    });
    await h.send(a, chat.id, { kind: "file", attachmentId: up.body.id }).expect(201);
  });

  it("repeats the same answer when a picture send is retried", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const up = await h.upload(a, PNG, "dot.png").expect(201);
    const clientId = randomUUID();
    const first = await h
      .send(a, chat.id, { clientId, kind: "image", attachmentId: up.body.id })
      .expect(201);
    const again = await h
      .send(a, chat.id, { clientId, kind: "image", attachmentId: up.body.id })
      .expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.attachment.id).toBe(up.body.id);
  });
});

describe("PATCH /messages/:id", () => {
  it("edits the text, marks it edited and answers the message", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const m = await h.say(a, chat.id, "typo");
    const res = await h.as(a).patch(`/messages/${m.id}`).send({ text: "  fixed " }).expect(200);
    expect(res.body).toMatchObject({ id: m.id, text: "fixed", edited: true });
    expect((await h.history(a, chat.id)).find((x) => x.id === m.id)).toMatchObject({
      text: "fixed",
      edited: true,
    });
  });

  it("edits the caption of a picture, and can remove it", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const up = await h.upload(a, PNG, "dot.png").expect(201);
    const m = (
      await h.send(a, chat.id, { kind: "image", attachmentId: up.body.id, text: "old" }).expect(201)
    ).body as MessageDto;
    const next = await h.as(a).patch(`/messages/${m.id}`).send({ text: "new" }).expect(200);
    expect(next.body.text).toBe("new");
    const none = await h.as(a).patch(`/messages/${m.id}`).send({ text: "  " }).expect(200);
    expect(none.body.text).toBeNull();
  });

  it("refuses: empty text 422, voice 422, deleted 422, other people's 403, system 403, missing 404", async () => {
    const [a, b] = [await t.signUp(), await t.signUp()];
    const { chat } = await h.directWith(a, "Priya Anand");
    const text = await h.say(a, chat.id, "mine");
    const voice = (await h.send(a, chat.id, { kind: "voice", duration: 3 }).expect(201))
      .body as MessageDto;
    const gone = await h.say(a, chat.id, "to delete");
    await h.as(a).delete(`/messages/${gone.id}?scope=everyone`).expect(204);
    const items = await h.history(a, chat.id);
    const theirs = items.find((m) => m.senderId !== a.user.id && m.kind === "text")!;

    const edit = (who: typeof a, id: string, body: unknown = { text: "x" }) =>
      h
        .as(who)
        .patch(`/messages/${id}`)
        .send(body as object);
    expect((await edit(a, text.id, { text: "" }).expect(422)).body.code).toBe("VALIDATION_ERROR");
    await edit(a, text.id, {}).expect(422);
    await edit(a, text.id, { text: 5 }).expect(422);
    await edit(a, voice.id).expect(422);
    await edit(a, gone.id).expect(422);
    expect((await edit(a, theirs.id).expect(403)).body.code).toBe("FORBIDDEN");
    // Somebody who cannot see the message gets 404, never 403.
    for (const id of [text.id, "zzz", newId()]) {
      expect((await edit(b, id).expect(404)).body.code).toBe("MESSAGE_NOT_FOUND");
    }
    expect((await h.history(a, chat.id)).find((m) => m.id === text.id)!.text).toBe("mine");
  });
});

describe("DELETE /messages/:id", () => {
  it("needs a scope: none or an unknown one is 422, and nothing is deleted", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const m = await h.say(a, chat.id);
    for (const query of ["", "?scope=", "?scope=all", "?scope=ME", "?scope=me&scope=everyone"]) {
      const res = await h.as(a).delete(`/messages/${m.id}${query}`).expect(422);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    }
    expect((await h.history(a, chat.id)).find((x) => x.id === m.id)).toMatchObject({
      deleted: false,
      text: "hello",
    });
  });

  it("scope=me hides it from you only, for your own and other people's messages", async () => {
    const { a, b, chat } = await h.pair();
    const m = await h.say(a, chat.id, "for both");
    const theirs = ((await h.as(b).get("/chats").expect(200)).body as ChatDto[]).find(
      (c) => c.lastMessage?.id === m.id,
    )!;
    await h.as(b).delete(`/messages/${m.id}?scope=me`).expect(204);
    await h.as(b).delete(`/messages/${m.id}?scope=me`).expect(404);
    expect((await h.history(b, theirs.id)).some((x) => x.id === m.id)).toBe(false);
    // The chat list no longer shows it as the last message either, for them only.
    const lastIdIn = async (user: typeof a, chatId: string) =>
      ((await h.as(user).get("/chats").expect(200)).body as ChatDto[]).find((c) => c.id === chatId)
        ?.lastMessage?.id;
    expect(await lastIdIn(b, theirs.id)).not.toBe(m.id);
    expect(await lastIdIn(a, chat.id)).toBe(m.id);
    expect((await h.history(a, chat.id)).find((x) => x.id === m.id)).toMatchObject({
      deleted: false,
      text: "for both",
    });
    await h.as(a).delete(`/messages/${m.id}?scope=me`).expect(204);
    expect((await h.history(a, chat.id)).some((x) => x.id === m.id)).toBe(false);
  });

  it("scope=everyone leaves a tombstone for everybody, drops reactions, and is repeatable", async () => {
    const { a, b, chat } = await h.pair();
    const m = await h.say(a, chat.id, "oops");
    const theirs = ((await h.as(b).get("/chats").expect(200)).body as ChatDto[]).find(
      (c) => c.lastMessage?.id === m.id,
    )!;
    await h.as(b).put(`/messages/${m.id}/reaction`).send({ emoji: "👍" }).expect(200);
    await h.as(a).patch(`/messages/${m.id}`).send({ text: "edited" }).expect(200);
    await h.as(a).delete(`/messages/${m.id}?scope=everyone`).expect(204);
    await h.as(a).delete(`/messages/${m.id}?scope=everyone`).expect(204);
    for (const [who, chatId] of [
      [a, chat.id],
      [b, theirs.id],
    ] as const) {
      expect((await h.history(who, chatId)).find((x) => x.id === m.id)).toMatchObject({
        deleted: true,
        text: null,
        attachment: null,
        reactions: {},
        edited: false,
      });
    }
    // Nothing more can be done to it.
    await h.as(a).patch(`/messages/${m.id}`).send({ text: "back" }).expect(422);
    await h.as(b).put(`/messages/${m.id}/reaction`).send({ emoji: "👍" }).expect(422);
  });

  it("scope=everyone is the sender's alone: 403 for somebody else's message", async () => {
    const { a, b, chat } = await h.pair();
    const m = await h.say(a, chat.id);
    const theirs = ((await h.as(b).get("/chats").expect(200)).body as ChatDto[]).find(
      (c) => c.lastMessage?.id === m.id,
    )!;
    const res = await h.as(b).delete(`/messages/${m.id}?scope=everyone`).expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect((await h.history(b, theirs.id)).find((x) => x.id === m.id)!.deleted).toBe(false);
  });

  it("answers 404 for unknown, malformed and invisible messages, whatever the scope", async () => {
    const [a, b] = [await t.signUp(), await t.signUp()];
    const { chat } = await h.directWith(a, "Priya Anand");
    const m = await h.say(a, chat.id);
    for (const scope of ["me", "everyone"]) {
      for (const id of ["zzz", newId(), m.id]) {
        const res = await h.as(b).delete(`/messages/${id}?scope=${scope}`).expect(404);
        expect(res.body.code).toBe("MESSAGE_NOT_FOUND");
      }
    }
    expect((await h.history(a, chat.id)).find((x) => x.id === m.id)!.deleted).toBe(false);
  });

  it("frees the file after the last message that used it is deleted for everyone", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const up = await h.upload(a, Buffer.from("secret"), "s.txt", "text/plain").expect(201);
    const m = (await h.send(a, chat.id, { kind: "file", attachmentId: up.body.id }).expect(201))
      .body as MessageDto;
    const { url } = m.attachment!;
    expect((await fetch(url)).status).toBe(200);
    expect(await objectBehind(url), "the helper must see a file that is there").toBe(true);
    await h.as(a).delete(`/messages/${m.id}?scope=everyone`).expect(204);
    expect(await objectBehind(url)).toBe(false);
  });
});

describe("PUT /messages/:id/reaction", () => {
  it("toggles on and off, replaces a different emoji, and shows contact ids to the other side", async () => {
    const { a, b, bContact, chat } = await h.pair();
    const m = await h.say(a, chat.id, "react");
    const theirs = ((await h.as(b).get("/chats").expect(200)).body as ChatDto[]).find(
      (c) => c.lastMessage?.id === m.id,
    )!;
    const put = (who: typeof a, emoji: unknown) =>
      h.as(who).put(`/messages/${m.id}/reaction`).send({ emoji });

    const on = await put(a, "👍").expect(200);
    expect(on.body.reactions).toEqual({ "👍": [a.user.id] });
    const second = await put(b, "👍").expect(200);
    const annAsSeenByBen = theirs.memberIds[0]!;
    // Ben sees himself by his own id and Ann by his contact for her.
    expect(second.body.reactions["👍"]).toEqual([annAsSeenByBen, b.user.id]);
    const replaced = await put(a, "🎉").expect(200);
    // Ann sees Ben as her contact for him.
    expect(replaced.body.reactions).toEqual({ "👍": [bContact.id], "🎉": [a.user.id] });
    const off = await put(a, "🎉").expect(200);
    expect(off.body.reactions).toEqual({ "👍": [bContact.id] });
    expect((await h.history(a, chat.id)).find((x) => x.id === m.id)!.reactions).toEqual({
      "👍": [bContact.id],
    });
  });

  it("accepts emoji and refuses anything else with 422", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const m = await h.say(a, chat.id);
    const put = (emoji: unknown) => h.as(a).put(`/messages/${m.id}/reaction`).send({ emoji });
    for (const emoji of ["👍", "👍🏽", "❤️", "🇧🇩", "1️⃣", "👨‍👩‍👧‍👦"]) {
      await put(emoji).expect(200);
    }
    for (const emoji of [
      "",
      "hi",
      "hi👍",
      "👍 ",
      "1",
      "#",
      "x".repeat(40),
      5,
      null,
      undefined,
      ["👍"],
    ]) {
      const res = await put(emoji).expect(422);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    }
  });

  it("is 404 for messages you cannot see, and 422 for system notes", async () => {
    const [a, b] = [await t.signUp(), await t.signUp()];
    const { chat } = await h.directWith(a, "Priya Anand");
    const m = await h.say(a, chat.id);
    for (const id of [m.id, "zzz", newId()]) {
      expect(
        (await h.as(b).put(`/messages/${id}/reaction`).send({ emoji: "👍" }).expect(404)).body.code,
      ).toBe("MESSAGE_NOT_FOUND");
    }
    const hikers = ((await h.as(a).get("/chats").expect(200)).body as ChatDto[]).find(
      (c) => c.name === "Weekend hikers",
    )!;
    const note = (await h.history(a, hikers.id)).find((x) => x.kind === "system")!;
    await h.as(a).put(`/messages/${note.id}/reaction`).send({ emoji: "👍" }).expect(422);
  });
});

describe("POST /messages/:id/forward", () => {
  it("copies the message into several chats, in the order given, marked forwarded", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const one = await h.directWith(a, "Imogen Varley");
    const two = await h.directWith(a, "Tobias Kellner");
    const m = await h.say(a, chat.id, "pass it on");
    await h.as(a).put(`/messages/${m.id}/reaction`).send({ emoji: "👍" }).expect(200);
    const res = await h
      .as(a)
      .post(`/messages/${m.id}/forward`)
      .send({ chatIds: [two.chat.id, one.chat.id, two.chat.id] })
      .expect(201);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((c: MessageDto) => c.chatId)).toEqual([two.chat.id, one.chat.id]);
    for (const copy of res.body as MessageDto[]) {
      expect(copy).toMatchObject({
        forwarded: true,
        text: "pass it on",
        senderId: a.user.id,
        reactions: {},
        replyTo: null,
        clientId: null,
      });
      expect(copy.id).not.toBe(m.id);
    }
  });

  it("returns an empty list with 201 for no chats", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const m = await h.say(a, chat.id);
    const res = await h.as(a).post(`/messages/${m.id}/forward`).send({ chatIds: [] }).expect(201);
    expect(res.body).toEqual([]);
  });

  it("is all or nothing: one chat that is not yours is 404 and nothing is sent", async () => {
    const [a, b] = [await t.signUp(), await t.signUp()];
    const { chat } = await h.directWith(a, "Priya Anand");
    const mine = await h.directWith(a, "Imogen Varley");
    const theirs = await h.directWith(b, "Imogen Varley");
    const m = await h.say(a, chat.id);
    const before = (await h.history(a, mine.chat.id)).length;
    for (const bad of [theirs.chat.id, "zzz", newId()]) {
      const res = await h
        .as(a)
        .post(`/messages/${m.id}/forward`)
        .send({ chatIds: [mine.chat.id, bad] })
        .expect(404);
      expect(res.body.code).toBe("CHAT_NOT_FOUND");
    }
    expect((await h.history(a, mine.chat.id)).length).toBe(before);
  });

  it("skips a direct chat with somebody you blocked", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const blocked = await h.directWith(a, "Imogen Varley");
    const fine = await h.directWith(a, "Tobias Kellner");
    await h.as(a).put(`/contacts/${blocked.contact.id}/block`).send({ blocked: true }).expect(200);
    const m = await h.say(a, chat.id);
    const res = await h
      .as(a)
      .post(`/messages/${m.id}/forward`)
      .send({ chatIds: [blocked.chat.id, fine.chat.id] })
      .expect(201);
    expect(res.body.map((c: MessageDto) => c.chatId)).toEqual([fine.chat.id]);
  });

  it("checks the list and the message", async () => {
    const [a, b] = [await t.signUp(), await t.signUp()];
    const { chat } = await h.directWith(a, "Priya Anand");
    const m = await h.say(a, chat.id);
    const fwd = (who: typeof a, id: string, body: unknown) =>
      h
        .as(who)
        .post(`/messages/${id}/forward`)
        .send(body as object);
    await fwd(a, m.id, {}).expect(422);
    await fwd(a, m.id, { chatIds: "x" }).expect(422);
    await fwd(a, m.id, { chatIds: [1] }).expect(422);
    await fwd(a, m.id, {
      chatIds: Array.from({ length: FORWARD_CHATS_MAX + 1 }, () => newId()),
    }).expect(422);
    for (const id of [m.id, "zzz", newId()]) {
      expect((await fwd(b, id, { chatIds: [] }).expect(404)).body.code).toBe("MESSAGE_NOT_FOUND");
    }
    await h.as(a).delete(`/messages/${m.id}?scope=everyone`).expect(204);
    await fwd(a, m.id, { chatIds: [chat.id] }).expect(422);
  });
});
