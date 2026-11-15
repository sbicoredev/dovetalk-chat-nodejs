"use client";

import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

export const Menu = BaseMenu.Root;
export const MenuTrigger = BaseMenu.Trigger;
export const MenuGroup = BaseMenu.Group;

export function MenuContent({
  children,
  align = "end",
}: {
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner align={align} className="z-50 outline-none" sideOffset={6}>
        <BaseMenu.Popup className="border-border bg-surface min-w-52 origin-(--transform-origin) rounded-xl border p-1.5 shadow-lg transition-[scale,opacity] duration-100 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="bg-border -mx-1.5 my-1.5 h-px" />;
}

export function MenuItem({
  icon,
  danger,
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof BaseMenu.Item> & {
  icon?: ReactNode;
  danger?: boolean;
}) {
  return (
    <BaseMenu.Item
      className={cn(
        "data-highlighted:bg-muted flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none",
        danger && "text-danger",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </BaseMenu.Item>
  );
}
