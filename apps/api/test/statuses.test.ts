import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { STATUS_TEXT_MAX, type StatusDto } from "@dovetalk/contracts";
import { newId, schema } from "@dovetalk/db";
import { byCodeUnit } from "@dovetalk/testkit";

import { createTestApp, type TestApp } from "./support/create-test-app.js";
import { http } from "./support/http.js";

const { statuses } = schema;

let t: TestApp;
let h: ReturnType<typeof http>;
beforeAll(async () => {
  t = await createTestApp();
  h = http(t);
});
afterAll(() => t.close());

const list = async (a: Parameters<typeof h.as>[0]) =>
  (await h.as(a).get("/statuses").expect(200)).body as StatusDto[];

describe("the status routes", () => {
  it.each([
    ["get", "/statuses"],
    ["post", "/statuses"],
    ["delete", "/statuses/x"],
    ["post", "/statuses/x/seen"],
  ])("%s %s needs a signed-in person", async (method, path) => {
    const res = await (request(t.server) as unknown as Record<string, (p: string) => request.Test>)[
      method
    ]!(path)
      .send({})
      .expect(401);
    expect(res.body).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
  });
});

describe("a new account's statuses", () => {
  it("has the six of the prototype, one of them already seen, under the contact ids of the account", async () => {
    const a = await t.signUp();
    const all = await list(a);
    expect(all).toHaveLength(6);
    expect(all.filter((s) => s.seen).map((s) => s.text)).toEqual(["Back from the coast."]);
    const contacts = (await h.as(a).get("/contacts").expect(200)).body as {
      id: string;
      name: string;
    }[];
    const owner = (name: string) => contacts.find((c) => c.name === name)!.id;
    const byText = new Map(all.map((s) => [s.text, s]));
    expect(byText.get("Booked the window table.")).toMatchObject({
      ownerId: owner("Imogen Varley"),
      color: 1,
    });
    expect(byText.get("Pasta night, finally.")).toMatchObject({
      ownerId: owner("Imogen Varley"),
      color: 3,
    });
    expect(byText.get("Got the call back. Thank you all.")).toMatchObject({
      ownerId: owner("Priya Anand"),
      color: 0,
    });
    expect(byText.get("Studio is open until six today.")).toMatchObject({
      ownerId: owner("Felix Moreau"),
      color: 2,
    });
    expect(byText.get("New cutting, day one.")).toMatchObject({
      ownerId: owner("Linnea Hoff"),
      color: 4,
    });
    expect(byText.get("Back from the coast.")).toMatchObject({
      ownerId: owner("Hugo Lindqvist"),
      color: 5,
    });
    for (const s of all) {
      expect(Object.keys(s).sort(byCodeUnit)).toEqual([
        "color",
        "createdAt",
        "id",
        "ownerId",
        "seen",
        "text",
      ]);
      expect(s.createdAt).toBeLessThan(Date.now());
    }
  });

  it("is different for every account: ids and contact ids are not shared", async () => {
    const [a, b] = [await t.signUp(), await t.signUp()];
    const [la, lb] = [await list(a), await list(b)];
    const ids = new Set(la.map((s) => s.id));
    expect(lb.some((s) => ids.has(s.id))).toBe(false);
    const owners = new Set(la.map((s) => s.ownerId));
    expect(lb.some((s) => owners.has(s.ownerId))).toBe(false);
    // One account marking one as seen does not touch the other's.
    await h.as(a).post(`/statuses/${la[1]!.id}/seen`).expect(204);
    expect((await list(b)).filter((s) => s.seen)).toHaveLength(1);
  });
});

describe("POST /statuses", () => {
  it("creates a status, which is listed as the person's own and already seen", async () => {
    const a = await t.signUp();
    const res = await h.as(a).post("/statuses").send({ text: "  hello  ", color: 4 }).expect(201);
    expect(res.body).toMatchObject({ ownerId: a.user.id, text: "hello", color: 4, seen: true });
    expect(typeof res.body.createdAt).toBe("number");
    const found = (await list(a)).find((s) => s.id === res.body.id);
    expect(found).toEqual(res.body);
    const [row] = await t.db.select().from(statuses).where(eq(statuses.id, res.body.id));
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(24 * 3_600_000);
  });

  it("cuts a long text at 120 characters and refuses an empty one", async () => {
    const a = await t.signUp();
    const long = await h
      .as(a)
      .post("/statuses")
      .send({ text: "😀".repeat(300), color: 0 })
      .expect(201);
    expect(Array.from(long.body.text as string)).toHaveLength(STATUS_TEXT_MAX);
    for (const text of ["", "   "]) {
      const res = await h.as(a).post("/statuses").send({ text, color: 0 }).expect(422);
      expect(res.body).toMatchObject({
        code: "VALIDATION_ERROR",
        message: ["Status can't be empty."],
      });
    }
  });

  it("accepts only the colours 0 to 5", async () => {
    const a = await t.signUp();
    for (const color of [0, 5]) {
      await h.as(a).post("/statuses").send({ text: "x", color }).expect(201);
    }
    for (const color of [-1, 6, 1.5, "1", null, undefined]) {
      const res = await h.as(a).post("/statuses").send({ text: "x", color }).expect(422);
      expect(res.body.message).toEqual(["Color must be a whole number from 0 to 5."]);
    }
    for (const body of [{}, { color: 1 }, { text: 5, color: 1 }, { text: "a\u0000", color: 1 }]) {
      await h.as(a).post("/statuses").send(body).expect(422);
    }
  });

  it("cannot be created for somebody else, or with an id of its own", async () => {
    const [a, b] = [await t.signUp(), await t.signUp()];
    const res = await h
      .as(a)
      .post("/statuses")
      .send({
        text: "mine",
        color: 1,
        ownerId: b.user.id,
        id: newId(),
        audienceId: b.user.id,
        seen: false,
      })
      .expect(201);
    expect(res.body.ownerId).toBe(a.user.id);
    expect((await list(b)).some((s) => s.id === res.body.id)).toBe(false);
  });
});

