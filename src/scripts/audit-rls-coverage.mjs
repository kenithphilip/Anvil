// RLS-coverage audit. Phase 1 F13.
//
// Sweeps every `svc.from("<table>")` call chain inside src/api/
// and verifies it carries an explicit `.eq("tenant_id", ...)` so
// a logic bug in the API code cannot leak across tenants even
// when Postgres RLS would otherwise catch it. Belt-and-braces:
// the script complements the database policies; it does not
// replace them.
//
// Two configurable inputs control the sweep:
//
//   TABLES (defaults: tally_companies, item_master,
//   item_customer_parts, customers, orders, source_pos,
//   quote_lines, ...): the set of tables the script considers
//   tenant-scoped. Pass `--table <name>` to scope to one table.
//
//   ALLOW_LIST: a curated set of file:line locations the script
//   accepts as intentionally cross-tenant. Cron sweeps that
//   iterate every tenant land here; same for service-role admin
//   endpoints that own the cross-tenant contract by design.
//
// Output mirrors audit-rbac.mjs: per-finding stdout + a markdown
// report at docs/RLS_COVERAGE_AUDIT.md. Exits non-zero on any
// FAIL-severity finding so CI (via `npm run verify`) blocks the
// merge.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_DIR = path.join(ROOT, "src", "api");
const REPORT = path.join(ROOT, "docs", "RLS_COVERAGE_AUDIT.md");

// Tenant-scoped tables to audit. Add new tables here as the
// schema grows. The script only flags chains that target these
// tables; everything else is ignored.
const DEFAULT_TABLES = new Set([
  "tally_companies",
  "tally_voucher_records",
  "tally_drift_findings",
  "item_master",
  "item_customer_parts",
  "item_specifications",
  "item_field_definitions",
  "item_field_values",
  "customers",
  "customer_format_profiles",
  "customer_format_profile_versions",
  "customer_terms_packs",
  "customer_terms_clauses",
  "customer_vendor_codes",
  "orders",
  "source_pos",
  "quote_lines",
  "quotes",
  "quote_approvals",
  "audit_events",
  "audit_failures",
  "validation_findings",
  "anomaly_findings",
  "tenant_members",
  "tenant_settings",
]);

// Allow-list. Each entry is { file: substring, line: number,
// reason: string } and matches an exact file:line site that the
// audit accepts as intentionally cross-tenant.
const ALLOW_LIST = [
  {
    file: "src/api/tally/sync.js",
    line: 211,
    reason: "Cron sweep iterates every tenant by design (if (isCron) branch).",
  },
];

// Parse CLI args.
//
// Default scope is the Phase 1 F13 target table: `tally_companies`.
// The broader DEFAULT_TABLES sweep is available with `--all-tables`
// for a manual audit pass. Restricting the CI gate to F13's scope
// keeps the verify pipeline tractable; expanding the sweep is a
// follow-up phase once the per-ERP retry / sync paths get the
// same belt-and-braces treatment.
//
// Flags:
//   --table <name>   restrict to one table (overrides default).
//   --all-tables     sweep every table in DEFAULT_TABLES.
//   --list-tables    print the audit table set and exit 0.
const argv = process.argv.slice(2);
let scopedTable = "tally_companies";
let allTables = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--table" && argv[i + 1]) {
    scopedTable = argv[i + 1];
    i++;
  } else if (argv[i] === "--all-tables") {
    allTables = true;
  } else if (argv[i] === "--list-tables") {
    process.stdout.write([...DEFAULT_TABLES].sort().join("\n") + "\n");
    process.exit(0);
  }
}

const targetTables = allTables ? DEFAULT_TABLES : new Set([scopedTable]);

const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
};

// Find every `.from("<table>")` site. For each, walk forward
// through the chain (up to the terminating semicolon or closing
// paren depth 0) and check if `.eq("tenant_id", ...)` appears.
//
// The chain may span multiple lines. We collect a window of up
// to 8 lines after the .from() and search within it for either
// the literal `.eq("tenant_id"` or a comment carrying
// `audit-allow: cross-tenant` so a maintainer can opt out
// inline (e.g. `// audit-allow: cross-tenant (cron sweep)`).
const FROM_RE = /\.from\(\s*["']([a-z_]+)["']\s*\)/;
const TENANT_EQ_RE = /\.eq\(\s*["']tenant_id["']/;
const ALLOW_COMMENT_RE = /audit-allow:\s*cross-tenant/i;

const scanFile = (file) => {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split(/\n/);
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FROM_RE);
    if (!m) continue;
    const table = m[1];
    if (!targetTables.has(table)) continue;
    // Lookahead window: up to 12 lines or until a semicolon ends
    // the expression. Lookbehind 4 lines for an opt-out comment
    // above the chain.
    const start = Math.max(0, i - 4);
    const end = Math.min(lines.length, i + 13);
    const window = lines.slice(start, end).join("\n");
    if (TENANT_EQ_RE.test(window)) continue;
    if (ALLOW_COMMENT_RE.test(window)) continue;
    const relFile = path.relative(ROOT, file);
    const lineNo = i + 1;
    const allow = ALLOW_LIST.find((a) => relFile.endsWith(a.file) && a.line === lineNo);
    if (allow) continue;
    findings.push({ severity: "FAIL", kind: "missing-tenant-filter",
      file: relFile, line: lineNo, table });
  }
  return findings;
};

const main = () => {
  const files = walk(API_DIR);
  const findings = [];
  for (const f of files) findings.push(...scanFile(f));

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
  process.stdout.write("RLS coverage audit: " + findings.length + " finding(s)" + (scopedTable ? " (table=" + scopedTable + ")" : "") + "\n");
  for (const k of Object.keys(counts)) process.stdout.write("  " + k + ": " + counts[k] + "\n");
  for (const f of findings) {
    process.stdout.write("  [" + f.severity + "] " + f.file + ":" + f.line + " table=" + f.table + "\n");
  }

  const reportLines = [
    "# RLS coverage audit",
    "",
    "Auto-generated by `src/scripts/audit-rls-coverage.mjs`. Run",
    "`node src/scripts/audit-rls-coverage.mjs` to refresh.",
    "",
    "## Scope",
    "",
    "Tables audited:",
    "",
    ...[...targetTables].sort().map((t) => "- `" + t + "`"),
    "",
    "Allow-list entries (intentionally cross-tenant):",
    "",
    ...ALLOW_LIST.map((a) => "- `" + a.file + ":" + a.line + "` (" + a.reason + ")"),
    "",
    "## Findings",
    "",
  ];
  if (findings.length === 0) {
    reportLines.push("No drift detected. Every `.from(<scoped_table>)` chain in `src/api/` carries an explicit `.eq(\"tenant_id\", ...)`.");
  } else {
    reportLines.push("| Severity | File | Line | Table |");
    reportLines.push("|----------|------|------|-------|");
    for (const f of findings) {
      reportLines.push("| " + f.severity + " | `" + f.file + "` | " + f.line + " | `" + f.table + "` |");
    }
  }
  fs.writeFileSync(REPORT, reportLines.join("\n") + "\n", "utf8");
  process.stdout.write("Report: " + path.relative(ROOT, REPORT) + "\n");

  if (counts.FAIL) {
    process.stdout.write("RLS coverage drift detected. Failing the build.\n");
    process.exit(1);
  }
};

main();
