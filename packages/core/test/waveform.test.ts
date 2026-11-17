import { describe, expect, it } from "vitest";

import { makeBars, seededRandom } from "../src/onboarding/waveform.js";

// Expected values come from running apps/web/src/lib/waveform.ts once. If the port drifts, the
// seeded voice messages stop matching the prototype and these fail.
describe("makeBars", () => {
  it.each([
    [
      7919,
      [
        77, 81, 53, 86, 44, 77, 29, 55, 72, 85, 49, 31, 47, 61, 51, 65, 45, 60, 53, 26, 82, 73, 60,
        35, 85, 65, 81, 53,
      ],
    ],
    [
      15_838,
      [
        91, 95, 51, 77, 42, 34, 47, 31, 68, 67, 51, 52, 83, 40, 33, 56, 78, 50, 72, 53, 43, 52, 56,
        100, 64, 85, 32, 56,
      ],
    ],
    [
      39_595,
      [
        50, 92, 46, 41, 50, 39, 59, 35, 84, 76, 26, 30, 57, 27, 65, 51, 60, 32, 36, 31, 36, 62, 66,
        30, 39, 33, 95, 80,
      ],
    ],
    [
      0,
      [
        45, 25, 42, 36, 60, 66, 71, 74, 59, 69, 43, 32, 93, 56, 79, 74, 85, 72, 68, 34, 43, 86, 49,
        32, 84, 93, 66, 60,
      ],
    ],
  ])("gives the web prototype's bars for seed %i", (seed, bars) => {
    expect(makeBars(seed)).toEqual(bars);
  });

  it("honours the count", () => {
    expect(makeBars(7919, 5)).toEqual([77, 81, 53, 86, 44]);
    expect(makeBars(7919, 0)).toEqual([]);
  });

  it("is deterministic and keeps every bar between 25 and 100", () => {
    expect(makeBars(123)).toEqual(makeBars(123));
    expect(makeBars(123)).not.toEqual(makeBars(124));
    for (const seed of [1, 2, 3, 99, 7919 * 140]) {
      for (const bar of makeBars(seed)) {
        expect(bar).toBeGreaterThanOrEqual(25);
        expect(bar).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("seededRandom", () => {
  it("repeats the web prototype's sequence", () => {
    const next = seededRandom(11);
    expect([next(), next(), next()]).toEqual([
      0.511_587_048_647_925_3, 0.529_946_408_234_536_6, 0.608_118_564_123_287_8,
    ]);
  });
});
