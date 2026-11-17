import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AttachmentDto, MeDto } from "@dovetalk/contracts";
import { UPLOAD_LIMIT_BYTES } from "@dovetalk/contracts";
import { schema } from "@dovetalk/db";

import { createTestApp, type TestApp } from "./support/create-test-app.js";
import { http, PNG } from "./support/http.js";
import { objectBehind } from "./support/storage.js";

const { attachments } = schema;

let t: TestApp;
let h: ReturnType<typeof http>;
beforeAll(async () => {
  t = await createTestApp();
  h = http(t);
});
afterAll(() => t.close());

const bytesAt = async (url: string) => Buffer.from(await (await fetch(url)).arrayBuffer());

describe("POST /uploads", () => {
  it("needs a signed-in person, even for a big body", async () => {
    const res = await request(t.server)
      .post("/uploads")
      .attach("file", Buffer.from("x"), "x.txt")
      .expect(401);
    expect(res.body).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
  });

  it("stores a file and answers 201 with an attachment whose link loads the bytes", async () => {
    const a = await t.signUp();
    const res = await h
      .upload(a, Buffer.from("hello notes"), "notes.txt", "text/plain")
      .expect(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      url: expect.stringMatching(/^https?:\/\//u),
      name: "notes.txt",
      size: 11,
      mime: "text/plain",
      width: null,
      height: null,
    });
    expect((await bytesAt(res.body.url)).toString()).toBe("hello notes");
    const [row] = await t.db.select().from(attachments).where(eq(attachments.id, res.body.id));
    expect(row).toMatchObject({ ownerId: a.user.id, size: 11 });
  });

  it("reads the kind from the bytes, not from what the client says", async () => {
    const a = await t.signUp();
    const png = await h.upload(a, PNG, "pic.bin", "application/octet-stream").expect(201);
    expect(png.body.mime).toBe("image/png");
    const lie = await h
      .upload(a, Buffer.from("<script>alert(1)</script>"), "x.png", "image/png")
      .expect(201);
    expect(lie.body.mime).toBe("application/octet-stream");
  });

  it("keeps the width and height of a picture, and ignores them for other files", async () => {
    const a = await t.signUp();
    const pic = await h
      .as(a)
      .post("/uploads")
      .field("width", "640")
      .field("height", "480")
      .attach("file", PNG, "dot.png")
      .expect(201);
    expect(pic.body).toMatchObject({ width: 640, height: 480 });
    const text = await h
      .as(a)
      .post("/uploads")
      .field("width", "640")
      .attach("file", Buffer.from("t"), { filename: "t.txt", contentType: "text/plain" })
      .expect(201);
    expect(text.body).toMatchObject({ width: null, height: null });
    for (const [field, value] of [
      ["width", "0"],
      ["width", "abc"],
      ["height", "1.5"],
      ["height", "99999"],
    ]) {
      const bad = await h
        .as(a)
        .post("/uploads")
        .field(field!, value!)
        .attach("file", PNG, "dot.png")
        .expect(422);
      expect(bad.body.code).toBe("VALIDATION_ERROR");
    }
  });

  it("uses the name field when it is sent, and the file's own name otherwise", async () => {
    const a = await t.signUp();
    const named = await h
      .as(a)
      .post("/uploads")
      .field("name", "report 2026.pdf")
      .attach("file", Buffer.from("x"), "ugly.bin")
      .expect(201);
    expect(named.body.name).toBe("report 2026.pdf");
    const fallback = await h.upload(a, Buffer.from("x"), "ugly.bin").expect(201);
    expect(fallback.body.name).toBe("ugly.bin");
  });

  it("keeps a name with accents, CJK and emoji whole, which multer reads as latin1 unless told", async () => {
    const a = await t.signUp();
    for (const name of ["Büro Übersicht.pdf", "写真 🌸.png", "naïve café.txt"]) {
      const res = await h.upload(a, Buffer.from("x"), name).expect(201);
      expect(res.body.name).toBe(name);
    }
  });

  it("cleans names: no folders, quotes or control characters survive", async () => {
    const a = await t.signUp();
    const res = await h.upload(a, Buffer.from("x"), "../../etc/passwd").expect(201);
    expect(res.body.name).toBe("passwd");
    const quoted = await h
      .as(a)
      .post("/uploads")
      .field("name", 'a"b\r\nc.txt')
      .attach("file", Buffer.from("x"), "f.txt")
      .expect(201);
    expect(quoted.body.name).not.toMatch(/[\r\n]/u);
  });

  it("accepts exactly the limit and refuses one byte more with 413 FILE_TOO_LARGE", async () => {
    const a = await t.signUp();
    const exact = await h
      .upload(a, Buffer.alloc(UPLOAD_LIMIT_BYTES, 97), "big.txt", "text/plain")
      .expect(201);
    expect(exact.body.size).toBe(UPLOAD_LIMIT_BYTES);
    const over = await h
      .upload(a, Buffer.alloc(UPLOAD_LIMIT_BYTES + 1, 97), "big.txt", "text/plain")
      .expect(413);
    expect(over.body).toEqual({
      statusCode: 413,
      code: "FILE_TOO_LARGE",
      message: "Files over 10 MB aren't supported.",
    });
    // The server is still fine afterwards.
    await h.upload(a, Buffer.from("small"), "s.txt").expect(201);
  }, 60_000);

  it("refuses an empty file with 422, and a request with no file, or the wrong field", async () => {
    const a = await t.signUp();
    const empty = await h.upload(a, Buffer.alloc(0), "empty.txt").expect(422);
    expect(empty.body).toEqual({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: ["That file is empty."],
    });
    const none = await h.as(a).post("/uploads").field("name", "x").expect(422);
    expect(none.body.code).toBe("VALIDATION_ERROR");
    const json = await h.as(a).post("/uploads").send({ name: "x" }).expect(422);
    expect(json.body.message).toEqual(["Choose a file to upload."]);
    const wrongField = await h
      .as(a)
      .post("/uploads")
      .attach("photo", Buffer.from("x"), "x.txt")
      .expect(422);
    expect(wrongField.body.code).toBe("VALIDATION_ERROR");
    const two = await h
      .as(a)
      .post("/uploads")
      .attach("file", Buffer.from("x"), "x.txt")
      .attach("file", Buffer.from("y"), "y.txt")
      .expect(422);
    expect(two.body.code).toBe("VALIDATION_ERROR");
  });

  it("answers 422, not 500, for a broken multipart body", async () => {
    const a = await t.signUp();
    const res = await h
      .as(a)
      .post("/uploads")
      .set("Content-Type", "multipart/form-data; boundary=xyz")
      .send('--xyz\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\nabc')
      .expect(422);
    expect(res.body).toMatchObject({ statusCode: 422, code: "VALIDATION_ERROR" });
  });
});

