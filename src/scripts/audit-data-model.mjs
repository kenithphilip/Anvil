// Audit form field -> API payload alignment.
//
// For each src/v3-app/screens/*.tsx that constructs a payload object
// passed to ObaraBackend.X.Y(payload), we extract the keys of that
// object literal and compare them against the keys the API handler
// actually reads.
//
// API handlers under api/ deconstruct request bodies via
// `body.fieldName`. We grep each handler for those reads and build a
// {endpoint -> Set<field>} table. Then for each call site in screens,
// we report any payload keys that DON'T appear in the handler. Those
// are silently-dropped fields, not crashing bugs but real data leaks.
//
// Note this is a heuristic: the API handler may also pull keys via
// destructuring (`const { foo } = body`) which we DO catch, or via a
// looser passthrough (e.g. `Object.assign(...)`) which we don't. If a
// finding is a false positive, add the call site to the allowlist
// below.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const API = path.join(ROOT, "src", "api");
const SCREENS = path.join(ROOT, "src", "v3-app", "screens");

const walk = (dir) => {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

// Build {handlerPath -> Set<field>} by inspecting each api/**.js file.
const apiFiles = walk(API).filter((f) => f.endsWith(".js"));
const handlerFields = new Map();
for (const f of apiFiles) {
  const text = fs.readFileSync(f, "utf8");
  const fields = new Set();
  // body.foo / body?.foo
  for (const m of text.matchAll(/body(?:\?)?\.([A-Za-z_$][\w$]*)/g)) fields.add(m[1]);
  // const { foo, bar = X } = body
  for (const m of text.matchAll(/const\s*\{\s*([^{}]+)\s*\}\s*=\s*body\b/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[\s=:]/)[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) fields.add(name);
    }
  }
  // const { foo } = req.body
  for (const m of text.matchAll(/const\s*\{\s*([^{}]+)\s*\}\s*=\s*req\.body\b/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[\s=:]/)[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) fields.add(name);
    }
  }
  // body.bulk_seed special case (api/service/amc.js)
  for (const m of text.matchAll(/body\.([A-Za-z_$][\w$]*)/g)) fields.add(m[1]);
  // bulk_seed.<field>
  for (const m of text.matchAll(/body\.bulk_seed\?\.([A-Za-z_$][\w$]*)/g)) fields.add(m[1]);
  handlerFields.set(path.relative(ROOT, f), fields);
}

// Convert "/api/orders" REST path back to the file under src/api/.
// Legacy client uses paths like `/api/sales/shipments`. We expect
// `src/api/sales/shipments.js` or `src/api/sales/shipments/index.js`.
// Suffix match against handlerFields' keys is tolerant to whichever
// directory layout the handlers live in.
const findHandlerByPath = (apiPath) => {
  const base = apiPath.replace(/^\//, "").split("?")[0];
  const candidates = [
    `${base}.js`,
    `${base}/index.js`,
  ];
  for (const c of candidates) {
    for (const key of handlerFields.keys()) {
      if (key.endsWith(c)) return key;
    }
  }
  // Try without trailing dynamic segment
  const trimmed = base.replace(/\/[^/]+$/, "");
  for (const c of [`${trimmed}.js`, `${trimmed}/index.js`]) {
    for (const key of handlerFields.keys()) {
      if (key.endsWith(c)) return key;
    }
  }
  return null;
};

// Pull the entire src/client/anvil-client.js so we can map a method
// reference back to its REST path.
const clientText = fs.readFileSync(path.join(ROOT, "src", "client", "anvil-client.js"), "utf8");
// Build {nsKey.method -> apiPath} by parsing the const-of-object-literal blocks.
const methodToPath = new Map();
{
  let depth = 0;
  let curNs = null;
  for (const line of clientText.split("\n")) {
    const open = line.match(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/);
    if (open && depth === 0) {
      curNs = open[1];
      depth = 1;
      continue;
    }
    if (depth > 0) {
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { curNs = null; break; }
        }
      }
      if (curNs && depth >= 1) {
        const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*async[^"'`]*["'`]([^"'`]+)["'`]/);
        if (m) {
          methodToPath.set(`${curNs}.${m[1]}`, m[2]);
        }
      }
    }
  }
}

