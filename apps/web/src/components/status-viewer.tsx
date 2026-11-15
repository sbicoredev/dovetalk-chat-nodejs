"use client";

import { Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Avatar } from "@/components/ui/avatar";
import { useMe } from "@/lib/auth/me";
import { STATUS_COLORS } from "@/lib/constants";
import { useNow } from "@/lib/hooks/use-now";
import { useDeleteStatus, useMarkStatusSeen } from "@/lib/queries/mutations";
import { useContactsById, useStatuses } from "@/lib/queries/queries";
import { notify, useUi } from "@/lib/stores/ui";
import { cn, formatAgo } from "@/lib/utils";

export function StatusViewer() {
  const statusOwner = useUi((s) => s.statusOwner);
  const closeStatus = useUi((s) => s.closeStatus);
  if (!statusOwner) {
    return null;
  }
  return <Viewer key={statusOwner} onClose={closeStatus} owner={statusOwner} />;
}

function Viewer({ owner, onClose }: { owner: string; onClose: () => void }) {
  const me = useMe();
  const now = useNow();
  const contactsById = useContactsById();
  const { data: statuses = [] } = useStatuses();
  const markSeen = useMarkStatusSeen();
  const deleteStatus = useDeleteStatus();
  const list = statuses
    .filter((s) => s.ownerId === owner)
    .sort((a, b) => a.createdAt - b.createdAt);
  const mine = owner === me.id;
  const [index, setIndex] = useState(0);
  const current = list[index];

  const contact = mine ? null : contactsById.get(owner);
  const name = mine ? "Your status" : (contact?.name ?? "Unknown contact");
  const hue = mine ? me.hue : (contact?.hue ?? 220);
  const photo = (mine ? me.avatarUrl : contact?.avatarUrl) ?? undefined;

  const removeCurrent = () => {
    if (!current) {
      return;
    }
    const remaining = list.length - 1;
    deleteStatus.mutate(current.id);
    notify("Status deleted");
    if (remaining === 0) {
      onClose();
    } else {
      setIndex(Math.min(index, remaining - 1));
    }
  };

  const next = () => (index < list.length - 1 ? setIndex(index + 1) : onClose());
  const prev = () => setIndex(Math.max(0, index - 1));

  // biome-ignore lint/correctness/useExhaustiveDependencies: closes only when the current status goes away; onClose is a new function on every render.
  useEffect(() => {
    if (!current) {
      onClose();
    }
  }, [current]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: marks a status seen once per status id; the other values it reads change after the mutation.
  useEffect(() => {
    if (current && !current.seen && !mine) {
      markSeen.mutate(current.id);
    }
  }, [current?.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the 5 s timer restarts when the index or the list length changes; next is a new function on every render.
  useEffect(() => {
    const timer = setTimeout(next, 5000);
    return () => clearTimeout(timer);
  }, [index, list.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the key handler is re-bound when the index or the list length changes; next, prev and onClose are new functions on every render.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
      if (e.key === "ArrowRight") {
        next();
      }
      if (e.key === "ArrowLeft") {
        prev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, list.length]);

  if (!current) {
    return null;
  }
  const palette = STATUS_COLORS[current.color] ?? STATUS_COLORS[0];

  return (
    <div className="animate-fade-in fixed inset-0 z-[60] grid place-items-center bg-black/80 p-4">
      <button
        aria-hidden="true"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <div
        aria-label={`Status from ${name}`}
        aria-modal="true"
        className="relative aspect-[9/16] max-h-[92dvh] w-full max-w-sm overflow-hidden rounded-3xl shadow-2xl"
        role="dialog"
        style={{ background: palette.bg, color: palette.fg }}
      >
        <div className="absolute inset-x-0 top-0 z-10 p-3">
          <div aria-hidden="true" className="flex gap-1">
            {list.map((s, i) => (
              <span className="relative h-[3px] flex-1 overflow-hidden rounded-full" key={s.id}>
                <span className="absolute inset-0 bg-current opacity-25" />
                <span
                  className={cn(
                    "relative block h-full bg-current",
                    i < index && "w-full",
                    i === index && "animate-story",
                    i > index && "w-0",
                  )}
                  key={i === index ? current.id : s.id}
                />
              </span>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2.5">
            <Avatar hue={hue} name={name} size="sm" src={photo} />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="font-display truncate text-sm font-semibold">{name}</p>
              <p className="text-xs opacity-80">{formatAgo(current.createdAt, now)}</p>
            </div>
            {mine ? (
              <button
                aria-label="Delete this status"
                className="relative z-10 grid size-9 place-items-center rounded-full hover:bg-black/10"
                onClick={removeCurrent}
                type="button"
              >
                <Trash2 className="size-5" />
              </button>
            ) : null}
            <button
              aria-label="Close status"
              autoFocus
              className="grid size-9 place-items-center rounded-full hover:bg-black/10"
              onClick={onClose}
              type="button"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        <button
          aria-label="Previous status"
          className="absolute inset-y-0 left-0 z-[5] w-1/3"
          onClick={prev}
          type="button"
        />
        <button
          aria-label="Next status"
          className="absolute inset-y-0 right-0 z-[5] w-2/3"
          onClick={next}
          type="button"
        />

        <p className="font-display grid h-full place-items-center px-8 text-center text-3xl leading-tight font-semibold [text-wrap:balance]">
          {current.text}
        </p>
      </div>
    </div>
  );
}
