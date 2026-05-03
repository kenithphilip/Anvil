// Dead onClick handler audit for src/v3-app/screens/.
//
// Catches four categories of unwired buttons that look fine in code
// review but do nothing for the user. We hit a real instance of #1
// on the live deploy where /#/intake had a button labeled "open
// intake" that just re-set the hash to the same route, so React
// never re-rendered and the click was visually a no-op.
//
// Categories:
//
// 1. SELF_NOOP_NAV  - onClick sets window.location.hash to the same
//                     route the user is already on, with no change in
//                     query string. The screen does not re-mount and
//                     the user perceives a dead button.
// 2. EMPTY_HANDLER  - onClick is `() => {}`, `() => null`, or
//                     `() => undefined`.
// 3. STUB_HANDLER   - onClick body is a single statement that does
//                     not call any backend, hash-nav, state setter,
//                     or DOM action. Logs are stubs.
// 4. NO_HANDLER     - <Btn> / <button> / <a> primary action with no
//                     onClick at all.
//
// We allow same-route nav iff a different query string is set, OR
// the destination is a different sub-view (different first segment
// of the hash). The route-id of each screen file is read from the
// FILE_TO_ROUTE map below, which mirrors src/v3-app/routes.ts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS = path.join(ROOT, "src", "v3-app", "screens");

// Each entry is screen-file -> top-level route id (the part right
// after #/). If a file maps to several routes (e.g. tally-push.tsx
// renders under #/tally?sub=push), use the FIRST segment that the
// user lands on by default.
const FILE_TO_ROUTE = {
  "home.tsx":               "home",
  "intake.tsx":             "intake",
  "orders.tsx":             "so",
  "so-workspace.tsx":       "so",
  "so-intake.tsx":          "so",
  "so-history.tsx":         "so",
  "internal-sos.tsx":       "internal",
  "approvals.tsx":          "approvals",
  "leads.tsx":              "leads",
  "opps.tsx":               "opps",
  "projects.tsx":           "projects",
  "shipments.tsx":          "shipments",
  "source-pos.tsx":         "spo",
  "spares.tsx":             "spares",
  "service-visits.tsx":     "svc-visits",
  "amc.tsx":                "amc",
  "car.tsx":                "car",
  "tally-push.tsx":         "tally",
  "tally-masters.tsx":      "tally",
  "tally-reconcile.tsx":    "tally",
  "einvoice.tsx":           "einvoice",
  "cost.tsx":               "cost",
  "customers.tsx":          "customers",
  "items.tsx":              "items",
  "bom-import.tsx":         "items",
  "guns-viewer.tsx":        "items",
  "equipment-hierarchy.tsx":"items",
  "jbm-importer.tsx":       "items",
  "graph.tsx":              "graph",
  "forecasts.tsx":          "forecasts",
  "evals.tsx":              "evals",
  "studio.tsx":             "studio",
  "anomaly.tsx":            "anomaly",
  "duplicates.tsx":         "duplicates",
  "comms.tsx":              "comms",
  "email.tsx":              "email",
  "security.tsx":           "security",
  "audit.tsx":              "audit",
  "admin.tsx":              "admin",
  "connect.tsx":            "connect",
  "onboarding.tsx":         "onboarding",
  "format-guide.tsx":       "format-guide",
};

const findings = [];
const push = (severity, file, line, category, snippet, hint) => {
  findings.push({ severity, file, line, category, snippet, hint });
};

