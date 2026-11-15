import { crc32, deflateSync } from "node:zlib";

import { type APIRequestContext, type Browser, expect, type Page } from "@playwright/test";

export const PASSWORD = "e2e-password-123";

let counter = 0;

export interface Person {
  email: string;
  name: string;
  phone: string;
}

/** A person nobody has used before. The phone number is unique per call, so people can find each other. */
export function newPerson(label: string): Person {
  counter += 1;
  const stamp = `${Date.now().toString(36)}${counter}`;
  const digits = `${Date.now()}`.slice(-8) + String(counter).padStart(2, "0");
  return {
    name: `${label} ${stamp}`,
    email: `e2e-${label.toLowerCase()}-${stamp}@example.com`,
    phone: `+1 555 ${digits.slice(0, 3)} ${digits.slice(3, 10)}`,
  };
}

/** Signs a person up through the API, as a shortcut for tests that are not about sign-up. */
export async function signUp(request: APIRequestContext, person: Person): Promise<string> {
  const response = await request.post("/api/auth/register", {
    data: { email: person.email, password: PASSWORD, name: person.name, phone: person.phone },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

/** Signs in through the login form, the way a person does. */
export async function signInThroughForm(page: Page, person: Person) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(person.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
}

/** A separate browser profile with its own cookies: a second person on a second computer. */
export async function newSession(browser: Browser, person: Person): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInThroughForm(page, person);
  return page;
}

/** Puts `other` in `owner`'s address book (found by phone number). Returns the contact id. */
export async function addContact(
  request: APIRequestContext,
  token: string,
  other: Person,
): Promise<string> {
  const contact = await request.post("/api/contacts", {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: other.name, phone: other.phone },
  });
  expect(contact.ok(), await contact.text()).toBe(true);
  return ((await contact.json()) as { id: string }).id;
}

/** Makes `owner` have `other` as a contact, and a direct chat with them. Returns the chat id. */
export async function befriend(
  request: APIRequestContext,
  token: string,
  other: Person,
): Promise<string> {
  const contactId = await addContact(request, token, other);
  const chat = await request.post("/api/chats", {
    headers: { Authorization: `Bearer ${token}` },
    data: { type: "direct", contactId },
  });
  expect(chat.ok(), await chat.text()).toBe(true);
  return ((await chat.json()) as { id: string }).id;
}

/** Sends a text message through the API, as a shortcut for tests that are not about sending. */
export async function sendText(
  request: APIRequestContext,
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const response = await request.post(`/api/chats/${chatId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      clientId: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: "text",
      text,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** Starts a group chat owned by `token`'s person. Returns the chat id. */
export async function createGroup(
  request: APIRequestContext,
  token: string,
  name: string,
  contactIds: string[],
): Promise<string> {
  const chat = await request.post("/api/chats", {
    headers: { Authorization: `Bearer ${token}` },
    data: { type: "group", name, memberIds: contactIds },
  });
  expect(chat.ok(), await chat.text()).toBe(true);
  return ((await chat.json()) as { id: string }).id;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable PNG (a colour gradient), so photo uploads go through the browser's image code. */
export function makePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const row = (y: number) =>
    Buffer.concat([
      Buffer.from([0]),
      Buffer.from(
        Array.from({ length: width }, (_, x) => [x % 256, y % 256, (x + y) % 256]).flat(),
      ),
    ]);
  const pixels = Buffer.concat(Array.from({ length: height }, (_, y) => row(y)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
