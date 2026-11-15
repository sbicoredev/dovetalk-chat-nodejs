import Link from "next/link";

import { Button } from "@/components/ui/button";

export function NotFoundPanel({
  title,
  body,
  href,
  label,
}: {
  title: string;
  body: string;
  href: string;
  label: string;
}) {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-6 text-center">
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{body}</p>
      <Link href={href}>
        <Button variant="primary">{label}</Button>
      </Link>
    </div>
  );
}