const isSameRouteNav = (currentRoute, navTarget) => {
  // navTarget is what's inside the quotes of `window.location.hash =
  // "..."`, e.g. `#/intake` or `#/so?id=X`. Strip leading #/.
  const trimmed = navTarget.replace(/^#\//, "");
  const [route, query] = trimmed.split("?");
  // Same route AND no query change is a dead nav. Different route or
  // any query is fine because the consumer screen branches on params.
  if (route !== currentRoute) return false;
  if (query && query.length > 0) return false;
  return true;
};

// Match `window.location.hash = "literal"` or `window.location.hash
// = \`literal\`` (no template expressions, since templates always
// carry a dynamic id).
const NAV_LITERAL = /window\.location\.hash\s*=\s*["'`](#\/[A-Za-z0-9_-]+(?:\?[^"'`]*)?)["'`]/g;

// Match an onClick attribute with an arrow body that is empty.
const EMPTY = /onClick=\{\s*\(\s*[^)]*\)\s*=>\s*(?:\{\s*\}|null|undefined|void\s+0)\s*\}/g;

// Heuristic stub onClick: the entire body is a single console call
// with nothing else. We do not greedy-match.
const STUB = /onClick=\{\s*\(\s*[^)]*\)\s*=>\s*console\.[a-z]+\s*\([^)]*\)\s*\}/g;

// Buttons (or <a>) with no onClick at all that nevertheless look
// like they should do something. We only flag <Btn ...>...</Btn>
// or <button ...>...</button> with kind="primary" and NO onClick
// in the opening tag.
const NO_HANDLER_PRIMARY = /<Btn\b(?![^>]*onClick=)[^>]*kind="primary"[^>]*>/g;

const linesOf = (src) => src.split("\n");

const lineNumberOfIndex = (text, idx) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

const allowedLegacySameRoute = (file, route, lineText, src, idx) => {
  // "back to list" / "cancel" buttons that intentionally drop query
  // params, e.g. /#/items?view=import -> /#/items.
  if (/back to|cancel|back to list|return to|close|open list/i.test(lineText)) return true;

  // Multi-view files: if the file reads `?new=1` or `?id=X` params,
  // then a bare-route nav is the "close form / back to list" path.
  // The actual URL change is from "?new=1" to nothing, which IS a
  // re-render, not a no-op.
  const readsParams = /params\.get\(["'](id|new|view|sub)["']\)/.test(src);
  if (!readsParams) return false;

  // And only allow if the nav is inside a closeForm-shaped function
  // (the surrounding 4 lines mention setForm/setEditing/closeForm).
  const sliceStart = Math.max(0, idx - 200);
  const sliceEnd = Math.min(src.length, idx + 50);
  const surrounding = src.slice(sliceStart, sliceEnd);
  if (/closeForm|setForm\(\s*null\s*\)|setEditing\(\s*null\s*\)|setActive\(\s*null\s*\)|setView\(\s*null\s*\)/.test(surrounding)) {
    return true;
  }
  return false;
};

const auditFile = (filePath) => {
  const base = path.basename(filePath);
  const route = FILE_TO_ROUTE[base];
  if (!route) return; // not in route map = not user-reachable
  const src = fs.readFileSync(filePath, "utf8");
  const rel = path.relative(ROOT, filePath);
  const lines = linesOf(src);

  // 1. SELF_NOOP_NAV
  for (const m of src.matchAll(NAV_LITERAL)) {
    const target = m[1];
    if (!isSameRouteNav(route, target)) continue;
    const ln = lineNumberOfIndex(src, m.index);
    const lineText = lines[ln - 1] || "";
    if (allowedLegacySameRoute(base, route, lineText, src, m.index)) continue;
    push("error", rel, ln, "SELF_NOOP_NAV", lineText.trim(),
      `Button navigates to ${target} from /#/${route} with no query change. The screen will not re-mount; click is a no-op.`);
  }

  // 2. EMPTY_HANDLER
  for (const m of src.matchAll(EMPTY)) {
    const ln = lineNumberOfIndex(src, m.index);
    push("error", rel, ln, "EMPTY_HANDLER", (lines[ln - 1] || "").trim(),
      "onClick body is empty. Either remove the button or wire a real handler.");
  }

  // 3. STUB_HANDLER
  for (const m of src.matchAll(STUB)) {
    const ln = lineNumberOfIndex(src, m.index);
    push("warn", rel, ln, "STUB_HANDLER", (lines[ln - 1] || "").trim(),
      "onClick body is a one-line trace; no user-visible effect.");
  }

  // 4. NO_HANDLER on a primary <Btn>. Skip type="submit" buttons
  // because submit buttons do not need onClick (form action handles).
  for (const m of src.matchAll(NO_HANDLER_PRIMARY)) {
    const ln = lineNumberOfIndex(src, m.index);
    const lineText = (lines[ln - 1] || "").trim();
    if (/type="submit"/.test(lineText)) continue;
    push("error", rel, ln, "NO_HANDLER", lineText,
      "Primary button has no onClick. Wire a handler or change kind.");
  }
};

const walk = () => {
  const out = [];
  for (const name of fs.readdirSync(SCREENS)) {
    if (name.endsWith(".test.tsx")) continue;
    if (!name.endsWith(".tsx")) continue;
    out.push(path.join(SCREENS, name));
  }
  return out;
};

const main = () => {
  const files = walk();
  for (const f of files) auditFile(f);

  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity === "warn");

  process.stdout.write(`Dead-handler audit: scanned ${files.length} screens\n`);
  process.stdout.write(`  errors: ${errors.length}\n`);
  process.stdout.write(`  warns:  ${warns.length}\n\n`);

  if (errors.length) {
    process.stdout.write("ERRORS:\n");
    for (const f of errors) {
      process.stdout.write(`  [${f.category}] ${f.file}:${f.line}\n`);
      process.stdout.write(`    ${f.snippet}\n`);
      process.stdout.write(`    -> ${f.hint}\n`);
    }
    process.stdout.write("\n");
  }

  if (warns.length) {
    process.stdout.write("WARNS:\n");
    for (const f of warns) {
      process.stdout.write(`  [${f.category}] ${f.file}:${f.line}\n`);
      process.stdout.write(`    ${f.snippet}\n`);
      process.stdout.write(`    -> ${f.hint}\n`);
    }
    process.stdout.write("\n");
  }

  process.exit(errors.length > 0 ? 1 : 0);
};

main();
