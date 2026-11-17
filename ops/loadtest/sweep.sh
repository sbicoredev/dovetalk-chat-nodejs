#!/usr/bin/env bash
# Runs the fan-out test at several message rates and prints one line per rate, so the knee (where
# latency stops being flat) is easy to see. Same options as ws-fanout.ts, minus --rate and --out.
#
#   ops/loadtest/sweep.sh "0.05 0.1 0.2 0.4" --fixture fixture.json --pairs 500 --targets http://a,http://b --duration 20
#
# Results go to $OUT_DIR (default ./results), one JSON file per rate.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
rates="$1"; shift
out_dir="${OUT_DIR:-./results}"
mkdir -p "$out_dir"
printf '%-9s %-9s %-8s %-8s %-8s %-9s %-10s %-6s %-6s\n' "rate/pair" "msg/s" "p50ms" "p95ms" "p99ms" "post-p50" "cpu-ms/msg" "lost" "dup"
for rate in $rates; do
  file="$out_dir/rate-$rate.json"
  node --expose-gc "$here/src/ws-fanout.ts" "$@" --rate "$rate" --out "$file" >"$out_dir/rate-$rate.log" 2>&1 || true
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const l = r.latencyMs.sendToReceive, m = r.messages;
    console.log([String(r.config.ratePerPair).padEnd(9), String(m.throughputPerS).padEnd(9), String(l.p50).padEnd(8), String(l.p95).padEnd(8), String(l.p99).padEnd(8), String(r.latencyMs.postRoundTrip.p50).padEnd(9), String(r.serverCpu ? r.serverCpu.msPerMessage : "-").padEnd(10), String(m.lostAfterResync + m.lostLive).padEnd(6), String(m.duplicates)].join(" "));
  ' "$file"
done
