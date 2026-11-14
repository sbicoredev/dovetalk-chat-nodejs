import { createDatabase } from "./client.js";
import { runMigrations } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const { db, pool, close } = createDatabase({
  url,
  poolMax: 2,
  applicationName: "dovetalk-migrate",
  statementTimeoutMs: 0,
});

try {
  await runMigrations(db, pool);
  console.log("Migrations applied.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await close();
}
