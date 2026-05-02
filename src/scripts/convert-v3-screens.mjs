// One-shot converter: src/v3/screens*/wired-*.jsx -> src/v3-app/screens/*.jsx
//
// The legacy build concatenates many JSX files. Each file ends with a
// `window.<Name> = Wired<Name>;` line that registers the component. This
// converter:
//
// 1. Walks SCREEN_FILES from build-v3.mjs in order so last-write-wins
//    matches the legacy load order (CRUD overlays beat base files).
// 2. Builds a (windowName -> finalFilePath) map.
// 3. For each route, transforms the legacy file content:
//    - Add explicit ESM imports for React hooks, primitives, icons,
//      helpers, RBAC, Prefs, ObaraBackend.
//    - Drop top-level helper redefinitions (lib/helpers.js owns them).
//    - Drop the `const { useState: useStateW, ... } = React;` shim and
//      rename usages back to plain useState/useEffect/useMemo.
//    - Rewrite globals: window.ObaraBackend -> ObaraBackend, etc.
//    - Replace the trailing `window.X = Wired...;` with default export.
//
// 4. Writes the result to src/v3-app/screens/<routeFile>.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILD_FILE = path.join(ROOT, "src", "scripts", "build-v3.mjs");
const V3_DIR = path.join(ROOT, "src", "v3");
const OUT_DIR = path.join(ROOT, "src", "v3-app", "screens");

const ROUTE_MAP = {
  HomeEngineer: "home.jsx",
  HomeManager: "home-manager.jsx",
  HomeAdmin: "home-admin.jsx",
  Inbox: "intake.jsx",
  SOList: "orders.jsx",
  SOWorkspace: "so-workspace.jsx",
  SOIntake: "so-intake.jsx",
  SOHistory: "so-history.jsx",
  InternalSOs: "internal-sos.jsx",
  Approvals: "approvals.jsx",
  Leads: "leads.jsx",
  Opportunities: "opps.jsx",
  Projects: "projects.jsx",
  Shipments: "shipments.jsx",
  SourcePOs: "source-pos.jsx",
  SPOList: "source-pos.jsx",
  SparesMatrix: "spares.jsx",
  ServiceVisits: "service-visits.jsx",
  AMCSchedule: "amc.jsx",
  CARReports: "car.jsx",
  TallyPush: "tally-push.jsx",
  TallyMasters: "tally-masters.jsx",
  TallyReconcile: "tally-reconcile.jsx",
  EInvoice: "einvoice.jsx",
  CostMargin: "cost.jsx",
  Customers: "customers.jsx",
  Items: "items.jsx",
  BomImport: "bom-import.jsx",
  GunsViewer: "guns-viewer.jsx",
  EquipmentHierarchy: "equipment-hierarchy.jsx",
  JbmImporter: "jbm-importer.jsx",
  MasterDataGraph: "graph.jsx",
  Forecasts: "forecasts.jsx",
  EvalSuites: "evals.jsx",
  ProfileStudio: "studio.jsx",
  Findings: "anomaly.jsx",
  Duplicates: "duplicates.jsx",
  Communications: "comms.jsx",
  EmailTriage: "email.jsx",
  Security: "security.jsx",
  AuditLog: "audit.jsx",
  AdminCenter: "admin.jsx",
  BackendConnect: "connect.jsx",
  Onboarding: "onboarding.jsx",
  FormatGuide: "format-guide.jsx",
};

const readScreenFiles = () => {
  const text = fs.readFileSync(BUILD_FILE, "utf8");
  const start = text.indexOf("const SCREEN_FILES = [");
  const end = text.indexOf("];", start);
  if (start < 0 || end < 0) throw new Error("SCREEN_FILES block not found");
  const block = text.slice(start, end);
  const matches = [...block.matchAll(/"([^"]+\.jsx)"/g)].map((m) => m[1]);
  return matches;
};

const findExportsInFile = (relPath) => {
  const full = path.join(V3_DIR, relPath);
  if (!fs.existsSync(full)) return [];
  const text = fs.readFileSync(full, "utf8");
  const exports = [];
  const reA = /\bwindow\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g;
  const reB = /Object\.assign\s*\(\s*window\s*,\s*\{([^}]+)\}\s*\)/g;
  for (const m of text.matchAll(reA)) {
    exports.push({ name: m[1], local: m[2] });
  }
  for (const m of text.matchAll(reB)) {
    const inner = m[1];
    const names = inner.split(",").map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      const [k, v] = n.split(":").map((s) => s.trim());
      exports.push({ name: k, local: v || k });
    }
  }
  return exports;
};

const buildExportMap = () => {
  const screens = readScreenFiles();
  const map = {};
  for (const rel of screens) {
    const exps = findExportsInFile(rel);
    for (const exp of exps) {
      map[exp.name] = { source: rel, local: exp.local };
    }
  }
  return map;
};

const HELPER_NAMES = ["useFetch", "ageLabel", "fmtINRShort", "stageOf", "sevOf"];

const PRIMITIVE_NAMES = [
  "Btn", "Chip", "Dot", "Sev", "Prov",
  "WSTitle", "WSTabs", "Card", "KV", "KPI", "KPIRow", "Steps",
  "Banner", "RailPanel", "Stream",
  "fmtINR", "fmtUSD", "fmtPct",
];

const detectIdentifiers = (text, names) => {
  const used = new Set();
  for (const n of names) {
    const re = new RegExp(`(?<![\\w$.])${n}(?![\\w$])`, "g");
    if (re.test(text)) used.add(n);
  }
  return Array.from(used).sort();
};