// Build the alias map (apiAliases) like in audit-backend-calls.mjs.
const apiBlockMatch = clientText.match(/const\s+api\s*=\s*\{([\s\S]*?)\}\s*;\s*\n\s*global\.ObaraBackend/);
const apiAliases = {};
if (apiBlockMatch) {
  for (const part of apiBlockMatch[1].split(",")) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?$/);
    if (m) apiAliases[m[1]] = m[2] || m[1];
  }
}

// For each screen, find every `ObaraBackend.X.Y(payload)` call, extract
// payload keys, and check them against the resolved handler's fields.
const screens = fs.readdirSync(SCREENS).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
const findings = [];
for (const f of screens) {
  const text = fs.readFileSync(path.join(SCREENS, f), "utf8");
  // Match `ObaraBackend?.ns?.method?.({ ... })` and grab the payload.
  // The payload may span multiple lines; balance braces.
  const re = /ObaraBackend(?:\?)?\.\s*([A-Za-z_$][\w$]*)\s*(?:\?)?\s*\.\s*([A-Za-z_$][\w$]*)\s*(?:\?)?\s*\(\s*\{/g;
  for (const m of text.matchAll(re)) {
    const [, ns, method] = m;
    const internalNs = apiAliases[ns];
    if (!internalNs) continue;
    const apiPath = methodToPath.get(`${internalNs}.${method}`);
    if (!apiPath) continue;
    const handlerKey = findHandlerByPath(apiPath);
    if (!handlerKey) continue;
    const allowedFields = handlerFields.get(handlerKey);
    if (!allowedFields) continue;

    // Walk the payload object: starting at the index of the opening `{`
    // (m.index + m[0].length - 1), balance braces.
    const startBrace = m.index + m[0].length - 1;
    let depth = 1;
    let i = startBrace + 1;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    const payload = text.slice(startBrace + 1, i - 1);
    // Pull keys at top level only (depth 0). A simple state machine
    // skips nested braces / brackets / strings.
    const keys = new Set();
    let d = 0;
    let j = 0;
    let buf = "";
    let inStr = null;
    while (j < payload.length) {
      const ch = payload[j];
      if (inStr) {
        if (ch === "\\") { j += 2; continue; }
        if (ch === inStr) inStr = null;
        j++; continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; j++; continue; }
      if (ch === "{" || ch === "[" || ch === "(") d++;
      else if (ch === "}" || ch === "]" || ch === ")") d--;
      if (d === 0 && (ch === "," || j === payload.length - 1)) {
        const piece = (j === payload.length - 1 && ch !== ",") ? buf + ch : buf;
        const trimmed = piece.trim();
        // Skip spread expressions (`...row`). We cannot statically
        // resolve which keys the spread contributes; treat the call
        // site as opaque for that piece.
        if (trimmed.startsWith("...")) {
          buf = "";
          j++;
          continue;
        }
        const colon = piece.indexOf(":");
        if (colon > 0) {
          const key = piece.slice(0, colon).trim().replace(/\["?|"?\]$/g, "");
          if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.add(key);
        } else {
          // Shorthand `{ foo }` where the key === local var name.
          if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) keys.add(trimmed);
        }
        buf = "";
        j++;
        continue;
      }
      buf += ch;
      j++;
    }

    // Allowlist common pass-through wrappers: `id` is always passed for
    // PATCH/DELETE; not all handlers explicitly read `body.id` because
    // they may parse it from query.
    const ALWAYS_OK = new Set(["id"]);

    const orphans = [...keys].filter((k) => !allowedFields.has(k) && !ALWAYS_OK.has(k));
    if (orphans.length) {
      findings.push({
        file: f,
        call: `ObaraBackend.${ns}.${method}`,
        handler: handlerKey,
        orphans,
      });
    }
  }
}

console.log("\nData model alignment audit");
console.log("─".repeat(70));
const byFile = {};
for (const f of findings) {
  byFile[f.file] = byFile[f.file] || [];
  byFile[f.file].push(f);
}
let total = 0;
for (const file of Object.keys(byFile).sort()) {
  console.log(`\n${file}`);
  for (const f of byFile[file]) {
    console.log(`  ${f.call} -> ${f.handler}`);
    console.log(`    payload key(s) the handler does NOT read: ${f.orphans.join(", ")}`);
    total++;
  }
}
console.log("\n" + "─".repeat(70));
console.log(`${total} mismatch(es) across ${Object.keys(byFile).length} file(s)`);
if (total > 0) process.exit(1);
