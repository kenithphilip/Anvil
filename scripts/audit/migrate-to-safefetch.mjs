// One-shot migration: every `await fetch(` callsite under src/api
// becomes `await safeFetch(`, with a corresponding import added.
//
// Excludes:
//   - src/api/_lib/safe-fetch.js (the helper itself uses fetch)
//   - any file already using safeFetch (idempotent)

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "src/api");
const HELPER = join(API_DIR, "_lib/safe-fetch.js");

const computeImportPath = (fromFile) => {
  // Compute relative path from `fromFile` to safe-fetch.js, with .js
  // suffix and "./" prefix when in same dir.
  const rel = relative(dirname(fromFile), HELPER).replace(/\\/g, "/");
  return rel.startsWith(".") ? rel : "./" + rel;
};

const visit = (dir, files) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) visit(p, files);
    else if (p.endsWith(".js")) files.push(p);
  }
};

const files = [];
visit(API_DIR, files);

let touched = 0;
for (const f of files) {
  if (f === HELPER) continue;
  let src = readFileSync(f, "utf8");
  if (!/await\s+fetch\(/.test(src)) continue;
  if (src.includes("safeFetch")) {
    // Already partially migrated; convert remaining fetch calls but
    // skip the import (already there).
    const before = src;
    src = src.replace(/await\s+fetch\(/g, "await safeFetch(");
    if (before !== src) {
      writeFileSync(f, src, "utf8");
      touched += 1;
      console.log("partial: " + f.replace(ROOT + "/", ""));
    }
    continue;
  }
  // Add import. Find the last existing `^import ... from ...;` line.
  const lines = src.split("\n");
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\b.+from\s+["'].+["'];?\s*$/.test(lines[i])) lastImportIdx = i;
    else if (lastImportIdx >= 0 && !/^\s*(\/\/|\*|\/\*|$)/.test(lines[i])) break;
  }
  const importLine = 'import { safeFetch } from "' + computeImportPath(f) + '";';
  if (lastImportIdx >= 0) {
    lines.splice(lastImportIdx + 1, 0, importLine);
  } else {
    // No existing imports; prepend.
    lines.unshift(importLine);
  }
  src = lines.join("\n");
  src = src.replace(/await\s+fetch\(/g, "await safeFetch(");
  writeFileSync(f, src, "utf8");
  touched += 1;
  console.log("migrated: " + f.replace(ROOT + "/", ""));
}

console.log("\n" + touched + " files updated.");
