import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import pg from "pg";

/**
 * Where tests find Postgres and Redis.
 *
 * - Set TEST_DATABASE_URL and TEST_REDIS_URL to use servers you already run (CI service
 *   containers, or a local install). Nothing is started.
 * - Otherwise Testcontainers starts a throwaway Postgres and Redis through Docker.
 *
 * Every suite gets its own database, so test files can run in parallel.
 */
export interface TestInfra {
  /** A connection string with rights to CREATE DATABASE. */
  adminDatabaseUrl: string;
  /** Redis server URL without a database number. */
  redisBaseUrl: string;
  stop: () => Promise<void>;
}

let infra: Promise<TestInfra> | null = null;

export function getTestInfra(): Promise<TestInfra> {
  infra ??= startInfra();
  return infra;
}

async function startInfra(): Promise<TestInfra> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const redisUrl = process.env.TEST_REDIS_URL;
  if (databaseUrl && redisUrl) {
    return {
      adminDatabaseUrl: databaseUrl,
      redisBaseUrl: redisUrl.replace(/\/\d+$/u, ""),
      stop: () => Promise.resolve(),
    };
  }

  try {
    const [{ PostgreSqlContainer }, { RedisContainer }] = await Promise.all([
      import("@testcontainers/postgresql"),
      import("@testcontainers/redis"),
    ]);
    const [postgres, redis] = await Promise.all([
      new PostgreSqlContainer("postgres:18").start(),
      new RedisContainer("redis:8").start(),
    ]);
    return {
      adminDatabaseUrl: postgres.getConnectionUri(),
      redisBaseUrl: `redis://${redis.getHost()}:${redis.getPort()}`,
      stop: async () => {
        await Promise.all([postgres.stop(), redis.stop()]);
      },
    };
  } catch (error) {
    throw new Error(
      "No test infrastructure. Set TEST_DATABASE_URL and TEST_REDIS_URL, or start Docker so Testcontainers can run.",
      { cause: error },
    );
  }
}

export interface TestDatabase {
  /** Drops the database. Open connections are terminated first. */
  drop: () => Promise<void>;
  url: string;
}

/** Creates an empty database with a random name. Run migrations on it yourself. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const { adminDatabaseUrl } = await getTestInfra();
  const name = `dovetalk_t_${randomBytes(6).toString("hex")}`;

  const admin = new pg.Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${name}`;

  return {
    url: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: adminDatabaseUrl });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}

export interface TestRedis {
  /** Empties this logical database. */
  flush: () => Promise<void>;
  url: string;
}

/** The name of the package whose tests are running (Vitest runs with the package as its working directory). */
function packageName(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      name?: string;
    };
    return manifest.name ?? "";
  } catch {
    return "";
  }
}

/** Logical databases each package may use. Redis has 16 by default and database 0 is left alone. */
export const REDIS_DATABASES_PER_PACKAGE = 5;

const REDIS_BLOCKS: Record<string, number> = {
  "@dovetalk/core": 0,
  "@dovetalk/api": 1,
  "@dovetalk/worker": 2,
};

/**
 * A Redis URL on a logical database picked from the package under test and the Vitest worker id,
 * emptied first. `pnpm test` runs the packages at the same time and every package numbers its
 * workers from 1, so the worker id alone put the API, core and worker suites on the same
 * database, where one suite's `flushdb` deleted the queues of another. Each package therefore has
 * its own block of five databases, and its Vitest config caps the workers at five.
 */
export async function createTestRedis(): Promise<TestRedis> {
  const { redisBaseUrl } = await getTestInfra();
  const worker = Number(process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 0);
  const block = REDIS_BLOCKS[packageName()] ?? 0;
  const url = `${redisBaseUrl}/${1 + block * REDIS_DATABASES_PER_PACKAGE + (worker % REDIS_DATABASES_PER_PACKAGE)}`;
  const flush = async () => {
    const client = new Redis(url, { maxRetriesPerRequest: 1 });
    try {
      await client.flushdb();
    } finally {
      client.disconnect();
    }
  };
  await flush();
  return { url, flush };
}

/**
 * Orders strings by UTF-16 code unit, the way `<` does and the way the code under test builds its
 * keys (`directKey`). `localeCompare` would sort differently once punctuation is involved.
 */
export const byCodeUnit = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
};

// ---- object storage -----------------------------------------------------------------------

