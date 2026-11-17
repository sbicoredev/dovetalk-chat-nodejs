import type { ChatRow, MessageRow } from "@dovetalk/db";

let counter = 0;
const uuid = () => {
  counter += 1;
  return `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`;
};

/** A message row with every column set, for tests that do not touch the database. */
export function messageRow(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: uuid(),
    chatId: "00000000-0000-7000-8000-00000000c0de",
    seq: 1,
    senderId: null,
    clientId: null,
    kind: "text",
    text: "hello",
    duration: null,
    bars: null,
    attachmentId: null,
    replyToId: null,
    forwarded: false,
    edited: false,
    deleted: false,
    event: null,
    createdAt: new Date("2026-11-13T10:00:00.000Z"),
    ...over,
  };
}

export function chatRow(over: Partial<ChatRow> = {}): ChatRow {
  return {
    id: uuid(),
    type: "direct",
    name: null,
    hue: null,
    directKey: "a:b",
    createdBy: null,
    lastSeq: 0,
    createdAt: new Date("2026-11-13T09:00:00.000Z"),
    ...over,
  };
}
