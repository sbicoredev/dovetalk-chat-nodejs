import { describe, expect, it, vi } from "vitest";

import { isApiError } from "./errors";
import { createHttpApi, type RefreshOutcome } from "./http";

function respond(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setup(token: string | null = "tok") {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const onUnauthorized = vi.fn();
  const api = createHttpApi({
    baseUrl: "http://api.test/v1/",
    getToken: () => token,
    onUnauthorized,
    fetch,
  });
  return { api, fetch, onUnauthorized };
}

describe("http api", () => {
  it("sends the bearer token and joins the base url", async () => {
    const { api, fetch } = setup();
    fetch.mockResolvedValue(respond(200, []));
    await api.contacts.list();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://api.test/v1/contacts");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("sends json bodies and query strings", async () => {
    const { api, fetch } = setup();
    fetch.mockResolvedValue(respond(200, { items: [], nextCursor: null }));
    await api.chats.messages("c1", { before: "m9", limit: 25 });
    expect(fetch.mock.calls[0][0]).toBe("http://api.test/v1/chats/c1/messages?before=m9&limit=25");

    fetch.mockResolvedValue(respond(200, {}));
    await api.messages.edit("m1", "hi");
    const init = fetch.mock.calls[1][1]!;
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ text: "hi" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("passes the delete scope as a query", async () => {
    const { api, fetch } = setup();
    fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.messages.remove("m1", "everyone")).resolves.toBeUndefined();
    expect(fetch.mock.calls[0][0]).toBe("http://api.test/v1/messages/m1?scope=everyone");
  });

  it("turns a Nest error body into an ApiError", async () => {
    const { api, fetch } = setup();
    fetch.mockResolvedValue(
      respond(409, { statusCode: 409, code: "PIN_LIMIT", message: "Too many pinned." }),
    );
    const error = await api.chats.update("c1", { pinned: true }).catch((e) => e);
    expect(isApiError(error)).toBe(true);
    expect(error).toMatchObject({ status: 409, code: "PIN_LIMIT", message: "Too many pinned." });
  });

  it("joins validation message arrays", async () => {
    const { api, fetch } = setup();
    fetch.mockResolvedValue(
      respond(400, { statusCode: 400, message: ["name must not be empty", "phone is invalid"] }),
    );
    const error = await api.contacts.create({ name: "", phone: "" }).catch((e) => e);
    expect(error.status).toBe(400);
    expect(error.message).toContain("name must not be empty");
  });

  it("maps network failures to NETWORK_ERROR", async () => {
    const { api, fetch } = setup();
    fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const error = await api.me.get().catch((e) => e);
    expect(error).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  it("calls onUnauthorized for a 401, except on login", async () => {
    const { api, fetch, onUnauthorized } = setup();
    fetch.mockResolvedValue(respond(401, { message: "Unauthorized" }));
    await api.me.get().catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    await api.auth.login({ email: "a@b.c", password: "x" }).catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("uploads as multipart without a content type", async () => {
    const { api, fetch } = setup();
    fetch.mockResolvedValue(
      respond(201, {
        id: "a1",
        url: "http://x/a1",
        name: "n.txt",
        size: 3,
        mime: "text/plain",
        width: null,
        height: null,
      }),
    );
    await api.uploads.create(new Blob(["abc"], { type: "text/plain" }), { name: "n.txt" });
    const init = fetch.mock.calls[0][1]!;
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect((init.body as FormData).get("file")).toBeInstanceOf(Blob);
  });
});

describe("http api: renewing an expired session", () => {
  function setupRefresh(outcome: RefreshOutcome, newToken = "new") {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const onUnauthorized = vi.fn();
    let token: string | null = "old";
    const refreshSession = vi.fn(async () => {
      if (outcome === "refreshed") {
        token = newToken;
      }
      return outcome;
    });
    const api = createHttpApi({
      baseUrl: "http://api.test",
      getToken: () => token,
      onUnauthorized,
      refreshSession,
      fetch,
    });
    return { api, fetch, onUnauthorized, refreshSession, setToken: (t: string) => (token = t) };
  }
  const bearer = (call: unknown[]) =>
    ((call[1] as RequestInit).headers as Record<string, string>).Authorization;

  it("refreshes on a 401 and sends the request again with the new token", async () => {
    const { api, fetch, onUnauthorized, refreshSession } = setupRefresh("refreshed");
    fetch
      .mockResolvedValueOnce(respond(401, { code: "UNAUTHORIZED", message: "Expired." }))
      .mockResolvedValueOnce(respond(200, { id: "u1" }));
    await expect(api.me.get()).resolves.toEqual({ id: "u1" });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bearer(fetch.mock.calls[0])).toBe("Bearer old");
    expect(bearer(fetch.mock.calls[1])).toBe("Bearer new");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("sends an upload again after a refresh", async () => {
    const { api, fetch } = setupRefresh("refreshed");
    fetch
      .mockResolvedValueOnce(respond(401, { code: "UNAUTHORIZED", message: "Expired." }))
      .mockResolvedValueOnce(respond(201, { id: "a1" }));
    await api.uploads.create(new Blob(["abc"]), { name: "n.txt" });
    expect((fetch.mock.calls[1][1] as RequestInit).body).toBeInstanceOf(FormData);
  });

  it("asks only once: a second 401 signs out", async () => {
    const { api, fetch, onUnauthorized, refreshSession } = setupRefresh("refreshed");
    fetch.mockResolvedValue(respond(401, { code: "UNAUTHORIZED", message: "Expired." }));
    await expect(api.me.get()).rejects.toMatchObject({ status: 401 });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("signs out when the session cannot be renewed", async () => {
    const { api, fetch, onUnauthorized } = setupRefresh("signed-out");
    fetch.mockResolvedValue(respond(401, { code: "UNAUTHORIZED", message: "Expired." }));
    await expect(api.me.get()).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not sign anybody out when the server cannot be reached to renew", async () => {
    const { api, fetch, onUnauthorized } = setupRefresh("unavailable");
    fetch.mockResolvedValue(respond(401, { code: "UNAUTHORIZED", message: "Expired." }));
    await expect(api.me.get()).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("skips the refresh when another request already renewed the token", async () => {
    const { api, fetch, refreshSession, setToken } = setupRefresh("refreshed");
    fetch
      .mockImplementationOnce(async () => {
        setToken("renewed-elsewhere");
        return respond(401, { code: "UNAUTHORIZED", message: "Expired." });
      })
      .mockResolvedValueOnce(respond(200, {}));
    await api.me.get();
    expect(refreshSession).not.toHaveBeenCalled();
    expect(bearer(fetch.mock.calls[1])).toBe("Bearer renewed-elsewhere");
  });

  it("never refreshes because an /auth call failed, and sends the cookie with those calls", async () => {
    const { api, fetch, refreshSession, onUnauthorized } = setupRefresh("refreshed");
    fetch.mockResolvedValue(respond(401, { code: "UNAUTHORIZED", message: "No session." }));
    await expect(api.auth.refresh()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(refreshSession).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect((fetch.mock.calls[0][1] as RequestInit).credentials).toBe("include");
    expect(fetch.mock.calls[0][0]).toBe("http://api.test/auth/refresh");
  });

  it("registers and starts a guest through the auth routes", async () => {
    const { api, fetch } = setupRefresh("refreshed");
    fetch.mockImplementation(async () => respond(201, { accessToken: "t", user: {} }));
    await api.auth.register({ email: "a@b.co", password: "12345678", name: "A" });
    await api.auth.guest();
    expect(fetch.mock.calls[0][0]).toBe("http://api.test/auth/register");
    expect((fetch.mock.calls[0][1] as RequestInit).body).toBe(
      JSON.stringify({ email: "a@b.co", password: "12345678", name: "A" }),
    );
    expect(fetch.mock.calls[1][0]).toBe("http://api.test/auth/guest");
    expect((fetch.mock.calls[1][1] as RequestInit).method).toBe("POST");
  });
});
