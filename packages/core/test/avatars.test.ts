import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type UserRow } from "@dovetalk/db";

import { codeOf } from "./support/helpers.js";
import { createWorld, type World } from "./support/world.js";

const { users, contacts } = schema;

let w: World;
beforeAll(async () => {
  w = await createWorld({ storage: true });
});
afterAll(() => w.close());

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1,
]);

const upload = (owner: UserRow, bytes: Uint8Array = PNG, name = "me.png") =>
  w.uploads.create(owner.id, { bytes, name });

describe("StorageService.keyFromLink", () => {
  it("is the inverse of signedUrl", async () => {
    const link = await w.storage.signedUrl("uploads/u/an id.png", {
      mime: "image/png",
      name: "a.png",
    });
    expect(w.storage.keyFromLink(link)).toBe("uploads/u/an id.png");
  });

  it("refuses an address that is not ours", async () => {
    const link = new URL(
      await w.storage.signedUrl("uploads/u/x", { mime: "image/png", name: "a.png" }),
    );
    const other = new URL(link);
    other.host = "evil.example";
    const wrongBucket = new URL(link);
    wrongBucket.pathname = wrongBucket.pathname.replace(/^\/[^/]+\//u, "/other-bucket/");
    for (const bad of [
      other.href,
      wrongBucket.href,
      link.href.replace("http:", "https:"),
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "not a url",
      "",
      `${link.origin}/%E0%A4%A`,
    ]) {
      expect(w.storage.keyFromLink(bad), bad).toBeNull();
    }
  });
});

describe("AttachmentsService.avatarFromLink", () => {
  it("accepts a link to the person's own picture", async () => {
    const owner = await w.user();
    const file = await upload(owner);
    const row = await w.attachments.avatarFromLink(w.db, owner.id, file.url);
    expect(row.id).toBe(file.id);
  });

  it("gives one answer for somebody else's picture, a file that is not a picture, and any other address", async () => {
    const owner = await w.user();
    const other = await w.user();
    const theirs = await upload(other);
    const notPicture = await upload(owner, new TextEncoder().encode("hello"), "notes.txt");
    for (const link of [theirs.url, notPicture.url, "https://evil.example/x.png", "data:,x"]) {
      const error = await w.attachments.avatarFromLink(w.db, owner.id, link).catch((e) => e);
      expect(error.code, link).toBe("VALIDATION_ERROR");
      expect(error.messages).toEqual(["That image can't be used as a profile photo."]);
    }
  });
});

describe("contact photos", () => {
  it("shows the linked person's profile photo as a signed link", async () => {
    const owner = await w.user();
    const person = await w.user({ name: "Priya Anand" });
    const file = await upload(person);
    await w.db.update(users).set({ avatarAttachmentId: file.id }).where(eq(users.id, person.id));
    await w.befriend(owner, [person]);

    const [contact] = await w.contacts.list(owner.id);
    expect(contact?.avatarUrl).toBe(file.url);
  });

  it("is null when the person has no photo, and the owner's own picture wins when they set one", async () => {
    const owner = await w.user();
    const person = await w.user();
    const file = await upload(person);
    await w.db.update(users).set({ avatarAttachmentId: file.id }).where(eq(users.id, person.id));
    const [contactId] = await w.befriend(owner, [person]);

    await w.db
      .update(contacts)
      .set({ avatarUrl: "https://example.com/mine.png" })
      .where(eq(contacts.id, contactId!));
    const [mine] = await w.contacts.list(owner.id);
    expect(mine?.avatarUrl).toBe("https://example.com/mine.png");

    await w.db.update(users).set({ avatarAttachmentId: null }).where(eq(users.id, person.id));
    await w.db.update(contacts).set({ avatarUrl: null }).where(eq(contacts.id, contactId!));
    const [none] = await w.contacts.list(owner.id);
    expect(none?.avatarUrl).toBeNull();
  });

  it("releases the old file once nothing uses it, and keeps one something still uses", async () => {
    const owner = await w.user();
    const used = await upload(owner);
    const spare = await upload(owner);
    await w.db.update(users).set({ avatarAttachmentId: used.id }).where(eq(users.id, owner.id));
    await w.attachments.releaseUnused([used.id, spare.id]);
    const rows = await w.attachments.rows(w.db, [used.id, spare.id]);
    expect([...rows.keys()]).toEqual([used.id]);
  });
});

describe("codeOf helper sanity", () => {
  it("is exercised so a rename of the code is noticed", async () => {
    const owner = await w.user();
    expect(await codeOf(() => w.attachments.avatarFromLink(w.db, owner.id, "nope"))).toBe(
      "VALIDATION_ERROR",
    );
  });
});
