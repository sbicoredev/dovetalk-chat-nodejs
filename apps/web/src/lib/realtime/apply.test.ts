import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import { createSeed, ME_ID } from "@/lib/api/mock/seed";
import type { ChatDto, ContactDto, MessageDto } from "@/lib/api/types";
import type { MessagesData } from "@/lib/queries/cache";
import { keys } from "@/lib/queries/keys";

import { applyServerEvent } from "./apply";

const NOW = 1_700_000_000_000;

function message(over: Partial<MessageDto> = {}): MessageDto {
  return {
    id: "m-new",
    chatId: "chat-a",
    clientId: null,
    senderId: "c1",
    kind: "text",
    text: "hello",
    duration: null,
    bars: null,
    attachment: null,
    createdAt: NOW,
    replyTo: null,
    reactions: {},
    edited: false,
    deleted: false,
    forwarded: false,
    ...over,
  };
}

function chat(over: Partial<ChatDto> = {}): ChatDto {
  return {
    id: "chat-a",
    type: "direct",
    name: null,
    hue: 10,
    memberIds: ["c1"],
    unread: 0,
    archived: false,
    pinned: false,
    muted: false,
    createdAt: NOW - 1000,
    lastMessage: message({ id: "m-old", createdAt: NOW - 500 }),
    ...over,
  };
}

let qc: QueryClient;
const ctx = { meId: ME_ID, activeChatId: null as string | null };

const messagesOf = (id = "chat-a") =>
  qc.getQueryData<MessagesData>(keys.messages(id))!.pages.flatMap((p) => p.items.map((m) => m.id));

beforeEach(() => {
  qc = new QueryClient();
  qc.setQueryData(keys.chats, [chat()]);
  qc.setQueryData<MessagesData>(keys.messages("chat-a"), {
    pages: [{ items: [message({ id: "m-old", createdAt: NOW - 500 })], nextCursor: null }],
    pageParams: [null],
  });
  void createSeed;
});

