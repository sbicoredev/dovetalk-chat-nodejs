let context: AudioContext | null = null;

/** A short two-note chime for incoming messages. Silent if audio is unavailable. */
export function playChime() {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      return;
    }
    context ??= new Ctor();
    const ctx = context;
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
    const start = ctx.currentTime;
    [660, 880].forEach((frequency, i) => {
      const at = start + i * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.08, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.2);
    });
  } catch {
    // Ignore audio errors, the chime is optional.
  }
}
