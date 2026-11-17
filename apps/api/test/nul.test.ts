import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestApp, TEST_PASSWORD, type TestApp } from "./support/create-test-app.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const refused = {
  statusCode: 422,
  code: "VALIDATION_ERROR",
  message: ["Text can't contain null characters."],
};

describe("NUL characters in request bodies", () => {
  it("are a 422 on PATCH /me, in a value, in a nested value and in a key", async () => {
    const account = await t.signUp();
    for (const body of [
      { name: "Ali\u0000ce" },
      { about: "\u0000" },
      { preferences: { sounds: true, "x\u0000": 1 } },
      { "na\u0000me": "x" },
    ]) {
      const res = await request(t.server).patch("/me").set(account.bearer).send(body).expect(422);
      expect(res.body).toEqual(refused);
    }
    // And nothing changed.
    const me = await request(t.server).get("/me").set(account.bearer).expect(200);
    expect(me.body.name).toBe("Test Person");
  });

  it("are a 422 on register and login, not a 500", async () => {
    const reg = await request(t.server)
      .post("/auth/register")
      .send({ email: "nul@example.com", password: TEST_PASSWORD, name: "Nu\u0000l" })
      .expect(422);
    expect(reg.body).toEqual(refused);
    await request(t.server)
      .post("/auth/login")
      .send({ email: "nul@example.com", password: "pass\u0000word" })
      .expect(422);
  });

  it("do not stop the text 'u0000' or a literal backslash sequence", async () => {
    const account = await t.signUp();
    const res = await request(t.server)
      .patch("/me")
      .set(account.bearer)
      .send({ about: "u0000 and \\u0000" })
      .expect(200);
    expect(res.body.about).toBe("u0000 and \\u0000");
  });
});
