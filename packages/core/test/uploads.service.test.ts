import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UPLOAD_LIMIT_BYTES } from "@dovetalk/contracts";
import { schema, type UserRow } from "@dovetalk/db";
import { getTestStorage } from "@dovetalk/testkit";

import { codeOf } from "./support/helpers.js";
import { createWorld, type World } from "./support/world.js";

const { attachments, messages } = schema;

let world: World;
let owner: UserRow;
let s3: S3Client;
let bucket: string;

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1,
]);
const bytes = (value: string) => new TextEncoder().encode(value);

beforeAll(async () => {
  world = await createWorld({ storage: true });
  owner = await world.user();
  const { options } = await getTestStorage();
  ({ bucket } = options);
  s3 = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: true,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
});
afterAll(async () => {
  s3.destroy();
  await world.close();
});

const rowOf = async (id: string) =>
  (await world.db.select().from(attachments).where(eq(attachments.id, id)))[0];

describe("UploadsService.create", () => {
  it("stores the bytes, records the file and returns a link that serves it", async () => {
    const dto = await world.uploads.create(owner.id, {
      bytes: bytes("hello"),
      declaredMime: "text/plain",
      name: "notes.txt",
    });
    expect(dto).toMatchObject({
      name: "notes.txt",
      size: 5,
      mime: "text/plain",
      width: null,
      height: null,
    });

    const row = (await rowOf(dto.id))!;
    expect(row.ownerId).toBe(owner.id);
    expect(row.storageKey).toBe(`uploads/${owner.id}/${dto.id}`);
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: row.storageKey }));
    expect(head.ContentLength).toBe(5);
    // Stored as it is served: an opaque download. The real type is in the database.
    expect(head.ContentType).toBe("application/octet-stream");
    expect(head.ContentDisposition).toMatch(/^attachment; filename="notes.txt"/u);
    expect(row.mime).toBe("text/plain");

    // The link works without credentials, and is a download.
    const res = await fetch(dto.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="notes.txt"/u);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("shows a picture inline and keeps the size the client gave", async () => {
    const dto = await world.uploads.create(owner.id, {
      bytes: PNG,
      declaredMime: "image/png",
      name: "dot.png",
      width: 1,
      height: 1,
    });
    expect(dto).toMatchObject({ mime: "image/png", width: 1, height: 1 });
    const res = await fetch(dto.url);
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/u);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("serves the same link all hour, and a fresh one for the next", async () => {
    const dto = await world.uploads.create(owner.id, {
      bytes: bytes("a"),
      name: "a.txt",
      declaredMime: "text/plain",
    });
    const row = (await rowOf(dto.id))!;
    const hour = 3_600_000;
    const start = Math.floor(Date.now() / hour) * hour;
    const a = await world.storage.signedUrl(row.storageKey, row, start + 1000);
    const b = await world.storage.signedUrl(row.storageKey, row, start + hour - 1000);
    const c = await world.storage.signedUrl(row.storageKey, row, start + hour + 1000);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    // The link made at the end of the hour still has at least an hour to live.
    const lifetime = Number(new URL(b).searchParams.get("X-Amz-Expires"));
    expect(lifetime * 1000 - (hour - 1000)).toBeGreaterThanOrEqual(hour);
  });

  it("believes the bytes over a claimed type", async () => {
    const dto = await world.uploads.create(owner.id, {
      bytes: PNG,
      declaredMime: "application/pdf",
      name: "x",
    });
    expect(dto.mime).toBe("image/png");
    const script = await world.uploads.create(owner.id, {
      bytes: bytes("<script>alert(1)</script>"),
      declaredMime: "image/png",
      name: "evil.png",
      width: 5,
      height: 5,
    });
    expect(script.mime).toBe("application/octet-stream");
    // The size of something that is not a picture is dropped.
    expect(script.width).toBeNull();
    expect(script.height).toBeNull();
  });

  it("cleans the name and falls back when there is none", async () => {
    const dirty = await world.uploads.create(owner.id, {
      bytes: bytes("x"),
      name: "../a\r\nb.txt",
    });
    expect(dirty.name).toBe("a b.txt");
    const none = await world.uploads.create(owner.id, { bytes: bytes("x") });
    expect(none.name).toBe("file");
  });

  it("refuses an empty file, a file over the limit and a bad size, and stores nothing", async () => {
    const before = await world.db.select().from(attachments);
    expect(
      await codeOf(() => world.uploads.create(owner.id, { bytes: new Uint8Array(0), name: "e" })),
    ).toBe("VALIDATION_ERROR");
    expect(
      await codeOf(() =>
        world.uploads.create(owner.id, {
          bytes: new Uint8Array(UPLOAD_LIMIT_BYTES + 1),
          name: "big",
        }),
      ),
    ).toBe("FILE_TOO_LARGE");
    const badWidth = (width: number) =>
      codeOf(() => world.uploads.create(owner.id, { bytes: PNG, name: "p.png", width }));
    expect(await Promise.all([0, -3, 1.5, 20_001].map(badWidth))).toEqual(
      new Array(4).fill("VALIDATION_ERROR"),
    );
    expect(await world.db.select().from(attachments)).toHaveLength(before.length);
  });

  it("accepts a file of exactly the limit", async () => {
    const dto = await world.uploads.create(owner.id, {
      bytes: new Uint8Array(UPLOAD_LIMIT_BYTES),
      name: "max.bin",
    });
    expect(dto.size).toBe(UPLOAD_LIMIT_BYTES);
  });
});

