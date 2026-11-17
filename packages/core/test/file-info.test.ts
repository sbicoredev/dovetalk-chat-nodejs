import { describe, expect, it } from "vitest";

import { cleanFileName, detectMime, isRasterImage, servingHeaders } from "../src/index.js";

/** The first bytes of a PNG and of a PDF: enough for a signature check. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
]);
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const text = (value: string) => new TextEncoder().encode(value);

describe("detectMime", () => {
  it("believes the bytes over the client", async () => {
    expect(await detectMime(PNG, "text/plain")).toBe("image/png");
    expect(await detectMime(JPEG, "application/pdf")).toBe("image/jpeg");
    expect(await detectMime(PDF, "image/png")).toBe("application/pdf");
  });

  it("keeps a declared plain-text type, ignoring parameters and case", async () => {
    expect(await detectMime(text("hello"), "text/plain")).toBe("text/plain");
    expect(await detectMime(text("a,b"), "TEXT/CSV; charset=utf-8")).toBe("text/csv");
    expect(await detectMime(text("{}"), "application/json")).toBe("application/json");
  });

  it("turns every other claim without proof into an opaque download", async () => {
    expect(await detectMime(text("<svg onload=alert(1)>"), "image/svg+xml")).toBe(
      "application/octet-stream",
    );
    expect(await detectMime(text("<script>x</script>"), "text/html")).toBe(
      "application/octet-stream",
    );
    expect(await detectMime(text("not a png"), "image/png")).toBe("application/octet-stream");
    expect(await detectMime(text("x"), undefined)).toBe("application/octet-stream");
    expect(await detectMime(text("x"), "")).toBe("application/octet-stream");
  });
});

describe("isRasterImage", () => {
  it("is true for pictures browsers draw and false for the rest", () => {
    for (const mime of ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]) {
      expect(isRasterImage(mime), mime).toBe(true);
    }
    for (const mime of ["image/svg+xml", "text/html", "application/pdf", "image/bmp"]) {
      expect(isRasterImage(mime), mime).toBe(false);
    }
  });
});

describe("cleanFileName", () => {
  it("keeps an ordinary name", () => {
    expect(cleanFileName("trail map.pdf")).toBe("trail map.pdf");
    expect(cleanFileName("Café – résumé 日本語.docx")).toBe("Café – résumé 日本語.docx");
  });

  it("drops folders from either kind of path", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
  });

  it("removes control characters and text-direction tricks", () => {
    expect(cleanFileName("a\r\nb\u0000c.txt")).toBe("a b c.txt");
    expect(cleanFileName("photo\u202Egpj.exe")).toBe("photo gpj.exe");
  });

  it("collapses whitespace, trims, and falls back when nothing is left", () => {
    expect(cleanFileName("  many   spaces  .txt ")).toBe("many spaces .txt");
    expect(cleanFileName("")).toBe("file");
    expect(cleanFileName(undefined)).toBe("file");
    expect(cleanFileName("/")).toBe("file");
    expect(cleanFileName("\n\t", "attachment")).toBe("attachment");
  });

  it("cuts to 255 characters without splitting an emoji", () => {
    const long = cleanFileName(`${"😀".repeat(300)}.png`);
    expect([...long]).toHaveLength(255);
    expect(long).toBe("😀".repeat(255));
  });
});

describe("servingHeaders", () => {
  it("shows pictures inline with their own type", () => {
    const { disposition, type } = servingHeaders("cat.jpg", "image/jpeg");
    expect(type).toBe("image/jpeg");
    expect(disposition).toBe(`inline; filename="cat.jpg"; filename*=UTF-8''cat.jpg`);
  });

  it("makes everything else a download of an opaque type", () => {
    for (const mime of ["text/html", "image/svg+xml", "application/pdf", "text/plain"]) {
      const { disposition, type } = servingHeaders("x.bin", mime);
      expect(type, mime).toBe("application/octet-stream");
      expect(disposition, mime).toMatch(/^attachment;/u);
    }
  });

  it("encodes names so a quote or line break cannot end the header early", () => {
    const { disposition } = servingHeaders(
      'he said "hi"\r\nSet-Cookie: x=1.pdf',
      "application/pdf",
    );
    expect(disposition).not.toMatch(/[\r\n]/u);
    expect(disposition.match(/"/gu)).toHaveLength(2);
    expect(disposition).toContain("filename*=UTF-8''");
  });

  it("carries non-ASCII names in the encoded form and a plain fallback", () => {
    const { disposition } = servingHeaders("naïve café.txt", "text/plain");
    expect(disposition).toContain('filename="na_ve caf_.txt"');
    expect(disposition).toContain("filename*=UTF-8''na%C3%AFve%20caf%C3%A9.txt");
  });

  it("encodes the characters encodeURIComponent leaves alone", () => {
    const { disposition } = servingHeaders("it's (1)*.txt", "text/plain");
    expect(disposition).toContain("it%27s%20%281%29%2A.txt");
  });
});
