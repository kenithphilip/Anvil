// Static analyzer that confirms each screen's submit handlers are wired
// to a real persisting backend handler. Walks every screen TSX, finds
// onSubmit/onClick handlers that perform a mutation, and confirms the
// matching API route file requires permission, persists, and audits.
//
// Output: docs/WRITE_PATH_AUDIT.md plus a stdout summary. Exits non-zero
// on any finding rated WARN or higher.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS = path.join(ROOT, "src", "v3-app", "screens");
const API_DIR = path.join(ROOT, "src", "api");
const REPORT = path.join(ROOT, "docs", "WRITE_PATH_AUDIT.md");

const MUTATION_VERBS = new Set([
  "create", "update", "upsert", "delete", "remove",
  "push", "insert", "post", "patch", "send",
  "approve", "reject", "ack", "reconcile", "amend",
  "promote", "scan", "sync", "refresh", "rollback",
  "inviteMember", "resendInvite", "revokeMember", "updateMemberRole",
  "deleteHoliday", "deleteLeadTime", "deleteContract",
  "deleteCustomerLocation", "deleteApprovalThreshold", "deleteItemMaster",
  "bulkItemMaster", "upsertHoliday", "upsertLeadTime", "upsertContract",
  "upsertCustomerLocation", "upsertApprovalThreshold", "upsertItemMaster",
  "upsertInventory", "deleteInventory", "refreshFxRates",
  "regenerate", "retry", "publish", "save",
]);

const SUCCESS_TOKENS = ["flashOk", "notifySuccess", "notifyLive", '"good"', "kind: \"good\""];
const RELOAD_TOKENS  = [".reload(", "reload()", "setList(", "setRows(", "setOrders("];
const ERROR_TOKENS   = ["flashErr", "notifyError", "setErr(", "kind: \"bad\""];

const findings = [];

const screenFiles = () => {
  const out = [];
  for (const name of fs.readdirSync(SCREENS)) {
    if (name.endsWith(".test.tsx")) continue;
    if (!name.endsWith(".tsx")) continue;
    out.push(path.join(SCREENS, name));
  }
  return out;
};

const parseTsx = (src) =>
  parse(src, { sourceType: "module", plugins: ["jsx", "typescript"], errorRecovery: true });

function* walk(node) {
  if (!node || typeof node !== "object") return;
  yield node;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) yield* walk(c);
    } else if (child && typeof child === "object" && child.type) {
      yield* walk(child);
    }
  }
}

const collectFunctions = (ast) => {
  const out = new Map();
  for (const node of walk(ast.program)) {
    if (node.type === "VariableDeclarator" && node.id?.name) {
      const init = node.init;
      if (!init) continue;
      if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
        out.set(node.id.name, init);
      }
    }
    if (node.type === "FunctionDeclaration" && node.id?.name) {
      out.set(node.id.name, node);
    }
  }
  return out;
};

const collectHandlers = (ast, funcs) => {
  const refs = [];
  for (const node of walk(ast.program)) {
    if (node.type !== "JSXAttribute") continue;
    const name = node.name?.name;
    if (!name || !/^on[A-Z]/.test(name)) continue;
    const value = node.value;
    if (!value) continue;
    if (value.type === "JSXExpressionContainer") {
      const expr = value.expression;
      if (expr.type === "Identifier" && funcs.has(expr.name)) {
        refs.push({ propName: name, ident: expr.name, fn: funcs.get(expr.name), inline: false });
      } else if (expr.type === "ArrowFunctionExpression" || expr.type === "FunctionExpression") {
        refs.push({ propName: name, ident: null, fn: expr, inline: true });
      }
    }
  }
  return refs;
};

const fnSource = (src, fn) => {
  if (!fn || typeof fn.start !== "number" || typeof fn.end !== "number") return "";
  return src.slice(fn.start, fn.end);
};

