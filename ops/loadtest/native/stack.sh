#!/usr/bin/env bash
# Starts the scale-out stack WITHOUT Docker, for machines that have Postgres and Redis but no
# container runtime: N API instances, M workers and a load balancer in front. The Compose `scale`
# profile is the real thing (nginx, containers); this runs the same built code in plain processes.
#
#   ops/loadtest/native/stack.sh up      start (needs `pnpm build` first, Postgres and Redis running)
#   ops/loadtest/native/stack.sh down    stop everything it started
#   ops/loadtest/native/stack.sh status  show the processes
#   ops/loadtest/native/stack.sh kill-api 2   SIGKILL API instance 2 (the chaos test uses this)
#
# Settings (environment): API_INSTANCES=3 WORKERS=2 API_BASE_PORT=3101 LB_PORT=8080 NODE=node
#   DATABASE_URL REDIS_URL DATABASE_POOL_MAX, STATE_DIR (pids and logs), API_NODE_ARGS (extra node flags
#   for the API, for example --cpu-prof --cpu-prof-dir=/tmp/prof).
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
state="${STATE_DIR:-$root/.loadtest}"
node_bin="${NODE:-node}"
instances="${API_INSTANCES:-3}"
workers="${WORKERS:-2}"
base_port="${API_BASE_PORT:-3101}"
lb_port="${LB_PORT:-8080}"

export DATABASE_URL="${DATABASE_URL:-postgres://dovetalk:dovetalk@localhost:5432/dovetalk}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379/0}"

common_env() {
  export NODE_ENV=production LOG_LEVEL="${LOG_LEVEL:-warn}" JWT_SECRET="${JWT_SECRET:-load-test-secret-load-test-secret-0000}"
  export DATABASE_POOL_MAX="${DATABASE_POOL_MAX:-10}" QUEUE_PREFIX="${QUEUE_PREFIX:-dovetalk}"
  # No object storage is needed to send messages: nothing here uploads a file.
  export S3_ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:8333}" S3_REGION=us-east-1 S3_BUCKET=dovetalk
  export S3_ACCESS_KEY_ID=dovetalk S3_SECRET_ACCESS_KEY=dovetalk-secret S3_FORCE_PATH_STYLE=true S3_CREATE_BUCKET=false
  # A load test signs up thousands of people from one address.
  export RATE_LIMIT_GLOBAL=10000000 RATE_LIMIT_LOGIN_IP=10000000 RATE_LIMIT_LOGIN_EMAIL=10000000
  export RATE_LIMIT_REGISTER=10000000 RATE_LIMIT_GUEST=10000000 RATE_LIMIT_REFRESH=10000000
}

up() {
  mkdir -p "$state"
  common_env
  # Each process is started by a subshell that `exec`s into node, so the pid written down is
  # node's own, and killing it (the chaos test) kills the server and nothing else.
  for i in $(seq 1 "$instances"); do
    (cd "$root/apps/api" && PORT=$((base_port + i - 1)) HOST=127.0.0.1 TRUST_PROXY=1 \
      exec "$node_bin" ${API_NODE_ARGS:-} --import ./dist/instrumentation.js dist/main.js) >"$state/api-$i.log" 2>&1 </dev/null &
    echo $! >"$state/api-$i.pid"
  done
  for i in $(seq 1 "$workers"); do
    (cd "$root/apps/worker" && WORKER_HEALTH_HOST=127.0.0.1 WORKER_HEALTH_PORT=$((3200 + i)) \
      exec "$node_bin" --import ./dist/instrumentation.js dist/main.js) >"$state/worker-$i.log" 2>&1 </dev/null &
    echo $! >"$state/worker-$i.pid"
  done
  upstreams=""
  for i in $(seq 1 "$instances"); do upstreams="$upstreams,127.0.0.1:$((base_port + i - 1))"; done
  (cd "$root/ops/loadtest" && exec "$node_bin" native/lb.ts --listen "$lb_port" --upstreams "${upstreams#,}") \
    >"$state/lb.log" 2>&1 </dev/null &
  echo $! >"$state/lb.pid"
  for i in $(seq 1 "$instances"); do
    for _ in $(seq 1 60); do
      if curl -fsS "http://127.0.0.1:$((base_port + i - 1))/health/ready" >/dev/null 2>&1; then break; fi
      sleep 1
    done
    curl -fsS "http://127.0.0.1:$((base_port + i - 1))/health/ready" >/dev/null || { echo "api $i did not become ready, see $state/api-$i.log"; exit 1; }
  done
  echo "Up: $instances API instances on $base_port.., $workers workers, load balancer on $lb_port. Logs and pids in $state."
}

down() {
  for pidfile in "$state"/*.pid; do
    [ -e "$pidfile" ] || continue
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  done
  echo "Stopped."
}

status() {
  for pidfile in "$state"/*.pid; do
    [ -e "$pidfile" ] || continue
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then echo "$(basename "$pidfile" .pid) pid $pid"; else echo "$(basename "$pidfile" .pid) pid $pid (gone)"; fi
  done
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  kill-api) kill -9 "$(cat "$state/api-${2:?which instance, 1..N}.pid")" && echo "Killed API instance $2." ;;
  pids) cat "$state"/api-*.pid | paste -sd, - ;;
  *) echo "usage: $0 up|down|status|kill-api N|pids" >&2; exit 2 ;;
esac
