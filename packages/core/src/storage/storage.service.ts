import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import type { CoreOptions } from "../core.options.js";
import { CORE_OPTIONS } from "../tokens.js";
import { servingHeaders } from "./file-info.js";

const HOUR_MS = 3_600_000;
/** A store that is still starting (Compose, CI) gets about a minute to answer before the app gives up. */
const STARTUP_ATTEMPTS = 30;
const STARTUP_DELAY_MS = 2000;
const TRAILING_SLASHES = /\/+$/u;
/** How long a signed link stays valid, counted from the start of the hour it was made in. */
const LINK_LIFETIME_SECONDS = 2 * 3600;

/**
 * Object storage: save a file, remove it, and sign a link to read it.
 *
 * Signed links are made from the start of the current hour, so every request inside that hour gets
 * the same link, which keeps browser caches useful and DTOs stable. A link made at 10:59 is
 * valid until 12:00, so one is always valid for at least an hour after it is handed out
 * (docs/edge-cases.md, #16).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger("Storage");
  private readonly bucket: string;
  private readonly client: S3Client;
  /** Signing makes no request, so this client only has to carry the public address. */
  private readonly signer: S3Client;
  private readonly createBucket: boolean;
  private readonly publicBase: URL;
  private readonly pathStyle: boolean;

  constructor(@Inject(CORE_OPTIONS) options: CoreOptions) {
    const { storage } = options;
    this.bucket = storage.bucket;
    this.createBucket = storage.createBucket;
    this.publicBase = new URL(storage.publicEndpoint);
    this.pathStyle = storage.forcePathStyle;
    const common = {
      region: storage.region,
      forcePathStyle: storage.forcePathStyle,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
      // The newer defaults add checksum headers that some S3-compatible stores do not accept.
      requestChecksumCalculation: "WHEN_REQUIRED" as const,
      responseChecksumValidation: "WHEN_REQUIRED" as const,
    };
    this.client = new S3Client({ ...common, endpoint: storage.endpoint });
    this.signer = new S3Client({ ...common, endpoint: storage.publicEndpoint });
  }

  async onModuleInit(): Promise<void> {
    if (this.createBucket) {
      await this.ensureBucketWhenReady(STARTUP_ATTEMPTS, STARTUP_DELAY_MS);
    }
  }

  /**
   * `ensureBucket`, tried again while the store is not answering yet. Compose starts the API and
   * the store together, and SeaweedFS takes a while before it can make a bucket. The last error is
   * thrown when the attempts run out, so a wrong address or key still stops the app, only later.
   */
  async ensureBucketWhenReady(attempts: number, delayMs: number): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each try must wait for the one before it.
        await this.ensureBucket();
        return;
      } catch (error) {
        if (attempt >= attempts) {
          throw error;
        }
        this.logger.warn(`Storage is not ready (attempt ${attempt} of ${attempts}); trying again.`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /** Creates the bucket if it is missing. Safe to run from several instances at once. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created bucket ${this.bucket}.`);
    } catch (error) {
      // Another instance made it between our check and our request.
      const { name } = error as { name?: string };
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
        throw error;
      }
    }
  }

  /**
   * Saves a file. How it is served is stored with it (`servingHeaders`), not only asked for in
   * the signed link, because not every store honours the link's overrides: SeaweedFS does not.
   * So a file that is not a plain picture is an opaque download whichever store holds it.
   */
  async put(key: string, body: Uint8Array, file: { mime: string; name: string }): Promise<void> {
    const { disposition, type } = servingHeaders(file.name, file.mime);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.byteLength,
        ContentType: type,
        ContentDisposition: disposition,
      }),
    );
  }

  /** Removes objects. A key that is already gone is not an error. */
  async delete(keys: readonly string[]): Promise<void> {
    await Promise.all(
      keys.map((key) =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })),
      ),
    );
  }

  /**
   * The object key a link of ours points at, or `null` for any other address. This is the inverse
   * of `signedUrl`, so a client can hand a link it got from an upload back to the API, which
   * keeps the attachment, never the link (docs/edge-cases.md, #15). Only the address is read:
   * the signature does not matter, because what the key names is looked up and checked against
   * its owner afterwards.
   */
  keyFromLink(link: string): string | null {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return null;
    }
    if (url.protocol !== this.publicBase.protocol) {
      return null;
    }
    const basePath = this.publicBase.pathname.replace(TRAILING_SLASHES, "");
    const expectedHost = this.pathStyle
      ? this.publicBase.host
      : `${this.bucket}.${this.publicBase.host}`;
    if (url.host !== expectedHost) {
      return null;
    }
    const prefix = this.pathStyle ? `${basePath}/${this.bucket}/` : `${basePath}/`;
    if (!url.pathname.startsWith(prefix)) {
      return null;
    }
    try {
      return decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      return null;
    }
  }

  /** A link the browser can load. `name` and `mime` decide how it is served. */
  signedUrl(
    key: string,
    file: { mime: string; name: string },
    now: number = Date.now(),
  ): Promise<string> {
    const { disposition, type } = servingHeaders(file.name, file.mime);
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: disposition,
        ResponseContentType: type,
      }),
      {
        expiresIn: LINK_LIFETIME_SECONDS,
        signingDate: new Date(Math.floor(now / HOUR_MS) * HOUR_MS),
      },
    );
  }
}

const isMissing = (error: unknown): boolean => {
  const info = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return info.name === "NotFound" || info.$metadata?.httpStatusCode === 404;
};
