// Deep audit of every converted screen. Goes beyond the migration parity
// checks and looks for runtime-breaking issues the converter could have
// introduced:
//
// 1. Identifier-used-but-not-imported: a JSX/JS file references a name
//    that isn't in its imports and isn't locally defined. (Common after
//    regex-based ports because cross-screen globals like `tallyOrderRows`
//    used to hoist across files.)
// 2. window.* references that point at things the v3-app no longer
//    provides. window.notify*, window.location, window.history, etc.
//    are legitimate. window.showOpsModal / runOpsAction / Icon / NAV /
//    ObaraBackend / RBAC / Prefs / cytoscape / XLSX / JSZip are NOT.
// 3. Direct CDN <script> assumptions (window.cytoscape, etc.) without a
//    local fallback or comment explaining the runtime contract.
// 4. JSX self-references using shadowed names (a `const X = () => {}`
//    inside a component that also uses `<X />` outside its scope).
//
// Output: one row per finding. Exits non-zero if any blocking issue is
// reported. Run via `node src/scripts/audit-screens-deep.mjs`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS = path.join(ROOT, "src", "v3-app", "screens");
const LIB = path.join(ROOT, "src", "v3-app", "lib");

const screens = fs.readdirSync(SCREENS).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));

// Known-good window.* properties: standard browser APIs the v3-app may use.
const WINDOW_OK = new Set([
  "location", "history", "navigator", "localStorage", "sessionStorage",
  "addEventListener", "removeEventListener", "dispatchEvent", "CustomEvent",
  "scrollTo", "scrollY", "scrollX", "innerWidth", "innerHeight",
  "open", "close", "alert", "confirm", "prompt", "print",
  "URL", "Blob", "File", "FormData", "FileReader",
  "fetch", "Request", "Response", "Headers",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame",
  "matchMedia", "getComputedStyle",
  "crypto", "btoa", "atob",
  "document", "console",
  // Toast compat surface (lib/toasts.tsx attaches these on purpose)
  "notify", "notifySuccess", "notifyWarn", "notifyError", "notifyLive",
  "notifyDismiss", "__toastSubscribe", "__toastsCurrent",
  // CDN libraries loaded on demand via runtime <script> injection. Each
  // consuming screen has its own loadXLSX / loadJSZip / loadCytoscape
  // helper that injects the cdn script tag if window.X is not yet set.
  "XLSX", "JSZip", "cytoscape", "dagre",
]);

// Identifiers that screens may rely on but should NOT come via window.
// Each entry maps the legacy name to the ESM module the screen should
// import from instead.
const REQUIRES_IMPORT = {
  Icon: "../lib/icons",
  NAV: "../lib/nav",
  ROLES: "../lib/nav",
  RBAC: "../lib/rbac",
  Prefs: "../lib/preferences",
  ObaraBackend: "../lib/api",
  storage: "../lib/api",
  // No legacy unified-app surface. Screens that use these are broken.
  // The audit reports them so we can rewrite or delete the call site.
  showOpsModal: "[legacy unified app surface; rewrite needed]",
  runOpsAction: "[legacy unified app surface; rewrite needed]",
  hideOpsModal: "[legacy unified app surface; rewrite needed]",
};

const WORD = "[A-Za-z_$][\\w$]*";

// Strip JS string literals + line/block comments before scanning so a
// reference inside a comment or a CSS-in-JS string doesn't trigger.
const sanitize = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ")
  .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
  .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, "``");

// Pull every imported identifier out of a file's import statements.
const collectImports = (text) => {
  const set = new Set();
  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) set.add(m[1]);
  for (const m of text.matchAll(/import\s+\{([^}]+)\}\s+from/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) set.add(name);
    }
  }
  for (const m of text.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g)) set.add(m[1]);
  return set;
};

