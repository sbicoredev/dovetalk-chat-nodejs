"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  Copy,
  CornerUpLeft,
  Download,
  FileText,
  Forward,
  Loader2,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";

import { ImageLightbox } from "@/components/lightbox";
import { Time } from "@/components/time";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import type { ContactDto } from "@/lib/api/types";
import { useMe } from "@/lib/auth/me";
import { REACTIONS } from "@/lib/constants";
import type { ClientMessage } from "@/lib/queries/cache";
import {
  discardMessage,
  useDeleteMessage,
  useSendMessage,
  useToggleReaction,
} from "@/lib/queries/mutations";
import { notify } from "@/lib/stores/ui";
import { cn, firstName, formatBytes, formatDuration, splitMatches } from "@/lib/utils";

export type Quote = { id: string; label: string; snippet: string } | "missing";

interface Props {
  chatId: string;
  firstInRun: boolean;
  /** True briefly after jumping to this message from a reply quote. */
  flash: boolean;
  group: boolean;
  /** Search text to highlight inside this message. */
  highlight: string;
  /** True when this is the search match currently in focus. */
  isCurrentMatch: boolean;
  lastInRun: boolean;
  message: ClientMessage;
  mine: boolean;
  onEdit: (message: ClientMessage) => void;
  onForward: (message: ClientMessage) => void;
  onJumpTo: (messageId: string) => void;
  onReply: (message: ClientMessage) => void;
  quote?: Quote;
  sender?: ContactDto;
}

