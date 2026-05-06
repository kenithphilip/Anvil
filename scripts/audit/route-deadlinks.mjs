// Audit: hash links / hash navigations referencing route ids that
// don't exist in RESOLVERS. Catches dead-end nav (the New SPO button
// pattern: button sets `#/spo?new=1` but no resolver handles the
// `?new=1` branch, so click does nothing visible).
//
// Two checks:
//   1. Route id used in code but not in RESOLVERS at all.
//   2. Route id used WITH params that no resolver branch handles.
//
// Stdout: human-readable report, exit 1 if any issues found.
//
// Run: node scripts/audit/route-deadlinks.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ROUTES_FILE = join(ROOT, "src/v3-app/routes.ts");

// 1. Parse RESOLVERS keys + resolver bodies.
const routesSrc = readFileSync(ROUTES_FILE, "utf8");
const resolversBlock = routesSrc.match(/export const RESOLVERS\s*=\s*\{([\s\S]*?)\n\};/);
if (!resolversBlock) {
  console.error("Could not find RESOLVERS block in routes.ts");
  process.exit(1);
}
const definedRoutes = new Set();
const resolverBodies = {};
{
  const lines = resolversBlock[1].split("\n");
  let cur = null;
  let depth = 0;
  for (const line of lines) {
    const m = line.match(/^\s*"?([a-zA-Z][a-zA-Z0-9_-]*)"?\s*:/);
    if (m && depth === 0) {
      cur = m[1];
      definedRoutes.add(cur);
      resolverBodies[cur] = line + "\n";
    } else if (cur) {
      resolverBodies[cur] += line + "\n";
    }
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
    if (depth < 0) depth = 0;
  }
}

// 2. Walk src/v3-app and pull every #/route reference.
const ROUTE_RE = /#\/[a-zA-Z][a-zA-Z0-9_-]*(?:\?[A-Za-z0-9_=&%-]+)?/g;
const usedRoutes = new Set();
const paramUsage = {};
const usageSites = {};

const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) { walk(p); continue; }
    if (!/\.(tsx?|jsx?|css)$/.test(p)) continue;
    if (/\.test\.(tsx?|jsx?)$/.test(p)) continue;
    const src = readFileSync(p, "utf8");
    const matches = src.match(ROUTE_RE) || [];
    for (const m of matches) {
      const stripped = m.replace(/^#\//, "");
      const [route, query] = stripped.split("?");
      if (!route) continue;
      usedRoutes.add(route);
      usageSites[route] = usageSites[route] || new Set();
      usageSites[route].add(p.replace(ROOT + "/", ""));
      if (query) {
        const params = new URLSearchParams(query);
        for (const k of params.keys()) {
          paramUsage[route] = paramUsage[route] || new Set();
          paramUsage[route].add(k);
        }
      }
    }
  }
};
walk(join(ROOT, "src/v3-app"));

// 3. Dead routes (used, not in RESOLVERS).
const dead = [...usedRoutes].filter((r) => !definedRoutes.has(r)).sort();

// 4a. Map each route to the screen file(s) it lazy-loads. We need
//     this so we can check whether the screen reads a hash param
//     itself (the source-pos.tsx pattern) when the resolver doesn't
//     branch on it. A param can be "handled" by either the resolver
//     or the destination screen.
const screenForRoute = {};
{
  // Walk the `screens` object literal, e.g. `home: lazy(() => import("./screens/home"))`.
  const screensBlock = routesSrc.match(/const screens\s*=\s*\{([\s\S]*?)\n\};/);
  if (screensBlock) {
    for (const line of screensBlock[1].split("\n")) {
      const m = line.match(/^\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*lazy\(\s*\(\)\s*=>\s*import\(\s*"([^"]+)"/);
      if (m) screenForRoute[m[1]] = m[2];
    }
  }
}
// The RESOLVERS map sometimes uses different keys than the screens
// map (e.g. `svcVisits` in `screens`, `"svc-visits"` in RESOLVERS).
// Build a lookup that goes from a RESOLVERS key (the route id) to
// the screen module path by parsing the resolver body for
// `screens.X`.
const screenPathFor = (resolverKey) => {
  const body = resolverBodies[resolverKey] || "";
  const m = body.match(/screens\.([a-zA-Z][a-zA-Z0-9_-]*)/);
  if (!m) return null;
  return screenForRoute[m[1]] || null;
};

// 4b. For each (route, param) pair, "handled" means EITHER the
//     resolver branches on it OR the destination screen reads it
//     directly. This avoids flagging the source-pos `?new=1`
//     pattern after the in-screen handler is added.
const screenHandlesParam = (resolverKey, param) => {
  const path = screenPathFor(resolverKey);
  if (!path) return false;
  // The screens are imported as e.g. "./screens/home"; resolve to
  // src/v3-app/screens/home.tsx.
  const candidates = [
    join(ROOT, "src/v3-app", path + ".tsx"),
    join(ROOT, "src/v3-app", path + ".ts"),
    join(ROOT, "src/v3-app", path + ".jsx"),
    join(ROOT, "src/v3-app", path + ".js"),
  ];
  for (const candidate of candidates) {
    let src;
    try { src = readFileSync(candidate, "utf8"); } catch (_) { continue; }
    // Heuristics: any of these patterns count as "the screen reads
    // this param".
    const patterns = [
      'URLSearchParams(', // explicit param parsing
      'readHashParams(',  // helper from routes.ts
      'window.location.hash',
      'location.hash',
    ];
    const reads = patterns.some((p) => src.includes(p));
    if (!reads) continue;
    // Stronger check: look for the literal param name appearing as
    // a string in proximity to the hash parsing.
    const looksLikeReadOfThisParam = new RegExp(
      '["\']' + param + '["\']',
    ).test(src);
    if (looksLikeReadOfThisParam) return true;
  }
  return false;
};

// 4c. Unhandled params (resolver ignores it, screen also doesn't read it).
const unhandledParams = [];
for (const [route, paramSet] of Object.entries(paramUsage)) {
  if (!definedRoutes.has(route)) continue;
  const body = resolverBodies[route] || "";
  for (const p of paramSet) {
    const handledByResolver = body.includes('params.get("' + p + '")') ||
                              body.includes("params.get('" + p + "')");
    if (handledByResolver) continue;
    if (screenHandlesParam(route, p)) continue;
    unhandledParams.push({ route, param: p });
  }
}

// 5. Report.
let exit = 0;
if (dead.length) {
  console.log("\n## Dead route ids (used but not in RESOLVERS):\n");
  for (const r of dead) {
    const sites = [...(usageSites[r] || [])].slice(0, 3).join(", ");
    console.log("  - #/" + r + "  used in: " + sites);
  }
  exit = 1;
} else {
  console.log("\n## Dead route ids: none");
}

if (unhandledParams.length) {
  console.log("\n## Unhandled hash params (route exists, resolver ignores the param):\n");
  unhandledParams.sort((a, b) => a.route.localeCompare(b.route) || a.param.localeCompare(b.param));
  for (const { route, param } of unhandledParams) {
    const sites = [...(usageSites[route] || [])].slice(0, 3).join(", ");
    console.log("  - #/" + route + "?" + param + "=...  used in: " + sites);
  }
  exit = 1;
} else {
  console.log("\n## Unhandled hash params: none");
}

if (!exit) console.log("\nAll route references resolve cleanly.\n");
process.exit(exit);
