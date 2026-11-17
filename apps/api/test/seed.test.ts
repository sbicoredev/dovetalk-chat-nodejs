import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEMO_EMAIL, DEMO_PASSWORD } from "@dovetalk/contracts";
import { DRIZZLE, OnboardingService } from "@dovetalk/core";
import { type Database, schema } from "@dovetalk/db";

import { PasswordService } from "../src/auth/password.service.js";
import { DEMO_HUE, DEMO_NAME, seedDemoAccount } from "../src/seed/demo-account.js";
import { UsersService } from "../src/users/users.service.js";
import { createTestApp, type TestApp } from "./support/create-test-app.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const { users, contacts, chatMembers } = schema;

const seed = () =>
  seedDemoAccount({
    users: t.app.get(UsersService),
    passwords: t.app.get(PasswordService),
    onboarding: t.app.get(OnboardingService),
    db: t.app.get<Database>(DRIZZLE),
  });

const login = async () =>
  (
    await request(t.server)
      .post("/auth/login")
      .send({ email: DEMO_EMAIL, password: DEMO_PASSWORD })
      .expect(200)
  ).body as {
    accessToken: string;
    user: { id: string };
  };

describe("seeding the demo account", () => {
  it("creates an account the demo password signs in to", async () => {
    expect(await seed()).toBe("created");

    const res = await request(t.server)
      .post("/auth/login")
      .send({ email: DEMO_EMAIL, password: DEMO_PASSWORD })
      .expect(200);
    expect(res.body.user).toMatchObject({
      email: DEMO_EMAIL,
      name: DEMO_NAME,
      hue: DEMO_HUE,
      phone: null,
    });
  });

  it("can be run again without changing anything", async () => {
    await seed(); // Creates the account if the test above did not run.
    const session = await request(t.server)
      .post("/auth/login")
      .send({ email: DEMO_EMAIL, password: DEMO_PASSWORD })
      .expect(200);
    await request(t.server)
      .patch("/me")
      .set({ Authorization: `Bearer ${session.body.accessToken}` })
      .send({ name: "Renamed" })
      .expect(200);

    expect(await seed()).toBe("exists");

    const after = await request(t.server)
      .post("/auth/login")
      .send({ email: DEMO_EMAIL, password: DEMO_PASSWORD })
      .expect(200);
    expect(after.body.user.name).toBe("Renamed");
  });
});

describe("the demo account's starting data", () => {
  const countsFor = async (db: Database, userId: string) => ({
    contacts: (await db.select().from(contacts).where(eq(contacts.ownerId, userId))).length,
    chats: (await db.select().from(chatMembers).where(eq(chatMembers.userId, userId))).length,
  });

  it("has the seeded contacts and chats after a fresh seed", async () => {
    await seed();
    const { user, accessToken } = await login();
    expect(await countsFor(t.db, user.id)).toEqual({ contacts: 14, chats: 11 });
    // The demo account shows the six statuses too.
    const list = await request(t.server)
      .get("/statuses")
      .set({ Authorization: `Bearer ${accessToken}` })
      .expect(200);
    expect(list.body).toHaveLength(6);
  });

  it("gives an account made before contacts existed, one with no contacts, its data once", async () => {
    // Its own database, so the demo account the tests above use is not disturbed.
    const other = await createTestApp();
    try {
      const passwords = other.app.get(PasswordService);
      await other.db.insert(users).values({
        email: DEMO_EMAIL,
        passwordHash: await passwords.hash(DEMO_PASSWORD),
        name: DEMO_NAME,
        hue: DEMO_HUE,
      });
      const [row] = await other.db.select().from(users).where(eq(users.email, DEMO_EMAIL));
      expect(await countsFor(other.db, row!.id)).toEqual({ contacts: 0, chats: 0 });

      const run = () =>
        seedDemoAccount({
          users: other.app.get(UsersService),
          passwords,
          onboarding: other.app.get(OnboardingService),
          db: other.db,
        });
      expect(await run()).toBe("onboarded");
      expect(await countsFor(other.db, row!.id)).toEqual({ contacts: 14, chats: 11 });
      expect(await run()).toBe("exists");
      expect(await countsFor(other.db, row!.id)).toEqual({ contacts: 14, chats: 11 });

      // And the account still signs in.
      await request(other.server)
        .post("/auth/login")
        .send({ email: DEMO_EMAIL, password: DEMO_PASSWORD })
        .expect(200);
    } finally {
      await other.close();
    }
  });

  it("is only filled once when two seeds run at the same time on a bare account", async () => {
    const other = await createTestApp();
    try {
      const passwords = other.app.get(PasswordService);
      await other.db.insert(users).values({
        email: DEMO_EMAIL,
        passwordHash: await passwords.hash(DEMO_PASSWORD),
        name: DEMO_NAME,
        hue: DEMO_HUE,
      });
      const run = () =>
        seedDemoAccount({
          users: other.app.get(UsersService),
          passwords,
          onboarding: other.app.get(OnboardingService),
          db: other.db,
        });
      const results = await Promise.all([run(), run(), run()]);
      expect(results.filter((r) => r === "onboarded")).toHaveLength(1);
      const [row] = await other.db.select().from(users).where(eq(users.email, DEMO_EMAIL));
      expect(await countsFor(other.db, row!.id)).toEqual({ contacts: 14, chats: 11 });
    } finally {
      await other.close();
    }
  });
});
