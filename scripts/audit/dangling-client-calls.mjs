// Audit: every `ObaraBackend?.X?.Y?.()` call site in the v3 frontend
// must resolve to a real method exposed by anvil-client.js. Optional
// chaining (`?.`) silently returns `undefined` when a method doesn't
// exist, which manifests as a button click that does nothing.
//
// The recent SO Intake auto-extract bug was an instance of this: the
// frontend called `ObaraBackend?.documents?.extract?.(...)` but the
// client never exposed `extract`, so the call resolved to `undefined`
// and the operator never got auto-population.
//
// This scanner reads the `defineModule` block of `anvil-client.js`
// to learn which (namespace, method) pairs exist, then greps every
// `.tsx` / `.ts` file under `src/v3-app/` for `ObaraBackend?.X?.Y?.(`
// patterns and flags any (X, Y) the client doesn't expose.
//
// Stdout: human report, exit 1 on any finding.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CLIENT = join(ROOT, "src/client/anvil-client.js");
const FRONTEND_DIRS = [
  join(ROOT, "src/v3-app"),
];

// 1. Parse the client's namespace -> method map. The client builds
//    `const orders = { list, get, create, ... }`, sometimes under a
//    different variable name (e.g. `const authMethods = {...}`), and
//    exposes them via a final `return { ..., auth: authMethods }`
//    object literal. We learn the variable -> methods map first,
//    then resolve the public namespace -> variable map from the
//    return statement.
const clientSrc = readFileSync(CLIENT, "utf8");

// Step 1a: variable -> Set(methods).
const varMethods = new Map();
const namespaceDeclRe = /const\s+(\w+)\s*=\s*\{([\s\S]*?)\n\s{2}\};/g;
for (const m of clientSrc.matchAll(namespaceDeclRe)) {
  const varName = m[1];
  const body = m[2];
  const methods = new Set();
  const methodRe = /^\s+(\w+)\s*:\s*(?:async\s*)?\(/gm;
  for (const mm of body.matchAll(methodRe)) {
    methods.add(mm[1]);
  }
  if (methods.size) varMethods.set(varName, methods);
}

// Step 1b: parse the final `const api = { ... }` (or `return { ... }`)
// shape that exposes namespaces. The shape is e.g.:
//   {
//     orders,                  // shorthand: namespace == variable name
//     auth: authMethods,       // aliased
//     tally: tallyExt,
//   }
// Collapse aliases into the public namespace.
const knownMethods = new Map();
// Look for the api object literal. It has the shape `const api = {...};`
// (or `return {...};`) followed by `global.AnvilBackend = api;`.
const apiBlock = clientSrc.match(/const api\s*=\s*\{([\s\S]*?)\n\s{2}\};\s*\n[\s\S]{0,1500}global\.AnvilBackend\s*=\s*api/);
if (apiBlock) {
  const body = apiBlock[1];
  for (const line of body.split("\n")) {
    // shorthand `name,`
    const sh = line.match(/^\s+(\w+)\s*,?\s*$/);
    if (sh) {
      const name = sh[1];
      if (varMethods.has(name)) knownMethods.set(name, varMethods.get(name));
      continue;
    }
    // aliased `name: alias,`
    const al = line.match(/^\s+(\w+)\s*:\s*(\w+)\s*,?\s*$/);
    if (al) {
      const [, publicName, varName] = al;
      if (varMethods.has(varName)) knownMethods.set(publicName, varMethods.get(varName));
    }
  }
}
// Fallback: if we couldn't parse the api block, fall back to using
// every variable as its own namespace.
if (!knownMethods.size) {
  for (const [v, ms] of varMethods.entries()) knownMethods.set(v, ms);
}

// 2. Walk frontend.
const walk = (dir, files = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, files);
    else if (/\.(tsx?|jsx?)$/.test(p) && !/\.test\./.test(p)) files.push(p);
  }
  return files;
};

const files = FRONTEND_DIRS.flatMap((d) => walk(d));

// 3. For each file, find every `ObaraBackend?.X?.Y?.(` site.
//    Same for the `AnvilBackend` alias.
const callRe = /(?:Obara|Anvil)Backend\?\.(\w+)\?\.(\w+)\?\.\(/g;
const findings = []; // {file, line, ns, method, snippet}

for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(callRe)) {
    const [_, ns, method] = m;
    const ok = knownMethods.get(ns)?.has(method);
    if (ok) continue;
    // Skip matches inside a single-line `//` comment or a `/* ... */`
    // block. Doc comments often show example call shapes that would
    // otherwise be flagged as dangling.
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const lineUpToHere = src.slice(lineStart, m.index);
    if (/(^|\s)\/\//.test(lineUpToHere)) continue;
    // Detect block comment by looking at the closest `/*` and `*/`
    // before the match.
    const lastBlockOpen = src.lastIndexOf("/*", m.index);
    const lastBlockClose = src.lastIndexOf("*/", m.index);
    if (lastBlockOpen > lastBlockClose) continue;
    const ln = src.slice(0, m.index).split("\n").length;
    const snippet = src.slice(m.index, m.index + 90).replace(/\s+/g, " ").trim();
    findings.push({ file: f.replace(ROOT + "/", ""), line: ln, ns, method, snippet });
  }
}

// 4. Filter false positives. Three families:
//    a. Methods on namespaces this scanner couldn't see (the
//       namespace is a dynamic property the regex missed). We err on
//       the side of false-positive but list known-OK namespaces.
//    b. Methods that exist as direct top-level fields, not inside a
//       namespace const (rare).
//    c. The `health` namespace is set up via `health: async () => ...`
//       outside a const block.
const KNOWN_TOP_LEVEL = new Set(["health", "isReady", "getConfig", "setConfig", "getSession", "setSession"]);
const filtered = findings.filter((f) => !KNOWN_TOP_LEVEL.has(f.method) || f.ns !== "auth");

if (!filtered.length) {
  console.log("\n## Dangling backend calls: none. Every ObaraBackend?.X?.Y?.() resolves to a real client method.\n");
  process.exit(0);
}

console.log("\n## Dangling backend calls (silent no-op risk):\n");
const byCall = new Map();
for (const f of filtered) {
  const key = f.ns + "." + f.method;
  if (!byCall.has(key)) byCall.set(key, []);
  byCall.get(key).push(f);
}
for (const [call, sites] of [...byCall.entries()].sort()) {
  console.log("  - " + call + "()  " + sites.length + " site" + (sites.length === 1 ? "" : "s"));
  for (const s of sites.slice(0, 3)) {
    console.log("      " + s.file + ":" + s.line);
  }
  if (sites.length > 3) console.log("      ... +" + (sites.length - 3) + " more");
}
console.log("\nKnown namespaces in client:");
for (const [ns, methods] of [...knownMethods.entries()].sort()) {
  console.log("  " + ns + ": " + [...methods].sort().join(", "));
}
process.exit(filtered.length > 0 ? 1 : 0);
