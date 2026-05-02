// Contract test for the v3 build. Runs in CI after `npm run build`.
//
// Asserts:
// 1. Every nav id from shell.jsx has a matching entry in app.jsx ROUTES.
// 2. Every entry in app.jsx ROUTES references at least one window.X
//    component that is actually defined somewhere in the bundle.
// 3. Every wired override (window.X = WiredX) lands AFTER the static
//    Object.assign(window, { X }) so the wired version wins on first
//    paint.
// 4. RBAC.MATRIX in rbac.js covers every nav id.
//
// Exit code: 0 = all good, 1 = any contract violation.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const shell = read("src/v3/shell.jsx");
const app = read("src/v3/app.jsx");
const rbac = read("src/v3/rbac.js");
const html = read("public/v3.html");

let failures = 0;
const fail = (msg) => { console.error("FAIL " + msg); failures++; };
const pass = (msg) => console.log("OK   " + msg);

// 1. Nav ids vs app routes
const navBlock = shell.match(/const NAV = \[([\s\S]*?)\n\];/)[1];
const navIds = [...navBlock.matchAll(/id: "([a-z][a-z-]*)"/g)].map((m) => m[1]);
const routesBlock = app.match(/const ROUTES = \{([\s\S]*?)\n\};/)[1];
const routeKeys = [...routesBlock.matchAll(/^\s+"?([a-z][a-z-]*)"?:\s*\(\)/gm)].map((m) => m[1]);

// Routes intentionally outside the sidebar nav (reached via header pill,
// auto-redirect, or deep-link). The user wouldn't browse to these from
// the nav tree, so we allow them to exist as ROUTES without NAV entries.
const HIDDEN_ROUTES = new Set(["connect"]);

const navMissingRoute = navIds.filter((id) => !routeKeys.includes(id));
const routeMissingNav = routeKeys.filter((id) => !navIds.includes(id) && !HIDDEN_ROUTES.has(id));
if (navMissingRoute.length === 0) pass(`every nav id (${navIds.length}) has a route handler`);
else fail("nav ids without a route: " + navMissingRoute.join(", "));
if (routeMissingNav.length === 0) pass(`every visible route has a nav id (${HIDDEN_ROUTES.size} hidden routes ok: ${[...HIDDEN_ROUTES].join(", ")})`);
else fail("routes without a nav id: " + routeMissingNav.join(", "));

// 2. Every component referenced by ROUTES must be window-defined
const componentsRef = new Set();
for (const m of routesBlock.matchAll(/<([A-Z][A-Za-z]+)\s/g)) {
  if (m[1] !== "Placeholder" && m[1] !== "HomeRoute") componentsRef.add(m[1]);
}
const windowDefs = new Set([
  ...[...html.matchAll(/^window\.([A-Z][A-Za-z]+)\s*=/gm)].map((m) => m[1]),
  ...[...html.matchAll(/Object\.assign\(window,\s*\{([^}]+)\}/g)]
    .flatMap((m) => m[1].split(",").map((s) => s.trim().split(":")[0].trim()))
    .filter((s) => /^[A-Z][A-Za-z]+$/.test(s)),
]);
const missingComp = [...componentsRef].filter((c) => !windowDefs.has(c));
if (missingComp.length === 0) pass(`every routed component (${componentsRef.size}) is window-defined`);
else fail("routed components not defined: " + missingComp.join(", "));

// 3. Wired overrides land after static for collision-prone names
const collisionNames = ["Inbox", "SOList", "SOIntake", "SOWorkspace", "Approvals",
  "InternalSOs", "Leads", "Opportunities", "Projects", "Shipments",
  "SourcePOs", "SparesMatrix", "ServiceVisits", "AMCSchedule", "CARReports",
  "TallyMasters", "TallyPush", "TallyReconcile", "EInvoice", "CostMargin",
  "Customers", "Items", "MasterDataGraph", "Forecasts", "EvalSuites",
  "ProfileStudio", "Findings", "Duplicates", "Aliases",
  "Communications", "EmailTriage", "Security", "AuditLog", "AdminCenter",
  "CmdK", "ThreadDrawer"];
const wiredOrderProblems = [];
for (const name of collisionNames) {
  const wiredRe = new RegExp(`^window\\.${name}\\s*=\\s*Wired${name === "AuditLog" ? "Audit" : (name === "ThreadDrawer" ? "ThreadDrawer" : "")}`, "m");
  // Simpler: find last 'window.<name> = ' and assert it equals 'Wired...'
  const finds = [...html.matchAll(new RegExp(`window\\.${name}\\s*=\\s*([A-Za-z_][A-Za-z0-9_]*)`, "g"))];
  if (finds.length === 0) {
    wiredOrderProblems.push(`${name}: never assigned`);
    continue;
  }
  const lastAssignment = finds[finds.length - 1][1];
  if (!lastAssignment.startsWith("Wired")) {
    wiredOrderProblems.push(`${name}: last assignment is ${lastAssignment} (not a Wired override)`);
  }
}
if (wiredOrderProblems.length === 0) pass(`every collision-prone name (${collisionNames.length}) has Wired wins last`);
else { fail("wired-order problems:"); wiredOrderProblems.forEach((p) => console.error("  - " + p)); }

// 4. RBAC matrix covers every nav id
const matrixBlock = rbac.match(/const MATRIX = \{([\s\S]*?)\n\s*\};/)[1];
const matrixKeys = new Set([...matrixBlock.matchAll(/^\s+"?([a-z][a-z-]*)"?:\s*\{/gm)].map((m) => m[1]));
const rbacMissing = navIds.filter((id) => !matrixKeys.has(id));
if (rbacMissing.length === 0) pass(`RBAC matrix covers every nav id (${navIds.length})`);
else fail("RBAC missing entries for: " + rbacMissing.join(", "));

// Done
if (failures > 0) {
  console.error(`\n${failures} contract failure(s)`);
  process.exit(1);
}
console.log("\nv3 contract: clean");
process.exit(0);
