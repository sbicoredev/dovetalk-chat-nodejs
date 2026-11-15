import { DEMO_EMAIL, DEMO_PASSWORD, MESSAGE_PAGE_SIZE, PIN_LIMIT } from "@/lib/constants";

import type { Api, RealtimeClient } from "../api";
import { ApiError } from "../errors";
import {
  type AttachmentDto,
  type AuthResult,
  type ChatDto,
  type ConnectionState,
  type ContactDto,
  EMAIL_MAX,
  GUEST_EMAIL_DOMAIN,
  type MessageDto,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PROFILE_NAME_MAX,
  type ServerEventName,
  type ServerEvents,
  SYSTEM_SENDER,
} from "../types";
import { CANNED_REPLIES } from "./replies";
import { createSeed, ME_ID, type MockDb, type StoredChat, type StoredMessage } from "./seed";
import type { MockStorage } from "./storage";

const LAST_COMMA = /, (?<last>[^,]*)$/u;
const TRAILING_ZERO = /\.0$/u;

export interface MockOptions {
  /** Contacts answer your messages with a short typing delay. Defaults to true. */
  autoReply?: boolean;
  /** Reads the access token the app is currently using. */
  getToken: () => string | null;
  /** Longest simulated network delay in milliseconds. 0 turns it off. */
  latencyMs?: number;
  now?: () => number;
  random?: () => number;
  /** [when typing starts, when the reply arrives], in milliseconds. */
  replyDelaysMs?: [number, number];
  /** Where to keep data between visits. Leave out to keep it in memory only. */
  storage?: MockStorage | null;
  /** Largest upload accepted, in bytes. */
  uploadLimitBytes?: number;
}

export interface MockApi {
  api: Api;
  realtime: RealtimeClient;
  /** Replaces everything with the original demo data. */
  reset: () => void;
  /** The current data, for tests. */
  snapshot: () => MockDb;
}

const MAX_TEXT = 4000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const isGuestAddress = (address: string) => address.endsWith(`@${GUEST_EMAIL_DOMAIN}`);

/** Reads a blob as a data URL so the mock can show it without a file server. */
async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

