function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Bar heights (25 to 100) for a voice message waveform. The same seed gives the same bars. */
export function makeBars(seed: number, count = 28) {
  const next = rng(seed);
  return Array.from({ length: count }, () => Math.round(25 + next() * 75));
}

/** A small deterministic random generator, used for demo data. */
export const seededRandom = rng;
