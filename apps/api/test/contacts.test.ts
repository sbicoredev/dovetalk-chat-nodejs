import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ContactDto } from "@dovetalk/contracts";
import { schema } from "@dovetalk/db";

import { createTestApp, type TestAccount, type TestApp } from "./support/create-test-app.js";

const { contacts, users } = schema;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const get = (a: TestAccount, path: string) => request(t.server).get(path).set(a.bearer);
const post = (a: TestAccount, path: string) => request(t.server).post(path).set(a.bearer);
const patch = (a: TestAccount, path: string) => request(t.server).patch(path).set(a.bearer);
const put = (a: TestAccount, path: string) => request(t.server).put(path).set(a.bearer);
const del = (a: TestAccount, path: string) => request(t.server).delete(path).set(a.bearer);

const list = async (a: TestAccount) => (await get(a, "/contacts").expect(200)).body as ContactDto[];
const phoneOf = () => `+1 555 ${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;

describe("GET /contacts", () => {
  it("needs a signed-in person", async () => {
    await request(t.server).get("/contacts").expect(401);
  });

  it("lists the 14 seeded contacts, saved, in a stable order", async () => {
    const a = await t.signUp();
    const first = await list(a);
    expect(first).toHaveLength(14);
    expect(first.every((c) => c.saved)).toBe(true);
    expect(first[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      name: expect.any(String),
      phone: expect.any(String),
      about: expect.any(String),
      hue: expect.any(Number),
      online: expect.any(Boolean),
      blocked: false,
      avatarUrl: null,
      saved: true,
    });
    expect((await list(a)).map((c) => c.id)).toEqual(first.map((c) => c.id));
  });

  it("gives two people different ids for the same bot", async () => {
    const a = await t.signUp();
    const b = await t.signUp();
    const ids = new Set([...(await list(a)), ...(await list(b))].map((c) => c.id));
    expect(ids.size).toBe(28);
  });
});

describe("POST /contacts", () => {
  it("adds a contact and answers 201", async () => {
    const a = await t.signUp();
    const res = await post(a, "/contacts")
      .send({ name: "  Priya Nair ", phone: "+1 555 010 0142" })
      .expect(201);
    expect(res.body).toMatchObject({
      name: "Priya Nair",
      phone: "+1 555 010 0142",
      saved: true,
      blocked: false,
      online: false,
      avatarUrl: null,
    });
    expect(await list(a)).toHaveLength(15);
  });

  it("returns the contact you already have for a number, as 200, and adds nothing", async () => {
    const a = await t.signUp();
    const phone = phoneOf();
    const first = await post(a, "/contacts").send({ name: "One", phone }).expect(201);
    // The same digits typed differently are the same number.
    const again = await post(a, "/contacts")
      .send({ name: "Two", phone: phone.replace(/ /gu, "-") })
      .expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.name).toBe("One");
    expect(await list(a)).toHaveLength(15);
  });

  it("links a number that belongs to a registered person", async () => {
    const b = await t.signUp({ phone: "+44 7700 900123" });
    const a = await t.signUp();
    const res = await post(a, "/contacts")
      .send({ name: "Bea", phone: "+44 7700 900123" })
      .expect(201);
    expect(res.body).toMatchObject({ name: "Bea" });
    const [row] = await t.db.select().from(contacts).where(eq(contacts.id, res.body.id));
    expect(row!.linkedUserId).toBe(b.user.id);
    // No ghost was made for a number that belongs to somebody.
    const ghosts = await t.db.select().from(users).where(eq(users.ghostOwnerId, a.user.id));
    expect(ghosts).toHaveLength(0);
  });

  it("makes a private bot for a number nobody has registered", async () => {
    const a = await t.signUp();
    await post(a, "/contacts").send({ name: "Nobody", phone: phoneOf() }).expect(201);
    const ghosts = await t.db.select().from(users).where(eq(users.ghostOwnerId, a.user.id));
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toMatchObject({ isBot: true });
  });

  it("refuses your own number", async () => {
    const a = await t.signUp({ phone: "+1 555 010 7777" });
    const res = await post(a, "/contacts")
      .send({ name: "Me", phone: "+1 (555) 010-7777" })
      .expect(422);
    expect(res.body).toEqual({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: ["That is your own number."],
    });
  });

  it("validates the name and the number, one message per field", async () => {
    const a = await t.signUp();
    const res = await post(a, "/contacts").send({ name: "   ", phone: "12" }).expect(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.message).toHaveLength(2);
    expect(res.body.message[0]).toBe("Enter a name.");
    await post(a, "/contacts")
      .send({ name: "x".repeat(61), phone: phoneOf() })
      .expect(422);
    await post(a, "/contacts").send({ name: 5, phone: phoneOf() }).expect(422);
    await post(a, "/contacts").send({ phone: phoneOf() }).expect(422);
    await post(a, "/contacts").send({ name: "No phone" }).expect(422);
    await post(a, "/contacts").expect(422);
    expect(await list(a)).toHaveLength(14);
  });

  it("refuses a NUL in the name", async () => {
    const a = await t.signUp();
    await post(a, "/contacts").send({ name: "Bad\u0000", phone: phoneOf() }).expect(422);
  });

  it("does not add two rows when the same number is added at once", async () => {
    const a = await t.signUp();
    const phone = phoneOf();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post(a, "/contacts").send({ name: `N${i}`, phone })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await list(a)).toHaveLength(15);
  });
});

describe("PATCH /contacts/:id", () => {
  it("changes only what was sent", async () => {
    const a = await t.signUp();
    const [c] = await list(a);
    const res = await patch(a, `/contacts/${c!.id}`)
      .send({ name: " Renamed ", about: " Hi " })
      .expect(200);
    expect(res.body).toEqual({ ...c, name: "Renamed", about: "Hi" });
    const phone = phoneOf();
    const res2 = await patch(a, `/contacts/${c!.id}`).send({ phone }).expect(200);
    expect(res2.body).toMatchObject({ name: "Renamed", about: "Hi", phone });
  });

  it("is 409 PHONE_TAKEN for the number of another saved contact", async () => {
    const a = await t.signUp();
    const [one, two] = await list(a);
    const res = await patch(a, `/contacts/${one!.id}`).send({ phone: two!.phone }).expect(409);
    expect(res.body.code).toBe("PHONE_TAKEN");
    // Keeping your own number is fine.
    await patch(a, `/contacts/${one!.id}`).send({ phone: one!.phone }).expect(200);
  });

  it("refuses your own number and bad values", async () => {
    const a = await t.signUp({ phone: "+1 555 010 8888" });
    const [c] = await list(a);
    await patch(a, `/contacts/${c!.id}`).send({ phone: "+1 555 010 8888" }).expect(422);
    await patch(a, `/contacts/${c!.id}`).send({ name: "" }).expect(422);
    await patch(a, `/contacts/${c!.id}`).send({ name: null }).expect(422);
    await patch(a, `/contacts/${c!.id}`)
      .send({ about: "x".repeat(141) })
      .expect(422);
    await patch(a, `/contacts/${c!.id}`).send({ phone: "abc" }).expect(422);
    expect((await list(a))[0]).toEqual(c);
  });

  it("refuses a NUL in the name or note", async () => {
    const a = await t.signUp();
    const [c] = await list(a);
    await patch(a, `/contacts/${c!.id}`).send({ name: "x\u0000" }).expect(422);
    await patch(a, `/contacts/${c!.id}`).send({ about: "\u0000" }).expect(422);
  });

  it("is 404 for a contact that does not exist or was deleted", async () => {
    const a = await t.signUp();
    const [c] = await list(a);
    await del(a, `/contacts/${c!.id}`).expect(204);
    const res = await patch(a, `/contacts/${c!.id}`).send({ name: "Back" }).expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, code: "CONTACT_NOT_FOUND" });
  });
});

describe("DELETE /contacts/:id", () => {
  it("answers 204 with no body, un-saves the contact and keeps it listed", async () => {
    const a = await t.signUp();
    const [c] = await list(a);
    const res = await del(a, `/contacts/${c!.id}`).expect(204);
    expect(res.text).toBe("");
    const after = (await list(a)).find((x) => x.id === c!.id);
    expect(after?.saved).toBe(false);
    expect(await list(a)).toHaveLength(14);
  });

  it("is 404 the second time, and for an unsaved contact", async () => {
    const a = await t.signUp();
    const [c] = await list(a);
    await del(a, `/contacts/${c!.id}`).expect(204);
    const res = await del(a, `/contacts/${c!.id}`).expect(404);
    expect(res.body.code).toBe("CONTACT_NOT_FOUND");
  });

  it("keeps a block", async () => {
    const a = await t.signUp();
    const [c] = await list(a);
    await put(a, `/contacts/${c!.id}/block`).send({ blocked: true }).expect(200);
    await del(a, `/contacts/${c!.id}`).expect(204);
    expect((await list(a)).find((x) => x.id === c!.id)).toMatchObject({
      saved: false,
      blocked: true,
    });
  });
});

describe("PUT /contacts/:id/block", () => {
  it("blocks and unblocks, and repeating changes nothing", async () => {
    const a = await t.signUp();
    const [c] = await list(a);
    const on = await put(a, `/contacts/${c!.id}/block`).send({ blocked: true }).expect(200);
    expect(on.body).toEqual({ ...c, blocked: true });
    const again = await put(a, `/contacts/${c!.id}/block`).send({ blocked: true }).expect(200);
    expect(again.body).toEqual(on.body);
    const off = await put(a, `/contacts/${c!.id}/block`).send({ blocked: false }).expect(200);
    expect(off.body).toEqual(c);
  });

  it("needs a real boolean", async () => {
    const a = await t.signUp();
    const [c] = await list(a);
    for (const body of [{}, { blocked: "true" }, { blocked: 1 }, { blocked: null }]) {
      const res = await put(a, `/contacts/${c!.id}/block`).send(body).expect(422);
      expect(res.body).toEqual({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: ["Blocked must be true or false."],
      });
    }
    expect((await list(a))[0]!.blocked).toBe(false);
  });
});

describe("contacts belong to one person", () => {
  it("answers 404, never 403, when somebody else's contact is used", async () => {
    const a = await t.signUp();
    const b = await t.signUp();
    const [mine] = await list(a);

    for (const run of [
      () => patch(b, `/contacts/${mine!.id}`).send({ name: "Hijacked" }),
      () => del(b, `/contacts/${mine!.id}`),
      () => put(b, `/contacts/${mine!.id}/block`).send({ blocked: true }),
    ]) {
      const res = await run().expect(404);
      expect(res.body).toMatchObject({ statusCode: 404, code: "CONTACT_NOT_FOUND" });
    }
    // The answer is the same as for an id that never existed.
    const ghost = await del(b, "/contacts/0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c").expect(404);
    expect(ghost.body.message).toBe(
      (await del(b, `/contacts/${mine!.id}`).expect(404)).body.message,
    );
    expect((await list(a))[0]).toEqual(mine);
  });

  it("is 404, never a 500, for an id that is not an id", async () => {
    const a = await t.signUp();
    for (const id of ["zzz", "1", "not-a-uuid", "%00", "' OR 1=1 --", "0".repeat(300)]) {
      const encoded = encodeURIComponent(id);
      await patch(a, `/contacts/${encoded}`).send({ name: "x" }).expect(404);
      await del(a, `/contacts/${encoded}`).expect(404);
      await put(a, `/contacts/${encoded}/block`).send({ blocked: true }).expect(404);
    }
  });
});

describe("every contact route needs a signed-in person", () => {
  const id = "00000000-0000-4000-8000-000000000000";
  type Method = "get" | "post" | "patch" | "put" | "delete";
  const routes: [Method, string, object?][] = [
    ["post", "/contacts", { name: "Nobody", phone: "+1 555 010 0100" }],
    ["patch", `/contacts/${id}`, { name: "Nobody" }],
    ["delete", `/contacts/${id}`],
    ["put", `/contacts/${id}/block`, { blocked: true }],
  ];

  it.each(routes)("%s %s", async (method, path, body) => {
    const anonymous = await request(t.server)[method](path).send(body).expect(401);
    expect(anonymous.body).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    const call = request(t.server)[method](path);
    const forged = await call.set({ Authorization: "Bearer not-a-token" }).send(body).expect(401);
    expect(forged.body).toMatchObject({ code: "UNAUTHORIZED" });
  });
});
