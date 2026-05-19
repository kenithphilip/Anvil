// Generate one smoke test per screen under src/v3-app/screens/.
//
// The smoke is intentionally minimal. Each test:
// 1. Installs a stubbed ObaraBackend + RBAC role.
// 2. Imports the screen module.
// 3. Renders it and asserts the document has SOME content (no crash).
// 4. Runs the loaded -> empty branch one micro-task later.
//
// Behavior + interaction coverage is layered on top in helper.test.js,
// rbac.test.js, toasts.test.jsx, primitives.test.jsx files. The point of
// this generator is to guarantee EVERY converted screen actually parses,
// imports its dependencies cleanly, and survives a render with empty data.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS_DIR = path.join(ROOT, "src", "v3-app", "screens");

// Vite/TypeScript port: every screen file is .tsx and imports
// without an extension, so the template emits a .test.tsx file
// targeting the .tsx module. The pre-rename generator only saw
// .jsx files (none exist after the migration) and wrote zero
// stubs, which let 10 screens land without smoke coverage and
// kept the audit-migration "screen-tests-exist" check red.
const TEMPLATE = (name, importName) => `// Auto-generated smoke test for screens/${name}.tsx.
// Hand-edit if a screen needs a more specific assertion; the generator
// only overwrites files that match the auto-generated header below.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  // jsdom's confirm/alert/prompt are no-ops by default; stub them so
  // accidental click handlers can't pop dialogs during a smoke render.
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("${importName}", () => {
  it("renders without throwing", async () => {
    const mod = await import("./${name}");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});
`;

const main = () => {
  const files = fs.readdirSync(SCREENS_DIR).filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));
  let written = 0;
  for (const f of files) {
    const base = f.replace(/\.tsx$/, "");
    const importName = base
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join("");
    const out = path.join(SCREENS_DIR, base + ".test.tsx");
    // Strictly create-only. Many test files start with the auto-gen
    // sentinel but have hand-written additional `it(...)` blocks
    // below the smoke case; the previous overwrite-on-sentinel-match
    // policy silently destroyed those extra cases on every run. Use
    // `--force` to opt back into overwriting.
    if (fs.existsSync(out)) {
      if (!process.argv.includes("--force")) {
        console.log(`skip ${path.relative(ROOT, out)} (already exists; pass --force to overwrite)`);
        continue;
      }
    }
    fs.writeFileSync(out, TEMPLATE(base, importName));
    written++;
  }
  console.log(`[gen] wrote ${written} smoke tests`);
};

main();
