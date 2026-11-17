import { describe, expect, it } from "vitest";

import { SYSTEM_SENDER } from "@dovetalk/contracts";
import type { SystemEvent } from "@dovetalk/db";

import { createDirectory, Projector } from "../src/conversations/projector.js";
import { chatRow, messageRow } from "./support/rows.js";

const projector = new Projector();

// The viewer is Alex. Imogen, Priya and Sam are people Alex has contacts for, each under an id
// that only Alex's address book knows. Zed is somebody Alex has no contact for.
const ALEX = "user-alex";
const IMOGEN = "user-imogen";
const PRIYA = "user-priya";
const SAM = "user-sam";
const ZED = "user-zed";

const directory = createDirectory(ALEX, [
  { userId: IMOGEN, contactId: "contact-imogen", name: "Imogen Varley", hue: 262 },
  { userId: PRIYA, contactId: "contact-priya", name: "Priya Anand", hue: 335 },
  { userId: SAM, contactId: "contact-sam", name: "Sam", hue: 10 },
]);

/** The same people from Priya's side: other contact ids, other names. */
const priyasDirectory = createDirectory(PRIYA, [
  { userId: ALEX, contactId: "priya-contact-alex", name: "Alexander", hue: 40 },
  { userId: IMOGEN, contactId: "priya-contact-imogen", name: "Immy", hue: 1 },
]);

describe("Projector ids", () => {
  it("keeps the viewer's own user id, maps others to the viewer's contact, and system stays system", () => {
    expect(projector.senderId(directory, ALEX)).toBe(ALEX);
    expect(projector.senderId(directory, IMOGEN)).toBe("contact-imogen");
    expect(projector.senderId(directory, null)).toBe(SYSTEM_SENDER);
  });

  it("shows the same person under a different id to each viewer", () => {
    const row = messageRow({ senderId: IMOGEN });
    expect(projector.toMessageDto(directory, row).senderId).toBe("contact-imogen");
    expect(projector.toMessageDto(priyasDirectory, row).senderId).toBe("priya-contact-imogen");
    // ... and the viewer's own messages carry the viewer's user id, not a contact id.
    const mine = messageRow({ senderId: PRIYA });
    expect(projector.toMessageDto(priyasDirectory, mine).senderId).toBe(PRIYA);
    expect(projector.toMessageDto(directory, mine).senderId).toBe("contact-priya");
  });

  it("reads a sender the viewer has no contact for as system, and never throws", () => {
    const dto = projector.toMessageDto(directory, messageRow({ senderId: ZED }));
    expect(dto.senderId).toBe(SYSTEM_SENDER);
  });

  it("only returns the client id to the person who sent the message", () => {
    const row = messageRow({ senderId: ALEX, clientId: "c-1" });
    expect(projector.toMessageDto(directory, row).clientId).toBe("c-1");
    expect(projector.toMessageDto(priyasDirectory, row).clientId).toBeNull();
  });
});

