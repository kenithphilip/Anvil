// Audit: frontend code reads object properties that don't exist as
// columns in the migrations.
//
// Pins the regression behind PR #21 (customers screen tried to render
// customer.currency / customer.payment_terms / customer.margin_floor_pct
// but those columns weren't in the customers table).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const tableColumns = {};
const SQL_DIR = join(ROOT, "supabase/migrations");

const recordCreate = (table, body) => {
  const cols = new Set();
  const lines = body.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("--")) continue;
    if (/^(primary|unique|check|foreign|constraint|index|create)\b/i.test(line)) continue;
    const m = line.match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+/);
    if (!m) continue;
    cols.add(m[1]);
  }
  if (!tableColumns[table]) tableColumns[table] = new Set();
  cols.forEach((c) => tableColumns[table].add(c));
};

for (const file of readdirSync(SQL_DIR).filter((f) => f.endsWith(".sql")).sort()) {
  const src = readFileSync(join(SQL_DIR, file), "utf8");
  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(([\s\S]*?)\);/gi;
  let m;
  while ((m = createRe.exec(src)) !== null) recordCreate(m[1], m[2]);
  const alterRe = /alter\s+table\s+(?:only\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+([\s\S]*?);/gi;
  while ((m = alterRe.exec(src)) !== null) {
    const table = m[1];
    const body = m[2];
    const colRe = /add\s+column(?:\s+if\s+not\s+exists)?\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
    let cm;
    while ((cm = colRe.exec(body)) !== null) {
      if (!tableColumns[table]) tableColumns[table] = new Set();
      tableColumns[table].add(cm[1]);
    }
  }
}

const VAR_TO_TABLE = {
  customer: "customers",
  customers: "customers",
  order: "orders",
  orders: "orders",
  invoice: "invoices",
  invoices: "invoices",
  shipment: "shipments",
  shipments: "shipments",
  sourcePo: "source_pos",
  spo: "source_pos",
  internalSo: "internal_sales_orders",
  iso: "internal_sales_orders",
  lead: "leads",
  opp: "opportunities",
  project: "projects",
  document: "documents",
  doc: "documents",
};

const INTRINSIC = new Set([
  "length", "map", "filter", "find", "some", "every", "reduce", "forEach",
  "slice", "split", "join", "concat", "push", "pop", "shift", "unshift",
  "toLowerCase", "toUpperCase", "trim", "replace", "match", "test",
  "toString", "valueOf", "toJSON", "toFixed",
  "then", "catch", "finally",
  "props", "state", "current", "ref",
  "prototype", "constructor",
  "data", "error", "loading", "rows", "items", "results",
]);

const findings = {};
const recordFinding = (table, column, file, line) => {
  const key = table + "." + column;
  if (!findings[key]) findings[key] = { table, column, sites: [] };
  findings[key].sites.push({ file: file.replace(ROOT + "/", ""), line });
};

const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) { walk(p); continue; }
    if (!/\.(tsx?|jsx?)$/.test(p)) continue;
    if (/\.test\.(tsx?|jsx?)$/.test(p)) continue;
    const src = readFileSync(p, "utf8");
    for (const [varName, table] of Object.entries(VAR_TO_TABLE)) {
      const cols = tableColumns[table];
      if (!cols) continue;
      const re = new RegExp("\\b" + varName + "\\.([a-zA-Z_][a-zA-Z0-9_]*)", "g");
      let mm;
      while ((mm = re.exec(src)) !== null) {
        const col = mm[1];
        if (INTRINSIC.has(col)) continue;
        if (cols.has(col)) continue;
        if (/^(_|fmt|display|computed|memo|raw|live|next|prev|is[A-Z])/.test(col)) continue;
        const line = src.slice(0, mm.index).split("\n").length;
        recordFinding(table, col, p, line);
      }
    }
  }
};
walk(join(ROOT, "src/v3-app/screens"));
walk(join(ROOT, "src/api"));

const grouped = {};
for (const f of Object.values(findings)) {
  grouped[f.table] = grouped[f.table] || [];
  grouped[f.table].push(f);
}

const totalRows = Object.values(grouped).reduce((s, list) => s + list.length, 0);
if (totalRows === 0) {
  console.log("\n## Schema drift: none detected\n");
  process.exit(0);
}

console.log("\n## Possible schema drift (frontend reads columns absent from migrations)\n");
for (const table of Object.keys(grouped).sort()) {
  console.log("### Table: " + table);
  const list = grouped[table].sort((a, b) => b.sites.length - a.sites.length);
  for (const f of list) {
    const sites = f.sites.slice(0, 3).map((s) => s.file + ":" + s.line).join(", ");
    const more = f.sites.length > 3 ? "  (+" + (f.sites.length - 3) + " more)" : "";
    console.log("  - " + f.column + "  " + sites + more);
  }
  console.log("");
}
console.log("Total drift columns: " + totalRows);
console.log("Note: heuristic. False positives possible when a screen names a variable");
console.log("after a table but populates it from a JOIN or a custom RPC. Review each finding.");
process.exit(1);
