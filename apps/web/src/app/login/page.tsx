import type { Metadata } from "next";

import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Sign in · Dovetalk" };

export default function LoginPage() {
  return (
    <div className="bg-background grid min-h-dvh place-items-center px-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="bg-accent font-display text-accent-foreground grid size-12 place-items-center rounded-2xl text-3xl leading-none font-bold">
            d
          </span>
          <h1 className="font-display text-2xl font-semibold">Welcome to Dovetalk</h1>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