describe("Projector messages", () => {
  it("maps the fields of an ordinary message", () => {
    const row = messageRow({
      senderId: IMOGEN,
      kind: "voice",
      text: null,
      duration: 14,
      bars: [25, 50, 100],
      edited: true,
      forwarded: true,
      createdAt: new Date(1_700_000_000_123),
    });
    expect(projector.toMessageDto(directory, row)).toEqual({
      id: row.id,
      chatId: row.chatId,
      clientId: null,
      senderId: "contact-imogen",
      kind: "voice",
      text: null,
      duration: 14,
      bars: [25, 50, 100],
      attachment: null,
      createdAt: 1_700_000_000_123,
      replyTo: null,
      reactions: {},
      edited: true,
      deleted: false,
      forwarded: true,
    });
  });

  it("blanks the text of a deleted message", () => {
    const dto = projector.toMessageDto(directory, messageRow({ deleted: true, text: "secret" }));
    expect(dto).toMatchObject({ deleted: true, text: null });
  });

  it("builds a reply preview from the original, in the viewer's ids", () => {
    const original = messageRow({ senderId: IMOGEN, text: "question?" });
    const reply = messageRow({ senderId: ALEX, replyToId: original.id });
    expect(projector.toMessageDto(directory, reply, original).replyTo).toEqual({
      id: original.id,
      senderId: "contact-imogen",
      kind: "text",
      text: "question?",
      deleted: false,
    });
  });

  it("follows an edit and a delete of the original, because the preview is not a copy", () => {
    const original = messageRow({ senderId: IMOGEN, text: "v1" });
    const reply = messageRow({ senderId: ALEX, replyToId: original.id });
    const edited = { ...original, text: "v2", edited: true };
    expect(projector.toMessageDto(directory, reply, edited).replyTo?.text).toBe("v2");
    const deleted = { ...original, deleted: true, text: null };
    expect(projector.toMessageDto(directory, reply, deleted).replyTo).toMatchObject({
      text: null,
      deleted: true,
    });
  });

  it("shows a reply to a message the viewer cannot see as a deleted message", () => {
    const reply = messageRow({ senderId: ALEX, replyToId: "gone-id" });
    expect(projector.toMessageDto(directory, reply, null).replyTo).toEqual({
      id: "gone-id",
      senderId: SYSTEM_SENDER,
      kind: "text",
      text: null,
      deleted: true,
    });
  });

  it("does not read the reply argument for a message that is not a reply", () => {
    const stray = messageRow({ text: "unrelated" });
    expect(projector.toMessageDto(directory, messageRow(), stray).replyTo).toBeNull();
  });
});

describe("Projector files and reactions", () => {
  const file = {
    id: "file-1",
    url: "https://files.example/uploads/u/file-1?sig=1",
    name: "notes.txt",
    size: 5,
    mime: "text/plain",
    width: null,
    height: null,
  };

  it("carries the attachment it was given, and none when the message is deleted", () => {
    const row = messageRow({ senderId: ALEX, kind: "file", attachmentId: "file-1" });
    expect(projector.toMessageDto(directory, row, null, { attachment: file }).attachment).toBe(
      file,
    );
    expect(projector.toMessageDto(directory, row).attachment).toBeNull();
    const gone = messageRow({ senderId: ALEX, kind: "file", deleted: true });
    expect(
      projector.toMessageDto(directory, gone, null, { attachment: file }).attachment,
    ).toBeNull();
  });

  it("names reactors in the three id spaces: me as my user id, others as my contacts", () => {
    const row = messageRow({ senderId: IMOGEN });
    const dto = projector.toMessageDto(directory, row, null, {
      reactions: [
        { emoji: "👍", userId: IMOGEN },
        { emoji: "👍", userId: ALEX },
        { emoji: "❤️", userId: PRIYA },
      ],
    });
    expect(dto.reactions).toEqual({ "👍": ["contact-imogen", ALEX], "❤️": ["contact-priya"] });
    // Priya sees the same reactions with her own ids.
    expect(
      projector.toMessageDto(priyasDirectory, row, null, {
        reactions: [
          { emoji: "👍", userId: IMOGEN },
          { emoji: "❤️", userId: PRIYA },
        ],
      }).reactions,
    ).toEqual({ "👍": ["priya-contact-imogen"], "❤️": [PRIYA] });
  });

  it("leaves out a reactor the viewer has no contact for rather than showing 'system'", () => {
    const dto = projector.toMessageDto(directory, messageRow(), null, {
      reactions: [
        { emoji: "👍", userId: ZED },
        { emoji: "👍", userId: SAM },
      ],
    });
    expect(dto.reactions).toEqual({ "👍": ["contact-sam"] });
  });

  it("shows no reactions on a deleted message", () => {
    const row = messageRow({ deleted: true });
    expect(
      projector.toMessageDto(directory, row, null, { reactions: [{ emoji: "👍", userId: SAM }] })
        .reactions,
    ).toEqual({});
  });

  it("previews a captionless picture or file by its file name", () => {
    const original = messageRow({ senderId: IMOGEN, kind: "file", text: null });
    const reply = messageRow({ senderId: ALEX, replyToId: original.id });
    expect(
      projector.toMessageDto(directory, reply, original, { replyFileName: "notes.txt" }).replyTo,
    ).toMatchObject({ kind: "file", text: "notes.txt", deleted: false });
    const captioned = { ...original, text: "the notes" };
    expect(
      projector.toMessageDto(directory, reply, captioned, { replyFileName: "notes.txt" }).replyTo
        ?.text,
    ).toBe("the notes");
    const deleted = { ...original, deleted: true };
    expect(
      projector.toMessageDto(directory, reply, deleted, { replyFileName: "notes.txt" }).replyTo,
    ).toMatchObject({ text: null, deleted: true });
  });
});

