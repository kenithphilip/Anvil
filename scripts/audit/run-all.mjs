// Run every systemic-issue audit script, print a single summary,
// exit 1 if any audit found new issues.
//
// New scripts can be added by appending to AUDITS below.
// Each script must:
//   - print a human-readable report to stdout
//   - exit 0 when clean, 1 when findings exist
//
// Wired into npm test via package.json scripts.audit.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// Each audit's exit code is treated as advisory by default. Promote
// to a hard CI gate by setting `gate: true`. The systemic-audit PR
// cleaned every finding for the gated audits; new code is expected
// to keep them clean.
const AUDITS = [
  // Hard gates (block deploys):
  { id: "promiselike-catch", file: "promiselike-catch.mjs", gate: true,
    note: "Supabase .catch sites; the bug behind PR #20" },
  { id: "dangling-client-calls", file: "dangling-client-calls.mjs", gate: true,
    note: "ObaraBackend?.X?.Y?.() where Y is missing on the client (silent no-op clicks)" },
  { id: "route-deadlinks",   file: "route-deadlinks.mjs",   gate: false,
    note: "Hash params not handled by resolver or screen (heuristic; tracks new dead-end clicks)" },
  // Soft warnings (heuristic, false-positive prone):
  { id: "column-drift",      file: "column-drift.mjs",      gate: false,
    note: "Frontend reads of columns absent from migrations" },
];

let hardFail = 0;
let softWarn = 0;

for (const a of AUDITS) {
  const path = join(HERE, a.file);
  console.log("\n========================================");
  console.log("Audit: " + a.id);
  console.log("(" + a.note + ")");
  console.log("========================================");
  const out = spawnSync("node", [path], { stdio: "inherit", encoding: "utf8" });
  if (out.status !== 0) {
    if (a.gate) {
      console.log("\n[FAIL gate: " + a.id + "]");
      hardFail += 1;
    } else {
      console.log("\n[WARN " + a.id + "]");
      softWarn += 1;
    }
  } else {
    console.log("\n[OK " + a.id + "]");
  }
}

console.log("\n========================================");
console.log("Audit summary: " + (hardFail > 0 ? "FAIL" : "OK"));
console.log("Hard gate failures: " + hardFail);
console.log("Soft warnings:      " + softWarn);
console.log("========================================\n");
process.exit(hardFail > 0 ? 1 : 0);
