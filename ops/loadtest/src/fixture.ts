import { readFileSync } from "node:fs";

export interface FixtureUser {
  email: string;
  id: string;
  password: string;
}

/** Two people with a direct chat between them. `a` sends in the load test and `b` receives. */
export interface FixturePair {
  a: FixtureUser;
  b: FixtureUser;
  /** The chat's id, which is the same for both people. */
  chatId: string;
}

export interface Fixture {
  createdAt: string;
  pairs: FixturePair[];
}

export function readFixture(path: string): Fixture {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  if (!Array.isArray(fixture.pairs) || fixture.pairs.length === 0) {
    throw new Error(
      `${path} has no pairs. Make one with: pnpm --filter @dovetalk/loadtest provision`,
    );
  }
  return fixture;
}