describe("applyServerEvent", () => {
  it("adds a new message, updates the chat and asks for a chime", () => {
    const effects = applyServerEvent(
      qc,
      { event: "message:new", payload: { message: message() } },
      ctx,
    );
    expect(messagesOf()).toEqual(["m-old", "m-new"]);
    expect(qc.getQueryData<ChatDto[]>(keys.chats)![0].lastMessage?.id).toBe("m-new");
    expect(effects).toContainEqual({ type: "chime" });
  });

  it("is harmless when the same message arrives twice", () => {
    const ev = { event: "message:new" as const, payload: { message: message() } };
    applyServerEvent(qc, ev, ctx);
    applyServerEvent(qc, ev, ctx);
    expect(messagesOf()).toEqual(["m-old", "m-new"]);
  });

  it("replaces an optimistic message that has the same clientId", () => {
    qc.setQueryData<MessagesData>(keys.messages("chat-a"), {
      pages: [
        {
          items: [
            { ...message({ id: "pending-k1", senderId: ME_ID, clientId: "k1" }), pending: true },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [null],
    });
    applyServerEvent(
      qc,
      {
        event: "message:new",
        payload: { message: message({ id: "real", senderId: ME_ID, clientId: "k1" }) },
      },
      ctx,
    );
    expect(messagesOf()).toEqual(["real"]);
  });

  it("stays quiet for my own messages and muted chats", () => {
    expect(
      applyServerEvent(
        qc,
        { event: "message:new", payload: { message: message({ senderId: ME_ID }) } },
        ctx,
      ),
    ).toEqual([]);
    qc.setQueryData(keys.chats, [chat({ muted: true })]);
    expect(
      applyServerEvent(
        qc,
        { event: "message:new", payload: { message: message({ id: "m2" }) } },
        ctx,
      ),
    ).toEqual([]);
  });

  it("marks the open chat read instead of leaving it unread", () => {
    const effects = applyServerEvent(
      qc,
      { event: "message:new", payload: { message: message() } },
      { ...ctx, activeChatId: "chat-a" },
    );
    expect(effects).toContainEqual({ type: "markRead", chatId: "chat-a" });
    expect(qc.getQueryData<ChatDto[]>(keys.chats)![0].unread).toBe(0);
  });

  it("refetches the chat list for a chat it doesn't know", () => {
    qc.setQueryData(keys.chats, []);
    applyServerEvent(
      qc,
      { event: "message:new", payload: { message: message({ chatId: "chat-zzz" }) } },
      ctx,
    );
    expect(qc.getQueryState(keys.chats)?.isInvalidated).toBe(true);
  });

  it("adds a chat it has never seen when the server says it changed", () => {
    // A group someone else made with me in it: it is in no list the page has loaded yet.
    const group = chat({ id: "chat-new", type: "group", name: "Hikers", memberIds: ["c1", "c2"] });
    const effects = applyServerEvent(qc, { event: "chat:updated", payload: { chat: group } }, ctx);
    const chats = qc.getQueryData<ChatDto[]>(keys.chats)!;
    expect(chats.map((c) => c.id)).toEqual(["chat-new", "chat-a"]);
    expect(effects).toEqual([]);
  });

  it("replaces a known chat with the new version, for example after a rename or new members", () => {
    const renamed = chat({ id: "chat-a", type: "group", name: "Renamed", memberIds: ["c1", "c2"] });
    applyServerEvent(qc, { event: "chat:updated", payload: { chat: renamed } }, ctx);
    const chats = qc.getQueryData<ChatDto[]>(keys.chats)!;
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ name: "Renamed", memberIds: ["c1", "c2"] });
  });

  it("does not leave the open chat unread when the server sends it with unread messages", () => {
    const effects = applyServerEvent(
      qc,
      { event: "chat:updated", payload: { chat: chat({ unread: 3 }) } },
      { ...ctx, activeChatId: "chat-a" },
    );
    expect(effects).toContainEqual({ type: "markRead", chatId: "chat-a" });
    expect(qc.getQueryData<ChatDto[]>(keys.chats)![0].unread).toBe(0);
  });

  it("applies message updates in the list and in the chat preview", () => {
    applyServerEvent(
      qc,
      {
        event: "message:updated",
        payload: {
          message: message({ id: "m-old", text: "edited", edited: true, createdAt: NOW - 500 }),
        },
      },
      ctx,
    );
    const [loaded] = qc.getQueryData<MessagesData>(keys.messages("chat-a"))!.pages[0].items;
    expect(loaded).toMatchObject({ text: "edited", edited: true });
    expect(qc.getQueryData<ChatDto[]>(keys.chats)![0].lastMessage?.text).toBe("edited");
  });

  it("removes a chat and its messages", () => {
    applyServerEvent(qc, { event: "chat:removed", payload: { chatId: "chat-a" } }, ctx);
    expect(qc.getQueryData<ChatDto[]>(keys.chats)).toEqual([]);
    expect(qc.getQueryData(keys.messages("chat-a"))).toBeUndefined();
  });

  it("turns typing events into effects", () => {
    expect(
      applyServerEvent(
        qc,
        {
          event: "typing",
          payload: { chatId: "chat-a", contactId: "c1", name: "Imogen", isTyping: true },
        },
        ctx,
      ),
    ).toEqual([{ type: "typing", chatId: "chat-a", name: "Imogen" }]);
    expect(
      applyServerEvent(
        qc,
        {
          event: "typing",
          payload: { chatId: "chat-a", contactId: "c1", name: "Imogen", isTyping: false },
        },
        ctx,
      ),
    ).toEqual([{ type: "typing", chatId: "chat-a", name: null }]);
  });

  it("updates presence", () => {
    qc.setQueryData<ContactDto[]>(keys.contacts, [
      {
        id: "c1",
        name: "A",
        phone: "1",
        about: "",
        hue: 1,
        online: false,
        blocked: false,
        avatarUrl: null,
        saved: true,
      },
    ]);
    applyServerEvent(qc, { event: "presence", payload: { contactId: "c1", online: true } }, ctx);
    expect(qc.getQueryData<ContactDto[]>(keys.contacts)![0].online).toBe(true);
  });
});
