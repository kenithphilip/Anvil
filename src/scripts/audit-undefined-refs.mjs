// Find runtime ReferenceErrors hidden by `// @ts-nocheck`.
//
// 1. Strips the @ts-nocheck header from every screen file.
// 2. Runs tsc and captures TS2304 ("Cannot find name X") + TS2552
//    ("Cannot find name X. Did you mean Y?"). Both indicate the
//    referenced symbol does NOT exist at runtime.
// 3. Restores the headers so the working tree is unchanged.
// 4. Prints findings grouped by file + name. Exits non-zero if any.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS_DIR = path.join(ROOT, "src", "v3-app", "screens");
const HEADER = "// @ts-nocheck — converted screen, types follow in a focused TS pass";

const screens = fs.readdirSync(SCREENS_DIR).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
const stripped = [];

for (const f of screens) {
  const full = path.join(SCREENS_DIR, f);
  const text = fs.readFileSync(full, "utf8");
  if (text.startsWith(HEADER)) {
    fs.writeFileSync(full, text.slice(HEADER.length).replace(/^\n/, ""));
    stripped.push(f);
  }
}

const tscBin = path.join(ROOT, "node_modules", ".bin", "tsc");
const result = spawnSync(tscBin, ["--noEmit", "-p", "tsconfig.json"], {
  cwd: ROOT,
  encoding: "utf8",
});
const tscOut = (result.stdout || "") + (result.stderr || "");

// Restore headers so the working tree is back to normal.
for (const f of stripped) {
  const full = path.join(SCREENS_DIR, f);
  const text = fs.readFileSync(full, "utf8");
  if (!text.startsWith(HEADER)) fs.writeFileSync(full, HEADER + "\n" + text);
}

const lines = tscOut.split("\n");
const findings = [];
for (const line of lines) {
  const m = line.match(/^src\/v3-app\/screens\/([^(]+)\((\d+),(\d+)\): error (TS2304|TS2552):\s*(.*)$/);
  if (!m) continue;
  findings.push({
    file: m[1],
    line: m[2],
    col: m[3],
    code: m[4],
    msg: m[5],
  });
}

console.log("\nUndefined-reference audit (TS2304 / TS2552 only)");
console.log("─".repeat(70));
const byFile = {};
for (const f of findings) {
  byFile[f.file] = byFile[f.file] || [];
  byFile[f.file].push(f);
}
for (const file of Object.keys(byFile).sort()) {
  console.log(`\n${file}`);
  for (const f of byFile[file]) {
    console.log(`  L${f.line}  ${f.code}: ${f.msg}`);
  }
}
console.log("\n" + "─".repeat(70));
console.log(`${findings.length} finding(s) across ${Object.keys(byFile).length} file(s)`);
if (findings.length > 0) process.exit(1);