const detectMutation = (body) => {
  let m;
  // Match both direct calls `ObaraBackend.orders.create(...)` AND
  // indirect references like `const fn = ObaraBackend.sales.createShipment`
  // (which is the common shipments/leads/svc-visits pattern). A trailing
  // `(` is no longer required.
  const obaraRe = /ObaraBackend\??\.\??([a-zA-Z_$][a-zA-Z0-9_$]*)\??\.\??([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  while ((m = obaraRe.exec(body))) {
    if (MUTATION_VERBS.has(m[2])) return { kind: "obara", target: m[1] + "." + m[2], method: m[2] };
  }
  const adminRe = /adminCrudFetch\(\s*["'`]([^"'`]+)["'`][\s\S]{0,200}?method:\s*["'](POST|PATCH|DELETE|PUT)["']/g;
  while ((m = adminRe.exec(body))) return { kind: "adminCrudFetch", target: m[1], method: m[2] };
  const apiRe = /apiFetch\(\s*["'`]([^"'`]+)["'`][\s\S]{0,200}?method:\s*["'](POST|PATCH|DELETE|PUT)["']/g;
  while ((m = apiRe.exec(body))) return { kind: "apiFetch", target: m[1], method: m[2] };
  const fetchRe = /fetch\(\s*["'`](\/api\/[^"'`]+)["'`][\s\S]{0,200}?method:\s*["'](POST|PATCH|DELETE|PUT)["']/g;
  while ((m = fetchRe.exec(body))) return { kind: "fetch", target: m[1], method: m[2] };
  return null;
};

const containsAny = (body, tokens) => tokens.some((t) => body.includes(t));

let _apiCache = null;
const apiFiles = () => {
  if (_apiCache) return _apiCache;
  const out = [];
  const recur = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) recur(full);
      else if (name.endsWith(".js")) out.push(full);
    }
  };
  recur(API_DIR);
  _apiCache = out;
  return out;
};

// camelCase to snake_case so client targets like "sourcePos.ack" map to
// the "source_pos/" directory.
const camelToSnake = (s) => s.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase());

const findApiHandlers = (target) => {
  const parts = target.split(/[./]/).filter(Boolean);
  const segment = (parts[0] || "");
  const segmentSnake = camelToSnake(segment);
  const verb = (parts[1] || "").toLowerCase();
  const verbSnake = camelToSnake(verb);
  const candidates = [];
  for (const f of apiFiles()) {
    const rel = path.relative(API_DIR, f);
    const top = rel.split(path.sep)[0];
    if (segment && top !== segment && top !== segmentSnake) continue;
    if (rel.includes("/cron.")) continue;
    candidates.push(f);
  }
  if (verb) {
    candidates.sort((a, b) => {
      const aName = path.basename(a).toLowerCase();
      const bName = path.basename(b).toLowerCase();
      const aHit = aName.includes(verb) || aName.includes(verbSnake) ? 0 : 1;
      const bHit = bName.includes(verb) || bName.includes(verbSnake) ? 0 : 1;
      return aHit - bHit;
    });
  }
  return candidates;
};

const auditApiFile = (filePath) => {
  const src = fs.readFileSync(filePath, "utf8");
  return {
    requirePerm: /requirePermission\(\s*ctx\s*,/.test(src),
    persists:    /\.from\([^)]+\)\.(insert|update|upsert|delete)\(/.test(src),
    audited:     /recordAudit\(/.test(src),
  };
};

const SEVERITY = ["OK", "INFO", "WARN", "FAIL"];
const worse = (a, b) => SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b;

const auditScreen = (filePath) => {
  const src = fs.readFileSync(filePath, "utf8");
  const rel = path.relative(ROOT, filePath);
  let ast;
  try { ast = parseTsx(src); } catch (e) {
    findings.push({ severity: "FAIL", screen: rel, handler: "(parse)", reason: "Could not parse: " + e.message });
    return;
  }
  const funcs = collectFunctions(ast);
  const handlers = collectHandlers(ast, funcs);
  for (const h of handlers) {
    const body = fnSource(src, h.fn);
    if (!body) continue;
    const mut = detectMutation(body);
    if (!mut) continue;

    // Match `await ObaraBackend...` and the wrapped `await (Obara... ||
    // fallback)` pattern admin.tsx uses. Allow optional leading parens
    // and negation between `await` and the mutation token.
    const awaited = /\bawait\s+[(!]*\s*(ObaraBackend|apiFetch|adminCrudFetch|fetch)\b/.test(body);
    const success = containsAny(body, SUCCESS_TOKENS);
    const reloads = containsAny(body, RELOAD_TOKENS);
    const errored = containsAny(body, ERROR_TOKENS) && /\bcatch\b/.test(body);

    let severity = "OK";
    const reasons = [];
    if (!awaited) { severity = worse(severity, "WARN"); reasons.push("not awaited"); }
    if (!success) { severity = worse(severity, "WARN"); reasons.push("no success feedback"); }
    if (!reloads) { severity = worse(severity, "WARN"); reasons.push("no list reload"); }
    if (!errored) { severity = worse(severity, "WARN"); reasons.push("no error catch"); }

    let apiVerdict = "(skipped)";
    if (mut.kind === "obara") {
      const candidates = findApiHandlers(mut.target);
      if (candidates.length === 0) {
        severity = worse(severity, "WARN");
        reasons.push("no matching api handler");
      } else {
        const v = auditApiFile(candidates[0]);
        const flags = [];
        if (!v.requirePerm) { flags.push("no requirePermission"); severity = worse(severity, "WARN"); }
        if (!v.persists) { flags.push("does not persist"); severity = worse(severity, "FAIL"); }
        if (!v.audited) { flags.push("no recordAudit"); severity = worse(severity, "INFO"); }
        apiVerdict = path.relative(ROOT, candidates[0]) + (flags.length ? " [" + flags.join(",") + "]" : " [ok]");
      }
    } else {
      apiVerdict = mut.target + " (" + mut.method + ")";
    }

    findings.push({
      severity, screen: rel,
      handler: h.ident || "(inline " + h.propName + ")",
      mutationTarget: mut.target + (mut.method ? " " + mut.method : ""),
      api: apiVerdict,
      reason: reasons.join("; ") || "ok",
    });
  }
};

const writeReport = () => {
  const counts = { OK: 0, INFO: 0, WARN: 0, FAIL: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const lines = [
    "# Write-path audit",
    "",
    "Auto-generated by `src/scripts/audit-write-paths.mjs`. Each row is a",
    "screen handler that performs a mutation. Run `npm run audit:write-paths`",
    "to refresh.",
    "",
    "Summary:",
    "- OK:   " + counts.OK,
    "- INFO: " + counts.INFO,
    "- WARN: " + counts.WARN,
    "- FAIL: " + counts.FAIL,
    "",
    "| Severity | Screen | Handler | Mutation | API handler | Reason |",
    "|----------|--------|---------|----------|-------------|--------|",
  ];
  const sortKey = (f) => SEVERITY.indexOf(f.severity) + "::" + f.screen + "::" + f.handler;
  const sorted = findings.slice().sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  for (const f of sorted) {
    lines.push(
      "| " + f.severity +
      " | " + f.screen.replace(/\|/g, "\\|") +
      " | `" + (f.handler || "-").replace(/\|/g, "\\|") + "`" +
      " | " + (f.mutationTarget || "-").replace(/\|/g, "\\|") +
      " | " + (f.api || "-").replace(/\|/g, "\\|") +
      " | " + (f.reason || "-").replace(/\|/g, "\\|") +
      " |"
    );
  }
  fs.writeFileSync(REPORT, lines.join("\n") + "\n", "utf8");
};

const main = () => {
  const files = screenFiles();
  for (const f of files) auditScreen(f);
  writeReport();
  const counts = { OK: 0, INFO: 0, WARN: 0, FAIL: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  process.stdout.write("Write-path audit: " + findings.length + " mutation handlers across " + files.length + " screens\n");
  process.stdout.write("  OK:   " + counts.OK + "\n");
  process.stdout.write("  INFO: " + counts.INFO + "\n");
  process.stdout.write("  WARN: " + counts.WARN + "\n");
  process.stdout.write("  FAIL: " + counts.FAIL + "\n");
  process.stdout.write("Report: " + path.relative(ROOT, REPORT) + "\n");
  const bad = findings.filter((f) => f.severity === "WARN" || f.severity === "FAIL");
  if (bad.length) {
    process.stdout.write("\nFindings to remediate:\n");
    for (const f of bad) {
      process.stdout.write("  [" + f.severity + "] " + f.screen + " :: " + f.handler + " -> " + f.mutationTarget + " :: " + f.reason + "\n");
    }
  }
  process.exit(counts.FAIL > 0 ? 1 : 0);
};

main();
