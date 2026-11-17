import { describe, expect, it } from "vitest";

import {
  botFor,
  botReplyClientId,
  botReplyJobId,
  botTypingJobId,
  CANNED_REPLIES,
  pick,
  replyTextFor,
} from "../src/index.js";

const ids = Array.from({ length: 200 }, (_, i) => `message-${i}`);

describe("pick", () => {
  it("gives the same answer for the same message every time", () => {
    for (const id of ids) {
      expect(pick(id, "text", 8)).toBe(pick(id, "text", 8));
    }
  });

  it("stays inside the range, including a range of one", () => {
    for (const id of ids) {
      const n = pick(id, "bot", 5);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(5);
      expect(pick(id, "bot", 1)).toBe(0);
    }
  });

  it("is not the same choice for the bot and for the line", () => {
    const same = ids.filter((id) => pick(id, "bot", 8) === pick(id, "text", 8)).length;
    expect(same).toBeLessThan(ids.length / 2);
  });

  it("refuses an empty range", () => {
    expect(() => pick("x", "bot", 0)).toThrow(RangeError);
  });
});

describe("replyTextFor", () => {
  it("is always one of the canned lines, and every line gets used", () => {
    const used = new Set(ids.map(replyTextFor));
    for (const line of used) {
      expect(CANNED_REPLIES).toContain(line);
    }
    expect(used.size).toBe(CANNED_REPLIES.length);
  });
});

describe("botFor", () => {
  const bots = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("picks the same bot for the same message, so a retry cannot change who answers", () => {
    for (const id of ids) {
      expect(botFor(bots, id)).toBe(botFor([...bots], id));
    }
  });

  it("spreads across the bots", () => {
    expect(new Set(ids.map((id) => botFor(bots, id).id)).size).toBe(3);
  });
});

describe("job ids", () => {
  it("avoid the colon BullMQ refuses, and differ per message and per job", () => {
    expect(botReplyJobId("m1")).not.toContain(":");
    expect(botTypingJobId("m1")).not.toContain(":");
    expect(botReplyJobId("m1")).not.toBe(botTypingJobId("m1"));
    expect(botReplyJobId("m1")).not.toBe(botReplyJobId("m2"));
  });

  it("make a client id that fits the contract's limit", () => {
    expect(botReplyClientId("0198d3a8-6b1e-7c3a-9f2e-4d5c6b7a8e90").length).toBeLessThanOrEqual(
      100,
    );
  });
});
