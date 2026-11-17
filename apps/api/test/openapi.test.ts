import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { byCodeUnit } from "@dovetalk/testkit";

import { createTestApp, type TestApp } from "./support/create-test-app.js";

/**
 * `createTestApp` boots the app through `createApp`, the function `main.ts` uses, and swagger is
 * on whenever NODE_ENV is not production, so the document tested here is the one served at
 * /docs-json in development.
 */

interface Operation {
  requestBody?: {
    content?: Record<string, { examples?: Record<string, unknown>; schema?: unknown }>;
  };
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  security?: unknown[];
  summary?: string;
}
interface Doc {
  components: { schemas: Record<string, unknown> };
  paths: Record<string, Record<string, Operation>>;
}

let t: TestApp;
let doc: Doc;
beforeAll(async () => {
  t = await createTestApp();
  doc = (await request(t.server).get("/docs-json").expect(200)).body as Doc;
});
afterAll(() => t.close());

const operations = () =>
  Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      key: `${method.toUpperCase()} ${path}`,
      method,
      path,
      operation,
    })),
  );

/** The operations of the contacts, chats and messages endpoints. */
const CONTACT_AND_CHAT_ROUTES = [
  "GET /contacts",
  "POST /contacts",
  "PATCH /contacts/{id}",
  "DELETE /contacts/{id}",
  "PUT /contacts/{id}/block",
  "GET /chats",
  "POST /chats",
  "PATCH /chats/{id}",
  "DELETE /chats/{id}",
  "POST /chats/{id}/read",
  "POST /chats/{id}/clear",
  "POST /chats/{id}/members",
  "DELETE /chats/{id}/members/{contactId}",
  "GET /chats/{chatId}/messages",
];

/** The routes for writing messages, statuses and uploads. */
const WRITE_ROUTES = [
  "POST /chats/{chatId}/messages",
  "PATCH /messages/{id}",
  "DELETE /messages/{id}",
  "PUT /messages/{id}/reaction",
  "POST /messages/{id}/forward",
  "GET /statuses",
  "POST /statuses",
  "DELETE /statuses/{id}",
  "POST /statuses/{id}/seen",
  "POST /uploads",
];

