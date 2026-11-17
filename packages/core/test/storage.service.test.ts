import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getTestStorage } from "@dovetalk/testkit";

import { StorageService, storageEnvShape, storageOptionsFromEnv } from "../src/index.js";

const serviceFor = async (over: Record<string, unknown> = {}) => {
  const { options } = await getTestStorage();
  return new StorageService({
    serviceName: "test",
    database: { url: "postgres://unused" },
    redisUrl: "redis://unused",
    storage: { ...options, ...over },
  });
};

describe("StorageService.ensureBucket", () => {
  it("creates a missing bucket, and is happy to run again and at the same time", async () => {
    const bucket = `dovetalk-t-${randomBytes(4).toString("hex")}`;
    const service = await serviceFor({ bucket });
    await Promise.all([service.ensureBucket(), service.ensureBucket(), service.ensureBucket()]);
    await service.ensureBucket();
    await service.put("probe", new TextEncoder().encode("ok"), {
      mime: "text/plain",
      name: "p.txt",
    });
    await service.delete(["probe"]);
  });

  it("creates the bucket at start only when asked to", async () => {
    const bucket = `dovetalk-t-${randomBytes(4).toString("hex")}`;
    const { options } = await getTestStorage();
    // Asked through a client of its own: some stores (SeaweedFS) make a bucket on the first PUT,
    // so a PUT cannot show whether the service made it.
    const probe = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
    const exists = () =>
      probe.send(new HeadBucketCommand({ Bucket: bucket })).then(
        () => true,
        () => false,
      );

    const off = await serviceFor({ bucket, createBucket: false });
    await off.onModuleInit();
    expect(await exists()).toBe(false);

    const on = await serviceFor({ bucket, createBucket: true });
    await on.onModuleInit();
    expect(await exists()).toBe(true);
    await expect(
      on.put("a", new Uint8Array([1]), { mime: "x/y", name: "a" }),
    ).resolves.toBeUndefined();
    probe.destroy();
  });

  it("treats deleting a file that is not there as success", async () => {
    const service = await serviceFor();
    await expect(
      service.delete([`uploads/none/${randomBytes(4).toString("hex")}`]),
    ).resolves.toBeUndefined();
  });
});

/** A store that is not there yet. `listen` brings it up later, answering like an empty S3 server. */
const lateStore = async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  const requests: string[] = [];
  let server: Server | undefined;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    listen: () =>
      new Promise<void>((resolve) => {
        server = createServer((request, response) => {
          requests.push(`${request.method} ${request.url}`);
          // HEAD finds no bucket, PUT makes it.
          response.statusCode = request.method === "HEAD" ? 404 : 200;
          response.end();
        }).listen(port, "127.0.0.1", resolve);
      }),
    close: () => new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined))),
  };
};

describe("StorageService.ensureBucketWhenReady", () => {
  it("waits for a store that comes up late, then makes the bucket", async () => {
    const store = await lateStore();
    const service = await serviceFor({
      endpoint: store.endpoint,
      publicEndpoint: store.endpoint,
      bucket: "late-bucket",
    });
    const ready = service.ensureBucketWhenReady(100, 50);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(store.requests).toEqual([]);
    await store.listen();
    await ready;
    expect(store.requests).toEqual(["HEAD /late-bucket/", "PUT /late-bucket/"]);
    await store.close();
  });

  it("gives up with the last error when the store never answers", async () => {
    const store = await lateStore();
    const service = await serviceFor({
      endpoint: store.endpoint,
      publicEndpoint: store.endpoint,
    });
    await expect(service.ensureBucketWhenReady(2, 10)).rejects.toThrow();
  });

  it("does not wait when the first try works", async () => {
    const service = await serviceFor({ bucket: `dovetalk-t-${randomBytes(4).toString("hex")}` });
    await expect(service.ensureBucketWhenReady(1, 10)).resolves.toBeUndefined();
  });
});

describe("storage settings", () => {
  const env = {
    S3_ENDPOINT: "http://s3:8333",
    S3_BUCKET: "dovetalk",
    S3_ACCESS_KEY_ID: "k",
    S3_SECRET_ACCESS_KEY: "s",
  };
  const parse = (over: Record<string, string> = {}) =>
    z.object(storageEnvShape).parse({ ...env, ...over });

  it("defaults the public address to the internal one, and the rest to path-style on us-east-1", () => {
    const options = storageOptionsFromEnv(parse());
    expect(options).toMatchObject({
      endpoint: "http://s3:8333",
      publicEndpoint: "http://s3:8333",
      region: "us-east-1",
      forcePathStyle: true,
      createBucket: false,
    });
  });

  it("keeps a separate public address for browsers", () => {
    const options = storageOptionsFromEnv(
      parse({ S3_PUBLIC_ENDPOINT: "http://localhost:8333", S3_CREATE_BUCKET: "true" }),
    );
    expect(options.endpoint).toBe("http://s3:8333");
    expect(options.publicEndpoint).toBe("http://localhost:8333");
    expect(options.createBucket).toBe(true);
  });

  it("refuses a missing key, a bad bucket name and a non-http endpoint", () => {
    expect(() => parse({ S3_ACCESS_KEY_ID: "" })).toThrow();
    expect(() => parse({ S3_BUCKET: "ab" })).toThrow();
    expect(() => parse({ S3_ENDPOINT: "ftp://x" })).toThrow();
  });
});