function Highlighted({
  value,
  query,
  current,
}: {
  value: string;
  query: string;
  current: boolean;
}) {
  return (
    <>
      {splitMatches(value, query).map((part, i) =>
        part.match ? (
          <mark
            className={cn(
              "bg-accent/70 text-accent-foreground rounded px-0.5",
              current && "bg-accent ring-accent ring-2",
            )}
            key={i}
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function MessageBubble(props: Props) {
  const {
    chatId,
    message,
    mine,
    firstInRun,
    lastInRun,
    group,
    sender,
    quote,
    highlight,
    isCurrentMatch,
    flash,
    onReply,
    onEdit,
    onForward,
    onJumpTo,
  } = props;
  const me = useMe();
  const qc = useQueryClient();
  const send = useSendMessage();
  const toggle = useToggleReaction();
  const remove = useDeleteMessage();
  const toggleReaction = (emoji: string) => toggle.mutate({ chatId, messageId: message.id, emoji });
  const copyText = (value: string) => {
    navigator.clipboard.writeText(value).then(
      () => notify("Copied to clipboard"),
      () => notify("Couldn't copy. Select the text and copy it yourself."),
    );
  };

  if (message.kind === "system") {
    return (
      <div className="my-3 flex justify-center" id={`msg-${message.id}`}>
        <span className="bg-muted text-muted-foreground rounded-full px-3 py-1 text-xs">
          {message.text}
        </span>
      </div>
    );
  }

  const { deleted } = message;
  const unsent = !!message.pending || !!message.failed;
  const copyable = !deleted && !!message.text;
  const editable = mine && !deleted && !unsent && message.kind !== "voice";
  const reactions = Object.entries(message.reactions);

  const actions = (
    <Menu>
      <MenuTrigger
        render={
          <button
            aria-label="Message actions"
            className="text-muted-foreground hover:bg-muted grid size-7 shrink-0 place-items-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
            type="button"
          />
        }
      >
        <ChevronDown className="size-4" />
      </MenuTrigger>
      <MenuContent align={mine ? "end" : "start"}>
        {deleted || unsent ? null : (
          <>
            <MenuGroup aria-label="React" className="flex gap-0.5 px-0.5 pb-0.5">
              {REACTIONS.map((emoji) => (
                <MenuItem
                  aria-label={`React with ${emoji}`}
                  className={cn(
                    "size-9 justify-center px-0 py-0 text-lg",
                    message.reactions[emoji]?.includes(me.id) && "bg-muted",
                  )}
                  key={emoji}
                  onClick={() => toggleReaction(emoji)}
                >
                  {emoji}
                </MenuItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
            <MenuItem icon={<CornerUpLeft className="size-4" />} onClick={() => onReply(message)}>
              Reply
            </MenuItem>
            {copyable ? (
              <MenuItem
                icon={<Copy className="size-4" />}
                onClick={() => copyText(message.text ?? "")}
              >
                Copy text
              </MenuItem>
            ) : null}
            <MenuItem icon={<Forward className="size-4" />} onClick={() => onForward(message)}>
              Forward
            </MenuItem>
            {editable ? (
              <MenuItem icon={<Pencil className="size-4" />} onClick={() => onEdit(message)}>
                Edit
              </MenuItem>
            ) : null}
            <MenuSeparator />
          </>
        )}
        {unsent && !message.failed ? null : (
          <MenuItem
            danger
            icon={<Trash2 className="size-4" />}
            onClick={() => {
              if (message.failed && message.clientId) {
                discardMessage(qc, chatId, message.clientId);
                return;
              }
              remove.mutate({ chatId, messageId: message.id, scope: "me" });
              notify("Message deleted for you");
            }}
          >
            {message.failed ? "Discard" : "Delete for me"}
          </MenuItem>
        )}
        {mine && !deleted && !unsent ? (
          <MenuItem
            danger
            icon={<Trash2 className="size-4" />}
            onClick={() => {
              remove.mutate({ chatId, messageId: message.id, scope: "everyone" });
              notify("Message deleted for everyone");
            }}
          >
            Delete for everyone
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  );

  return (
    <div
      className={cn(
        "group flex items-center gap-1",
        mine ? "justify-end" : "justify-start",
        firstInRun ? "mt-3" : "mt-0.5",
        reactions.length > 0 && "mb-2",
      )}
      id={`msg-${message.id}`}
    >
      {mine ? actions : null}

      <div
        className={cn(
          "flex max-w-[82%] flex-col md:max-w-[70%]",
          mine ? "items-end" : "items-start",
        )}
      >
        <div
          className={cn(
            "rounded-[18px] px-3.5 py-2 text-[15px] leading-snug shadow-sm transition-shadow",
            mine ? "bg-primary text-primary-foreground" : "bg-bubble-in text-foreground",
            lastInRun && (mine ? "rounded-br-[5px]" : "rounded-bl-[5px]"),
            flash && "ring-accent ring-2",
          )}
        >
          {group && !mine && firstInRun && sender ? (
            <p
              className="mb-0.5 text-xs font-semibold text-[hsl(var(--h)_55%_36%)] dark:text-[hsl(var(--h)_70%_72%)]"
              style={{ "--h": sender.hue } as CSSProperties}
            >
              {firstName(sender.name)}
            </p>
          ) : null}

          {message.forwarded && !deleted ? (
            <p className="mb-0.5 flex items-center gap-1 text-xs italic opacity-75">
              <Forward className="size-3" />
              Forwarded
            </p>
          ) : null}

          {quote ? (
            quote === "missing" ? (
              <p
                className={cn(
                  "mb-1.5 rounded-lg border-l-4 px-2.5 py-1.5 text-xs italic opacity-80",
                  mine ? "border-white/50 bg-black/15" : "border-border bg-muted",
                )}
              >
                Original message unavailable
              </p>
            ) : (
              <button
                aria-label={`Go to the message from ${quote.label}`}
                className={cn(
                  "mb-1.5 block w-full rounded-lg border-l-4 px-2.5 py-1.5 text-left text-xs",
                  mine
                    ? "border-white/60 bg-black/15"
                    : "border-primary bg-muted dark:border-accent",
                )}
                onClick={() => onJumpTo(quote.id)}
                type="button"
              >
                <span className="block font-semibold">{quote.label}</span>
                <span className="line-clamp-2 opacity-80">{quote.snippet}</span>
              </button>
            )
          ) : null}

          {deleted ? (
            <p className="italic opacity-70">This message was deleted</p>
          ) : message.kind === "voice" ? (
            <VoiceMessage message={message} mine={mine} />
          ) : message.kind === "image" && message.attachment ? (
            <div className="space-y-1.5">
              <ImageLightbox attachment={message.attachment}>
                {/* biome-ignore lint/performance/noImgElement: attachments and profile photos are blob:, data: and presigned URLs that next/image cannot optimise. */}
                <img
                  alt={message.attachment.name}
                  className="max-h-72 w-auto max-w-full object-cover"
                  height={message.attachment.height ?? undefined}
                  src={message.attachment.url}
                  width={message.attachment.width ?? undefined}
                />
              </ImageLightbox>
              {message.text ? (
                <p className="break-words whitespace-pre-wrap">
                  <Highlighted current={isCurrentMatch} query={highlight} value={message.text} />
                </p>
              ) : null}
            </div>
          ) : message.kind === "file" && message.attachment ? (
            <div className="space-y-1.5">
              <div
                className={cn(
                  "flex min-w-[210px] items-center gap-3 rounded-xl p-2.5",
                  mine ? "bg-black/15" : "bg-muted",
                )}
              >
                <FileText className="size-8 shrink-0 opacity-80" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    <Highlighted
                      current={isCurrentMatch}
                      query={highlight}
                      value={message.attachment.name}
                    />
                  </p>
                  <p className="text-xs opacity-75">{formatBytes(message.attachment.size)}</p>
                </div>
                <a
                  aria-label={`Download ${message.attachment.name}`}
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-white/15 transition-colors hover:bg-white/25"
                  download={message.attachment.name}
                  href={message.attachment.url}
                >
                  <Download className="size-4" />
                </a>
              </div>
              {message.text ? (
                <p className="break-words whitespace-pre-wrap">
                  <Highlighted current={isCurrentMatch} query={highlight} value={message.text} />
                </p>
              ) : null}
            </div>
          ) : (
            <p className="break-words whitespace-pre-wrap">
              <Highlighted current={isCurrentMatch} query={highlight} value={message.text ?? ""} />
            </p>
          )}

          <p className="mt-0.5 flex items-center justify-end gap-1.5 text-right text-[11px] tabular-nums opacity-70">
            {message.edited && !deleted ? <span>Edited</span> : null}
            {message.pending ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                Sending
              </span>
            ) : (
              <span>
                <Time ts={message.createdAt} />
              </span>
            )}
          </p>
        </div>

        {message.failed ? (
          <div className="text-danger mt-1 flex items-center gap-2 px-1 text-xs" role="alert">
            <AlertCircle aria-hidden="true" className="size-3.5" />
            <span>Not sent.</span>
            <button
              className="font-semibold underline underline-offset-2"
              onClick={() =>
                message.input &&
                send.mutate({
                  chatId,
                  input: message.input,
                  attachment: message.attachment,
                  replyTo: message.replyTo,
                })
              }
              type="button"
            >
              Retry
            </button>
            <button
              className="font-semibold underline underline-offset-2"
              onClick={() => message.clientId && discardMessage(qc, chatId, message.clientId)}
              type="button"
            >
              Discard
            </button>
          </div>
        ) : null}

        {reactions.length > 0 ? (
          <div className="relative z-10 -mt-1.5 flex flex-wrap gap-1 px-2">
            {reactions.map(([emoji, who]) => {
              const reacted = who.includes(me.id);
              return (
                <button
                  aria-label={`${emoji} from ${who.length} ${who.length === 1 ? "person" : "people"}${reacted ? ", including you" : ""}`}
                  aria-pressed={reacted}
                  className={cn(
                    "bg-surface inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs shadow-sm",
                    reacted ? "border-primary dark:border-accent" : "border-border",
                  )}
                  key={emoji}
                  onClick={() => toggleReaction(emoji)}
                  type="button"
                >
                  <span>{emoji}</span>
                  {who.length > 1 ? <span className="tabular-nums">{who.length}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {mine ? null : actions}
    </div>
  );
}

function VoiceMessage({ message, mine }: { message: ClientMessage; mine: boolean }) {
  const duration = message.duration ?? 1;
  const bars = message.bars ?? [];
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const startedAt = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `elapsed` is read only when playback starts.
  useEffect(() => {
    if (!playing) {
      return;
    }
    startedAt.current = performance.now() - elapsed * 1000;
    const timer = setInterval(() => {
      const next = (performance.now() - startedAt.current) / 1000;
      if (next >= duration) {
        setPlaying(false);
        setElapsed(0);
      } else {
        setElapsed(next);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [playing, duration]);

  const playedBars = Math.floor((elapsed / duration) * bars.length);

  return (
    <div className="flex min-w-[210px] items-center gap-3">
      <button
        aria-label={playing ? "Pause voice message" : "Play voice message"}
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full transition-colors",
          mine
            ? "bg-white/20 hover:bg-white/30"
            : "bg-primary/10 text-primary hover:bg-primary/20 dark:text-foreground dark:bg-white/10",
        )}
        onClick={() => setPlaying((p) => !p)}
        type="button"
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>
      <div aria-hidden="true" className="flex h-7 flex-1 items-center gap-[2px]">
        {bars.map((height, i) => (
          <span
            className={cn(
              "w-[3px] rounded-full bg-current",
              i < playedBars ? "opacity-100" : "opacity-40",
            )}
            key={i}
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
      <span className="w-9 text-xs tabular-nums">
        {formatDuration(playing ? elapsed : duration)}
      </span>
    </div>
  );
}

export function TypingBubble({ name }: { name: string }) {
  return (
    <div aria-label={`${name} is typing`} className="mt-3 flex justify-start" role="status">
      <div className="bg-bubble-in flex items-center gap-1 rounded-[18px] rounded-bl-[5px] px-4 py-3 shadow-sm">
        {[0, 1, 2].map((i) => (
          <span
            className="animate-typing bg-muted-foreground size-1.5 rounded-full"
            key={i}
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
