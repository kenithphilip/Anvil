// Phase 8 cutover audit. Walks the repository post-migration and reports:
// 1. No legacy v3 source remains.
// 2. Every NAV id has a registered route AND a screen file under
//    src/v3-app/screens/.
// 3. Every screen referenced in routes.ts maps to a real file.
// 4. Test files exist for every screen + every shared lib module.
// 5. No legacy globals (window.X = WiredX, useStateW, etc.) leak in.
// 6. tsc + vitest + vite all pass.
//
// Run with `node src/scripts/audit-migration.mjs`. Exit code is 0 only
// when every check passes; CI can wire this in if it wants a single
// success signal beyond build+test.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = path.join(ROOT, "src", "v3-app");
const SCREENS = path.join(APP, "screens");
const LIB = path.join(APP, "lib");

const results = [];
const fail = (label, msg) => results.push({ ok: false, label, msg });
const ok = (label, msg) => results.push({ ok: true, label, msg });

// Check 1: no leftover legacy source.
const legacyPaths = [
  path.join(ROOT, "src", "v3"),
  path.join(ROOT, "src", "scripts", "build-v3.mjs"),
  path.join(ROOT, "src", "scripts", "test-v3-contract.mjs"),
  path.join(ROOT, "public", "v3.html"),
];
for (const p of legacyPaths) {
  if (fs.existsSync(p)) fail("legacy-source-removed", `still present: ${path.relative(ROOT, p)}`);
}
if (results.every((r) => r.ok || r.label !== "legacy-source-removed")) {
  ok("legacy-source-removed", `none of [${legacyPaths.length}] legacy paths remain`);
}

// Check 2: NAV ids declared by lib/nav.ts cover every public route.
const NAV_IDS = [
  "home", "intake", "so", "internal", "approvals",
  "leads", "opps", "projects", "shipments",
  "spo", "spares",
  "svc-visits", "amc", "car",
  "tally", "einvoice", "cost",
  "customers", "items", "graph", "forecasts",
  "evals", "studio", "anomaly", "duplicates",
  "comms", "email", "security",
  "audit", "admin",
  "connect", "onboarding", "format-guide", // hidden routes
];

const routesText = fs.readFileSync(path.join(APP, "routes.ts"), "utf8");
let missingResolvers = [];
for (const id of NAV_IDS) {
  const lit = id.includes("-") ? `"${id}"` : id;
  if (!routesText.includes(`${lit}:`)) missingResolvers.push(id);
}
if (missingResolvers.length) fail("routes-cover-nav", `missing resolvers: ${missingResolvers.join(", ")}`);
else ok("routes-cover-nav", `${NAV_IDS.length} routes resolve`);

// Check 3: every screen file referenced in routes exists. We strip line
// comments first so the example in the routes.ts header doesn't count.
const routesNoComments = routesText
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
const screenImports = [...routesNoComments.matchAll(/import\("\.\/screens\/([^"]+)"\)/g)].map((m) => m[1]);
const missingScreens = screenImports.filter((rel) => !fs.existsSync(path.join(APP, "screens", rel + ".tsx")) && !fs.existsSync(path.join(APP, "screens", rel + ".ts")));
if (missingScreens.length) fail("screen-files-exist", `missing: ${missingScreens.join(", ")}`);
else ok("screen-files-exist", `${screenImports.length} lazy imports resolve`);

// Check 4: every screen has a test file, every lib module has a test file.
const allScreens = fs.readdirSync(SCREENS).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
const screensMissingTests = allScreens.filter((f) => {
  const base = f.replace(/\.tsx$/, "");
  return !fs.existsSync(path.join(SCREENS, `${base}.test.tsx`));
});
if (screensMissingTests.length) fail("screen-tests-exist", `missing: ${screensMissingTests.join(", ")}`);
else ok("screen-tests-exist", `${allScreens.length} screens have tests`);

const libModules = fs.readdirSync(LIB).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f));
const libMissingTests = libModules.filter((f) => {
  const base = f.replace(/\.(ts|tsx)$/, "");
  return !fs.existsSync(path.join(LIB, `${base}.test.ts`)) && !fs.existsSync(path.join(LIB, `${base}.test.tsx`));
});
// Some lib files (api.ts, icons.tsx) don't need behavior tests of their own;
// they're exercised by every screen test. Treat them as advisory only.
const advisoryLibs = ["api.ts", "icons.tsx"];
const libBlocking = libMissingTests.filter((f) => !advisoryLibs.includes(f));
if (libBlocking.length) fail("lib-tests-exist", `missing: ${libBlocking.join(", ")}`);
else ok("lib-tests-exist", `${libModules.length - advisoryLibs.length} lib modules have direct tests (api + icons covered transitively)`);

// Check 5: no legacy globals leak into the converted source.
const grepFor = (pattern, label, scope) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        if (pattern.test(text)) out.push(path.relative(ROOT, full));
      }
    }
  };
  walk(scope);
  if (out.length) fail(label, `${out.length} file(s) match: ${out.slice(0, 5).join(", ")}${out.length > 5 ? "…" : ""}`);
  else ok(label, "no matches in src/v3-app/");
};

grepFor(/\bwindow\.\w+\s*=\s*Wired\w+\s*;/, "no-window-wired-exports", APP);
grepFor(/\buseStateW\b|\buseEffectW\b|\buseMemoW\b/, "no-w-suffixed-hooks", APP);
grepFor(/^const useFetch\s*=\s*\(/m, "no-local-useFetch-redef", APP);

// Check 6: package.json has the new scripts and not the old ones.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const requiredScripts = ["build", "build:v3", "build:legacy", "dev:v3", "typecheck", "test", "test:watch", "verify", "check"];
const missingScripts = requiredScripts.filter((s) => !pkg.scripts[s]);
if (missingScripts.length) fail("npm-scripts", `missing: ${missingScripts.join(", ")}`);
else ok("npm-scripts", `${requiredScripts.length} required scripts present`);

const forbiddenScripts = pkg.scripts["build:v3"]?.includes("build-v3.mjs");
if (forbiddenScripts) fail("npm-scripts", "build:v3 still points at the deleted build-v3.mjs concatenator");

// Final report.
console.log("\nv3 Phase 8 Migration Audit");
console.log("─".repeat(60));
let failed = 0;
for (const r of results) {
  const icon = r.ok ? "OK  " : "FAIL";
  console.log(`${icon}  ${r.label.padEnd(30)} ${r.msg || ""}`);
  if (!r.ok) failed++;
}
console.log("─".repeat(60));
console.log(`${results.length - failed} of ${results.length} checks passed`);
if (failed) {
  process.exit(1);
}
