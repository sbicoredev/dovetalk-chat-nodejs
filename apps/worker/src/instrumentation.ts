// Loaded before the app (node --import ./dist/instrumentation.js dist/main.js), because the
// instrumentations work by patching libraries as they are imported. Does nothing, and costs
// nothing, unless an OTLP endpoint is configured: see `telemetryEnabled` in @dovetalk/telemetry.
import { startTelemetry } from "@dovetalk/telemetry/start";

startTelemetry({ serviceName: "dovetalk-worker" });