describe("Projector system messages", () => {
  const text = (viewer: typeof directory, event: SystemEvent) =>
    projector.toMessageDto(viewer, messageRow({ kind: "system", text: null, event })).text;

  it("reads a group creation from the creator's side and from everyone else's", () => {
    const event: SystemEvent = { type: "group_created", actorId: ALEX };
    expect(text(directory, event)).toBe("You created this group");
    expect(text(priyasDirectory, event)).toBe("Alexander created this group");
    expect(text(priyasDirectory, { type: "group_created", actorId: IMOGEN })).toBe(
      "Immy created this group",
    );
  });

  it("uses first names from the viewer's own contact names", () => {
    expect(text(directory, { type: "group_created", actorId: IMOGEN })).toBe(
      "Imogen created this group",
    );
  });

  it("reads a rename", () => {
    expect(text(directory, { type: "group_renamed", actorId: ALEX, name: "Trip" })).toBe(
      "You renamed the group to “Trip”",
    );
    expect(text(directory, { type: "group_renamed", actorId: IMOGEN, name: "Trip" })).toBe(
      "Imogen renamed the group to “Trip”",
    );
  });

  it("lists the people who were added, with 'and' before the last one", () => {
    const added = (actorId: string, targetIds: string[]): SystemEvent => ({
      type: "members_added",
      actorId,
      targetIds,
    });
    expect(text(directory, added(ALEX, [PRIYA]))).toBe("You added Priya");
    expect(text(directory, added(ALEX, [PRIYA, SAM]))).toBe("You added Priya and Sam");
    expect(text(directory, added(ALEX, [PRIYA, SAM, IMOGEN]))).toBe(
      "You added Priya, Sam and Imogen",
    );
  });

  it("says 'you' for the viewer when somebody else added them", () => {
    const added = (targetIds: string[]): SystemEvent => ({
      type: "members_added",
      actorId: IMOGEN,
      targetIds,
    });
    expect(text(directory, added([ALEX]))).toBe("Imogen added you");
    expect(text(directory, added([PRIYA, ALEX]))).toBe("Imogen added you and Priya");
    expect(text(directory, added([PRIYA, SAM]))).toBe("Imogen added Priya and Sam");
  });

  it("reads removals the same way", () => {
    const removed = (actorId: string, targetIds: string[]): SystemEvent => ({
      type: "members_removed",
      actorId,
      targetIds,
    });
    expect(text(directory, removed(ALEX, [PRIYA]))).toBe("You removed Priya");
    expect(text(directory, removed(IMOGEN, [ALEX]))).toBe("Imogen removed you");
    expect(text(directory, removed(IMOGEN, [PRIYA]))).toBe("Imogen removed Priya");
  });

  it("falls back to 'Someone' and 'someone' for people the viewer has no name for", () => {
    expect(text(directory, { type: "group_created", actorId: ZED })).toBe(
      "Someone created this group",
    );
    expect(text(directory, { type: "members_added", actorId: ALEX, targetIds: [ZED, PRIYA] })).toBe(
      "You added someone and Priya",
    );
  });

  it("is the text of a reply preview to a system message, and of the chat's last message", () => {
    const note = messageRow({
      kind: "system",
      text: null,
      event: { type: "group_created", actorId: IMOGEN },
    });
    const reply = messageRow({ senderId: ALEX, replyToId: note.id });
    expect(projector.toMessageDto(directory, reply, note).replyTo?.text).toBe(
      "Imogen created this group",
    );
  });
});

