# Roadmap

What is not built, and where a contributor could start. Each item has an issue draft in
[`.github/roadmap`](../.github/roadmap); `ops/scripts/github-setup.sh` creates them as GitHub issues, with the
`good first issue` and `help wanted` labels.

| Item                                                                                       | Label             |
| ------------------------------------------------------------------------------------------ | ----------------- |
| [Link a ghost contact to a user who registers later](../.github/roadmap/01-link-ghost-contacts.md) | help wanted       |
| [Search a chat's full history](../.github/roadmap/02-message-search.md)                    | help wanted       |
| [End every tab's session at once on sign-out](../.github/roadmap/03-sign-out-all-tabs.md)  | good first issue  |
| [Read receipts](../.github/roadmap/04-read-receipts.md)                                    | help wanted       |
| [Web push notifications](../.github/roadmap/05-web-push.md)                                | help wanted       |
| [A Helm chart](../.github/roadmap/06-helm-chart.md)                                        | help wanted       |
| [Try `bullmq-otel` for job spans](../.github/roadmap/07-bullmq-otel.md)                    | good first issue  |
| [Turn the web app's lint rules back on](../.github/roadmap/08-refactor-web-ui.md)         | good first issue  |

## Next steps for the project itself

- **A hosted demo.** The repository runs locally and in Compose. Nothing is deployed yet. The planned shape (web on
  a static host, the API and worker as always-on services, managed Postgres, Redis and object storage, telemetry to a
  hosted Grafana) is drawn in [architecture.md](architecture.md). Hosts, plans and prices have to be checked when it
  is done, because free tiers change and BullMQ's polling does not suit pay-per-request Redis plans.
- **Grafana screenshots.** The dashboards are in git and generated, but nobody has run the stack with traffic and
  captured them. [observability.md](observability.md) says what to capture.
- **The fan-out change.** [scaling.md](scaling.md) names the larger edit to `RealtimeEvents` that the load tests
  point at, and was not made.
- **Things the contract leaves out:** a leave-group endpoint, and socket events for blocking, renaming and deleting
  a contact ([edge cases](edge-cases.md)).
