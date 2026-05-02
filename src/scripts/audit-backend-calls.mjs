// Verify every `ObaraBackend.<ns>.<method>` call site in the converted
// screens corresponds to a real method on the legacy obara-client.
//
// The Vite ObaraBackend Proxy returns undefined for missing methods, so
// optional-chained calls silently no-op. That's safe but it means a
// typo in a method name produces a button that does nothing rather than
// a runtime error. This audit catches those silent dead clicks.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS = path.join(ROOT, "src", "v3-app", "screens");
const CLIENT = path.join(ROOT, "src", "client", "obara-client.js");

const clientText = fs.readFileSync(CLIENT, "utf8");

// Top-level namespaces in the legacy IIFE: each is `const X = { ... };`
// followed eventually by an `api = { X, ... }` aggregate. We scan every
// const-of-object-literal and collect its method names.
const namespaces = {};
let depth = 0;
let cur = null;
const lines = clientText.split("\n");
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const open = line.match(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/);
  if (open && depth === 0) {
    cur = open[1];
    namespaces[cur] = namespaces[cur] || new Set();
    depth = 1;
    continue;
  }
  if (depth > 0) {
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { cur = null; break; }
      }
    }
    if (cur && depth >= 1) {
      // Method shorthand: `methodName: ` or `methodName(`
      for (const m of line.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[:(]/g)) {
        namespaces[cur].add(m[1]);
      }
    }
  }
}

// The legacy file ends with `const api = { customers, orders, ... }`.
// Extract the property->aliasNamespace map. Most are 1:1 (key === ns
// name). A few rename the namespace (e.g. `eval: evalExt`).
const apiBlockMatch = clientText.match(/const\s+api\s*=\s*\{([\s\S]*?)\}\s*;\s*\n\s*global\.ObaraBackend/);
const apiAliases = {}; // public namespace key -> internal const name
if (apiBlockMatch) {
  const inner = apiBlockMatch[1];
  for (const part of inner.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?$/);
    if (m) apiAliases[m[1]] = m[2] || m[1];
  }
}

// Resolve `ObaraBackend.<key>.<method>` -> `<aliasedNamespace>.<method>`.
const resolveMethod = (nsKey, method) => {
  const internalNs = apiAliases[nsKey];
  if (!internalNs) return false;
  const methods = namespaces[internalNs];
  if (!methods) return false;
  return methods.has(method);
};

const screens = fs.readdirSync(SCREENS).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));

// Look for `A || B`-style fallback patterns where the call expression
// uses a method that may not exist but the screen falls back to one
// that does. The audit treats those as intentional and quiet.
const isInFallbackChain = (text, idx) => {
  // Walk back from idx looking for an unmatched `(` that opens `||` /
  // `??` chain context. Heuristic but precise enough.
  const slice = text.slice(Math.max(0, idx - 200), idx);
  return /\|\||\?\?/.test(slice);
};

const findings = [];
for (const f of screens) {
  const text = fs.readFileSync(path.join(SCREENS, f), "utf8");
  // Match ObaraBackend?.ns?.method?. or ObaraBackend.ns.method
  const re = /ObaraBackend(?:\?)?\.\s*([A-Za-z_$][\w$]*)\s*(?:\?)?\s*\.\s*([A-Za-z_$][\w$]*)/g;
  for (const m of text.matchAll(re)) {
    const [, ns, method] = m;
    if (resolveMethod(ns, method)) continue;
    // Skip if the method is part of a `||` / `??` fallback chain.
    if (isInFallbackChain(text, m.index)) continue;
    findings.push({ file: f, ns, method });
  }
}

const seen = new Set();
const unique = findings.filter((f) => {
  const key = `${f.file}|${f.ns}.${f.method}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

console.log("\nObaraBackend method audit");
console.log("─".repeat(70));
console.log(`Known top-level namespaces: ${Object.keys(apiAliases).sort().join(", ")}`);
console.log("─".repeat(70));
const byFile = {};
for (const f of unique) {
  byFile[f.file] = byFile[f.file] || [];
  byFile[f.file].push(f);
}
let total = 0;
for (const file of Object.keys(byFile).sort()) {
  console.log(`\n${file}`);
  for (const f of byFile[file]) {
    console.log(`  ObaraBackend.${f.ns}.${f.method}() — namespace or method missing`);
    total++;
  }
}
console.log("\n" + "─".repeat(70));
console.log(`${total} likely-dead call(s) across ${Object.keys(byFile).length} file(s)`);
if (total > 0) process.exit(1);
