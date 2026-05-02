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
// names from earlier files (e.g. screens-orders uses `Steps` from
// primitives, `Card` from primitives, etc. — primitives loads first).
const SCREEN_FILES = [
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
