import { createMockApi, type MockApi } from "@/lib/api/mock/server";

export const TOKEN = "mock.test";

/** A mock server with no delay, no auto replies and a fixed clock. */
export function makeMock(overrides: Partial<Parameters<typeof createMockApi>[0]> = {}): MockApi {
  let token: string | null = TOKEN;
  const mock = createMockApi({
    getToken: () => token,
    latencyMs: 0,
    autoReply: false,
    ...overrides,
  });
  return Object.assign(mock, { setToken: (t: string | null) => (token = t) }) as MockApi;
}

export const cid = (() => {
  let n = 0;
  return () => {
    n += 1;
    return `client-${n}`;
  };
})();
