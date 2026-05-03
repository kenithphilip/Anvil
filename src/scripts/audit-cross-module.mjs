// Cross-module data-flow audit. Checks every `window.location.hash =`
// and `<a href="#/...">` reference in the codebase and verifies the
// target route id is registered in routes.ts. Anything that points at
// a stale or never-existed route is flagged so deep-links don't 404.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP = path.join(ROOT, "src", "v3-app");
const ROUTES_TS = path.join(APP, "routes.ts");

const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
};

// Build the registered route set from routes.ts. We pull both the
// keys of RESOLVERS and the screens dictionary names to be thorough.
const routesText = fs.readFileSync(ROUTES_TS, "utf8");
const REGISTERED = new Set();
{
  const block = routesText.match(/export\s+const\s+RESOLVERS\s*=\s*\{([\s\S]*?)\n\};/);
  if (block) {
    for (const m of block[1].matchAll(/^\s*"?([A-Za-z][\w-]*)"?\s*:/gm)) {
      REGISTERED.add(m[1]);
    }
  }
}

// Hash links may also include sub-route params (`#/so?id=X`,
// `#/items?view=guns`). We treat the part before `?` as the route id.
const stripQuery = (s) => s.split("?")[0];

const findings = [];
const note = (file, line, kind, msg) => findings.push({ file: path.relative(ROOT, file), line, kind, msg });

const files = walk(APP);
for (const full of files) {
  const text = fs.readFileSync(full, "utf8");
  const lines = text.split("\n");

  // Pattern 1: window.location.hash = "#/<route>..."
  for (const m of text.matchAll(/window\.location\.hash\s*=\s*[`"']#\/([\w-]+)[^`"']*[`"']/g)) {
    const route = m[1];
    if (!REGISTERED.has(route)) {
      const line = text.slice(0, m.index).split("\n").length;
      note(full, line, "stale-hash-nav", `window.location.hash points to /${route} but no resolver`);
    }
  }
  // Pattern 2: window.location.hash = `#/${variable}` and template
  // literals with a literal route prefix. Best-effort.
  for (const m of text.matchAll(/window\.location\.hash\s*=\s*`#\/([\w-]+)\?\$\{[^`]+\}`/g)) {
    const route = m[1];
    if (!REGISTERED.has(route)) {
      const line = text.slice(0, m.index).split("\n").length;
      note(full, line, "stale-hash-nav", `template hash points to /${route} but no resolver`);
    }
  }
  // Pattern 3: <a href="#/X">
  for (const m of text.matchAll(/href\s*=\s*[`"']#\/([\w-]+)[^`"']*[`"']/g)) {
    const route = stripQuery(m[1]);
    if (!REGISTERED.has(route)) {
      const line = text.slice(0, m.index).split("\n").length;
      note(full, line, "stale-href-nav", `<a href> points to /${route} but no resolver`);
    }
  }
}

console.log("\nCross-module hash-route audit");
console.log("─".repeat(70));
const byFile = {};
for (const f of findings) {
  byFile[f.file] = byFile[f.file] || [];
  byFile[f.file].push(f);
}
for (const file of Object.keys(byFile).sort()) {
  console.log(`\n${file}`);
  for (const f of byFile[file]) {
    console.log(`  L${String(f.line).padEnd(4)} ${f.kind.padEnd(20)} ${f.msg}`);
  }
}
console.log("\n" + "─".repeat(70));
console.log(`Routes registered: ${REGISTERED.size}`);
console.log(`${findings.length} stale hash link(s) across ${Object.keys(byFile).length} file(s)`);
if (findings.length > 0) process.exit(1);
