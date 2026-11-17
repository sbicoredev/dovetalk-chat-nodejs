import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const VM_RSS = /VmRSS:\s+(?<kb>\d+)\s+kB/u;
const DOCKER_MEM = /^(?<amount>[\d.]+)\s*(?<unit>[KMG])i?B/iu;
const UNIT_TO_MB: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024 };

function procMemoryMb(pids: readonly string[]): number {
  let kb = 0;
  for (const pid of pids) {
    const match = VM_RSS.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    kb += match?.groups?.kb ? Number(match.groups.kb) : 0;
  }
  return kb / 1024;
}

function dockerMemoryMb(containers: readonly string[]): number {
  const out = execFileSync(
    "docker",
    ["stats", "--no-stream", "--format", "{{.MemUsage}}", ...containers],
    { encoding: "utf8" },
  );
  let mb = 0;
  for (const line of out.trim().split("\n")) {
    const { amount, unit } = DOCKER_MEM.exec(line)?.groups ?? {};
    mb += amount && unit ? Number(amount) * (UNIT_TO_MB[unit.toUpperCase()] ?? 1) : 0;
  }
  return mb;
}

/**
 * Resident memory of the servers under test, in MB, summed. `spec` says where to look:
 *
 * - `pids:123,456`: read VmRSS from /proc (a stack started without Docker).
 * - `docker:dovetalk-scale-api-1,dovetalk-scale-api-2`: `docker stats` of those containers.
 *
 * Returns null when no spec was given or it cannot be read, so a missing number is reported as
 * missing and not as zero.
 */
export function serverMemoryMb(spec: string | undefined): number | null {
  if (!spec) {
    return null;
  }
  const [kind, rest = ""] = spec.split(":");
  const targets = rest.split(",").filter(Boolean);
  try {
    if (kind === "pids") {
      return procMemoryMb(targets);
    }
    if (kind === "docker") {
      return dockerMemoryMb(targets);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * CPU seconds the servers have used so far, summed, for `pids:` specs (read from /proc, so only for
 * a stack started without Docker). The difference between two readings, divided by the messages
 * sent in between, is the server's CPU cost per message: a number that does not depend on how busy
 * the machine is, which latency does.
 */
export function serverCpuSeconds(spec: string | undefined): number | null {
  if (!spec?.startsWith("pids:")) {
    return null;
  }
  const clockTicksPerSecond = 100;
  try {
    let ticks = 0;
    for (const pid of spec.slice("pids:".length).split(",").filter(Boolean)) {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name is in parentheses and may contain spaces, so count fields after it.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ticks += Number(fields[11]) + Number(fields[12]); // utime, stime
    }
    return ticks / clockTicksPerSecond;
  } catch {
    return null;
  }
}
