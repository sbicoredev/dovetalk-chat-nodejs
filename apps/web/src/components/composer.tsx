"use client";

import {
  Check,
  CornerUpLeft,
  FileText,
  Loader2,
  Mic,
  Paperclip,
  Pencil,
  SendHorizontal,
  Smile,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { uploadLimitBytes } from "@/lib/api";
import { useRealtime } from "@/lib/api/context";
import { errorMessage } from "@/lib/api/errors";
import type { AttachmentDto, ReplyPreview } from "@/lib/api/types";
import { useMe } from "@/lib/auth/me";
import { EMOJI } from "@/lib/constants";
import { prepareUpload } from "@/lib/files";
import { useEditMessage, useSendMessage, useUploadFile } from "@/lib/queries/mutations";
import { notify } from "@/lib/stores/ui";
import { formatBytes, formatDuration } from "@/lib/utils";
import { makeBars } from "@/lib/waveform";

/** What the person is replying to: the preview the server keeps, plus how to show it. */
export interface ReplyDraft {
  label: string;
  preview: ReplyPreview;
  snippet: string;
}
export interface EditDraft {
  allowEmpty: boolean;
  id: string;
  text: string;
}

interface Props {
  chatId: string;
  editing: EditDraft | null;
  onCancelEdit: () => void;
  onCancelReply: () => void;
  reply: ReplyDraft | null;
}

// Grows the box with its content, up to 140 px. Pure, so it lives outside the component.
function resize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

export function Composer({ chatId, reply, onCancelReply, editing, onCancelEdit }: Props) {
  const me = useMe();
  const realtime = useRealtime();
  const send = useSendMessage();
  const edit = useEditMessage();
  const upload = useUploadFile();
  const { enterToSend } = me.preferences;
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<AttachmentDto | null>(null);
  const [preparing, setPreparing] = useState(false);
  const lastTypingSent = useRef(0);
  const typingStop = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!recording) {
      return;
    }
    setSeconds(0);
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  // Entering edit mode fills the box with the message being edited.
  useEffect(() => {
    if (!editing) {
      return;
    }
    setText(editing.text);
    setAttachment(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) {
        return;
      }
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      resize(el);
    });
  }, [editing]);

  useEffect(() => {
    if (reply) {
      inputRef.current?.focus();
    }
  }, [reply]);

  const stopTyping = () => {
    if (typingStop.current) {
      clearTimeout(typingStop.current);
    }
    typingStop.current = null;
    if (lastTypingSent.current) {
      realtime.emit("typing", { chatId, isTyping: false });
    }
    lastTypingSent.current = 0;
  };

  /** Tells the server we're typing, at most every 3 seconds, and again when we stop. */
  const signalTyping = () => {
    const now = Date.now();
    if (now - lastTypingSent.current > 3000) {
      realtime.emit("typing", { chatId, isTyping: true });
      lastTypingSent.current = now;
    }
    if (typingStop.current) {
      clearTimeout(typingStop.current);
    }
    typingStop.current = setTimeout(stopTyping, 4000);
  };

  useEffect(
    () => () => {
      if (typingStop.current) {
        clearTimeout(typingStop.current);
      }
    },
    [],
  );

  const clearBox = () => {
    setText("");
    setAttachment(null);
    setShowEmoji(false);
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  };

  const submit = () => {
    const value = text.trim();
    if (editing) {
      if (!(value || editing.allowEmpty)) {
        return;
      }
      edit.mutate({ chatId, messageId: editing.id, text: value });
      onCancelEdit();
      clearBox();
      return;
    }
    if (preparing) {
      return;
    }
    const base = { chatId, replyTo: reply?.preview ?? null };
    const replyToId = reply?.preview.id;
    if (attachment) {
      send.mutate({
        ...base,
        attachment,
        input: {
          clientId: crypto.randomUUID(),
          kind: attachment.mime.startsWith("image/") ? "image" : "file",
          text: value || undefined,
          attachmentId: attachment.id,
          replyToId,
        },
      });
    } else if (value) {
      send.mutate({
        ...base,
        input: { clientId: crypto.randomUUID(), kind: "text", text: value, replyToId },
      });
    } else {
      return;
    }
    stopTyping();
    onCancelReply();
    clearBox();
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setPreparing(true);
    try {
      const prepared = await prepareUpload(file, uploadLimitBytes);
      const uploaded = await upload.mutateAsync({
        file: prepared.blob,
        name: prepared.name,
        width: prepared.width,
        height: prepared.height,
      });
      setAttachment(uploaded);
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setPreparing(false);
    }
  };

  const cancelEditing = () => {
    onCancelEdit();
    clearBox();
  };

  if (recording) {
    return (
      <div className="border-border bg-surface flex items-center gap-3 border-t px-4 py-3">
        <Button
          aria-label="Cancel recording"
          onClick={() => setRecording(false)}
          size="icon"
          variant="ghost"
        >
          <Trash2 className="size-5" />
        </Button>
        <div className="flex flex-1 items-center gap-3" role="status">
          <span aria-hidden="true" className="bg-danger size-2.5 animate-pulse rounded-full" />
          <span className="text-sm">Recording voice message</span>
          <span className="text-muted-foreground text-sm tabular-nums">
            {formatDuration(seconds)}
          </span>
        </div>
        <Button
          aria-label="Send voice message"
          onClick={() => {
            const duration = Math.max(1, seconds);
            send.mutate({
              chatId,
              replyTo: reply?.preview ?? null,
              input: {
                clientId: crypto.randomUUID(),
                kind: "voice",
                duration,
                bars: makeBars(Math.floor(Math.random() * 1_000_000)),
                replyToId: reply?.preview.id,
              },
            });
            onCancelReply();
            setRecording(false);
          }}
          size="icon"
          variant="primary"
        >
          <Check className="size-5" />
        </Button>
      </div>
    );
  }

  const hasContent = text.trim().length > 0 || !!attachment;
  const canSend = editing ? text.trim().length > 0 || editing.allowEmpty : hasContent;

  return (
    <div className="border-border bg-surface border-t px-4 py-3">
      {editing ? (
        <div className="bg-muted mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-sm">
          <Pencil className="text-muted-foreground size-4 shrink-0" />
          <span className="flex-1 font-medium">Editing message</span>
          <Button
            aria-label="Cancel editing"
            onClick={cancelEditing}
            size="icon-sm"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}

      {reply && !editing ? (
        <div className="border-primary bg-muted dark:border-accent mb-2 flex items-center gap-2 rounded-xl border-l-4 px-3 py-2 text-sm">
          <CornerUpLeft className="text-muted-foreground size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold">Replying to {reply.label}</p>
            <p className="text-muted-foreground truncate">{reply.snippet}</p>
          </div>
          <Button aria-label="Cancel reply" onClick={onCancelReply} size="icon-sm" variant="ghost">
            <X className="size-4" />
          </Button>
        </div>
      ) : null}

      {preparing || attachment ? (
        <div className="bg-muted mb-2 flex items-center gap-3 rounded-xl px-3 py-2 text-sm">
          {preparing ? (
            <>
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
              <span className="flex-1">Preparing attachment…</span>
            </>
          ) : attachment ? (
            <>
              {attachment.mime.startsWith("image/") ? (
                // biome-ignore lint/performance/noImgElement: attachments and profile photos are blob:, data: and presigned URLs that next/image cannot optimise.
                <img
                  alt=""
                  className="size-12 rounded-lg object-cover"
                  height={48}
                  src={attachment.url}
                  width={48}
                />
              ) : (
                <FileText className="text-muted-foreground size-8 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{attachment.name}</p>
                <p className="text-muted-foreground text-xs">{formatBytes(attachment.size)}</p>
              </div>
              <Button
                aria-label="Remove attachment"
                onClick={() => setAttachment(null)}
                size="icon-sm"
                variant="ghost"
              >
                <X className="size-4" />
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      {showEmoji ? (
        <fieldset
          aria-label="Emoji"
          className="bg-muted mb-2 flex min-w-0 flex-wrap gap-1 rounded-xl p-2"
        >
          {EMOJI.map((emoji) => (
            <button
              className="hover:bg-surface grid size-9 place-items-center rounded-lg text-xl transition-colors"
              key={emoji}
              onClick={() => {
                setText((t) => t + emoji);
                inputRef.current?.focus();
              }}
              type="button"
            >
              {emoji}
            </button>
          ))}
        </fieldset>
      ) : null}

      <div className="flex items-end gap-2">
        <Button
          aria-label="Emoji"
          aria-pressed={showEmoji}
          onClick={() => setShowEmoji((v) => !v)}
          size="icon"
          variant="ghost"
        >
          <Smile className="size-5" />
        </Button>
        <input
          aria-label="Choose a file to attach"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void pickFile(file);
          }}
          ref={fileRef}
          type="file"
        />
        <Button
          aria-label="Attach file"
          disabled={!!editing || preparing}
          onClick={() => fileRef.current?.click()}
          size="icon"
          variant="ghost"
        >
          <Paperclip className="size-5" />
        </Button>
        <textarea
          aria-label="Message"
          className="border-border bg-background placeholder:text-muted-foreground max-h-[140px] min-h-10 flex-1 resize-none rounded-[10px] border px-3 py-2 text-[15px] leading-6"
          onChange={(e) => {
            setText(e.target.value);
            resize(e.currentTarget);
            if (!editing && e.target.value.trim()) {
              signalTyping();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (editing) {
                cancelEditing();
              } else if (reply) {
                onCancelReply();
              }
              return;
            }
            if (e.key !== "Enter") {
              return;
            }
            const sendKey = enterToSend ? !e.shiftKey : e.ctrlKey || e.metaKey;
            if (sendKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            attachment
              ? "Add a caption"
              : enterToSend
                ? "Write a message"
                : "Write a message (Ctrl+Enter to send)"
          }
          ref={inputRef}
          rows={1}
          value={text}
        />
        {canSend ? (
          <Button
            aria-label={editing ? "Save edit" : "Send message"}
            onClick={submit}
            size="icon"
            variant="primary"
          >
            {editing ? <Check className="size-5" /> : <SendHorizontal className="size-5" />}
          </Button>
        ) : (
          <Button
            aria-label="Record voice message"
            disabled={!!editing || preparing}
            onClick={() => setRecording(true)}
            size="icon"
            variant="secondary"
          >
            <Mic className="size-5" />
          </Button>
        )}
      </div>
    </div>
  );
}
