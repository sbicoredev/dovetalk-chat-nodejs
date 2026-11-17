import { getTestStorage } from "@dovetalk/testkit";

/**
 * Whether the object behind a signed URL is still in storage. Asks the store directly (a HEAD
 * request) instead of fetching the link: S3-compatible servers disagree on what a link to a
 * missing key answers (SeaweedFS says 404, moto says 403), so the status of a link proves nothing.
 */
export async function objectBehind(url: string): Promise<boolean> {
  const storage = await getTestStorage();
  const prefix = `/${storage.options.bucket}/`;
  const { pathname } = new URL(url);
  if (!pathname.startsWith(prefix)) {
    throw new Error(`Not a path-style link into ${storage.options.bucket}: ${pathname}`);
  }
  return storage.objectExists(decodeURIComponent(pathname.slice(prefix.length)));
}
