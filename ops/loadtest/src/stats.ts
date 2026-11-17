/** The p-th percentile (0 to 100) of an ascending-sorted list, by the nearest-rank method. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

export interface Summary {
  count: number;
  max: number;
  mean: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
}

export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? Number.NaN,
    mean: sorted.length === 0 ? Number.NaN : sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? Number.NaN,
  };
}

export const round = (value: number, digits = 1) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
