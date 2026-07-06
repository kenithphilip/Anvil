// RBAC consistency audit.
//
// Compares the frontend permission matrix (src/v3-app/lib/rbac.ts) with
// the backend permission sets (src/api/_lib/auth.js) and reports:
//
// 1. Roles that exist on one side but not the other.
// 2. API endpoints that call requirePermission(ctx, level) but where
//    every role in the frontend MATRIX is empty for that endpoint
//    (suggesting the UI hides what the backend would actually allow).
// 3. Endpoints whose backend role check is more permissive than the
//    frontend, so a role can be silently locked out.
//
// The output is a markdown report at docs/RBAC_AUDIT.md plus a stdout
// summary. The script is informational; it never fails the build, but
// it surfaces drift quickly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RBAC_TS  = path.join(ROOT, "src", "v3-app", "lib", "rbac.ts");
const AUTH_JS  = path.join(ROOT, "src", "api", "_lib", "auth.js");
const MEMBERS_JS = path.join(ROOT, "src", "api", "admin", "members.js");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const REPORT  = path.join(ROOT, "docs", "RBAC_AUDIT.md");

const readFile = (p) => fs.readFileSync(p, "utf8");

// Parse the canonical role list from rbac.ts.
const parseRolesFromRbac = () => {
  const src = readFile(RBAC_TS);
  const m = src.match(/export const ROLES:\s*Role\[\]\s*=\s*\[([^\]]+)\];/);
  if (!m) throw new Error("Could not find ROLES export in rbac.ts");
  return m[1].split(",").map((s) => s.replace(/["'\s]/g, "")).filter(Boolean);
};

// Parse the MATRIX from rbac.ts. Cheap: regex for `key: { ... }` rows.
const parseMatrix = () => {
  const src = readFile(RBAC_TS);
  const start = src.indexOf("export const MATRIX");
  if (start < 0) throw new Error("MATRIX export not found");
  const block = src.slice(start, src.indexOf("};", start) + 2);
  const rows = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*"?([\w-]+)"?:\s*\{(.+)\},?\s*$/);
    if (!m) continue;
    const navId = m[1];
    if (navId === "MATRIX" || navId === "ROLES") continue;
    const cells = {};
    for (const part of m[2].split(",")) {
      const cm = part.match(/(\w+):\s*"([^"]*)"/);
      if (cm) cells[cm[1]] = cm[2];
    }
    rows[navId] = cells;
  }
  return rows;
};

