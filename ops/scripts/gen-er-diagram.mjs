#!/usr/bin/env node
// Prints the Mermaid ER diagram of the database, read from the newest Drizzle snapshot, so the
// diagram in docs/architecture.md is made from the schema and not drawn by hand.
//
//   node ops/scripts/gen-er-diagram.mjs            print the diagram
//   node ops/scripts/gen-er-diagram.mjs --check    exit 1 if docs/architecture.md is out of date
//
// The diagram sits between the two markers below in docs/architecture.md.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const metaDir = join(root, "packages", "db", "drizzle", "meta");
const docPath = join(root, "docs", "architecture.md");
const START = "<!-- er-diagram:start -->";
const END = "<!-- er-diagram:end -->";

const SNAPSHOT_FILE = /^\d{4}_snapshot\.json$/u;
const SCHEMA_PREFIX = /^public\./u;
const PARENTHESES = /\(.*\)/u;
const WHITESPACE = /\s+/gu;
const FENCE_OPEN = /^\s*```mermaid\n/u;
const FENCE_CLOSE = /\n```\s*$/u;

const TYPES = {
  "timestamp with time zone": "timestamptz",
  "character varying": "varchar",
  "double precision": "float8",
};

function latestSnapshot() {
  const names = readdirSync(metaDir)
    .filter((name) => SNAPSHOT_FILE.test(name))
    .sort();
  const newest = names.at(-1);
  if (!newest) {
    throw new Error(`No snapshot in ${metaDir}`);
  }
  return JSON.parse(readFileSync(join(metaDir, newest), "utf8"));
}

function typeOf(column) {
  const base = TYPES[column.type] ?? column.type;
  return base.replace(PARENTHESES, "").replace(WHITESPACE, "_");
}

function keyColumns(table) {
  const primary = new Set(
    Object.values(table.compositePrimaryKeys ?? {}).flatMap((key) => key.columns),
  );
  const unique = new Set(
    Object.values(table.uniqueConstraints ?? {})
      .filter((constraint) => constraint.columns.length === 1)
      .flatMap((constraint) => constraint.columns),
  );
  const foreign = new Set(Object.values(table.foreignKeys ?? {}).flatMap((key) => key.columnsFrom));
  return { primary, unique, foreign };
}

function columnLine(column, { primary, unique, foreign }) {
  const keys = [];
  const isPrimary = column.primaryKey || primary.has(column.name);
  if (isPrimary) {
    keys.push("PK");
  }
  if (foreign.has(column.name)) {
    keys.push("FK");
  }
  if (unique.has(column.name)) {
    keys.push("UK");
  }
  const suffix = keys.length > 0 ? ` ${keys.join(", ")}` : "";
  const note = column.notNull || isPrimary ? "" : ' "nullable"';
  return `    ${typeOf(column)} ${column.name}${suffix}${note}`;
}

function tableBlock(table) {
  const keys = keyColumns(table);
  return [
    `  ${table.name} {`,
    ...Object.values(table.columns).map((column) => columnLine(column, keys)),
    "  }",
  ];
}

function relationLines(tables) {
  const lines = new Set();
  for (const table of tables) {
    for (const key of Object.values(table.foreignKeys ?? {})) {
      const [column] = key.columnsFrom;
      const parent = key.tableTo.replace(SCHEMA_PREFIX, "");
      const optional = table.columns[column]?.notNull === false;
      lines.add(`  ${parent} ${optional ? "|o" : "||"}--o{ ${table.name} : "${column}"`);
    }
  }
  return [...lines];
}

export function buildDiagram(snapshot) {
  const tables = Object.values(snapshot.tables).sort((a, b) => a.name.localeCompare(b.name));
  return ["erDiagram", ...tables.flatMap(tableBlock), ...relationLines(tables)].join("\n");
}

const diagram = buildDiagram(latestSnapshot());

if (process.argv.includes("--check")) {
  const doc = readFileSync(docPath, "utf8");
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1) {
    console.error(`${docPath} has no ${START} / ${END} markers.`);
    process.exit(1);
  }
  const block = doc
    .slice(start + START.length, end)
    .replace(FENCE_OPEN, "")
    .replace(FENCE_CLOSE, "")
    .trim();
  if (block !== diagram) {
    console.error(
      "The ER diagram in docs/architecture.md is out of date. Run:\n" +
        "  node ops/scripts/gen-er-diagram.mjs\n" +
        "and paste the output between the er-diagram markers.",
    );
    process.exit(1);
  }
  console.log("ER diagram is up to date.");
} else {
  console.log(diagram);
}
