// Verify every <script> block in the legacy unified HTML.
//
// Plain JS blocks parsed via vm.Script (V8 built-in parser).
// Babel/JSX blocks parsed via @babel/parser with the jsx plugin.
//
// After Phase 8 cutover, only `public/index.html` (the legacy SO Agent
// unified app) is shipped from a concatenated build. The v3 surface is
// emitted by Vite as ESM chunks under `public/v3-app/` and validated by
// Vitest + tsc, so it does not need this static analyzer.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

let parseBabel = null;
try {
  ({ parse: parseBabel } = await import("@babel/parser"));
} catch (_) {
  console.warn(
    "[verify-html] @babel/parser not installed; skipping JSX blocks. " +
    "Install with `npm install --save-dev @babel/parser` to catch " +
    "const collisions across concatenated screen files."
  );
}

const ROOT = process.cwd();
const TARGETS = [
  { label: "legacy", path: path.join(ROOT, "public", "index.html") },
];

let totalCount = 0;
let totalFailed = 0;

for (const target of TARGETS) {
  if (!fs.existsSync(target.path)) {
    console.warn(`[verify-html] ${target.label}: ${target.path} missing, skipping`);
    continue;
  }
  const html = fs.readFileSync(target.path, "utf8");
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let count = 0;
  let failed = 0;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1].trim();
    if (!body) continue;
    const isBabel = /type=["'](text\/babel|text\/jsx)["']/.test(m[0]);
    count++;
    try {
      if (isBabel) {
        if (parseBabel) {
          parseBabel(m[1], {
            sourceType: "script",
            plugins: ["jsx"],
            allowReturnOutsideFunction: true,
          });
        }
      } else {
        new vm.Script(body, { filename: target.label + "_block_" + count + ".js" });
      }
    } catch (e) {
      console.error(`[${target.label}] block ${count} (${isBabel ? "babel" : "plain"}) failed: ${e.message}`);
      if (e.loc) console.error(`  at line ${e.loc.line}, col ${e.loc.column}`);
      failed++;
    }
  }
  console.log(`[${target.label}] verified ${count} script blocks, ${failed} failed`);
  totalCount += count;
  totalFailed += failed;
}

console.log(`verified ${totalCount} script blocks, ${totalFailed} failed`);
process.exit(totalFailed === 0 ? 0 : 1);
