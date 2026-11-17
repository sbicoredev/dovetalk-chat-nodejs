#!/usr/bin/env node
// Parses every ```mermaid block in README.md and docs/**/*.md with Mermaid's own parser, so a
// syntax error fails CI instead of showing up as a red box on GitHub.
//
//   node ops/scripts/check-mermaid.mjs
//
// This checks syntax. It does not draw the diagram, so layout problems are not caught.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Mermaid sanitises with DOMPurify, which wants a DOM even when only parsing.
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const { default: mermaid } = await import("mermaid");
mermaid.initialize({ startOnLoad: false });

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) {
      return [];
    }
    if (statSync(path).isDirectory()) {
      return markdownFiles(path);
    }
    return path.endsWith(".md") ? [path] : [];
  });
}

const files = [join(root, "README.md"), ...markdownFiles(join(root, "docs"))];
const fence = /^```mermaid\n(?<source>[\s\S]*?)^```/gmu;

const diagrams = files.flatMap((file) => {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(fence)].map((match) => ({
    where: `${relative(root, file)}:${text.slice(0, match.index).split("\n").length}`,
    source: match.groups.source,
  }));
});

const results = await Promise.all(
  diagrams.map(async ({ where, source }) => {
    try {
      await mermaid.parse(source);
      return null;
    } catch (error) {
      return `${where}: ${String(error.message).split("\n")[0]}`;
    }
  }),
);
const failures = results.filter((result) => result !== null);
for (const failure of failures) {
  console.error(failure);
}
const checked = diagrams.length;
const failed = failures.length;

console.log(`${checked} Mermaid diagrams checked, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
