import http from "node:http";

/** One keep-alive pool for everything the load tools send, so they do not spend time on TCP setup. */
const agent = new http.Agent({ keepAlive: true, maxSockets: 512, maxFreeSockets: 128 });

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(method: string, url: string, status: number, body: string) {
    super(`${method} ${url} answered ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Gives up after this long. Default 30 s. */
  timeoutMs?: number;
  token?: string;
}

/**
 * A JSON request. Resolves with the parsed body of a 2xx answer, rejects with `HttpError` for any
 * other status and with the network error otherwise (so callers can tell "the server said no" from
 * "the server was not there", which matters when an instance is being killed on purpose).
 */
export function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  return new Promise<T>((resolve, reject) => {
    const req = http.request(url, { method, headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new HttpError(method, url, status, text));
          return;
        }
        try {
          resolve((text === "" ? undefined : JSON.parse(text)) as T);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(options.timeoutMs ?? 30_000, () => {
      req.destroy(new Error(`${method} ${url} timed out`));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

/** Runs `task` for every item with at most `limit` in flight. Rejects on the first failure. */
export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // biome-ignore lint/performance/noAwaitInLoops: each worker handles its items one after another, on purpose.
      await task(items[index] as T, index);
    }
  });
  await Promise.all(workers);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