export function createMockApi(options: MockOptions): MockApi {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const latency = options.latencyMs ?? 0;
  const autoReply = options.autoReply ?? true;
  const [typingDelay, replyDelay] = options.replyDelaysMs ?? [700, 2400];
  const uploadLimit = options.uploadLimitBytes ?? 1_500_000;
  const storage = options.storage ?? null;

  let db: MockDb = storage?.load() ?? createSeed(now());
  // Stands in for the httpOnly refresh cookie: set by sign-in, read by refresh, cleared by logout.
  let hasSession = storage?.loadSession() ?? false;
  const setSession = (signedIn: boolean) => {
    hasSession = signedIn;
    storage?.saveSession(signedIn);
  };

  // ---- events ----------------------------------------------------------------

  const handlers = new Map<string, Set<(payload: never) => void>>();
  const connectionHandlers = new Set<(state: ConnectionState) => void>();
  let connected = false;

  const emit = <K extends ServerEventName>(event: K, payload: ServerEvents[K]) => {
    if (!connected) {
      return;
    }
    handlers.get(event)?.forEach((h) => h(payload as never));
  };

  // ---- saving ----------------------------------------------------------------

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const touch = () => {
    if (!storage) {
      return;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => storage.save(db), 250);
  };
  if (storage && typeof window !== "undefined") {
    window.addEventListener("pagehide", () => storage.save(db));
  }

  // ---- helpers ---------------------------------------------------------------

  const delay = () =>
    latency > 0
      ? new Promise<void>((resolve) => setTimeout(resolve, latency * (0.4 + random() * 0.6)))
      : Promise.resolve();

  const requireAuth = () => {
    const token = options.getToken();
    if (!token?.startsWith("mock.")) {
      throw new ApiError(401, "UNAUTHORIZED", "Your session has ended. Sign in again.");
    }
  };

  /** Every call except login waits out the network delay, then checks the token. */
  const guard = async () => {
    await delay();
    requireAuth();
  };

  /** What every call that signs somebody in returns. */
  const sessionResult = (): AuthResult => ({
    accessToken: `mock.${db.me.id}.${now()}`,
    user: structuredClone(db.me),
  });

  /** The mock holds one account at a time. A new one takes the place of the old. */
  const replaceAccount = (next: MockDb) => {
    db = next;
    pendingReplies.clear();
    touch();
  };

  const nextId = (prefix: string) => {
    db.seq += 1;
    return `${prefix}${String(db.seq).padStart(6, "0")}`;
  };

  const chatOf = (id: string): StoredChat => {
    const chat = db.chats.find((c) => c.id === id);
    if (!chat) {
      throw new ApiError(404, "CHAT_NOT_FOUND", "This chat no longer exists.");
    }
    return chat;
  };
  const contactOf = (id: string): ContactDto => {
    const contact = db.contacts.find((c) => c.id === id);
    if (!contact) {
      throw new ApiError(404, "CONTACT_NOT_FOUND", "This contact no longer exists.");
    }
    return contact;
  };
  const findMessage = (id: string) => {
    for (const chat of db.chats) {
      const message = chat.messages.find((m) => m.id === id);
      if (message) {
        return { chat, message };
      }
    }
    throw new ApiError(404, "MESSAGE_NOT_FOUND", "This message no longer exists.");
  };

  const messageView = (chat: StoredChat, m: StoredMessage): MessageDto => {
    const { replyToId, ...rest } = m;
    let replyTo: MessageDto["replyTo"] = null;
    if (replyToId) {
      const original = chat.messages.find((x) => x.id === replyToId);
      replyTo = original
        ? {
            id: original.id,
            senderId: original.senderId,
            kind: original.kind,
            text: original.deleted ? null : (original.text ?? original.attachment?.name ?? null),
            deleted: original.deleted,
          }
        : { id: replyToId, senderId: SYSTEM_SENDER, kind: "text", text: null, deleted: true };
    }
    return structuredClone({ ...rest, replyTo });
  };

  const chatView = (chat: StoredChat): ChatDto => {
    const { messages, ...rest } = chat;
    const last = messages.at(-1);
    return structuredClone({ ...rest, lastMessage: last ? messageView(chat, last) : null });
  };

  const emitChat = (chat: StoredChat) => emit("chat:updated", { chat: chatView(chat) });

  /** Adds a message to a chat and tells connected clients. */
  const push = (chat: StoredChat, message: StoredMessage) => {
    chat.messages.push(message);
    touch();
    emit("message:new", { message: messageView(chat, message) });
    emitChat(chat);
  };

  const systemNote = (chat: StoredChat, text: string) =>
    push(chat, {
      id: nextId("m"),
      chatId: chat.id,
      clientId: null,
      senderId: SYSTEM_SENDER,
      kind: "system",
      text,
      duration: null,
      bars: null,
      attachment: null,
      createdAt: now(),
      replyToId: null,
      reactions: {},
      edited: false,
      deleted: false,
      forwarded: false,
    });

  const firstNames = (ids: string[]) =>
    ids
      .map((id) => (db.contacts.find((c) => c.id === id)?.name ?? "someone").split(" ")[0])
      .join(", ")
      .replace(LAST_COMMA, " and $<last>");

  const isBlockedDirect = (chat: StoredChat) =>
    chat.type === "direct" && !!db.contacts.find((c) => c.id === chat.memberIds[0])?.blocked;

  // ---- simulated replies -----------------------------------------------------

  const pendingReplies = new Set<string>();

  const scheduleReply = (chat: StoredChat) => {
    if (!autoReply || pendingReplies.has(chat.id)) {
      return;
    }
    const candidates = chat.memberIds.filter(
      (id) => !db.contacts.find((c) => c.id === id)?.blocked,
    );
    if (candidates.length === 0) {
      return;
    }
    pendingReplies.add(chat.id);
    const contactId = candidates[Math.floor(random() * candidates.length)];
    const [name] = (db.contacts.find((c) => c.id === contactId)?.name ?? "Someone").split(" ");
    const text = CANNED_REPLIES[Math.floor(random() * CANNED_REPLIES.length)];

    setTimeout(
      () => emit("typing", { chatId: chat.id, contactId, name, isTyping: true }),
      typingDelay,
    );
    setTimeout(() => {
      pendingReplies.delete(chat.id);
      emit("typing", { chatId: chat.id, contactId, name, isTyping: false });
      const live = db.chats.find((c) => c.id === chat.id);
      if (!live) {
        return;
      }
      live.unread += 1;
      push(live, {
        id: nextId("m"),
        chatId: live.id,
        clientId: null,
        senderId: contactId,
        kind: "text",
        text,
        duration: null,
        bars: null,
        attachment: null,
        createdAt: now(),
        replyToId: null,
        reactions: {},
        edited: false,
        deleted: false,
        forwarded: false,
      });
    }, replyDelay);
  };

  // ---- the API ---------------------------------------------------------------

  const requireText = (text: string | undefined, label = "Message") => {
    const value = (text ?? "").trim();
    if (!value) {
      throw new ApiError(422, "VALIDATION_ERROR", `${label} can't be empty.`);
    }
    if (value.length > MAX_TEXT) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        `${label} is too long. The limit is ${MAX_TEXT} characters.`,
      );
    }
    return value;
  };

  const validPhone = (phone: string) => phone.replace(/\D/gu, "").length >= 7;

  const api: Api = {
    auth: {
      async login({ email, password }) {
        await delay();
        const address = email.trim().toLowerCase();
        // The mock keeps one account. The demo account always works: signing in with it brings
        // the original demo data back, in place of an account made since.
        if (address === DEMO_EMAIL && password === DEMO_PASSWORD && db.me.email !== DEMO_EMAIL) {
          replaceAccount(createSeed(now()));
        }
        // A guest has no password, so an empty one never matches.
        if (address !== db.me.email || !db.password || password !== db.password) {
          throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
        }
        setSession(true);
        return sessionResult();
      },
      async register({ email, password, name, phone }) {
        await delay();
        const address = email.trim().toLowerCase();
        const person = name.trim();
        const number = phone?.trim() ?? "";
        const problems: string[] = [];
        if (!EMAIL_PATTERN.test(address) || address.length > EMAIL_MAX || isGuestAddress(address)) {
          problems.push("Enter a valid email address.");
        }
        if (password.length < PASSWORD_MIN) {
          problems.push(`Password must be at least ${PASSWORD_MIN} characters.`);
        } else if (password.length > PASSWORD_MAX) {
          problems.push(`Password can be at most ${PASSWORD_MAX} characters.`);
        }
        if (!person) {
          problems.push("Name can't be empty.");
        } else if (person.length > PROFILE_NAME_MAX) {
          problems.push(`Name can be at most ${PROFILE_NAME_MAX} characters.`);
        }
        if (number && !validPhone(number)) {
          problems.push("Enter a phone number with 7 to 15 digits.");
        }
        if (problems.length > 0) {
          throw new ApiError(422, "VALIDATION_ERROR", problems.join(" "));
        }
        if (address === db.me.email) {
          throw new ApiError(409, "EMAIL_TAKEN", "An account with that email already exists.");
        }
        const fresh = createSeed(now());
        fresh.me = { ...fresh.me, email: address, name: person, phone: number || null };
        fresh.password = password;
        replaceAccount(fresh);
        setSession(true);
        return sessionResult();
      },
      async guest() {
        await delay();
        const number = Math.floor(1000 + random() * 9000);
        const fresh = createSeed(now());
        fresh.me = {
          ...fresh.me,
          email: `guest-${number}@${GUEST_EMAIL_DOMAIN}`,
          name: `Guest ${number}`,
        };
        fresh.password = "";
        replaceAccount(fresh);
        setSession(true);
        return sessionResult();
      },
      async refresh() {
        await delay();
        if (!hasSession) {
          throw new ApiError(401, "UNAUTHORIZED", "Your session has ended. Sign in again.");
        }
        return sessionResult();
      },
      async logout() {
        await delay();
        setSession(false);
      },
    },

    me: {
      async get() {
        await guard();
        return structuredClone(db.me);
      },
      async update(input) {
        await guard();
        if (input.name !== undefined) {
          db.me.name = requireText(input.name, "Name");
        }
        if (input.about !== undefined) {
          db.me.about = input.about.trim();
        }
        if (input.avatarUrl !== undefined) {
          db.me.avatarUrl = input.avatarUrl;
        }
        if (input.phone !== undefined) {
          db.me.phone = input.phone?.trim() || null;
        }
        if (input.preferences) {
          db.me.preferences = { ...db.me.preferences, ...input.preferences };
        }
        touch();
        return structuredClone(db.me);
      },
    },

    contacts: {
      async list() {
        await guard();
        return structuredClone(db.contacts);
      },
      async create({ name, phone }) {
        await guard();
        if (!name.trim()) {
          throw new ApiError(422, "VALIDATION_ERROR", "Enter a name.");
        }
        if (!validPhone(phone)) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "Enter a phone number with at least 7 digits.",
          );
        }
        const contact: ContactDto = {
          id: nextId("u"),
          name: name.trim(),
          phone: phone.trim(),
          about: "Hey there, I am using Dovetalk.",
          hue: Math.floor(random() * 360),
          online: false,
          blocked: false,
          avatarUrl: null,
          saved: true,
        };
        db.contacts.push(contact);
        touch();
        return structuredClone(contact);
      },
      async update(id, input) {
        await guard();
        const contact = contactOf(id);
        if (input.name !== undefined) {
          if (!input.name.trim()) {
            throw new ApiError(422, "VALIDATION_ERROR", "Enter a name.");
          }
          contact.name = input.name.trim();
        }
        if (input.phone !== undefined) {
          if (!validPhone(input.phone)) {
            throw new ApiError(
              422,
              "VALIDATION_ERROR",
              "Enter a phone number with at least 7 digits.",
            );
          }
          contact.phone = input.phone.trim();
        }
        if (input.about !== undefined) {
          contact.about = input.about.trim();
        }
        touch();
        return structuredClone(contact);
      },
      async remove(id) {
        await guard();
        contactOf(id);
        db.contacts = db.contacts.filter((c) => c.id !== id);
        for (const chat of [...db.chats]) {
          if (chat.type === "direct" && chat.memberIds[0] === id) {
            db.chats = db.chats.filter((c) => c.id !== chat.id);
            emit("chat:removed", { chatId: chat.id });
          } else if (chat.memberIds.includes(id)) {
            chat.memberIds = chat.memberIds.filter((m) => m !== id);
            emitChat(chat);
          }
        }
        db.statuses = db.statuses.filter((s) => s.ownerId !== id);
        touch();
      },
      async setBlocked(id, blocked) {
        await guard();
        const contact = contactOf(id);
        contact.blocked = blocked;
        touch();
        return structuredClone(contact);
      },
    },

    chats: {
      async list() {
        await guard();
        return db.chats.map(chatView);
      },
      async create(input) {
        await guard();
        if (input.type === "direct") {
          const contact = contactOf(input.contactId);
          const existing = db.chats.find(
            (c) => c.type === "direct" && c.memberIds[0] === contact.id,
          );
          if (existing) {
            return chatView(existing);
          }
          const chat: StoredChat = {
            id: `chat-${contact.id}`,
            type: "direct",
            name: null,
            hue: contact.hue,
            memberIds: [contact.id],
            unread: 0,
            archived: false,
            pinned: false,
            muted: false,
            createdAt: now(),
            messages: [],
          };
          db.chats.unshift(chat);
          touch();
          return chatView(chat);
        }
        const name = requireText(input.name, "Group name");
        const memberIds = [...new Set(input.memberIds)].filter((id) =>
          db.contacts.some((c) => c.id === id),
        );
        if (memberIds.length < 2) {
          throw new ApiError(422, "VALIDATION_ERROR", "A group needs at least two other people.");
        }
        const chat: StoredChat = {
          id: nextId("group-"),
          type: "group",
          name,
          hue: Math.floor(random() * 360),
          memberIds,
          unread: 0,
          archived: false,
          pinned: false,
          muted: false,
          createdAt: now(),
          messages: [],
        };
        db.chats.unshift(chat);
        systemNote(chat, "You created this group");
        return chatView(chat);
      },
      async update(id, input) {
        await guard();
        const chat = chatOf(id);
        if (
          input.pinned === true &&
          !chat.pinned &&
          db.chats.filter((c) => c.pinned).length >= PIN_LIMIT
        ) {
          throw new ApiError(
            409,
            "PIN_LIMIT",
            `You can pin up to ${PIN_LIMIT} chats. Unpin one first.`,
          );
        }
        if (input.name !== undefined) {
          if (chat.type !== "group") {
            throw new ApiError(422, "VALIDATION_ERROR", "Only groups can be renamed.");
          }
          const name = requireText(input.name, "Group name");
          if (name !== chat.name) {
            chat.name = name;
            systemNote(chat, `You renamed the group to “${name}”`);
          }
        }
        if (input.archived !== undefined) {
          chat.archived = input.archived;
        }
        if (input.pinned !== undefined) {
          chat.pinned = input.pinned;
        }
        if (input.muted !== undefined) {
          chat.muted = input.muted;
        }
        touch();
        emitChat(chat);
        return chatView(chat);
      },
      async remove(id) {
        await guard();
        chatOf(id);
        db.chats = db.chats.filter((c) => c.id !== id);
        touch();
        emit("chat:removed", { chatId: id });
      },
      async markRead(id) {
        await guard();
        const chat = chatOf(id);
        if (chat.unread === 0) {
          return;
        }
        chat.unread = 0;
        touch();
        emitChat(chat);
      },
      async clear(id) {
        await guard();
        const chat = chatOf(id);
        chat.messages = [];
        chat.unread = 0;
        touch();
        emitChat(chat);
      },
      async addMembers(id, memberIds) {
        await guard();
        const chat = chatOf(id);
        if (chat.type !== "group") {
          throw new ApiError(422, "VALIDATION_ERROR", "Only groups have members.");
        }
        const fresh = [...new Set(memberIds)].filter(
          (m) => !chat.memberIds.includes(m) && db.contacts.some((c) => c.id === m),
        );
        if (fresh.length > 0) {
          chat.memberIds = [...chat.memberIds, ...fresh];
          systemNote(chat, `You added ${firstNames(fresh)}`);
        }
        return chatView(chat);
      },
      async removeMember(id, contactId) {
        await guard();
        const chat = chatOf(id);
        if (chat.type !== "group") {
          throw new ApiError(422, "VALIDATION_ERROR", "Only groups have members.");
        }
        if (!chat.memberIds.includes(contactId)) {
          throw new ApiError(404, "MEMBER_NOT_FOUND", "That person isn't in this group.");
        }
        if (chat.memberIds.length <= 2) {
          throw new ApiError(422, "VALIDATION_ERROR", "A group keeps at least two other members.");
        }
        chat.memberIds = chat.memberIds.filter((m) => m !== contactId);
        systemNote(chat, `You removed ${firstNames([contactId])}`);
        return chatView(chat);
      },
      async messages(id, query) {
        await guard();
        const chat = chatOf(id);
        const limit = Math.min(Math.max(query?.limit ?? MESSAGE_PAGE_SIZE, 1), 100);
        let end = chat.messages.length;
        if (query?.before) {
          const index = chat.messages.findIndex((m) => m.id === query.before);
          if (index === -1) {
            throw new ApiError(
              400,
              "INVALID_CURSOR",
              "That page can't be loaded. Refresh the chat.",
            );
          }
          end = index;
        }
        const start = Math.max(0, end - limit);
        const items = chat.messages.slice(start, end).map((m) => messageView(chat, m));
        return { items, nextCursor: start > 0 ? items[0].id : null };
      },
    },

    messages: {
      async send(chatId, input) {
        await guard();
        const chat = chatOf(chatId);
        const duplicate = chat.messages.find((m) => m.clientId === input.clientId);
        if (duplicate) {
          return messageView(chat, duplicate);
        }
        if (isBlockedDirect(chat)) {
          throw new ApiError(403, "CONTACT_BLOCKED", "Unblock this contact to send messages.");
        }

        let text: string | null = null;
        let attachment: AttachmentDto | null = null;
        let duration: number | null = null;
        if (input.kind === "text") {
          text = requireText(input.text);
        } else if (input.kind === "voice") {
          if (!input.duration || input.duration < 1) {
            throw new ApiError(422, "VALIDATION_ERROR", "A voice message needs a length.");
          }
          duration = Math.round(input.duration);
        } else {
          const file = input.attachmentId ? db.uploads[input.attachmentId] : undefined;
          if (!file) {
            throw new ApiError(
              422,
              "ATTACHMENT_NOT_FOUND",
              "That attachment wasn't found. Upload it again.",
            );
          }
          if (input.kind === "image" && !file.mime.startsWith("image/")) {
            throw new ApiError(422, "VALIDATION_ERROR", "That file isn't an image.");
          }
          attachment = file;
          delete db.uploads[file.id];
          text = input.text?.trim() ? input.text.trim().slice(0, MAX_TEXT) : null;
        }
        if (input.replyToId && !chat.messages.some((m) => m.id === input.replyToId)) {
          throw new ApiError(
            422,
            "VALIDATION_ERROR",
            "The message you replied to no longer exists.",
          );
        }

        const message: StoredMessage = {
          id: nextId("m"),
          chatId,
          clientId: input.clientId,
          senderId: ME_ID,
          kind: input.kind,
          text,
          duration,
          bars: input.kind === "voice" ? (input.bars ?? null) : null,
          attachment,
          createdAt: now(),
          replyToId: input.replyToId ?? null,
          reactions: {},
          edited: false,
          deleted: false,
          forwarded: false,
        };
        push(chat, message);
        scheduleReply(chat);
        return messageView(chat, message);
      },

      async edit(id, text) {
        await guard();
        const { chat, message } = findMessage(id);
        if (message.senderId !== ME_ID) {
          throw new ApiError(403, "FORBIDDEN", "You can only edit your own messages.");
        }
        if (message.deleted || message.kind === "voice" || message.kind === "system") {
          throw new ApiError(422, "VALIDATION_ERROR", "This message can't be edited.");
        }
        message.text =
          message.kind === "text" ? requireText(text) : text.trim().slice(0, MAX_TEXT) || null;
        message.edited = true;
        touch();
        emit("message:updated", { message: messageView(chat, message) });
        if (chat.messages.at(-1) === message) {
          emitChat(chat);
        }
        return messageView(chat, message);
      },

      async remove(id, scope) {
        await guard();
        const { chat, message } = findMessage(id);
        if (scope === "me") {
          chat.messages = chat.messages.filter((m) => m.id !== id);
          touch();
          emitChat(chat);
          return;
        }
        if (message.senderId !== ME_ID) {
          throw new ApiError(
            403,
            "FORBIDDEN",
            "You can only delete your own messages for everyone.",
          );
        }
        Object.assign(message, {
          deleted: true,
          text: null,
          attachment: null,
          duration: null,
          bars: null,
          reactions: {},
          forwarded: false,
          edited: false,
        });
        touch();
        emit("message:updated", { message: messageView(chat, message) });
        emitChat(chat);
      },

      async toggleReaction(id, emoji) {
        await guard();
        const { chat, message } = findMessage(id);
        if (message.deleted || message.kind === "system") {
          throw new ApiError(422, "VALIDATION_ERROR", "You can't react to this message.");
        }
        const previous = Object.entries(message.reactions).find(([, who]) =>
          who.includes(ME_ID),
        )?.[0];
        const next: Record<string, string[]> = {};
        for (const [e, who] of Object.entries(message.reactions)) {
          const rest = who.filter((w) => w !== ME_ID);
          if (rest.length > 0) {
            next[e] = rest;
          }
        }
        if (previous !== emoji) {
          next[emoji] = [...(next[emoji] ?? []), ME_ID];
        }
        message.reactions = next;
        touch();
        emit("message:updated", { message: messageView(chat, message) });
        return messageView(chat, message);
      },

      async forward(id, chatIds) {
        await guard();
        const { message: source } = findMessage(id);
        if (source.deleted || source.kind === "system") {
          throw new ApiError(422, "VALIDATION_ERROR", "This message can't be forwarded.");
        }
        const created: MessageDto[] = [];
        for (const targetId of chatIds) {
          const target = chatOf(targetId);
          if (isBlockedDirect(target)) {
            continue;
          }
          const copy: StoredMessage = {
            ...structuredClone(source),
            id: nextId("m"),
            chatId: target.id,
            clientId: null,
            senderId: ME_ID,
            createdAt: now(),
            replyToId: null,
            reactions: {},
            edited: false,
            forwarded: true,
          };
          push(target, copy);
          created.push(messageView(target, copy));
        }
        return created;
      },
    },

    statuses: {
      async list() {
        await guard();
        return structuredClone(db.statuses);
      },
      async create({ text, color }) {
        await guard();
        const status = {
          id: nextId("s"),
          ownerId: ME_ID,
          text: requireText(text, "Status").slice(0, 120),
          color,
          createdAt: now(),
          seen: true,
        };
        db.statuses.push(status);
        touch();
        return structuredClone(status);
      },
      async remove(id) {
        await guard();
        const status = db.statuses.find((s) => s.id === id);
        if (!status) {
          throw new ApiError(404, "STATUS_NOT_FOUND", "This status no longer exists.");
        }
        if (status.ownerId !== ME_ID) {
          throw new ApiError(403, "FORBIDDEN", "You can only delete your own status.");
        }
        db.statuses = db.statuses.filter((s) => s.id !== id);
        touch();
      },
      async markSeen(id) {
        await guard();
        const status = db.statuses.find((s) => s.id === id);
        if (status) {
          status.seen = true;
        }
        touch();
      },
    },

    uploads: {
      async create(file, meta) {
        await guard();
        if (file.size === 0) {
          throw new ApiError(422, "VALIDATION_ERROR", "That file is empty.");
        }
        if (file.size > uploadLimit) {
          const mb = (uploadLimit / 1_000_000).toFixed(1).replace(TRAILING_ZERO, "");
          throw new ApiError(413, "FILE_TOO_LARGE", `Files over ${mb} MB aren't supported.`);
        }
        const attachment: AttachmentDto = {
          id: nextId("f"),
          url: await blobToDataUrl(file),
          name: meta.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          width: meta.width ?? null,
          height: meta.height ?? null,
        };
        db.uploads[attachment.id] = attachment;
        return structuredClone(attachment);
      },
    },
  };

  // ---- real-time client ------------------------------------------------------

  const setConnection = (state: ConnectionState) => connectionHandlers.forEach((h) => h(state));

  const realtime: RealtimeClient = {
    connect() {
      if (connected) {
        return;
      }
      setConnection("connecting");
      connected = true;
      queueMicrotask(() => setConnection("connected"));
    },
    disconnect() {
      connected = false;
      setConnection("disconnected");
    },
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler as (payload: never) => void);
      handlers.set(event, set);
      return () => {
        set.delete(handler as (payload: never) => void);
      };
    },
    onConnection(handler) {
      connectionHandlers.add(handler);
      return () => {
        connectionHandlers.delete(handler);
      };
    },
    emit() {
      // The mock has no other people to tell about typing.
    },
  };

  return {
    api,
    realtime,
    reset() {
      storage?.clear();
      db = createSeed(now());
      pendingReplies.clear();
      touch();
    },
    snapshot: () => db,
  };
}
