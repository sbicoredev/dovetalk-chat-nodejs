"use client";

import { useRouter } from "next/navigation";
import { type SyntheticEvent, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isMockApi } from "@/lib/api";
import { errorMessage } from "@/lib/api/errors";
import { PASSWORD_MAX, PASSWORD_MIN, PROFILE_NAME_MAX } from "@/lib/api/types";
import { DEMO_EMAIL, DEMO_PASSWORD } from "@/lib/constants";
import { useGuestLogin, useLogin, useRegister } from "@/lib/queries/auth";
import { cn } from "@/lib/utils";

type Mode = "signin" | "signup";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

interface Fields {
  email: string;
  name: string;
  password: string;
  phone: string;
}

/** What is wrong with a sign-up form, before it is sent. The server checks it all again. */
function signUpProblem({ email, name, password }: Fields): string | null {
  if (!name.trim()) {
    return "Enter your name.";
  }
  if (name.trim().length > PROFILE_NAME_MAX) {
    return `Your name can be at most ${PROFILE_NAME_MAX} characters.`;
  }
  if (!EMAIL_PATTERN.test(email.trim())) {
    return "Enter a valid email address.";
  }
  if (password.length < PASSWORD_MIN) {
    return `Choose a password of at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > PASSWORD_MAX) {
    return `Passwords can be at most ${PASSWORD_MAX} characters.`;
  }
  return null;
}

function Field({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Input id={id} {...props} />
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

export function LoginForm() {
  const router = useRouter();
  const login = useLogin();
  const register = useRegister();
  const guest = useGuestLogin();
  const [mode, setMode] = useState<Mode>("signin");
  const [fields, setFields] = useState<Fields>({
    email: isMockApi ? DEMO_EMAIL : "",
    name: "",
    password: isMockApi ? DEMO_PASSWORD : "",
    phone: "",
  });
  const [problem, setProblem] = useState<string | null>(null);

  const busy = login.isPending || register.isPending || guest.isPending;
  const failure = login.error ?? register.error ?? guest.error;
  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));
  const done = { onSuccess: () => router.replace("/") };

  function switchTo(next: Mode) {
    setMode(next);
    setProblem(null);
    login.reset();
    register.reset();
    guest.reset();
  }

  function submit(e: SyntheticEvent) {
    e.preventDefault();
    setProblem(null);
    if (mode === "signin") {
      login.mutate({ email: fields.email.trim(), password: fields.password }, done);
      return;
    }
    const found = signUpProblem(fields);
    if (found) {
      setProblem(found);
      return;
    }
    register.mutate(
      {
        email: fields.email.trim(),
        password: fields.password,
        name: fields.name.trim(),
        ...(fields.phone.trim() ? { phone: fields.phone.trim() } : {}),
      },
      done,
    );
  }

  const signingUp = mode === "signup";
  const message = problem ?? (failure ? errorMessage(failure) : null);

  return (
    <div className="w-full max-w-sm space-y-5">
      <div
        aria-label="Sign in or create an account"
        className="bg-muted grid grid-cols-2 gap-1 rounded-xl p-1"
        role="tablist"
      >
        {(["signin", "signup"] as const).map((tab) => (
          <button
            aria-selected={mode === tab}
            className={cn(
              "h-9 rounded-[9px] text-sm font-medium transition-colors",
              mode === tab
                ? "bg-surface text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={tab}
            onClick={() => switchTo(tab)}
            role="tab"
            type="button"
          >
            {tab === "signin" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      <form className="space-y-4" noValidate onSubmit={submit}>
        {signingUp ? (
          <Field
            autoComplete="name"
            label="Name"
            maxLength={PROFILE_NAME_MAX}
            onChange={set("name")}
            required
            value={fields.name}
          />
        ) : null}
        <Field
          autoComplete="email"
          label="Email"
          onChange={set("email")}
          required
          type="email"
          value={fields.email}
        />
        <Field
          autoComplete={signingUp ? "new-password" : "current-password"}
          hint={signingUp ? `At least ${PASSWORD_MIN} characters.` : undefined}
          label="Password"
          onChange={set("password")}
          required
          type="password"
          value={fields.password}
        />
        {signingUp ? (
          <Field
            autoComplete="tel"
            hint="Optional. Lets people who know your number find you."
            label="Phone"
            onChange={set("phone")}
            type="tel"
            value={fields.phone}
          />
        ) : null}

        {message ? (
          <p className="text-danger text-sm" role="alert">
            {message}
          </p>
        ) : null}

        <Button className="w-full" disabled={busy} type="submit" variant="primary">
          {signingUp
            ? register.isPending
              ? "Creating your account…"
              : "Create account"
            : login.isPending
              ? "Signing in…"
              : "Sign in"}
        </Button>
      </form>

      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span className="bg-border h-px flex-1" />
        or
        <span className="bg-border h-px flex-1" />
      </div>

      <div className="space-y-2">
        <Button
          className="w-full"
          disabled={busy}
          onClick={() => {
            setProblem(null);
            guest.mutate(undefined, done);
          }}
          variant="accent"
        >
          {guest.isPending ? "Setting up the demo…" : "Try the demo"}
        </Button>
        <p className="text-muted-foreground text-center text-xs">
          {isMockApi
            ? "Demo mode: the demo account is filled in, and everything is stored in this browser."
            : "No sign-up. You get a throwaway account with chats to explore. It is deleted after 24 hours."}
        </p>
      </div>
    </div>
  );
}
