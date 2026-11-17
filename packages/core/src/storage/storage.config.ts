import { z } from "zod";

/**
 * Where uploaded files live. Any S3-compatible store works: SeaweedFS in Compose, Cloudflare R2
 * or S3 in production. Both apps read these, because the worker removes files too.
 */
export const storageEnvShape = {
  /** What the server itself talks to. Inside Compose this is the service name, http://s3:8333. */
  S3_ENDPOINT: z.url({ protocol: /^https?$/u }),
  /**
   * What the browser is sent in signed links. It must be reachable from outside, which inside
   * Compose is not the same address as `S3_ENDPOINT`. Defaults to `S3_ENDPOINT`.
   */
  S3_PUBLIC_ENDPOINT: z.url({ protocol: /^https?$/u }).optional(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(3).max(63),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** `http://host/bucket/key` instead of `http://bucket.host/key`. SeaweedFS needs it, R2 accepts it. */
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),
  /** Creates the bucket at start if it is missing. For local development and CI, not production. */
  S3_CREATE_BUCKET: z.stringbool().default(false),
};

const storageEnvSchema = z.object(storageEnvShape);
export type StorageEnv = z.infer<typeof storageEnvSchema>;

export interface StorageOptions {
  accessKeyId: string;
  bucket: string;
  createBucket: boolean;
  endpoint: string;
  forcePathStyle: boolean;
  publicEndpoint: string;
  region: string;
  secretAccessKey: string;
}

/** The options `CoreModule.forRoot` takes, from an app's validated environment. */
export const storageOptionsFromEnv = (env: StorageEnv): StorageOptions => ({
  endpoint: env.S3_ENDPOINT,
  publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  createBucket: env.S3_CREATE_BUCKET,
});
