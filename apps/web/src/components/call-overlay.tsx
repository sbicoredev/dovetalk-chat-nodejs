"use client";

import { Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react";
import { useEffect, useState } from "react";

import { Avatar } from "@/components/ui/avatar";
import { type CallTarget, useUi } from "@/lib/stores/ui";
import { cn, formatDuration } from "@/lib/utils";

export function CallOverlay() {
  const call = useUi((s) => s.call);
  const endCall = useUi((s) => s.endCall);
  if (!call) {
    return null;
  }
  return <Call onEnd={endCall} target={call} />;
}

function Call({ target, onEnd }: { target: CallTarget; onEnd: () => void }) {
  const [connected, setConnected] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const video = target.mode === "video";

  useEffect(() => {
    const timer = setTimeout(() => setConnected(true), 2000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!connected) {
      return;
    }
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [connected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onEnd();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEnd]);

  return (
    <div
      aria-label={`${video ? "Video" : "Voice"} call with ${target.name}`}
      aria-modal="true"
      className="bg-rail text-rail-foreground animate-fade-in fixed inset-0 z-[70] flex flex-col"
      role="dialog"
    >
      <div className="relative flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        {video ? (
          <div
            aria-hidden="true"
            className="from-primary/60 via-rail to-rail absolute inset-4 rounded-3xl bg-gradient-to-br"
          />
        ) : null}

        <div className="relative">
          {connected ? null : (
            <span
              aria-hidden="true"
              className="animate-ring bg-accent/40 absolute inset-0 rounded-full"
            />
          )}
          <Avatar group={target.group} hue={target.hue} name={target.name} size="xl" />
        </div>

        <div className="relative">
          <h2 className="font-display text-2xl font-semibold">{target.name}</h2>
          <p className="text-rail-foreground/70 mt-1 text-sm tabular-nums" role="status">
            {connected ? formatDuration(seconds) : target.group ? "Ringing the group…" : "Calling…"}
          </p>
        </div>

        {video ? (
          <div className="absolute right-8 bottom-6 grid h-36 w-24 place-items-center rounded-2xl border border-white/15 bg-white/10 text-xs">
            {cameraOff ? "Camera off" : "You"}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col items-center gap-3 pb-8">
        <div className="flex items-center gap-4">
          <button
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={muted}
            className={cn(
              "grid size-14 place-items-center rounded-full transition-colors",
              muted ? "text-rail bg-white" : "bg-white/15 hover:bg-white/25",
            )}
            onClick={() => setMuted((m) => !m)}
            type="button"
          >
            {muted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
          </button>
          {video ? (
            <button
              aria-label={cameraOff ? "Turn camera on" : "Turn camera off"}
              aria-pressed={cameraOff}
              className={cn(
                "grid size-14 place-items-center rounded-full transition-colors",
                cameraOff ? "text-rail bg-white" : "bg-white/15 hover:bg-white/25",
              )}
              onClick={() => setCameraOff((c) => !c)}
              type="button"
            >
              {cameraOff ? <VideoOff className="size-6" /> : <Video className="size-6" />}
            </button>
          ) : null}
          <button
            aria-label="End call"
            autoFocus
            className="bg-danger hover:bg-danger/90 grid size-14 place-items-center rounded-full text-white transition-colors"
            onClick={onEnd}
            type="button"
          >
            <PhoneOff className="size-6" />
          </button>
        </div>
        <p className="text-rail-foreground/60 text-xs">
          This is a demo call. No audio or video leaves your device.
        </p>
      </div>
    </div>
  );
}