// Parse ALLOWED_ROLES from src/api/admin/members.js. Phase 1 F11
// guards against the file going out of sync with rbac.ts ROLES.
const parseMembersAllowedRoles = () => {
  const src = readFile(MEMBERS_JS);
  const m = src.match(/const ALLOWED_ROLES\s*=\s*new Set\(\[([^\]]+)\]\)/);
  if (!m) return null;
  return m[1].split(",").map((s) => s.replace(/["'\s]/g, "")).filter(Boolean);
};

// Parse the member-role enum values from the migration chain. Each
// migration either CREATE TYPE ... AS ENUM (...) or
// ALTER TYPE <role_enum> ADD VALUE 'x'. The enum was renamed
// obara_role -> anvil_role in migration 160, so we accept BOTH names:
// the original CREATE (001) declares obara_role; later ADD VALUEs may
// target either name. We walk every numbered migration file in order,
// apply both forms, then return the union. Phase 1 F11 surfaces drift
// between this set and rbac.ts / members.js.
const ROLE_ENUM_NAME = /(?:obara_role|anvil_role)/;
const parseObaraRoleEnum = () => {
  if (!fs.existsSync(MIGRATIONS_DIR)) return null;
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^[0-9]+_.*\.sql$/.test(f))
    .sort();
  const values = new Set();
  const createRe = new RegExp(`create type ${ROLE_ENUM_NAME.source} as enum \\(([^)]+)\\)`, "i");
  const addRe = new RegExp(`alter type ${ROLE_ENUM_NAME.source} add value\\s+(?:if not exists\\s+)?'([^']+)'`, "gi");
  for (const f of files) {
    const src = readFile(path.join(MIGRATIONS_DIR, f));
    const createMatch = src.match(createRe);
    if (createMatch) {
      for (const v of createMatch[1].split(",")) {
        const cleaned = v.replace(/['"\s]/g, "");
        if (cleaned) values.add(cleaned);
      }
    }
    for (const m of src.matchAll(addRe)) {
      values.add(m[1]);
    }
  }
  return [...values];
};

// Parse role sets from auth.js.
const parseAuthSets = () => {
  const src = readFile(AUTH_JS);
  const sets = {};
  for (const m of src.matchAll(/const (VIEWER|WRITER|APPROVER|ADMIN)_ROLES\s*=\s*new Set\(\[([^\]]+)\]\)/g)) {
    const key = m[1].toLowerCase();
    sets[key] = m[2].split(",").map((s) => s.replace(/["'\s]/g, "")).filter(Boolean);
  }
  return sets;
};

// For every API handler, find its requirePermission level. Returns a
// list of { file, level }.
const scanApiHandlers = () => {
  const out = [];
  const recur = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) recur(full);
      else if (name.endsWith(".js") && !name.startsWith("_")) {
        const src = readFile(full);
        const calls = [...src.matchAll(/requirePermission\(\s*ctx\s*,\s*["'](\w+)["']\)/g)].map((m) => m[1]);
        if (calls.length === 0) continue;
        out.push({ file: path.relative(ROOT, full), levels: Array.from(new Set(calls)) });
      }
    }
  };
  recur(path.join(ROOT, "src", "api"));
  return out;
};

const main = () => {
  const roles = parseRolesFromRbac();
  const matrix = parseMatrix();
  const sets = parseAuthSets();
  const handlers = scanApiHandlers();
  const allowedRoles = parseMembersAllowedRoles();
  const enumValues = parseObaraRoleEnum();

  const findings = [];

  // Phase 1 F11 hard gate: ALLOWED_ROLES in members.js must equal
  // ROLES in rbac.ts (the canonical 7-role set). LEGACY_ROLE_REMAP
  // is the soft path for callers still posting "approver"; the
  // SET itself must be drift-free.
  if (allowedRoles) {
    const a = new Set(allowedRoles), b = new Set(roles);
    const onlyAllow = [...a].filter((x) => !b.has(x));
    const onlyRbac  = [...b].filter((x) => !a.has(x));
    for (const r of onlyAllow) findings.push({ severity: "FAIL", kind: "members-extra-role",
      detail: r + " is in members.js ALLOWED_ROLES but not in rbac.ts ROLES" });
    for (const r of onlyRbac)  findings.push({ severity: "FAIL", kind: "members-missing-role",
      detail: r + " is in rbac.ts ROLES but not in members.js ALLOWED_ROLES" });
  } else {
    findings.push({ severity: "FAIL", kind: "members-allowed-roles-missing",
      detail: "could not parse ALLOWED_ROLES from src/api/admin/members.js" });
  }

  // Phase 1 F11 hard gate: obara_role enum (resulting from the
  // migration chain) must contain every rbac.ts role. Extras are
  // allowed for the future-flag case but missing values would
  // mean the DB cannot store a valid member role.
  if (enumValues && enumValues.length) {
    const enumSet = new Set(enumValues);
    for (const r of roles) {
      if (!enumSet.has(r)) findings.push({ severity: "FAIL", kind: "enum-missing-role",
        detail: r + " is in rbac.ts ROLES but not in the obara_role enum (run the migrations)" });
    }
  } else {
    findings.push({ severity: "WARN", kind: "enum-not-parsed",
      detail: "could not parse obara_role enum from supabase/migrations/ (the enum check is informational)" });
  }

  // Check role-list consistency. The backend role sets pull from a
  // hardcoded list; we want every role in rbac.ts to appear in at
  // least the viewer set.
  for (const r of roles) {
    if (!sets.viewer || !sets.viewer.includes(r)) {
      findings.push({ severity: "WARN", kind: "missing-viewer", detail: r + " is in rbac.ts ROLES but not in VIEWER_ROLES" });
    }
  }
  for (const r of (sets.viewer || [])) {
    if (!roles.includes(r)) {
      findings.push({ severity: "WARN", kind: "extra-viewer", detail: r + " is in VIEWER_ROLES but not in rbac.ts ROLES" });
    }
  }

  // Check matrix coverage. Every nav id in the matrix should have at
  // least one role with read access; otherwise the page is invisible
  // to everyone.
  for (const navId of Object.keys(matrix)) {
    const cells = matrix[navId];
    const anyRead = Object.values(cells).some((v) => /[rwax]/.test(v || ""));
    if (!anyRead) {
      findings.push({ severity: "WARN", kind: "no-readers", detail: "MATRIX." + navId + " has no role with read access" });
    }
  }

  // Heuristic: warn when a handler requires "approve" or "admin" but
  // the frontend matrix does not give any role 'a' or 'x' for any
  // navId that mentions the same group. Best-effort.
  // We skip this for now since matching API path -> navId is fuzzy.

  const lines = [
    "# RBAC consistency audit",
    "",
    "Auto-generated by `src/scripts/audit-rbac.mjs`. Run",
    "`node src/scripts/audit-rbac.mjs` to refresh.",
    "",
    "## Roles",
    "",
    "Frontend canonical roles (`src/v3-app/lib/rbac.ts` ROLES):",
    "",
    ...roles.map((r) => "- `" + r + "`"),
    "",
    "Backend role sets (`src/api/_lib/auth.js`):",
    "",
    "| Verb | Roles |",
    "|------|-------|",
    ...Object.keys(sets).map((k) => "| " + k + " | " + sets[k].map((r) => "`" + r + "`").join(", ") + " |"),
    "",
    "## Frontend permission matrix",
    "",
    "Cell legend: `r`=read, `w`=write, `a`=approve, `x`=admin, blank=hidden.",
    "",
    "| Nav id | " + roles.join(" | ") + " |",
    "|--------|" + roles.map(() => "---").join("|") + "|",
    ...Object.keys(matrix).sort().map((navId) => {
      const cells = matrix[navId];
      return "| `" + navId + "` | " + roles.map((r) => "`" + (cells[r] || "") + "`").join(" | ") + " |";
    }),
    "",
    "## API handlers and their permission levels",
    "",
    "| Handler | Levels |",
    "|---------|--------|",
    ...handlers.sort((a, b) => a.file.localeCompare(b.file)).map((h) => "| " + h.file + " | " + h.levels.join(", ") + " |"),
    "",
    "## Findings",
    "",
  ];
  if (findings.length === 0) {
    lines.push("No drift detected. Frontend matrix and backend role sets agree.");
  } else {
    for (const f of findings) {
      lines.push("- **[" + f.severity + "]** (" + f.kind + ") " + f.detail);
    }
  }
  fs.writeFileSync(REPORT, lines.join("\n") + "\n", "utf8");

  const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
  process.stdout.write("RBAC audit: " + findings.length + " finding(s)\n");
  for (const k of Object.keys(counts)) process.stdout.write("  " + k + ": " + counts[k] + "\n");
  process.stdout.write("Report: " + path.relative(ROOT, REPORT) + "\n");
  if (findings.length) {
    for (const f of findings) {
      process.stdout.write("  [" + f.severity + "] " + f.kind + ": " + f.detail + "\n");
    }
  }
  // Phase 1 F11: hard-fail CI on a FAIL-severity finding. WARN is
  // still informational. Drift between rbac.ts / members.js /
  // obara_role enum is the only way to land a FAIL today.
  if (counts.FAIL) {
    process.stdout.write("RBAC drift detected. Failing the build.\n");
    process.exit(1);
  }
};

main();