// Strip a top-level `const NAME = (...) => { ... };` block by counting
// braces, OR a single-line form.
const stripHelperBlock = (text, name) => {
  const single = new RegExp(`^const\\s+${name}\\s*=[^;\\n]*;\\s*$`, "gm");
  text = text.replace(single, "");
  const start = text.indexOf(`const ${name} = `);
  if (start < 0) return text;
  let i = text.indexOf("{", start);
  if (i < 0) return text;
  let depth = 1;
  i++;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  while (i < text.length && (text[i] === ";" || text[i] === " ")) i++;
  if (text[i] === "\n") i++;
  return text.slice(0, start) + text.slice(i);
};

const transform = (rawText, windowName, localName) => {
  let text = rawText;

  text = text.replace(
    /const\s*\{\s*useState\s*:\s*useStateW[^}]*\}\s*=\s*React\s*;\s*/g,
    "// (React hooks imported from 'react')\n"
  );
  text = text.replace(/^const\s*\{\s*[^}]+\}\s*=\s*React\s*;\s*$/m, "");

  text = text.replace(/\buseStateW\b/g, "useState");
  text = text.replace(/\buseEffectW\b/g, "useEffect");
  text = text.replace(/\buseMemoW\b/g, "useMemo");
  text = text.replace(/\buseRefW\b/g, "useRef");
  text = text.replace(/\buseCallbackW\b/g, "useCallback");

  for (const h of HELPER_NAMES) text = stripHelperBlock(text, h);

  text = text.replace(/\bwindow\.ObaraBackend\b/g, "ObaraBackend");
  text = text.replace(/\bwindow\.RBAC\b/g, "RBAC");
  text = text.replace(/\bwindow\.Prefs\b/g, "Prefs");
  text = text.replace(/\bwindow\.NAV\b/g, "NAV");
  text = text.replace(/\bwindow\.ROLES\b/g, "ROLES");

  // Strip ALL trailing window.X = Y; assignments + Object.assign(window, ...)
  // blocks, since this file becomes an ESM module that owns one default
  // export. Multiple legacy files set multiple names from one source file
  // (e.g. wired-source-pos-c.jsx exports both SourcePOs and SPOList); we
  // do not want any of those to leak into the converted output.
  text = text.replace(
    /^\s*Object\.assign\s*\(\s*window\s*,[^)]*\)\s*;\s*$/gm,
    ""
  );
  text = text.replace(
    /^\s*window\.[A-Za-z_$][\w$]*\s*=\s*[A-Za-z_$][\w$]*\s*;\s*$/gm,
    ""
  );

  const usedPrim = detectIdentifiers(text, PRIMITIVE_NAMES);
  const usedHelpers = detectIdentifiers(text, HELPER_NAMES);

  const usesIcon = /\bIcon\.[A-Za-z]/.test(text);
  const usesObara = /\bObaraBackend\b/.test(text);
  const usesRBAC = /\bRBAC\b/.test(text);
  const usesPrefs = /\bPrefs\b/.test(text);
  const usesNav = /\bNAV\b/.test(text);
  const usesRoles = /\bROLES\b/.test(text);

  const hookSet = new Set(["useState", "useEffect"]);
  if (/\buseMemo\b/.test(text)) hookSet.add("useMemo");
  if (/\buseRef\b/.test(text)) hookSet.add("useRef");
  if (/\buseCallback\b/.test(text)) hookSet.add("useCallback");
  if (/\buseLayoutEffect\b/.test(text)) hookSet.add("useLayoutEffect");

  const imports = [];
  imports.push(`import React, { ${[...hookSet].sort().join(", ")} } from "react";`);
  if (usedHelpers.length) imports.push(`import { ${usedHelpers.join(", ")} } from "../lib/helpers.js";`);
  if (usedPrim.length) imports.push(`import { ${usedPrim.join(", ")} } from "../lib/primitives.jsx";`);
  if (usesIcon) imports.push(`import { Icon } from "../lib/icons.jsx";`);
  if (usesObara) imports.push(`import { ObaraBackend } from "../lib/api.js";`);
  if (usesRBAC) imports.push(`import { RBAC } from "../lib/rbac.js";`);
  if (usesPrefs) imports.push(`import { Prefs } from "../lib/preferences.js";`);
  if (usesNav || usesRoles) {
    const navImports = [];
    if (usesNav) navImports.push("NAV");
    if (usesRoles) navImports.push("ROLES");
    imports.push(`import { ${navImports.join(", ")} } from "../lib/nav.js";`);
  }

  const header = imports.join("\n") + "\n\n";
  const trimmed = text.replace(/^\s+/, "");
  const footer = `\n\nexport default ${localName};\n`;
  return header + trimmed + footer;
};

const main = () => {
  const exportMap = buildExportMap();
  let written = 0;
  let skipped = 0;

  for (const [windowName, target] of Object.entries(ROUTE_MAP)) {
    const found = exportMap[windowName];
    if (!found) {
      console.warn(`[convert] no legacy file exports window.${windowName}; skipping ${target}`);
      skipped++;
      continue;
    }
    const sourcePath = path.join(V3_DIR, found.source);
    const raw = fs.readFileSync(sourcePath, "utf8");
    const out = transform(raw, windowName, found.local);
    const dest = path.join(OUT_DIR, target);
    fs.writeFileSync(dest, out);
    console.log(`wrote ${path.relative(ROOT, dest)} (from ${found.source}, exports ${windowName})`);
    written++;
  }
  console.log(`\n[convert] wrote ${written}, skipped ${skipped}`);
};

main();
