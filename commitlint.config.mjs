export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      ["web", "api", "worker", "core", "db", "contracts", "telemetry", "ops", "docs", "ci", "deps"],
    ],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
