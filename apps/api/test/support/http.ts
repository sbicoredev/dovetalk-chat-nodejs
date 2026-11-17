import { randomUUID } from "node:crypto";

import request from "supertest";

import type { ChatDto, ContactDto, MessageDto, MessagePage } from "@dovetalk/contracts";

import type { TestAccount, TestApp } from "./create-test-app.js";

/** The first bytes of a real 1x1 PNG: enough for the type to be read from the bytes. */
export const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082",
  "hex",
);

/** Short helpers around supertest, so a test reads as "what this person sends". */
export function http(t: TestApp) {
  const as = (a: TestAccount) => ({
    get: (path: string) => request(t.server).get(path).set(a.bearer),
    post: (path: string) => request(t.server).post(path).set(a.bearer),
    patch: (path: string) => request(t.server).patch(path).set(a.bearer),
    put: (path: string) => request(t.server).put(path).set(a.bearer),
    delete: (path: string) => request(t.server).delete(path).set(a.bearer),
  });

  const contactNamed = async (a: TestAccount, name: string): Promise<ContactDto> => {
    const list = (await as(a).get("/contacts").expect(200)).body as ContactDto[];
    const found = list.find((c) => c.name === name);
    if (!found) {
      throw new Error(`No contact named ${name}.`);
    }
    return found;
  };

  /** The seeded direct chat with a contact, found the way the app finds it. */
  const directWith = async (a: TestAccount, name: string) => {
    const contact = await contactNamed(a, name);
    const chats = (await as(a).get("/chats").expect(200)).body as ChatDto[];
    const chat = chats.find((c) => c.type === "direct" && c.memberIds.includes(contact.id));
    if (!chat) {
      throw new Error(`No direct chat with ${name}.`);
    }
    return { chat, contact };
  };

  const send = (a: TestAccount, chatId: string, body: Record<string, unknown> = {}) =>
    as(a)
      .post(`/chats/${chatId}/messages`)
      .send({ clientId: randomUUID(), kind: "text", text: "hello", ...body });

  /** Sends a text message and returns it. */
  const say = async (a: TestAccount, chatId: string, text = "hello") =>
    (await send(a, chatId, { text }).expect(201)).body as MessageDto;

  const history = async (a: TestAccount, chatId: string, limit = 100) =>
    ((await as(a).get(`/chats/${chatId}/messages?limit=${limit}`).expect(200)).body as MessagePage)
      .items;

  const upload = (a: TestAccount, bytes: Buffer, filename: string, contentType?: string) =>
    as(a)
      .post("/uploads")
      .attach("file", bytes, { filename, ...(contentType ? { contentType } : {}) });

  /** Two real people with each other as contacts, and their direct chat (on both lists once a message is sent). */
  const pair = async () => {
    const phone = (n: number) =>
      `+1 555 ${String(n).padStart(3, "0")} ${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const a = await t.signUp({ name: "Ann Pair", phone: phone(100) });
    const b = await t.signUp({ name: "Ben Pair", phone: phone(200) });
    const bContact = (
      await as(a).post("/contacts").send({ name: "Ben", phone: b.user.phone }).expect(201)
    ).body as ContactDto;
    const chat = (
      await as(a).post("/chats").send({ type: "direct", contactId: bContact.id }).expect(201)
    ).body as ChatDto;
    return { a, b, bContact, chat };
  };

  return { as, contactNamed, directWith, send, say, history, upload, pair };
}
