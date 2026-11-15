"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Download, X } from "lucide-react";
import type { ReactNode } from "react";

import type { AttachmentDto } from "@/lib/api/types";
import { formatBytes } from "@/lib/utils";

/** Wraps a thumbnail. Clicking it opens the full image in a viewer. */
export function ImageLightbox({
  attachment,
  children,
}: {
  attachment: AttachmentDto;
  children: ReactNode;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger
        aria-label={`Open photo ${attachment.name}`}
        className="block overflow-hidden rounded-xl"
      >
        {children}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[65] min-h-dvh bg-black/85 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="fixed inset-0 z-[66] flex flex-col items-center justify-center gap-3 p-4 transition-opacity duration-150 outline-none data-ending-style:opacity-0 data-starting-style:opacity-0">
          <Dialog.Title className="sr-only">{attachment.name}</Dialog.Title>
          <Dialog.Description className="sr-only">
            Full-size photo, {formatBytes(attachment.size)}
          </Dialog.Description>
          {/* biome-ignore lint/performance/noImgElement: attachments and profile photos are blob:, data: and presigned URLs that next/image cannot optimise. */}
          {/* biome-ignore lint/correctness/useImageSize: width and height attributes would stop max-h and max-w from keeping the photo's aspect ratio; the size of an upload is not known here. */}
          <img
            alt={attachment.name}
            className="max-h-[80dvh] max-w-full rounded-xl object-contain"
            src={attachment.url}
          />
          <div className="flex items-center gap-2 text-sm text-white">
            <span className="max-w-[50vw] truncate">{attachment.name}</span>
            <a
              className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-white/15 px-3 transition-colors hover:bg-white/25"
              download={attachment.name}
              href={attachment.url}
            >
              <Download className="size-4" />
              Download
            </a>
          </div>
          <Dialog.Close
            aria-label="Close photo"
            className="absolute top-4 right-4 grid size-10 place-items-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
          >
            <X className="size-5" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
