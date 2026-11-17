Labels: help wanted
# A Helm chart for the API, the worker and the web app

The repository runs on Docker Compose only. The API and the worker are stateless and scale independently, which maps
well onto Kubernetes.

**Idea.** A chart with a Deployment per app, a Service and Ingress for the API (WebSocket upgrade, no sticky sessions
needed, see [ADR 0013](../../docs/adr/0013-scale-out-without-sticky-sessions.md)), a Job for migrations, and values for
the external Postgres, Redis and S3-compatible store. Readiness and liveness probes already exist
(`/health/ready`, `/health/live`).

**Done when.** `helm lint` passes in CI and the chart is documented in `docs/`.
