import { readFileSync } from "node:fs";

/**
 * Where does a Node process spend its CPU? Reads `.cpuprofile` files (node --cpu-prof) and prints
 * self time by package and by function, so a bottleneck is a number and not a guess.
 *
 *   node src/profile-summary.ts /tmp/prof/*.cpuprofile
 */

interface Node {
  callFrame: { functionName: string; url: string; lineNumber: number };
  id: number;
}
interface Profile {
  nodes: Node[];
  samples: number[];
  timeDeltas: number[];
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node src/profile-summary.ts profile.cpuprofile...");
  process.exit(2);
}

const byFunction = new Map<string, number>();
const byPackage = new Map<string, number>();
let total = 0;

const NATIVE_NAMES: Record<string, string> = {
  "(garbage collector)": "garbage collector",
  "(idle)": "idle",
};
const WORKSPACE_PATH = /(?<kind>apps|packages)\/(?<name>[^/]+)\//u;

function bucket(url: string, functionName: string): string {
  if (url === "") {
    return NATIVE_NAMES[functionName] ?? "native / V8";
  }
  if (url.startsWith("node:")) {
    return "node internals";
  }
  const modules = url.lastIndexOf("node_modules/");
  if (modules >= 0) {
    const rest = url.slice(modules + "node_modules/".length);
    const parts = rest.split("/");
    return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : (parts[0] ?? "?");
  }
  const workspace = WORKSPACE_PATH.exec(url)?.groups;
  return workspace ? `dovetalk ${workspace.kind}/${workspace.name}` : "other";
}

for (const file of files) {
  const profile = JSON.parse(readFileSync(file, "utf8")) as Profile;
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  for (const [index, id] of profile.samples.entries()) {
    const delta = profile.timeDeltas[index] ?? 0;
    const node = nodes.get(id);
    if (!node) {
      continue;
    }
    const { functionName, url, lineNumber } = node.callFrame;
    const group = bucket(url, functionName);
    if (group === "idle") {
      continue;
    }
    total += delta;
    byPackage.set(group, (byPackage.get(group) ?? 0) + delta);
    const key = `${functionName || "(anonymous)"}  ${url.split("/").slice(-2).join("/")}:${lineNumber + 1}`;
    byFunction.set(key, (byFunction.get(key) ?? 0) + delta);
  }
}

const show = (title: string, map: Map<string, number>, rows: number) => {
  console.log(`\n${title}`);
  for (const [name, time] of [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, rows)) {
    console.log(`${((time / total) * 100).toFixed(1).padStart(5)}%  ${name}`);
  }
};
console.log(
  `Busy CPU time in ${files.length} profile(s): ${(total / 1e6).toFixed(1)} s (idle excluded)`,
);
show("By package", byPackage, 18);
show("By function (self time)", byFunction, 25);
