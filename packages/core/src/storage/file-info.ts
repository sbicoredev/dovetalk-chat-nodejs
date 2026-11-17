import { fileTypeFromBuffer } from "file-type";

import { FILE_NAME_MAX } from "@dovetalk/contracts";

/** Pictures every browser draws itself. Only these are shown inline, everything else downloads. */
const RASTER_IMAGES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

/**
 * Types with no signature to sniff that we still believe when the client says so. Anything else
 * the client claims and the bytes do not prove becomes a plain download (docs/edge-cases.md, #18).
 */
const DECLARED_TEXT_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
]);

const OCTET_STREAM = "application/octet-stream";

/**
 * What a file is, decided from its bytes. A signature in the bytes wins over what the client
 * said, so a script uploaded as `image/png` is not served as an image.
 */
export async function detectMime(bytes: Uint8Array, declared?: string | null): Promise<string> {
  const sniffed = await fileTypeFromBuffer(bytes);
  if (sniffed) {
    return sniffed.mime;
  }
  const claimed = declared?.split(";")[0]?.trim().toLowerCase();
  return claimed && DECLARED_TEXT_TYPES.has(claimed) ? claimed : OCTET_STREAM;
}

export const isRasterImage = (mime: string): boolean => RASTER_IMAGES.has(mime);

// Control characters, and the characters that reverse the direction of text. The latter make
// "photo\u202Egpj.exe" read as "photo exe.jpg".
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu;
const PATH_PREFIX = /^.*[/\\]/u;
const WHITESPACE = /\s+/gu;

/**
 * A file name that is safe to store, show and put in a header: no folders, no control or
 * direction-changing characters, one space between words, at most 255 characters.
 */
export function cleanFileName(raw: string | null | undefined, fallback = "file"): string {
  const base = (raw ?? "")
    .replace(UNSAFE_CHARS, " ")
    .replace(PATH_PREFIX, "")
    .replace(WHITESPACE, " ")
    .trim();
  const cut = [...base].slice(0, FILE_NAME_MAX).join("").trim();
  return cut || fallback;
}

/**
 * The `Content-Disposition` and `Content-Type` a download is served with. Pictures are inline,
 * everything else is an attachment of an opaque type, so an uploaded HTML or SVG file can never
 * run in the page's origin (docs/edge-cases.md, #17).
 */
export function servingHeaders(name: string, mime: string): { disposition: string; type: string } {
  const inline = isRasterImage(mime);
  const encoded = encodeURIComponent(name).replace(
    /['()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  // Old clients read `filename`, which can only hold plain ASCII. Everyone else reads `filename*`.
  const ascii = name.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\%]/gu, "_");
  return {
    disposition: `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    type: inline ? mime : OCTET_STREAM,
  };
}
