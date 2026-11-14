import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@dovetalk/testkit";

import { createDatabase, runMigrations } from "../src/index.js";

let testDb: TestDatabase;

const journal = JSON.parse(
  readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: unknown[] };

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});

describe("migrations", () => {
  it("apply once even when several instances start together", async () => {
    const handles = [1, 2, 3].map(() => createDatabase({ url: testDb.url, poolMax: 3 }));
    try {
      await Promise.all(handles.map((h) => runMigrations(h.db, h.pool)));
      const { rows } = await handles[0]!.pool.query(
        "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
      );
      // Each migration is recorded once, however many instances raced to apply it.
      expect(rows[0].n).toBe(journal.entries.length);
    } finally {
      await Promise.all(handles.map((h) => h.close()));
    }
  });
});

describe("createDatabase", () => {
  it("closes cleanly, twice, and survives an idle connection error", async () => {
    const errors: Error[] = [];
    const handle = createDatabase({ url: testDb.url, onPoolError: (e) => errors.push(e) });
    await handle.pool.query("SELECT 1");
    handle.pool.emit("error", new Error("boom"));
    expect(errors).toHaveLength(1);
    await handle.close();
    await handle.close();
    expect(handle.pool.ended).toBe(true);
  });
});
