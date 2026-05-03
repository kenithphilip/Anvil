// For each screen with `// @ts-nocheck`, temporarily strip the header,
// run tsc, count errors, restore. Used to triage which screens are
// already close to clean and which need the most work.
//
// Output: sorted list, fewest errors first.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS = path.join(ROOT, "src", "v3-app", "screens");
const HEADER = "// @ts-nocheck — converted screen, types follow in a focused TS pass";

const screens = fs.readdirSync(SCREENS).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));

const results = [];

const tscBin = path.join(ROOT, "node_modules", ".bin", "tsc");

for (const f of screens) {
  const full = path.join(SCREENS, f);
  const original = fs.readFileSync(full, "utf8");
  const stripped = original.startsWith(HEADER)
    ? original.slice(HEADER.length).replace(/^\n/, "")
    : original;
  fs.writeFileSync(full, stripped);

  const r = spawnSync(tscBin, ["--noEmit", "-p", "tsconfig.json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const fileErrors = out
    .split("\n")
    .filter((l) => l.startsWith(`src/v3-app/screens/${f}`))
    .length;

  fs.writeFileSync(full, original);
  results.push({ file: f, errors: fileErrors });
  process.stdout.write(`${f}: ${fileErrors}\n`);
}

results.sort((a, b) => a.errors - b.errors);

console.log("\nPer-screen tsc error count (fewest first)");
console.log("─".repeat(60));
for (const r of results) {
  console.log(`  ${r.file.padEnd(28)} ${r.errors}`);
}
const cleanCount = results.filter((r) => r.errors === 0).length;
console.log(`\n${cleanCount} screen(s) already pass strict typecheck`);