describe("OpenAPI document", () => {
  it("lists every contacts and chats endpoint, and no others under those paths", () => {
    const listed = operations()
      .map((o) => o.key)
      .filter((key) => /^\w+ \/(contacts|chats)/u.test(key));
    // Sending is `POST /chats/{chatId}/messages`, which lives under /chats and belongs with the message routes.
    expect(listed.sort(byCodeUnit)).toEqual(
      [...CONTACT_AND_CHAT_ROUTES, "POST /chats/{chatId}/messages"].sort(byCodeUnit),
    );
  });

  it("describes each of them, with a summary, a sign-in requirement and a 401", () => {
    for (const { key, operation } of operations().filter((o) =>
      CONTACT_AND_CHAT_ROUTES.includes(o.key),
    )) {
      expect(operation.summary, `${key} needs a summary`).toBeTruthy();
      expect(operation.security?.length, `${key} needs a security requirement`).toBeGreaterThan(0);
      expect(operation.responses["401"], `${key} should document 401`).toBeDefined();
    }
  });

  it("documents the status codes the endpoints really answer with", () => {
    const codes = (key: string) =>
      Object.keys(operations().find((o) => o.key === key)!.operation.responses).sort(byCodeUnit);
    // Created or found: 201 for a new row, 200 for an existing one.
    expect(codes("POST /contacts")).toEqual(expect.arrayContaining(["200", "201"]));
    expect(codes("POST /chats")).toEqual(expect.arrayContaining(["200", "201"]));
    // No body.
    for (const key of [
      "DELETE /contacts/{id}",
      "DELETE /chats/{id}",
      "POST /chats/{id}/read",
      "POST /chats/{id}/clear",
    ]) {
      expect(codes(key), key).toContain("204");
    }
    // These answer 200 with the chat, not 201 or 204.
    expect(codes("POST /chats/{id}/members")).toContain("200");
    expect(codes("DELETE /chats/{id}/members/{contactId}")).toContain("200");
    expect(codes("DELETE /chats/{id}/members/{contactId}")).toContain("403");
    expect(codes("PATCH /chats/{id}")).toContain("409");
    expect(codes("GET /chats/{chatId}/messages")).toEqual(
      expect.arrayContaining(["200", "400", "404", "422"]),
    );
  });

  it("lists every message, status and upload route, each with a summary, a sign-in requirement and a 401", () => {
    const listed = operations().map((o) => o.key);
    for (const key of WRITE_ROUTES) {
      expect(listed, `${key} is missing`).toContain(key);
    }
    for (const { key, operation } of operations().filter((o) => WRITE_ROUTES.includes(o.key))) {
      expect(operation.summary, `${key} needs a summary`).toBeTruthy();
      expect(operation.security?.length, `${key} needs a security requirement`).toBeGreaterThan(0);
      expect(operation.responses["401"], `${key} should document 401`).toBeDefined();
    }
    // And the whole write side of messages, statuses and uploads is these and nothing else.
    const under = listed.filter((key) => /^\w+ \/(messages|statuses|uploads)/u.test(key));
    expect(under.sort(byCodeUnit)).toEqual(
      WRITE_ROUTES.filter((key) => /^\w+ \/(messages|statuses|uploads)/u.test(key)).sort(
        byCodeUnit,
      ),
    );
  });

  it("gives every message, status and upload route with a body an example, and documents each error it can answer", () => {
    const op = (key: string) => operations().find((o) => o.key === key)!.operation;
    const examples = (key: string) =>
      Object.values(op(key).requestBody?.content ?? {}).flatMap((c) =>
        Object.keys(c.examples ?? {}),
      );
    expect(examples("POST /chats/{chatId}/messages")).toEqual(
      expect.arrayContaining(["text", "reply", "picture", "voice"]),
    );
    for (const key of [
      "PATCH /messages/{id}",
      "PUT /messages/{id}/reaction",
      "POST /messages/{id}/forward",
      "POST /statuses",
    ]) {
      expect(examples(key).length, `${key} needs an example body`).toBeGreaterThan(0);
    }
    // The upload body is a form, described by its schema.
    expect(Object.keys(op("POST /uploads").requestBody?.content ?? {})).toEqual([
      "multipart/form-data",
    ]);

    const codes = (key: string) => Object.keys(op(key).responses).sort(byCodeUnit);
    expect(codes("POST /chats/{chatId}/messages")).toEqual(
      expect.arrayContaining(["200", "201", "401", "403", "404", "422"]),
    );
    expect(codes("PATCH /messages/{id}")).toEqual(
      expect.arrayContaining(["200", "401", "403", "404", "422"]),
    );
    expect(codes("DELETE /messages/{id}")).toEqual(
      expect.arrayContaining(["204", "401", "403", "404", "422"]),
    );
    expect(codes("PUT /messages/{id}/reaction")).toEqual(
      expect.arrayContaining(["200", "401", "404", "422"]),
    );
    expect(codes("POST /messages/{id}/forward")).toEqual(
      expect.arrayContaining(["201", "401", "404", "422"]),
    );
    expect(codes("GET /statuses")).toEqual(expect.arrayContaining(["200", "401"]));
    expect(codes("POST /statuses")).toEqual(expect.arrayContaining(["201", "401", "422"]));
    expect(codes("DELETE /statuses/{id}")).toEqual(
      expect.arrayContaining(["204", "401", "403", "404"]),
    );
    expect(codes("POST /statuses/{id}/seen")).toEqual(
      expect.arrayContaining(["204", "401", "404"]),
    );
    expect(codes("POST /uploads")).toEqual(expect.arrayContaining(["201", "401", "413", "422"]));
  });

  it("documents DELETE /messages/{id} with a required scope", () => {
    const op = doc.paths["/messages/{id}"]!.delete! as Operation & {
      parameters: { name: string; required: boolean; schema: { enum?: string[] } }[];
    };
    const scope = op.parameters.find((p) => p.name === "scope")!;
    expect(scope.required).toBe(true);
    expect(scope.schema.enum).toEqual(["me", "everyone"]);
  });

  it("documents 401 on both /me routes, which need a signed-in person", () => {
    for (const key of ["GET /me", "PATCH /me"]) {
      const operation = operations().find((o) => o.key === key)?.operation;
      expect(operation, `${key} is missing`).toBeDefined();
      expect(operation?.security?.length, `${key} needs a security requirement`).toBeGreaterThan(0);
      expect(operation?.responses["401"], `${key} should document 401`).toBeDefined();
    }
  });

  it("has a schema for every response body and every reference resolves", () => {
    const text = JSON.stringify(doc);
    const refs = [...text.matchAll(/"#\/components\/schemas\/([^"]+)"/gu)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const name of new Set(refs)) {
      expect(doc.components.schemas[name], `$ref to ${name}`).toBeDefined();
    }

    const bodyOf = (key: string, status: string) =>
      JSON.stringify(
        operations().find((o) => o.key === key)!.operation.responses[status]?.content ?? null,
      );
    expect(bodyOf("GET /contacts", "200")).toContain("ContactModel");
    expect(bodyOf("POST /contacts", "201")).toContain("ContactModel");
    expect(bodyOf("PUT /contacts/{id}/block", "200")).toContain("ContactModel");
    expect(bodyOf("GET /chats", "200")).toContain("ChatModel");
    expect(bodyOf("PATCH /chats/{id}", "200")).toContain("ChatModel");
    expect(bodyOf("POST /chats/{id}/members", "200")).toContain("ChatModel");
    expect(bodyOf("DELETE /chats/{id}/members/{contactId}", "200")).toContain("ChatModel");
    expect(bodyOf("GET /chats/{chatId}/messages", "200")).toContain("MessagePageModel");
    expect(bodyOf("POST /chats/{chatId}/messages", "201")).toContain("MessageModel");
    expect(bodyOf("POST /chats/{chatId}/messages", "200")).toContain("MessageModel");
    expect(bodyOf("PATCH /messages/{id}", "200")).toContain("MessageModel");
    expect(bodyOf("PUT /messages/{id}/reaction", "200")).toContain("MessageModel");
    expect(bodyOf("POST /messages/{id}/forward", "201")).toContain("MessageModel");
    expect(bodyOf("GET /statuses", "200")).toContain("StatusModel");
    expect(bodyOf("POST /statuses", "201")).toContain("StatusModel");
    expect(bodyOf("POST /uploads", "201")).toContain("AttachmentModel");
    expect(bodyOf("POST /uploads", "413")).toContain("ErrorModel");
  });

  it("documents every route the app serves", () => {
    // Express 5 keeps the registered routes on `router.stack`.
    const instance = t.app.getHttpAdapter().getInstance() as {
      router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
    };
    const served = instance.router.stack
      .flatMap((layer) => (layer.route ? [layer.route] : []))
      .filter((route) => typeof route.path === "string" && route.path.startsWith("/"))
      .flatMap((route) =>
        Object.keys(route.methods)
          .filter((method) => method !== "_all")
          .map((method) => `${method.toUpperCase()} ${route.path.replace(/:(\w+)/gu, "{$1}")}`),
      );

    expect(served.length).toBeGreaterThan(20);
    const documented = new Set(operations().map((o) => o.key));
    const missing = served.filter((key) => !(documented.has(key) || key.startsWith("GET /docs")));
    expect(missing).toEqual([]);
  });
});