describe("Projector contacts", () => {
  const contact = {
    id: "contact-1",
    name: "Priya Anand",
    phone: "(555) 010-0119",
    about: null,
    hue: null,
    avatarUrl: null,
    blocked: false,
    saved: true,
  };
  const profile = {
    about: "Product designer, tea drinker.",
    hue: 335,
    avatarUrl: "https://example.com/p.png",
    isBot: false,
    botOnlineDefault: false,
  };

  it("lets the linked person's live profile show through where the owner set nothing", () => {
    expect(projector.toContactDto(contact, profile)).toEqual({
      id: "contact-1",
      name: "Priya Anand",
      phone: "(555) 010-0119",
      about: "Product designer, tea drinker.",
      hue: 335,
      online: false,
      blocked: false,
      avatarUrl: "https://example.com/p.png",
      saved: true,
    });
  });

  it("prefers what the owner set, including an empty about", () => {
    const dto = projector.toContactDto({ ...contact, about: "", hue: 0, avatarUrl: "x" }, profile);
    expect(dto).toMatchObject({ about: "", hue: 0, avatarUrl: "x" });
  });

  it("uses the bot's seeded availability, and never reports a person as online yet", () => {
    const bot = { ...profile, isBot: true, botOnlineDefault: true };
    expect(projector.toContactDto(contact, bot).online).toBe(true);
    expect(projector.toContactDto(contact, { ...bot, botOnlineDefault: false }).online).toBe(false);
    expect(projector.toContactDto(contact, { ...profile, botOnlineDefault: true }).online).toBe(
      false,
    );
  });

  it("gives a contact without a number an empty string, because the contract has no null", () => {
    expect(projector.toContactDto({ ...contact, phone: null }, profile).phone).toBe("");
  });
});

describe("Projector chats", () => {
  const member = { unreadCount: 2, archived: true, pinned: true, muted: false };

  it("takes a direct chat's colour from the other person and has no name", () => {
    const chat = chatRow({ type: "direct", hue: null });
    const dto = projector.toChatDto(directory, {
      chat,
      member,
      otherUserIds: [IMOGEN],
      lastMessage: null,
    });
    expect(dto).toEqual({
      id: chat.id,
      type: "direct",
      name: null,
      hue: 262,
      memberIds: ["contact-imogen"],
      unread: 2,
      archived: true,
      pinned: true,
      muted: false,
      createdAt: chat.createdAt.getTime(),
      lastMessage: null,
    });
  });

  it("gives a group its own name and colour and lists the others as the viewer's contacts", () => {
    const chat = chatRow({ type: "group", name: "Trip", hue: 160, directKey: null });
    const dto = projector.toChatDto(directory, {
      chat,
      member,
      otherUserIds: [PRIYA, SAM, IMOGEN],
      lastMessage: null,
    });
    expect(dto).toMatchObject({
      type: "group",
      name: "Trip",
      hue: 160,
      memberIds: ["contact-priya", "contact-sam", "contact-imogen"],
    });
  });

  it("never includes the viewer in memberIds, and skips a member it has no contact for", () => {
    const chat = chatRow({ type: "group", name: "Trip", hue: 160, directKey: null });
    const dto = projector.toChatDto(directory, {
      chat,
      member,
      otherUserIds: [PRIYA, ZED],
      lastMessage: null,
    });
    expect(dto.memberIds).toEqual(["contact-priya"]);
  });

  it("carries the last message it was given", () => {
    const chat = chatRow();
    const last = projector.toMessageDto(directory, messageRow({ senderId: IMOGEN }));
    const dto = projector.toChatDto(directory, {
      chat,
      member,
      otherUserIds: [IMOGEN],
      lastMessage: last,
    });
    expect(dto.lastMessage).toBe(last);
  });
});