describe("AttachmentsService.releaseUnused", () => {
  const exists = async (key: string) => {
    try {
      await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  };

  it("removes the row and the file when nothing uses it", async () => {
    const dto = await world.uploads.create(owner.id, {
      bytes: bytes("bye"),
      name: "bye.txt",
      declaredMime: "text/plain",
    });
    const key = (await rowOf(dto.id))!.storageKey;
    await world.attachments.releaseUnused([dto.id]);
    expect(await rowOf(dto.id)).toBeUndefined();
    expect(await exists(key)).toBe(false);
  });

  it("keeps a file a message or a profile still points at", async () => {
    const [chat] = await world.db
      .insert(schema.chats)
      .values({ type: "group", name: "G", hue: 1, createdBy: owner.id, lastSeq: 1 })
      .returning();
    const used = await world.uploads.create(owner.id, {
      bytes: bytes("m"),
      name: "m.txt",
      declaredMime: "text/plain",
    });
    await world.db.insert(messages).values({
      chatId: chat!.id,
      seq: 1,
      senderId: owner.id,
      kind: "file",
      attachmentId: used.id,
    });
    const photo = await world.uploads.create(owner.id, { bytes: PNG, name: "me.png" });
    await world.db
      .update(schema.users)
      .set({ avatarAttachmentId: photo.id })
      .where(eq(schema.users.id, owner.id));

    await world.attachments.releaseUnused([
      used.id,
      photo.id,
      "00000000-0000-7000-8000-000000000000",
    ]);

    for (const dto of [used, photo]) {
      const row = (await rowOf(dto.id))!;
      expect(row).toBeDefined();
      expect(await exists(row.storageKey)).toBe(true);
    }
    await world.db
      .update(schema.users)
      .set({ avatarAttachmentId: null })
      .where(eq(schema.users.id, owner.id));
  });

  it("does nothing for an empty list", async () => {
    await expect(world.attachments.releaseUnused([])).resolves.toBeUndefined();
  });
});

describe("AttachmentsService.load", () => {
  it("returns DTOs by id and leaves out unknown ids", async () => {
    const dto = await world.uploads.create(owner.id, {
      bytes: bytes("z"),
      name: "z.txt",
      declaredMime: "text/plain",
    });
    const loaded = await world.attachments.load(world.db, [
      dto.id,
      dto.id,
      "00000000-0000-7000-8000-000000000000",
    ]);
    expect([...loaded.keys()]).toEqual([dto.id]);
    expect(loaded.get(dto.id)).toEqual(dto);
  });
});