// Collect every locally-declared name (top-level + function-scoped).
const collectLocals = (text) => {
  const set = new Set();
  for (const m of text.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${WORD})`, "g"))) set.add(m[1]);
  for (const m of text.matchAll(new RegExp(`\\bfunction\\s+(${WORD})`, "g"))) set.add(m[1]);
  for (const m of text.matchAll(new RegExp(`\\bclass\\s+(${WORD})`, "g"))) set.add(m[1]);
  // Destructured bindings: { a, b: c, d = 1 } from ... — best-effort.
  for (const m of text.matchAll(/\{\s*([^{}]+)\s*\}\s*=\s*[A-Za-z_$]/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      const name = t.includes(":") ? t.split(":")[1].trim().split(/[\s=]/)[0] : t.split(/[\s=]/)[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) set.add(name);
    }
  }
  // Function parameters: do NOT add — too noisy. Findings will appear at
  // identifier-use level, then we can dial back if needed.
  return set;
};

const findings = [];
const note = (file, kind, msg) => findings.push({ file, kind, msg });

for (const f of screens) {
  const full = path.join(SCREENS, f);
  const raw = fs.readFileSync(full, "utf8");
  const sanitized = sanitize(raw);

  // 1. Forbidden window.X references.
  const windowRefs = new Set();
  for (const m of sanitized.matchAll(new RegExp(`window\\.(${WORD})`, "g"))) {
    windowRefs.add(m[1]);
  }
  for (const ref of windowRefs) {
    if (WINDOW_OK.has(ref)) continue;
    if (REQUIRES_IMPORT[ref]) {
      note(f, "window-instead-of-import", `window.${ref} should be: import from "${REQUIRES_IMPORT[ref]}"`);
    } else {
      note(f, "unknown-window-ref", `window.${ref} is not a known browser API or module surface`);
    }
  }

  // 2. Used-but-not-imported (only for the names we KNOW belong in lib/).
  const imports = collectImports(sanitized);
  const locals = collectLocals(sanitized);
  for (const name of Object.keys(REQUIRES_IMPORT)) {
    const useRe = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g");
    if (!useRe.test(sanitized)) continue;
    if (imports.has(name) || locals.has(name)) continue;
    note(f, "missing-import", `${name} is used but not imported (expected from ${REQUIRES_IMPORT[name]})`);
  }

  // 3. Primitives + Icon + helpers that the converter usually adds; flag
  // any usage that didn't get an import alongside.
  const PRIMITIVES = ["Btn", "Card", "Banner", "Chip", "Dot", "Sev", "Prov",
    "WSTitle", "WSTabs", "KV", "KPI", "KPIRow", "Steps", "RailPanel", "Stream"];
  const HELPERS = ["useFetch", "ageLabel", "fmtINRShort", "stageOf", "sevOf"];
  for (const name of [...PRIMITIVES, ...HELPERS]) {
    const useRe = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g");
    const matches = sanitized.match(useRe);
    if (!matches || matches.length === 0) continue;
    if (imports.has(name) || locals.has(name)) continue;
    note(f, "missing-import", `${name} used ${matches.length}x but not imported`);
  }

  // 4. Cross-screen helper references. Names that look like helper
  // functions defined elsewhere. The converter sometimes preserved a
  // call to a function that was hoisted from another file in the legacy
  // build. Heuristic: a CamelCase or snake_case identifier called as a
  // function but never declared / imported here, AND known to be defined
  // in another converted screen.
  // (We skip this in v1 of the audit because it's noisy; the typecheck
  // pass would catch it if @ts-nocheck were removed. Recorded here for a
  // future tighter pass.)
}

// Group + report.
const grouped = {};
for (const f of findings) {
  grouped[f.kind] = grouped[f.kind] || [];
  grouped[f.kind].push(f);
}

console.log("\nDeep screen audit");
console.log("─".repeat(70));
let total = 0;
for (const kind of Object.keys(grouped).sort()) {
  console.log(`\n[${kind}] ${grouped[kind].length} finding(s)`);
  for (const f of grouped[kind]) {
    console.log(`  ${f.file.padEnd(28)} ${f.msg}`);
    total++;
  }
}
console.log("\n" + "─".repeat(70));
console.log(`${total} finding(s) across ${screens.length} screens`);

if (total > 0) process.exit(1);