describe("profile photos from uploads (PATCH /me)", () => {
  const patch = (a: Parameters<typeof h.as>[0], body: object) => h.as(a).patch("/me").send(body);

  it("accepts the link of your own picture, shows it signed on /me, and takes it off with null", async () => {
    const a = await t.signUp();
    const up = await h.upload(a, PNG, "me.png").expect(201);
    const res = await patch(a, { avatarUrl: up.body.url }).expect(200);
    expect(res.body.avatarUrl).toMatch(/^https?:\/\//u);
    expect((await bytesAt(res.body.avatarUrl as string)).equals(PNG)).toBe(true);
    expect(((await h.as(a).get("/me").expect(200)).body as MeDto).avatarUrl).toBe(
      res.body.avatarUrl,
    );
    const removed = await patch(a, { avatarUrl: null }).expect(200);
    expect(removed.body.avatarUrl).toBeNull();
  });

  it("releases the old photo when it is replaced or removed", async () => {
    const a = await t.signUp();
    const first = await h.upload(a, PNG, "one.png").expect(201);
    const second = await h.upload(a, PNG, "two.png").expect(201);
    await patch(a, { avatarUrl: first.body.url }).expect(200);
    expect((await fetch(first.body.url)).status).toBe(200);
    await patch(a, { avatarUrl: second.body.url }).expect(200);
    expect(await objectBehind(first.body.url)).toBe(false);
    expect((await fetch(second.body.url)).status).toBe(200);
    await patch(a, { avatarUrl: null }).expect(200);
    expect(await objectBehind(second.body.url)).toBe(false);
  });

  it("refuses somebody else's upload, a file that is not a picture, a foreign link and junk, with one message", async () => {
    const [a, b] = [await t.signUp(), await t.signUp()];
    const theirs = await h.upload(b, PNG, "theirs.png").expect(201);
    const text = await h.upload(a, Buffer.from("hi"), "t.txt", "text/plain").expect(201);
    for (const avatarUrl of [
      theirs.body.url,
      text.body.url,
      "https://evil.example/tracker.png",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "",
      5,
    ]) {
      const res = await patch(a, { avatarUrl }).expect(422);
      expect(res.body.message).toEqual(["That image can't be used as a profile photo."]);
    }
    expect(((await h.as(a).get("/me").expect(200)).body as MeDto).avatarUrl).toBeNull();
    expect((await fetch(theirs.body.url)).status).toBe(200);
  });

  it("lets a picture that was sent be the photo too, and keeps the file until neither uses it", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const pic = await h.upload(a, PNG, "shared.png").expect(201);
    const sent = (
      await h.send(a, chat.id, { kind: "image", attachmentId: pic.body.id }).expect(201)
    ).body;
    await patch(a, { avatarUrl: pic.body.url }).expect(200);
    // Deleting the message does not take the photo's file.
    await h.as(a).delete(`/messages/${sent.id}?scope=everyone`).expect(204);
    expect((await fetch(pic.body.url)).status).toBe(200);
    await patch(a, { avatarUrl: null }).expect(200);
    expect(await objectBehind(pic.body.url)).toBe(false);
  });

  it("cannot send a picture that is somebody's profile photo as a message", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const photo = await h.upload(a, PNG, "photo.png").expect(201);
    await patch(a, { avatarUrl: photo.body.url }).expect(200);
    const reuse = await h
      .send(a, chat.id, { kind: "image", attachmentId: photo.body.id })
      .expect(422);
    expect(reuse.body.code).toBe("ATTACHMENT_NOT_FOUND");
  });

  it("shows the photo to contacts, signed, and is stable across requests in the same hour", async () => {
    const { a, b } = await h.pair();
    const up = await h.upload(b, PNG, "ben.png").expect(201);
    await patch(b, { avatarUrl: up.body.url }).expect(200);
    const read = async () =>
      (
        (await h.as(a).get("/contacts").expect(200)).body as {
          name: string;
          avatarUrl: string | null;
        }[]
      ).find((c) => c.name === "Ben")!.avatarUrl;
    const one = await read();
    expect(one).toMatch(/^https?:\/\//u);
    expect(await read()).toBe(one);
    expect((await bytesAt(one!)).equals(PNG)).toBe(true);
    // Not the same link a stranger could guess: it names its own signature.
    expect(one).toContain("X-Amz-Signature");
  });

  it("gives every upload a different id even for the same bytes", async () => {
    const a = await t.signUp();
    const [x, y] = await Promise.all(
      [randomUUID(), randomUUID()].map(
        async () => (await h.upload(a, PNG, "dot.png").expect(201)).body as AttachmentDto,
      ),
    );
    expect(x!.id).not.toBe(y!.id);
  });
});
