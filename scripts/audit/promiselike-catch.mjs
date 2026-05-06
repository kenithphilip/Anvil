// Audit: ".catch()" chained directly on a Supabase query builder.
//
// Pins the regression behind PR #20 ("forgot password broke with
// 'catch is not a function'"). The Supabase JS v2 query builder is
// PromiseLike (has .then) but NOT a real Promise (no .catch).
// Calling .catch on it throws synchronously the first time the
// failure path runs.
//
// Walks every .js file under src/api and flags chains that look like
// svc.from("X").insert(...).catch(...). Exit 1 if any findings.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const offenders = [];

const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) { walk(p); continue; }
    if (!p.endsWith(".js")) continue;
    if (p.includes("safe-thenable")) continue;
    const src = readFileSync(p, "utf8");
    // Match a Supabase chain ending in insert/update/delete/upsert/rpc
    // immediately followed by `.catch(`. The body of the call cannot
    // cross a semicolon (which would mean the `.catch` belongs to a
    // different statement entirely, like a separate fetch) or another
    // `.catch(` (nested chains).
    const re = /\.(insert|update|delete|upsert|rpc)\([^;]{0,4000}?\)\s*\.catch\(/g;
    let match;
    while ((match = re.exec(src)) !== null) {
      const idx = match.index;
      const line = src.slice(0, idx).split("\n").length;
      offenders.push({
        file: p.replace(ROOT + "/", ""),
        line,
        op: match[1],
      });
    }
  }
};
walk(join(ROOT, "src/api"));

if (offenders.length) {
  console.log("\n## Supabase PromiseLike .catch offenders:\n");
  for (const o of offenders) {
    console.log("  - " + o.file + ":" + o.line + "  " + o.op + "(...).catch(...)");
  }
  console.log("\nFix: replace .catch(...) with safeAwait(...) from src/api/_lib/safe-thenable.js,");
  console.log("or with .then(() => {}, () => {}) for fire-and-forget.\n");
  process.exit(1);
}
console.log("\n## Supabase .catch: none\n");
process.exit(0);
