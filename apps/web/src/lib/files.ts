const TRAILING_ZERO = /\.0$/u;
const FILE_EXTENSION = /\.[^.]+$/u;
const MAX_IMAGE_INPUT_BYTES = 15_000_000;
const MAX_IMAGE_EDGE = 1200;

export interface PreparedUpload {
  blob: Blob;
  height: number | null;
  name: string;
  width: number | null;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("That image couldn't be processed."))),
      "image/jpeg",
      quality,
    ),
  );
}

async function decodeImage(file: File): Promise<ImageBitmap> {
  if (file.size > MAX_IMAGE_INPUT_BYTES) {
    throw new Error("Images over 15 MB aren't supported. Pick a smaller one.");
  }
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error("That image couldn't be read. Try a JPEG or PNG.");
  }
}

function formatLimit(bytes: number) {
  return `${(bytes / 1_000_000).toFixed(1).replace(TRAILING_ZERO, "")} MB`;
}

/**
 * Gets a picked file ready to upload. Photos are scaled down and saved as JPEG, which keeps
 * uploads small. Other files are sent as they are. Throws a message that is safe to show.
 */
export async function prepareUpload(file: File, limitBytes: number): Promise<PreparedUpload> {
  const isPhoto = file.type.startsWith("image/") && file.type !== "image/svg+xml";

  if (isPhoto) {
    const bitmap = await decodeImage(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("That image couldn't be processed.");
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await toBlob(canvas, 0.82);
    if (blob.size > limitBytes) {
      throw new Error(`Files over ${formatLimit(limitBytes)} aren't supported.`);
    }
    return { blob, name: `${file.name.replace(FILE_EXTENSION, "")}.jpg`, width, height };
  }

  if (file.size > limitBytes) {
    throw new Error(`Files over ${formatLimit(limitBytes)} aren't supported.`);
  }
  return { blob: file, name: file.name, width: null, height: null };
}

/** Crops a picked photo to a centered square and scales it to 256 px for use as an avatar. */
export async function prepareAvatar(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    throw new Error("Pick a JPEG or PNG photo.");
  }
  const bitmap = await decodeImage(file);
  const edge = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("That image couldn't be processed.");
  }
  ctx.drawImage(
    bitmap,
    (bitmap.width - edge) / 2,
    (bitmap.height - edge) / 2,
    edge,
    edge,
    0,
    0,
    256,
    256,
  );
  bitmap.close();
  return toBlob(canvas, 0.85);
}
