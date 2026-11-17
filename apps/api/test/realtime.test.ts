import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ChatDto, MessageDto, StatusDto } from "@dovetalk/contracts";
import { RealtimeEvents } from "@dovetalk/core";

import { createTestApp, type TestApp } from "./support/create-test-app.js";
import { makePeople } from "./support/people.js";
import { connect, sleep, type TestSocket, until } from "./support/sockets.js";

let t: TestApp;
let url: string;
const opened: TestSocket[] = [];

beforeAll(async () => {
  t = await createTestApp();
  url = await t.listen();
});
afterAll(async () => {
  for (const socket of opened) {
    socket.close();
  }
  await t.close();
});

const compare = (a: string, b: string) => a.localeCompare(b);

/** Lets everything that was asked for be sent and delivered, so "nothing arrived" can be asserted. */
const settle = async () => {
  await t.app.get(RealtimeEvents).idle();
  await sleep(150);
};

/** Connects people after everything set up so far has been announced, so it is not mistaken for news. */
const online = async (...accounts: Parameters<typeof connect>[1][]) => {
  await t.app.get(RealtimeEvents).idle();
  await sleep(50);
  const sockets = await Promise.all(accounts.map((a) => connect(url, a)));
  opened.push(...sockets);
  return sockets;
};

/** How many times each of these events arrived, for the one chat. */
const count = (socket: TestSocket, event: "message:new" | "message:updated", id: string) =>
  socket.heard(event).filter((p) => p.message.id === id).length;

const chatsFor = (socket: TestSocket, chatId: string) =>
  socket.heard("chat:updated").filter((p) => p.chat.id === chatId);

