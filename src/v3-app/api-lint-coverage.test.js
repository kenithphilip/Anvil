// The lint config covered everything except the code that runs unattended.
//
// src/api/** — the whole API, everything under _lib, every cron worker — was
// outside every glob, and `npm run lint` was in no CI job. So those ~200 files
// had exactly one gate: `node --check`, which parses syntax and never resolves
// an identifier. A name used and never declared passes it and throws at
// runtime; in the cron worker that is worse than a normal crash, because any
// throw inside advanceJob is caught by the handler and marks the job 'failed'.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

describe("the lint config reaches the server code", () => {
  const cfg = read("eslint.config.mjs");

  it("covers src/api", () => {
    expect(cfg).toMatch(/"src\/api\/\*\*\/\*\.js"/);
  });

  it("makes an undeclared name an error, not a warning", () => {
    // The class node --check cannot see, and the one that bit twice in a day.
    expect(cfg).toMatch(/"no-undef": "error"/);
  });

  it("gives the browser client its own globals", () => {
    // It was grouped with the server files — harmless while no-undef was off,
    // wrong the moment it went on.
    expect(cfg).toMatch(/localStorage: "readonly"/);
    expect(cfg).toMatch(/window: "readonly"/);
  });

  it("does not put browser globals in the server block", () => {
    // Comments stripped first: the client block's own comment NAMES
    // localStorage, and matching prose instead of config is how a test ends up
    // asserting something it does not mean.
    const code = cfg.replace(/^\s*\/\/.*$/gm, "");
    const serverBlock = code.slice(
      code.indexOf('"src/api/**/*.js"'),
      code.indexOf('files: ["src/client/*.js"]'),
    );
    expect(serverBlock.length).toBeGreaterThan(100);
    expect(serverBlock).not.toMatch(/localStorage|sessionStorage|\bwindow:/);
  });
});

describe("and CI actually runs it", () => {
  const ci = read(".github/workflows/ci.yml");

  it("runs lint", () => {
    // A config nothing executes is not a gate.
    expect(ci).toMatch(/- run: npm run lint/);
  });

  it("runs it alongside the other static gates", () => {
    expect(ci.indexOf("npm run lint")).toBeGreaterThan(ci.indexOf("npm run check"));
    expect(ci.indexOf("npm run lint")).toBeLessThan(ci.indexOf("npm test"));
  });
});
