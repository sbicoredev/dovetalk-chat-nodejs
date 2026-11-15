import { vi } from "vitest";

import { DEMO_EMAIL, DEMO_PASSWORD } from "@/lib/constants";
import { makeMock } from "@/test/helpers";

import type { ConformanceHarness } from "./harness";

/** Small, so the oversize test does not have to build a megabyte string. */
const UPLOAD_LIMIT_BYTES = 10;
const STEP_MS = 50;

/** The in-browser mock server: every area, on a fake clock where timers matter. */
export function createMockHarness(): ConformanceHarness {
  return {
    name: "mock",
    areas: "all",
    demo: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    uploadLimitBytes: UPLOAD_LIMIT_BYTES,

    anonymous: () => makeMock({ getToken: () => null }).api,

    async login({ botReplies = false } = {}) {
      const mock = makeMock({
        autoReply: botReplies,
        replyDelaysMs: [100, 300],
        uploadLimitBytes: UPLOAD_LIMIT_BYTES,
      });
      return { api: mock.api, realtime: mock.realtime };
    },

    async eventually(check, { timeoutMs = 5000, message = "Timed out waiting." } = {}) {
      for (let waited = 0; waited < timeoutMs; waited += STEP_MS) {
        if (check()) {
          return;
        }
        await vi.advanceTimersByTimeAsync(STEP_MS);
      }
      if (!check()) {
        throw new Error(message);
      }
    },

    clock: {
      install: () => void vi.useFakeTimers(),
      restore: () => void vi.useRealTimers(),
    },

    // Every session is an object in memory. There is nothing to close.
    cleanup: async () => {},
  };
}
