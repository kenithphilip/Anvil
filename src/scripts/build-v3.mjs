// build-v3.mjs
// Assembles src/v3/* into public/v3.html. Mirrors the legacy build pipeline:
// concatenate the design system files into one HTML so a single load brings
// up the full operator console.
//
// Output: public/v3.html. The legacy build still produces public/index.html.
// A small shim in index.html redirects to v3.html when ?v3=1 is on.
//
// Run via:  npm run build:v3  (or)  node src/scripts/build-v3.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const V3 = path.join(ROOT, "src", "v3");
const PUB = path.join(ROOT, "public");
const OUT = path.join(PUB, "v3.html");

const read = (p) => fs.readFileSync(p, "utf8");

// Order matters for the screens. Several files reference Window-attached
// names from earlier files. Static demos load first, then "wired"
// versions in screens-wired/ overwrite the window.* exports with live-data
// implementations. The static files remain in the bundle so the design
// remains a self-documenting reference.
const SCREEN_FILES = [
  // Static demo screens (design templates with mock data)
  "screens/screens-home.jsx",
  "screens/screens-orders.jsx",
  "screens/screens-procurement.jsx",
  "screens/screens-finance.jsx",
  "screens/screens-logistics.jsx",
  "screens/screens-masters.jsx",
  "screens/screens-growth.jsx",
  "screens/screens-overview.jsx",
  "screens/screens-admin.jsx",
  "screens/screens-system.jsx",
  "screens/screens-auth.jsx",
  "screens/screens-cover.jsx",
  "screens/screens-docs.jsx",
  // intentionally skip screens-mobile + ios-frame; they are mobile-shell
  // surfaces that ship in a follow-up. See docs/ROADMAP.md.

  // Wired screens override the static demos with live ObaraBackend data.
  // Order matters: helpers (useFetch / ageLabel / fmtINRShort / stageOf /
  // sevOf) live at top level in wired-home.jsx, so it loads first and the
  // rest reference them without redeclaration. Each wired file ends with
  // `window.<Name> = Wired<Name>;` so the App router picks up the live
  // version over the static demo from screens/.
  "screens-wired/wired-home.jsx",
  "screens-wired/wired-orders.jsx",
  // Wave A: Workflows
  "screens-wired/wired-inbox.jsx",
  "screens-wired/wired-so-intake.jsx",
  "screens-wired/wired-so-workspace.jsx",
  "screens-wired/wired-approvals.jsx",
  "screens-wired/wired-internal-sos.jsx",
  // Wave B: Sales
  "screens-wired/wired-leads-b.jsx",
  "screens-wired/wired-opps-b.jsx",
  "screens-wired/wired-projects-b.jsx",
  "screens-wired/wired-shipments-b.jsx",
  // Wave C: Procurement + Service
  "screens-wired/wired-source-pos-c.jsx",
  "screens-wired/wired-spares-c.jsx",
  "screens-wired/wired-service-visits-c.jsx",
  "screens-wired/wired-amc-c.jsx",
  "screens-wired/wired-car-c.jsx",
  // Wave D: Finance
  "screens-wired/wired-tally-masters-d.jsx",
  "screens-wired/wired-tally-push-d.jsx",
  "screens-wired/wired-tally-reconcile-d.jsx",
  "screens-wired/wired-einvoice-d.jsx",
  "screens-wired/wired-cost-margin-d.jsx",
  // Wave E: Data + Quality
  "screens-wired/wired-customers-e.jsx",
  "screens-wired/wired-items-e.jsx",
  "screens-wired/wired-graph-e.jsx",
  "screens-wired/wired-forecasts-e.jsx",
  "screens-wired/wired-evals-e.jsx",
  "screens-wired/wired-studio-e.jsx",
  "screens-wired/wired-anomaly-e.jsx",
  "screens-wired/wired-duplicates-e.jsx",
  "screens-wired/wired-aliases-e.jsx",
  // Wave F: Comms + Admin
  "screens-wired/wired-comms-f.jsx",
  "screens-wired/wired-email-f.jsx",
  "screens-wired/wired-security-f.jsx",
  "screens-wired/wired-audit-f.jsx",
  "screens-wired/wired-admin-f.jsx",
  // Phase 4: shell-level overrides (Cmd+K palette + Thread drawer)
  "screens-wired/wired-cmdk.jsx",
  "screens-wired/wired-thread.jsx",
  // Migration gap fills (legacy showBackendModal etc.)
  "screens-wired/wired-backend-connect.jsx",
  "screens-wired/wired-toasts.jsx",
  "screens-wired/wired-onboarding.jsx",
  "screens-wired/wired-format-guide.jsx",
  // Phase 7 batch 1 + 2 (large surfaces). These OVERRIDE earlier wired
  // files via the order rule (last-write wins on window.*).
  "screens-wired/wired-spares-worksheet.jsx", // overrides wired-spares-c.jsx
  "screens-wired/wired-graph-cytoscape.jsx",  // overrides wired-graph-e.jsx
  "screens-wired/wired-bom-import.jsx",
  "screens-wired/wired-guns-viewer.jsx",
  "screens-wired/wired-so-history.jsx",
  "screens-wired/wired-equipment-hierarchy.jsx",
  "screens-wired/wired-jbm-importer.jsx",
  // Phase 7 batch 3 (CRUD completeness overlays)
  "screens-wired/wired-shipments-crud.jsx",       // overrides wired-shipments-b.jsx
  "screens-wired/wired-internal-sos-crud.jsx",    // overrides wired-internal-sos.jsx
  "screens-wired/wired-einvoice-crud.jsx",        // overrides wired-einvoice-d.jsx
  "screens-wired/wired-service-visits-crud.jsx",  // overrides wired-service-visits-c.jsx
  "screens-wired/wired-amc-crud.jsx",             // overrides wired-amc-c.jsx
  "screens-wired/wired-evals-crud.jsx",           // overrides wired-evals-e.jsx
];

