#!/usr/bin/env bash
# Applies the repository settings that live outside git: description, topics and the roadmap issues.
# Needs the GitHub CLI (`gh auth login` first) and the admin right on the repository.
#
#   ops/scripts/github-setup.sh OWNER/dovetalk            show what it would do
#   ops/scripts/github-setup.sh OWNER/dovetalk --apply    do it
#
# The social preview image cannot be set from the CLI: upload docs/assets/social-preview.png in
# Settings > General > Social preview.
set -euo pipefail

repo="${1:?usage: github-setup.sh OWNER/REPO [--apply]}"
apply="${2:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

description="A chat app with a NestJS API, a background worker and a Next.js client: idempotent sends, cursor paging, per-viewer projection, multi-instance realtime and OpenTelemetry."
topics=(nestjs nextjs typescript socket-io websocket postgresql drizzle-orm redis bullmq opentelemetry chat monorepo pnpm)

run() {
  if [ "$apply" = "--apply" ]; then "$@"; else printf 'would run:'; printf ' %q' "$@"; printf '\n'; fi
}

run gh repo edit "$repo" --description "$description"
for topic in "${topics[@]}"; do
  run gh repo edit "$repo" --add-topic "$topic"
done

for label in "good first issue" "help wanted"; do
  run gh label create "$label" --repo "$repo" --force
done

for file in "$root"/.github/roadmap/*.md; do
  title="$(grep -m1 '^# ' "$file" | sed 's/^# //')"
  labels="$(grep -m1 '^Labels: ' "$file" | sed 's/^Labels: //')"
  body="$(grep -v -e '^Labels: ' -e '^# ' "$file" | sed '1{/^$/d}')"
  run gh issue create --repo "$repo" --title "$title" --label "$labels" --body "$body"
done
