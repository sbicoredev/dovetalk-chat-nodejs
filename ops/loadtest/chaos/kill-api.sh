#!/usr/bin/env bash
# Kills one API replica of the Compose `scale` profile without warning (SIGKILL: no graceful
# shutdown, no goodbye to its clients), the way a crashed machine looks.
#
#   ops/loadtest/chaos/kill-api.sh [replica number, default 2]
#
# Pass it to the fan-out test:
#   --chaos-cmd "ops/loadtest/chaos/kill-api.sh 2" --chaos-at 20
#
# Bring the replica back afterwards with:  docker compose --profile scale up -d scale-api
set -euo pipefail
replica="${1:-2}"
project="${COMPOSE_PROJECT_NAME:-dovetalk}"
docker kill --signal SIGKILL "${project}-scale-api-${replica}"
echo "Killed ${project}-scale-api-${replica}."