describe("a message sent over REST", () => {
  it("reaches the other person as message:new then chat:updated, in their ids, and tells the sender's own devices", async () => {
    const { accounts, contactOf, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    const [annSocket, annPhone, benSocket] = await online(ann, ann, ben);

    const clientId = "0b7c6c2a-6b7a-4c0e-9d0c-4f5a2f7f0a11";
    const sent = (await h.send(ann, chat.id, { clientId, text: "hi Ben" }).expect(201))
      .body as MessageDto;

    // Ben: his own contact id for Ann, and the chat as he sees it.
    const toBen = await benSocket.waitFor("message:new", (p) => p.message.id === sent.id);
    expect(toBen.message).toMatchObject({
      chatId: chat.id,
      text: "hi Ben",
      senderId: contactOf(ben, ann).id,
    });
    const benChat = await benSocket.waitFor("chat:updated", (p) => p.chat.id === chat.id);
    expect(benChat.chat.unread).toBe(1);
    expect(benChat.chat.lastMessage?.id).toBe(sent.id);
    expect(benChat.chat.memberIds).toEqual([contactOf(ben, ann).id]);
    const order = benSocket.all.map((x) => x.event);
    expect(order.indexOf("message:new")).toBeLessThan(order.indexOf("chat:updated"));

    // Ann, on both devices: it is hers, with the client id she made up, and nothing unread.
    for (const device of [annSocket, annPhone]) {
      const mine = await device.waitFor("message:new", (p) => p.message.id === sent.id);
      expect(mine.message).toMatchObject({ clientId, senderId: ann.user.id });
      const hers = await device.waitFor("chat:updated", (p) => p.chat.id === chat.id);
      expect(hers.chat.unread).toBe(0);
      expect(hers.chat.memberIds).toEqual([contactOf(ann, ben).id]);
    }
  });

  it("emits nothing for a replayed clientId", async () => {
    const { accounts, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    const [annSocket, benSocket] = await online(ann, ben);

    const clientId = "5d4a6d0e-9f1e-4d58-8a35-1d7e0a3b9c22";
    const first = (await h.send(ann, chat.id, { clientId }).expect(201)).body as MessageDto;
    const again = (await h.send(ann, chat.id, { clientId }).expect(200)).body as MessageDto;
    expect(again.id).toBe(first.id);
    await benSocket.waitFor("message:new", (p) => p.message.id === first.id);
    await settle();

    expect(count(benSocket, "message:new", first.id)).toBe(1);
    expect(count(annSocket, "message:new", first.id)).toBe(1);
    expect(chatsFor(benSocket, chat.id)).toHaveLength(1);
    expect(chatsFor(benSocket, chat.id)[0]?.chat.unread).toBe(1);
  });

  it("is not delivered to somebody who blocked the sender, and the sender is not told", async () => {
    const { accounts, contactOf, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    await h
      .as(ben)
      .put(`/contacts/${contactOf(ben, ann).id}/block`)
      .send({ blocked: true })
      .expect(200);
    const [annSocket, benSocket] = await online(ann, ben);

    const sent = await h.say(ann, chat.id, "can you hear me");
    await annSocket.waitFor("message:new", (p) => p.message.id === sent.id);
    await settle();

    expect(benSocket.heard("message:new")).toEqual([]);
    expect(chatsFor(benSocket, chat.id)).toEqual([]);
  });

  it("brings back a chat the other person deleted", async () => {
    const { accounts, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    await h.say(ann, chat.id, "first");
    await h.as(ben).delete(`/chats/${chat.id}`).expect(204);
    const [benSocket] = await online(ben);

    const sent = await h.say(ann, chat.id, "second");
    await benSocket.waitFor("message:new", (p) => p.message.id === sent.id);
    const back = await benSocket.waitFor("chat:updated", (p) => p.chat.id === chat.id);
    expect(back.chat.lastMessage?.id).toBe(sent.id);
    expect(back.chat.unread).toBe(1);
  });

  it("keeps messages in the order they were sent", async () => {
    const { accounts, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    const [benSocket] = await online(ben);

    const sent: MessageDto[] = [];
    for (let i = 0; i < 8; i += 1) {
      sent.push(await h.say(ann, chat.id, `message ${i}`));
    }
    await benSocket.waitFor("message:new", (p) => p.message.id === sent.at(-1)?.id);
    expect(benSocket.heard("message:new").map((p) => p.message.id)).toEqual(sent.map((m) => m.id));
  });
});

describe("changes to a message", () => {
  it("an edit reaches both people", async () => {
    const { accounts, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    const m = await h.say(ann, chat.id, "typo");
    const [annSocket, benSocket] = await online(ann, ben);

    await h.as(ann).patch(`/messages/${m.id}`).send({ text: "fixed" }).expect(200);
    for (const socket of [annSocket, benSocket]) {
      const updated = await socket.waitFor("message:updated", (p) => p.message.id === m.id);
      expect(updated.message).toMatchObject({ text: "fixed", edited: true });
    }
    // An edit is not a new message.
    expect(benSocket.heard("message:new")).toEqual([]);
  });

  it("delete for everyone reaches both, and delete for me reaches nobody but is visible in the chat list", async () => {
    const { accounts, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    const gone = await h.say(ann, chat.id, "oops");
    const mine = await h.say(ann, chat.id, "only mine");
    const [annSocket, benSocket] = await online(ann, ben);

    await h.as(ann).delete(`/messages/${gone.id}?scope=everyone`).expect(204);
    for (const socket of [annSocket, benSocket]) {
      const updated = await socket.waitFor("message:updated", (p) => p.message.id === gone.id);
      expect(updated.message).toMatchObject({ deleted: true, text: null });
    }

    await h.as(ann).delete(`/messages/${mine.id}?scope=me`).expect(204);
    await settle();
    expect(count(benSocket, "message:updated", mine.id)).toBe(0);
    expect(count(annSocket, "message:updated", mine.id)).toBe(0);
  });

  it("a reaction reaches both, each seeing the people in their own ids", async () => {
    const { accounts, contactOf, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    const m = await h.say(ann, chat.id, "react to me");
    const [annSocket, benSocket] = await online(ann, ben);

    await h.as(ben).put(`/messages/${m.id}/reaction`).send({ emoji: "👍" }).expect(200);
    const forAnn = await annSocket.waitFor("message:updated", (p) => p.message.id === m.id);
    const forBen = await benSocket.waitFor("message:updated", (p) => p.message.id === m.id);
    expect(forAnn.message.reactions).toEqual({ "👍": [contactOf(ann, ben).id] });
    expect(forBen.message.reactions).toEqual({ "👍": [ben.user.id] });
  });

  it("a forward arrives as message:new in the chat it was sent to, and not in the one it came from", async () => {
    const { accounts, direct, h } = await makePeople(t, 3);
    const [ann, ben, cy] = accounts as [
      (typeof accounts)[0],
      (typeof accounts)[0],
      (typeof accounts)[0],
    ];
    const withBen = await direct(ann, ben);
    const withCy = await direct(ann, cy);
    const m = await h.say(ann, withBen.id, "pass it on");
    const [benSocket, cySocket] = await online(ben, cy);

    const copies = (
      await h
        .as(ann)
        .post(`/messages/${m.id}/forward`)
        .send({ chatIds: [withCy.id] })
        .expect(201)
    ).body as MessageDto[];
    const copy = await cySocket.waitFor("message:new", (p) => p.message.id === copies[0]?.id);
    expect(copy.message).toMatchObject({ chatId: withCy.id, forwarded: true, text: "pass it on" });
    await settle();
    expect(benSocket.heard("message:new")).toEqual([]);
  });
});

describe("groups and chat changes", () => {
  it("creating a group tells every member with the system note and the chat, in their own ids", async () => {
    const { accounts, contactOf, group } = await makePeople(t, 3);
    const [ann, ben, cy] = accounts as [
      (typeof accounts)[0],
      (typeof accounts)[0],
      (typeof accounts)[0],
    ];
    const [annSocket, benSocket, cySocket] = await online(ann, ben, cy);

    const made = await group(ann, [ben, cy], "Climbing");
    for (const [socket, viewer, others] of [
      [annSocket, ann, [ben, cy]],
      [benSocket, ben, [ann, cy]],
      [cySocket, cy, [ann, ben]],
    ] as const) {
      const note = await socket.waitFor("message:new", (p) => p.message.chatId === made.id);
      expect(note.message.kind).toBe("system");
      const chat = await socket.waitFor("chat:updated", (p) => p.chat.id === made.id);
      expect(chat.chat).toMatchObject({ type: "group", name: "Climbing" });
      expect([...chat.chat.memberIds].sort(compare)).toEqual(
        others.map((other) => contactOf(viewer, other).id).sort(compare),
      );
    }
  });

  it("a rename tells every member", async () => {
    const { accounts, group, h } = await makePeople(t, 3);
    const [ann, ben, cy] = accounts as [
      (typeof accounts)[0],
      (typeof accounts)[0],
      (typeof accounts)[0],
    ];
    const made = await group(ann, [ben, cy]);
    const [annSocket, benSocket, cySocket] = await online(ann, ben, cy);

    await h.as(ann).patch(`/chats/${made.id}`).send({ name: "Renamed" }).expect(200);
    for (const socket of [annSocket, benSocket, cySocket]) {
      const chat = await socket.waitFor(
        "chat:updated",
        (p) => p.chat.id === made.id && p.chat.name === "Renamed",
      );
      expect(chat.chat.lastMessage?.kind).toBe("system");
      await socket.waitFor("message:new", (p) => p.message.chatId === made.id);
    }
  });

  it("adding a member tells everyone, including the new member, who now has the chat", async () => {
    const { accounts, contactOf, group, h } = await makePeople(t, 4);
    const [ann, ben, cy, dee] = accounts as [
      (typeof accounts)[0],
      (typeof accounts)[0],
      (typeof accounts)[0],
      (typeof accounts)[0],
    ];
    const made = await group(ann, [ben, cy]);
    const [annSocket, benSocket, deeSocket] = await online(ann, ben, dee);

    await h
      .as(ann)
      .post(`/chats/${made.id}/members`)
      .send({ memberIds: [contactOf(ann, dee).id] })
      .expect(200);

    const forBen = await benSocket.waitFor(
      "chat:updated",
      (p) => p.chat.id === made.id && p.chat.memberIds.includes(contactOf(ben, dee).id),
    );
    expect(forBen.chat.lastMessage?.kind).toBe("system");
    await annSocket.waitFor(
      "chat:updated",
      (p) => p.chat.id === made.id && p.chat.memberIds.includes(contactOf(ann, dee).id),
    );
    const forDee = await deeSocket.waitFor("chat:updated", (p) => p.chat.id === made.id);
    expect(forDee.chat.type).toBe("group");
    expect(forDee.chat.memberIds).toContain(contactOf(dee, ann).id);
  });

  it("removing a member sends them chat:removed, and tells the others", async () => {
    const { accounts, contactOf, group, h } = await makePeople(t, 4);
    const [ann, ben, cy, dee] = accounts as [
      (typeof accounts)[0],
      (typeof accounts)[0],
      (typeof accounts)[0],
      (typeof accounts)[0],
    ];
    const made = await group(ann, [ben, cy, dee]);
    const [benSocket, deeSocket] = await online(ben, dee);

    await h
      .as(ann)
      .delete(`/chats/${made.id}/members/${contactOf(ann, dee).id}`)
      .expect(200);

    await deeSocket.waitFor("chat:removed", (p) => p.chatId === made.id);
    const forBen = await benSocket.waitFor(
      "chat:updated",
      (p) => p.chat.id === made.id && !p.chat.memberIds.includes(contactOf(ben, dee).id),
    );
    expect(forBen.chat.lastMessage?.kind).toBe("system");
    await settle();
    // Dee is not told about the chat any more once it is gone from her list.
    expect(
      deeSocket
        .heard("chat:updated")
        .filter((p) => p.chat.id === made.id && p.chat.memberIds.length === 2),
    ).toEqual([]);
  });

  it("pin, archive, mute, read and clear go to the person who did them and nobody else", async () => {
    const { accounts, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    await h.say(ann, chat.id, "hello");
    await h.say(ben, chat.id, "unread for Ann");
    const [annSocket, annPhone, benSocket] = await online(ann, ann, ben);

    const before = {
      ann: chatsFor(annSocket, chat.id).length,
      phone: chatsFor(annPhone, chat.id).length,
    };
    await h.as(ann).patch(`/chats/${chat.id}`).send({ pinned: true }).expect(200);
    await h.as(ann).patch(`/chats/${chat.id}`).send({ archived: true, muted: true }).expect(200);
    await h.as(ann).post(`/chats/${chat.id}/read`).expect(204);
    await h.as(ann).post(`/chats/${chat.id}/clear`).expect(204);

    // Both of Ann's devices hear every change, and the flags in the last one are the sum.
    for (const [device, was] of [
      [annSocket, before.ann],
      [annPhone, before.phone],
    ] as const) {
      await until(
        () => chatsFor(device, chat.id).length >= was + 4,
        "Not every change reached Ann's device.",
      );
      const last = chatsFor(device, chat.id).at(-1)?.chat as ChatDto;
      expect(last).toMatchObject({ pinned: true, archived: true, muted: true, unread: 0 });
      expect(last.lastMessage).toBeNull();
    }
    await settle();
    expect(benSocket.heard("chat:updated")).toEqual([]);
    expect(benSocket.heard("chat:removed")).toEqual([]);
  });

  it("deleting a chat sends chat:removed to the person who deleted it only", async () => {
    const { accounts, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    await h.say(ann, chat.id, "hello");
    const [annSocket, benSocket] = await online(ann, ben);

    await h.as(ann).delete(`/chats/${chat.id}`).expect(204);
    await annSocket.waitFor("chat:removed", (p) => p.chatId === chat.id);
    await settle();
    expect(benSocket.heard("chat:removed")).toEqual([]);
    expect(chatsFor(benSocket, chat.id)).toEqual([]);
  });

  it("delete for me re-sends only that person's chat, with the earlier message as the last one", async () => {
    const { accounts, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    const first = await h.say(ann, chat.id, "first");
    const second = await h.say(ann, chat.id, "second");
    const [annSocket, benSocket] = await online(ann, ben);

    await h.as(ann).delete(`/messages/${second.id}?scope=me`).expect(204);
    const updated = await annSocket.waitFor("chat:updated", (p) => p.chat.id === chat.id);
    expect(updated.chat.lastMessage?.id).toBe(first.id);
    await settle();
    expect(benSocket.heard("chat:updated")).toEqual([]);
  });
});

describe("statuses", () => {
  it("a new status reaches the author's devices, as seen, and everybody who has them as a contact, as unseen", async () => {
    const { accounts, contactOf, h } = await makePeople(t, 3);
    const [ann, ben, cy] = accounts as [
      (typeof accounts)[0],
      (typeof accounts)[0],
      (typeof accounts)[0],
    ];
    const stranger = await t.signUp({ name: "Stranger" });
    const [annSocket, benSocket, cySocket, strangerSocket] = await online(ann, ben, cy, stranger);

    const made = (
      await h.as(ann).post("/statuses").send({ text: "on a trail", color: 2 }).expect(201)
    ).body as StatusDto;

    const mine = await annSocket.waitFor("status:new", (p) => p.status.id === made.id);
    expect(mine.status).toMatchObject({ ownerId: ann.user.id, seen: true, text: "on a trail" });
    for (const [socket, viewer] of [
      [benSocket, ben],
      [cySocket, cy],
    ] as const) {
      const heard = await socket.waitFor("status:new", (p) => p.status.id === made.id);
      expect(heard.status).toMatchObject({
        ownerId: contactOf(viewer, ann).id,
        seen: false,
        color: 2,
      });
    }
    await settle();
    expect(strangerSocket.heard("status:new")).toEqual([]);
  });
});

describe("typing", () => {
  it("shows the typer's first name from the other person's address book, and stops", async () => {
    const { accounts, contactOf, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    await h.say(ann, chat.id, "hi");
    const [annSocket, benSocket] = await online(ann, ben);

    annSocket.socket.emit("typing", { chatId: chat.id, isTyping: true });
    const on = await benSocket.waitFor("typing", (p) => p.chatId === chat.id && p.isTyping);
    // Ben saved Ann as "Person 1 (for Person 2)", so her first name to him is "Person".
    expect(on).toEqual({
      chatId: chat.id,
      contactId: contactOf(ben, ann).id,
      name: "Person",
      isTyping: true,
    });
    annSocket.socket.emit("typing", { chatId: chat.id, isTyping: false });
    await benSocket.waitFor("typing", (p) => p.chatId === chat.id && !p.isTyping);
    // The typer is not told about their own typing.
    expect(annSocket.heard("typing")).toEqual([]);
  });

  it("passes on 'typing' at most once a second per chat, and 'stopped' always", async () => {
    const { accounts, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    await h.say(ann, chat.id, "hi");
    const [annSocket, benSocket] = await online(ann, ben);

    for (let i = 0; i < 5; i += 1) {
      annSocket.socket.emit("typing", { chatId: chat.id, isTyping: true });
    }
    annSocket.socket.emit("typing", { chatId: chat.id, isTyping: false });
    annSocket.socket.emit("typing", { chatId: chat.id, isTyping: false });
    await settle();
    const heard = benSocket.heard("typing").map((p) => p.isTyping);
    expect(heard).toEqual([true, false, false]);

    // After the interval it is let through again.
    await sleep(1050);
    annSocket.socket.emit("typing", { chatId: chat.id, isTyping: true });
    await settle();
    expect(benSocket.heard("typing").filter((p) => p.isTyping)).toHaveLength(2);
  });

  it("ignores somebody who is not in the chat, and payloads that make no sense", async () => {
    const { accounts, direct, h } = await makePeople(t, 3);
    const [ann, ben, cy] = accounts as [
      (typeof accounts)[0],
      (typeof accounts)[0],
      (typeof accounts)[0],
    ];
    const chat = await direct(ann, ben);
    await h.say(ann, chat.id, "hi");
    const [benSocket, cySocket] = await online(ben, cy);

    cySocket.socket.emit("typing", { chatId: chat.id, isTyping: true });
    for (const junk of [null, 7, "x", [], {}, { chatId: chat.id }, { chatId: 5, isTyping: true }]) {
      cySocket.socket.emit("typing", junk);
    }
    const [annSocket] = await online(ann);
    for (const junk of [
      { chatId: "not-a-uuid", isTyping: true },
      { chatId: chat.id, isTyping: "yes" },
      { chatId: chat.id },
      null,
      "text",
    ]) {
      annSocket.socket.emit("typing", junk);
    }
    await settle();
    expect(benSocket.heard("typing")).toEqual([]);
    // And the connection survives it all.
    annSocket.socket.emit("typing", { chatId: chat.id, isTyping: true });
    await benSocket.waitFor("typing", (p) => p.chatId === chat.id && p.isTyping);
  });

  it("says typing stopped when the typer's connection drops", async () => {
    const { accounts, direct, h } = await makePeople(t, 2);
    const [ann, ben] = accounts as [(typeof accounts)[0], (typeof accounts)[0]];
    const chat = await direct(ann, ben);
    await h.say(ann, chat.id, "hi");
    const [annSocket, benSocket] = await online(ann, ben);

    annSocket.socket.emit("typing", { chatId: chat.id, isTyping: true });
    await benSocket.waitFor("typing", (p) => p.isTyping);
    annSocket.close();
    await benSocket.waitFor("typing", (p) => p.chatId === chat.id && !p.isTyping);
  });

  it("is not heard by somebody who blocked the typer, or was blocked by them", async () => {
    const { accounts, contactOf, direct, h } = await makePeople(t, 3);
    const [ann, ben, cy] = accounts as [
      (typeof accounts)[0],
      (typeof accounts)[0],
      (typeof accounts)[0],
    ];
    const withBen = await direct(ann, ben);
    const withCy = await direct(ann, cy);
    await h.say(ann, withBen.id, "hi");
    await h.say(ann, withCy.id, "hi");
    await h
      .as(ben)
      .put(`/contacts/${contactOf(ben, ann).id}/block`)
      .send({ blocked: true })
      .expect(200);
    await h
      .as(ann)
      .put(`/contacts/${contactOf(ann, cy).id}/block`)
      .send({ blocked: true })
      .expect(200);
    const [annSocket, benSocket, cySocket] = await online(ann, ben, cy);

    annSocket.socket.emit("typing", { chatId: withBen.id, isTyping: true });
    annSocket.socket.emit("typing", { chatId: withCy.id, isTyping: true });
    await settle();
    expect(benSocket.heard("typing")).toEqual([]);
    expect(cySocket.heard("typing")).toEqual([]);
  });
});
