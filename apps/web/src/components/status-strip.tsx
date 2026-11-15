"use client";

import { Plus } from "lucide-react";
import { useMemo } from "react";

import { Avatar } from "@/components/ui/avatar";
import { useMe } from "@/lib/auth/me";
import { useContactsById, useStatuses } from "@/lib/queries/queries";
import { useUi } from "@/lib/stores/ui";
import { firstName } from "@/lib/utils";

export function StatusStrip() {
  const me = useMe();
  const { data: statuses = [] } = useStatuses();
  const contactsById = useContactsById();
  const openDialog = useUi((s) => s.openDialog);
  const openStatus = useUi((s) => s.openStatus);

  const owners = useMemo(() => {
    const byOwner = new Map<string, { unseen: boolean; latest: number }>();
    for (const s of statuses) {
      const cur = byOwner.get(s.ownerId) ?? { unseen: false, latest: 0 };
      byOwner.set(s.ownerId, {
        unseen: cur.unseen || !s.seen,
        latest: Math.max(cur.latest, s.createdAt),
      });
    }
    return [...byOwner.entries()]
      .filter(([id]) => id !== me.id)
      .sort((a, b) => Number(b[1].unseen) - Number(a[1].unseen) || b[1].latest - a[1].latest);
  }, [statuses, me.id]);

  const hasOwn = statuses.some((s) => s.ownerId === me.id);

  return (
    <section aria-label="Status updates" className="px-5 pb-3">
      <div className="scroll-none -mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
        {hasOwn ? (
          <button
            className="flex w-16 shrink-0 flex-col items-center gap-1 rounded-lg"
            onClick={() => openStatus(me.id)}
            type="button"
          >
            <Avatar hue={me.hue} name={me.name} ring="seen" src={me.avatarUrl ?? undefined} />
            <span className="text-muted-foreground w-full truncate text-center text-xs">
              Your status
            </span>
          </button>
        ) : null}

        <button
          className="flex w-16 shrink-0 flex-col items-center gap-1 rounded-lg"
          onClick={() => openDialog("addStatus")}
          type="button"
        >
          <span className="border-border text-muted-foreground hover:border-primary hover:text-primary grid size-[58px] place-items-center rounded-full border-2 border-dashed transition-colors">
            <Plus className="size-5" />
          </span>
          <span className="text-muted-foreground w-full truncate text-center text-xs">
            Add status
          </span>
        </button>

        {owners.map(([id, info]) => {
          const contact = contactsById.get(id);
          if (!contact) {
            return null;
          }
          return (
            <button
              aria-label={`${contact.name}, ${info.unseen ? "new status" : "viewed status"}`}
              className="flex w-16 shrink-0 flex-col items-center gap-1 rounded-lg"
              key={id}
              onClick={() => openStatus(id)}
              type="button"
            >
              <Avatar
                hue={contact.hue}
                name={contact.name}
                ring={info.unseen ? "unseen" : "seen"}
                src={contact.avatarUrl ?? undefined}
              />
              <span className="w-full truncate text-center text-xs">{firstName(contact.name)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
