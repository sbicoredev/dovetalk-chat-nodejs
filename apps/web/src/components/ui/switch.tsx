"use client";

import { Switch as BaseSwitch } from "@base-ui/react/switch";

interface SwitchProps {
  "aria-label"?: string;
  checked: boolean;
  id?: string;
  onCheckedChange: (checked: boolean) => void;
}

export function Switch({ checked, onCheckedChange, id, ...rest }: SwitchProps) {
  return (
    <BaseSwitch.Root
      aria-label={rest["aria-label"]}
      checked={checked}
      className="bg-border data-checked:bg-primary flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150"
      id={id}
      onCheckedChange={onCheckedChange}
    >
      <BaseSwitch.Thumb className="size-5 rounded-full bg-white shadow-sm transition-[translate] duration-150 data-checked:translate-x-4" />
    </BaseSwitch.Root>
  );
}