const tpl = read(path.join(V3, "index.html.tpl"));
const styles = read(path.join(V3, "styles.css"));
const rbac = read(path.join(V3, "rbac.js"));
const prefs = read(path.join(V3, "preferences.js"));
const primitives = read(path.join(V3, "primitives.jsx"));
const shell = read(path.join(V3, "shell.jsx"));
const app = read(path.join(V3, "app.jsx"));
const client = read(path.join(ROOT, "src", "client", "obara-client.js"));
const screens = SCREEN_FILES.map((rel) => {
  const full = path.join(V3, rel);
  if (!fs.existsSync(full)) {
    console.warn(`[v3] missing screen file: ${rel}`);
    return "";
  }
  return `// ===== ${rel} =====\n` + read(full);
}).join("\n\n");

// Load order matters because each <script> tag attaches values to window:
// later assignments overwrite earlier ones. Both screens-system.jsx and
// shell.jsx export a `CmdK`; screens-system's is a static demo, shell's is
// the interactive palette. We want shell's version to win, so shell loads
// AFTER screens. Same logic for any future collisions.
const out = tpl
  .replace("/* %V3_STYLES% */", () => styles)
  .replace("/* %V3_RBAC% */", () => rbac)
  .replace("/* %V3_PREFS% */", () => prefs)
  .replace("/* %V3_CLIENT% */", () => client)
  .replace("/* %V3_PRIMITIVES% */", () => primitives)
  .replace("/* %V3_SCREENS% */", () => screens)
  .replace("/* %V3_SHELL% */", () => shell)
  .replace("/* %V3_APP% */", () => app);

if (!fs.existsSync(PUB)) fs.mkdirSync(PUB, { recursive: true });
fs.writeFileSync(OUT, out);

const sizeKb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`wrote ${OUT} (${sizeKb} KB)`);