describe("who sees a status", () => {
  it("shows it to somebody who has the author as a contact, under their own contact id", async () => {
    const { a, b, bContact } = await h.pair();
    // Ben has Ann as an unsaved contact, made when Ann opened the chat.
    const annForBen = (
      (await h.as(b).get("/contacts").expect(200)).body as { id: string; name: string }[]
    ).find((c) => c.name === "Ann Pair")!;
    const made = await h.as(a).post("/statuses").send({ text: "for Ben", color: 2 }).expect(201);
    expect((await list(b)).find((s) => s.id === made.body.id)).toMatchObject({
      ownerId: annForBen.id,
      seen: false,
      text: "for Ben",
    });
    // Ann has Ben as a contact too, but he has posted nothing.
    expect((await list(a)).some((s) => s.ownerId === bContact.id)).toBe(false);
  });

  it("does not show it to somebody with no contact row for the author", async () => {
    const [a, c] = [await t.signUp(), await t.signUp()];
    const made = await h
      .as(a)
      .post("/statuses")
      .send({ text: "private-ish", color: 2 })
      .expect(201);
    expect((await list(c)).some((s) => s.id === made.body.id)).toBe(false);
    await h.as(c).post(`/statuses/${made.body.id}/seen`).expect(404);
    await h.as(c).delete(`/statuses/${made.body.id}`).expect(404);
  });

  it("hides one that has expired", async () => {
    const a = await t.signUp();
    const made = await h
      .as(a)
      .post("/statuses")
      .send({ text: "short lived", color: 2 })
      .expect(201);
    await t.db
      .update(statuses)
      .set({
        createdAt: new Date(Date.now() - 25 * 3_600_000),
        expiresAt: new Date(Date.now() - 3_600_000),
      })
      .where(eq(statuses.id, made.body.id));
    expect((await list(a)).some((s) => s.id === made.body.id)).toBe(false);
    await h.as(a).delete(`/statuses/${made.body.id}`).expect(404);
  });
});

describe("DELETE /statuses/:id", () => {
  it("deletes your own status with 204, and then it is 404", async () => {
    const a = await t.signUp();
    const made = await h.as(a).post("/statuses").send({ text: "bye", color: 0 }).expect(201);
    await h.as(a).delete(`/statuses/${made.body.id}`).expect(204);
    expect((await list(a)).some((s) => s.id === made.body.id)).toBe(false);
    const again = await h.as(a).delete(`/statuses/${made.body.id}`).expect(404);
    expect(again.body).toMatchObject({ statusCode: 404, code: "STATUS_NOT_FOUND" });
  });

  it("is 403 for a status you can see but did not post, and 404 for malformed or unknown ids", async () => {
    const a = await t.signUp();
    const [seeded] = await list(a);
    const res = await h.as(a).delete(`/statuses/${seeded!.id}`).expect(403);
    expect(res.body).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    expect((await list(a)).some((s) => s.id === seeded!.id)).toBe(true);
    for (const id of ["zzz", newId(), "1", "%00"]) {
      const miss = await h.as(a).delete(`/statuses/${id}`).expect(404);
      expect(miss.body.code).toBe("STATUS_NOT_FOUND");
    }
  });
});

describe("POST /statuses/:id/seen", () => {
  it("marks a status as seen, repeatably, for the caller only", async () => {
    const a = await t.signUp();
    const target = (await list(a)).find((s) => !s.seen)!;
    const res = await h.as(a).post(`/statuses/${target.id}/seen`).expect(204);
    expect(res.text).toBe("");
    await h.as(a).post(`/statuses/${target.id}/seen`).expect(204);
    expect((await list(a)).find((s) => s.id === target.id)!.seen).toBe(true);
  });

  it("does nothing for your own status", async () => {
    const a = await t.signUp();
    const made = await h.as(a).post("/statuses").send({ text: "own", color: 0 }).expect(201);
    await h.as(a).post(`/statuses/${made.body.id}/seen`).expect(204);
    expect((await list(a)).find((s) => s.id === made.body.id)!.seen).toBe(true);
  });

  it("is 404 for unknown and malformed ids, and for another account's seeded status", async () => {
    const [a, b] = [await t.signUp(), await t.signUp()];
    const theirs = (await list(b))[0]!;
    for (const id of ["zzz", newId(), theirs.id]) {
      const res = await h.as(a).post(`/statuses/${id}/seen`).expect(404);
      expect(res.body).toMatchObject({ statusCode: 404, code: "STATUS_NOT_FOUND" });
    }
  });
});
