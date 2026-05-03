// Audit for hardcoded demo data left over from the legacy concatenated
// build. The static screens-*.jsx files in src/v3/screens/ shipped with
// fake customer names, sample SO/quote numbers, demo dates, etc. The
// converter ported them as-is. We need to find and either remove or
// wire-up every instance.
//
// Patterns we treat as suspicious (deny-list):
//   - Customer names known to be in the legacy demos:
//     "Hyderabad Refractories", "Voestalpine", "Yokoi", "Kumera",
//     "POSCO", "Tata Steel", "JFE", "Maruti", "Hyundai" (when
//     hardcoded inline), etc. Some of these may legitimately appear
//     in inline schema docs / comments. The audit reports each line
//     so a human can triage.
//   - Quote/PO/SPO reference numbers in the legacy format
//     `OIQT??-26-NNNN`, `SPO/JP/26/NNNN`, `PO 2024-NNNN`.
//   - Hardcoded ISO dates like "12 Apr 09:14" or "13 Apr 11:00".
//
// The script does NOT count an instance as a finding if it appears
// inside a comment block. Code-only.
//
// Findings are grouped per file. Exit non-zero if anything matches.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN_DIRS = [
  path.join(ROOT, "src", "v3-app", "screens"),
  path.join(ROOT, "src", "v3-app", "components"),
  path.join(ROOT, "src", "v3-app", "lib"),
];

const DEMO_PATTERNS = [
  // Demo customer names (legacy SO Workspace demo)
  /Hyderabad Refractories/g,
  /Voestalpine Spec/g,
  /Yokoi Manufacturing/g,
  /Kumera/g,
  /POSCO Steel/g,
  // Demo reference numbers
  /OIQT[A-Z]{2}-\d{2}-\d{4}/g,
  /SPO\/[A-Z]{2,3}\/\d{2}\/\d{4}/g,
  /PO 20\d{2}-\d{4}/g,
  // Specific demo timestamps from the legacy thread drawer
  /12 Apr 09:14/g,
  /12 Apr 10:22/g,
  /13 Apr 11:00/g,
  /14 May/g,
];

const LABELS = [
  "demo-customer-Hyderabad",
  "demo-customer-Voestalpine",
  "demo-customer-Yokoi",
  "demo-customer-Kumera",
  "demo-customer-POSCO",
  "demo-quote-ref",
  "demo-spo-ref",
  "demo-po-ref",
  "demo-timestamp",
  "demo-timestamp",
  "demo-timestamp",
  "demo-timestamp",
];

const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/[^\n]*/gm, "");

const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
};

const files = SCAN_DIRS.flatMap(walk);

const findings = [];
for (const f of files) {
  const raw = fs.readFileSync(f, "utf8");
  const code = stripComments(raw);
  for (let i = 0; i < DEMO_PATTERNS.length; i++) {
    const re = DEMO_PATTERNS[i];
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) {
      const lineNo = code.slice(0, m.index).split("\n").length;
      findings.push({
        file: path.relative(ROOT, f),
        kind: LABELS[i],
        line: lineNo,
        match: m[0],
      });
    }
  }
}

console.log("\nHardcoded demo-data audit");
console.log("─".repeat(70));
const grouped = {};
for (const f of findings) {
  grouped[f.file] = grouped[f.file] || [];
  grouped[f.file].push(f);
}
for (const file of Object.keys(grouped).sort()) {
  console.log(`\n${file}`);
  for (const f of grouped[file]) {
    console.log(`  L${String(f.line).padEnd(4)} ${f.kind.padEnd(28)} "${f.match}"`);
  }
}
console.log("\n" + "─".repeat(70));
console.log(`${findings.length} finding(s) across ${Object.keys(grouped).length} file(s)`);
if (findings.length > 0) process.exit(1);
