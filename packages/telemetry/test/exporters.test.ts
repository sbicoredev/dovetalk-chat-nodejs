import { describe, expect, it, vi } from "vitest";

import {
  batchOptionsFromEnv,
  DEFAULT_EXPORT_COOLDOWN_MS,
  exportCooldownFromEnv,
  guardExporter,
} from "../src/exporters.js";

describe("batchOptionsFromEnv", () => {
  it("reads the standard span variables", () => {
    expect(
      batchOptionsFromEnv(
        {
          OTEL_BSP_SCHEDULE_DELAY: "2000",
          OTEL_BSP_EXPORT_TIMEOUT: "5000",
          OTEL_BSP_MAX_QUEUE_SIZE: "512",
          OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "128",
        },
        "OTEL_BSP",
      ),
    ).toEqual({
      scheduledDelayMillis: 2000,
      exportTimeoutMillis: 5000,
      maxQueueSize: 512,
      maxExportBatchSize: 128,
    });
  });

  it("keeps spans and logs apart", () => {
    const env = { OTEL_BSP_MAX_QUEUE_SIZE: "100", OTEL_BLRP_MAX_QUEUE_SIZE: "200" };
    expect(batchOptionsFromEnv(env, "OTEL_BSP")).toEqual({ maxQueueSize: 100 });
    expect(batchOptionsFromEnv(env, "OTEL_BLRP")).toEqual({ maxQueueSize: 200 });
  });

  it("leaves the SDK's default for anything that is not a positive whole number", () => {
    const junk = ["", " ", "abc", "0", "-5", "1.5", "NaN", "Infinity"];
    for (const value of junk) {
      expect(batchOptionsFromEnv({ OTEL_BSP_MAX_QUEUE_SIZE: value }, "OTEL_BSP"), value).toEqual(
        {},
      );
    }
    expect(batchOptionsFromEnv({}, "OTEL_BLRP")).toEqual({});
  });
});

describe("exportCooldownFromEnv", () => {
  it("defaults, accepts a number and 0 for off, and ignores junk", () => {
    expect(exportCooldownFromEnv({})).toBe(DEFAULT_EXPORT_COOLDOWN_MS);
    expect(exportCooldownFromEnv({ TELEMETRY_EXPORT_COOLDOWN_MS: "" })).toBe(
      DEFAULT_EXPORT_COOLDOWN_MS,
    );
    expect(exportCooldownFromEnv({ TELEMETRY_EXPORT_COOLDOWN_MS: "5000" })).toBe(5000);
    expect(exportCooldownFromEnv({ TELEMETRY_EXPORT_COOLDOWN_MS: "0" })).toBe(0);
    expect(exportCooldownFromEnv({ TELEMETRY_EXPORT_COOLDOWN_MS: "soon" })).toBe(
      DEFAULT_EXPORT_COOLDOWN_MS,
    );
    expect(exportCooldownFromEnv({ TELEMETRY_EXPORT_COOLDOWN_MS: "-1" })).toBe(
      DEFAULT_EXPORT_COOLDOWN_MS,
    );
  });
});

const SUCCESS = 0;
const FAILED = 1;

type Done = (result: { code: number; error?: Error }) => void;

/** An exporter whose outcome the test sets, and that counts the batches it was really handed. */
function fakeExporter(outcome: { code: number }) {
  const sent: unknown[] = [];
  return {
    sent,
    secret: "kept",
    export(items: unknown, done: Done) {
      sent.push(items);
      done({ ...outcome });
    },
    // Uses `this`, as the real exporters do with their private fields.
    describe() {
      return this.secret;
    },
  };
}

function exportOnce(exporter: { export: (items: unknown, done: Done) => void }, items: unknown) {
  const done = vi.fn<Done>();
  exporter.export(items, done);
  return done;
}

describe("guardExporter", () => {
  it("returns the exporter itself when the cooldown is 0", () => {
    const exporter = fakeExporter({ code: SUCCESS });
    expect(guardExporter(exporter, 0)).toBe(exporter);
  });

  it("passes batches through while they succeed", () => {
    const inner = fakeExporter({ code: SUCCESS });
    const guarded = guardExporter(inner, 30_000);
    for (const batch of ["a", "b", "c"]) {
      expect(exportOnce(guarded, batch)).toHaveBeenCalledWith({ code: SUCCESS });
    }
    expect(inner.sent).toEqual(["a", "b", "c"]);
  });

  it("after a failure fails the next batches at once, without sending them", () => {
    let clock = 1000;
    const inner = fakeExporter({ code: FAILED });
    const guarded = guardExporter(inner, 30_000, () => clock);

    expect(exportOnce(guarded, "first")).toHaveBeenCalledWith({ code: FAILED });
    expect(inner.sent).toEqual(["first"]);

    clock += 29_999;
    for (const batch of ["second", "third", "fourth"]) {
      const done = exportOnce(guarded, batch);
      expect(done).toHaveBeenCalledTimes(1);
      expect(done.mock.calls[0]?.[0]).toMatchObject({ code: FAILED });
      expect(done.mock.calls[0]?.[0].error).toBeInstanceOf(Error);
    }
    expect(inner.sent).toEqual(["first"]);
  });

  it("tries again when the cooldown is over, and a success ends the skipping", () => {
    let clock = 0;
    const outcome = { code: FAILED };
    const inner = fakeExporter(outcome);
    const guarded = guardExporter(inner, 1000, () => clock);

    exportOnce(guarded, "fails");
    clock = 1000;
    outcome.code = SUCCESS; // the Collector is back
    expect(exportOnce(guarded, "retry")).toHaveBeenCalledWith({ code: SUCCESS });
    expect(exportOnce(guarded, "next")).toHaveBeenCalledWith({ code: SUCCESS });
    expect(inner.sent).toEqual(["fails", "retry", "next"]);
  });

  it("starts the cooldown again when the retry fails too", () => {
    let clock = 0;
    const inner = fakeExporter({ code: FAILED });
    const guarded = guardExporter(inner, 1000, () => clock);

    exportOnce(guarded, "one");
    clock = 1000;
    exportOnce(guarded, "two");
    clock = 1500;
    exportOnce(guarded, "skipped");
    expect(inner.sent).toEqual(["one", "two"]);
  });

  it("passes everything else through, with the exporter as `this`", () => {
    const inner = fakeExporter({ code: SUCCESS });
    const guarded = guardExporter(inner, 1000);
    expect(guarded.secret).toBe("kept");
    expect(guarded.describe()).toBe("kept");
  });
});