/**
 * A test S3 server and the settings to reach it, in the two shapes the code under test takes: as
 * environment variables (for `loadApiEnv`) and as plain options (for `CoreModule.forRoot`).
 */
export interface TestStorage {
  env: Record<string, string>;
  /**
   * Whether the object is in the bucket, asked of the server directly (HeadObject). A signed link
   * cannot answer this: some servers (moto) refuse the link of a missing key as unsigned (403)
   * instead of answering 404, so the status of a link says nothing about the object.
   */
  objectExists: (key: string) => Promise<boolean>;
  options: {
    accessKeyId: string;
    bucket: string;
    createBucket: boolean;
    endpoint: string;
    forcePathStyle: boolean;
    publicEndpoint: string;
    region: string;
    secretAccessKey: string;
  };
}

/** The identity Compose gives SeaweedFS. Tests use the same file, so there is one source. */
const SEAWEED_CONFIG = new URL("../../../ops/docker/seaweedfs-s3.json", import.meta.url);

let storage: Promise<TestStorage> | null = null;

/**
 * An S3-compatible server with a bucket in it.
 *
 * - Set TEST_S3_ENDPOINT (and optionally TEST_S3_BUCKET, TEST_S3_ACCESS_KEY_ID and
 *   TEST_S3_SECRET_ACCESS_KEY) to use one you already run: CI, or `docker compose up s3`.
 * - Otherwise Testcontainers starts SeaweedFS, the same image Compose uses (TEST_S3_IMAGE
 *   overrides the tag).
 *
 * Every object is stored under a random key, so test files can share the bucket.
 */
export function getTestStorage(): Promise<TestStorage> {
  storage ??= startStorage();
  return storage;
}

async function startStorage(): Promise<TestStorage> {
  const configText = readFileSync(SEAWEED_CONFIG, "utf8");
  const [credential] = (
    JSON.parse(configText) as {
      identities: { credentials: { accessKey: string; secretKey: string }[] }[];
    }
  ).identities[0]!.credentials;
  const accessKeyId = process.env.TEST_S3_ACCESS_KEY_ID ?? credential!.accessKey;
  const secretAccessKey = process.env.TEST_S3_SECRET_ACCESS_KEY ?? credential!.secretKey;
  const bucket = process.env.TEST_S3_BUCKET ?? "dovetalk-test";

  let endpoint = process.env.TEST_S3_ENDPOINT;
  if (!endpoint) {
    try {
      const { GenericContainer, Wait } = await import("testcontainers");
      const container = await new GenericContainer(
        process.env.TEST_S3_IMAGE ?? "chrislusf/seaweedfs:3.99",
      )
        .withExposedPorts(8333)
        // Every bucket takes 7 volumes and the default cap is 8, so a few buckets (the tests make one
        // each) end in "Not enough data nodes found". Measured against the same weed 3.99 binary.
        .withCommand([
          "server",
          "-s3",
          "-s3.config=/etc/seaweedfs/s3.json",
          "-dir=/data",
          "-master.volumeSizeLimitMB=32",
          "-volume.max=2000",
        ])
        .withCopyContentToContainer([{ content: configText, target: "/etc/seaweedfs/s3.json" }])
        .withWaitStrategy(Wait.forListeningPorts())
        .start();
      endpoint = `http://${container.getHost()}:${container.getMappedPort(8333)}`;
    } catch (error) {
      throw new Error(
        "No test storage. Set TEST_S3_ENDPOINT to an S3-compatible server, or start Docker so Testcontainers can run one.",
        { cause: error },
      );
    }
  }

  const client = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  try {
    await ensureBucket(client, bucket);
  } finally {
    client.destroy();
  }

  const objectExists = async (key: string): Promise<boolean> => {
    const probe = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    try {
      await probe.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      const { name, $metadata } = error as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (name === "NotFound" || $metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    } finally {
      probe.destroy();
    }
  };

  return {
    objectExists,
    env: {
      S3_ENDPOINT: endpoint,
      S3_BUCKET: bucket,
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
      S3_FORCE_PATH_STYLE: "true",
    },
    options: {
      endpoint,
      publicEndpoint: endpoint,
      region: "us-east-1",
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: true,
      createBucket: false,
    },
  };
}

/** A freshly started server accepts connections a moment before it can create buckets. */
async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return;
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        return;
      }
    } catch (error) {
      const { name } = error as { name?: string };
      if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
        return;
      }
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("The test S3 server never accepted a bucket.", { cause: lastError });
}
