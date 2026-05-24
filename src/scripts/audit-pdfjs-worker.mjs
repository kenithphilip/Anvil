// PDF.js worker/API version audit. Defence-in-depth for the
// Review-tab regression where the operator saw:
//
//   Could not render PDF: The API version "4.8.69" does not match
//   the Worker version "4.10.38".
//
// Background:
//   components/PdfPagePreview.tsx imports the worker via
//   `import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"`.
//   At build time Vite copies that file into public/assets/ as a
//   hashed `pdf.worker.min-<hash>.mjs`. At runtime PDF.js asserts
//   `pdfjs.version === workerVersion`; a mismatch throws and the
//   Review tab falls back to the opaque native <embed>, killing the
//   bbox overlays + bidirectional click-to-locate.
//
// The pdfjs-version.test.ts unit test already guards the *declared*
// dependency tree (installed pdfjs-dist === react-pdf's bundled dep).
// This script adds a guard on the *built artefact*: it reads the
// emitted worker file and asserts its embedded version string equals
// what react-pdf's API will report. That catches cases the dep-tree
// test cannot -- a hand-vendored worker, an odd npm dedup, or a
// `?url` import that resolved to an unexpected copy.
//
// Runs in `npm run verify` AFTER `npm run build` in CI, so the built
// worker exists. When run standalone with no build present, it skips
// with a notice instead of failing (so a bare `npm run verify` on a
// clean checkout is not a false negative).
//
// Exits non-zero on a real mismatch so CI blocks the merge.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ASSETS_DIR = path.join(ROOT, "public", "assets");
const require = createRequire(import.meta.url);

const line = "─".repeat(60);
console.log("\nPDF.js worker/API version audit");
console.log(line);

let failures = 0;
const ok = (name, detail) => console.log(`OK    ${name.padEnd(30)} ${detail}`);
const fail = (name, detail) => { failures++; console.log(`FAIL  ${name.padEnd(30)} ${detail}`); };
const skip = (name, detail) => console.log(`SKIP  ${name.padEnd(30)} ${detail}`);

// 1. What version does react-pdf's bundled API expect? This is the
//    source of truth for what the worker MUST be.
let expectedVersion = null;
try {
  const reactPdfPkg = require("react-pdf/package.json");
  expectedVersion = reactPdfPkg.dependencies?.["pdfjs-dist"] || null;
  if (expectedVersion) {
    ok("react-pdf-bundled-pdfjs", `react-pdf@${reactPdfPkg.version} expects pdfjs-dist ${expectedVersion}`);
  } else {
    fail("react-pdf-bundled-pdfjs", "react-pdf package.json has no pdfjs-dist dependency");
  }
} catch (e) {
  fail("react-pdf-bundled-pdfjs", "could not read react-pdf/package.json: " + e.message);
}

// 2. What version is installed for the top-level `?url` import?
try {
  const installed = require("pdfjs-dist/package.json").version;
  if (expectedVersion && installed !== expectedVersion) {
    fail("installed-pdfjs", `installed pdfjs-dist ${installed} != react-pdf's ${expectedVersion}`);
  } else {
    ok("installed-pdfjs", `pdfjs-dist ${installed}`);
  }
} catch (e) {
  fail("installed-pdfjs", "could not read pdfjs-dist/package.json: " + e.message);
}

// 3. The built worker artefact. Skip cleanly when no build is present.
let workerFiles = [];
try {
  workerFiles = fs.existsSync(ASSETS_DIR)
    ? fs.readdirSync(ASSETS_DIR).filter((f) => /^pdf\.worker.*\.mjs$/.test(f))
    : [];
} catch (_) { workerFiles = []; }

if (workerFiles.length === 0) {
  skip("built-worker-version", "no public/assets/pdf.worker*.mjs (run `npm run build` first); dep-tree checks above still ran");
} else if (workerFiles.length > 1) {
  // Two different worker hashes shipping at once means two pdfjs
  // copies got bundled -- exactly the split that produces the
  // mismatch at runtime.
  fail("built-worker-version", `expected exactly one worker, found ${workerFiles.length}: ${workerFiles.join(", ")}`);
} else {
  const workerPath = path.join(ASSETS_DIR, workerFiles[0]);
  const src = fs.readFileSync(workerPath, "utf8");
  // PDF.js embeds its version exactly once as a quoted semver near
  // the top of the worker bundle. Grab the first x.y.z literal.
  const m = src.match(/"(\d+\.\d+\.\d+)"/);
  const builtVersion = m ? m[1] : null;
  if (!builtVersion) {
    fail("built-worker-version", `could not find a version string in ${workerFiles[0]}`);
  } else if (expectedVersion && builtVersion !== expectedVersion) {
    fail(
      "built-worker-version",
      `${workerFiles[0]} is ${builtVersion} but react-pdf's API is ${expectedVersion} -- runtime will throw "API version does not match Worker version"`,
    );
  } else {
    ok("built-worker-version", `${workerFiles[0]} -> ${builtVersion}`);
  }
}

console.log(line);
if (failures > 0) {
  console.log(`${failures} check(s) FAILED. Pin pdfjs-dist to match react-pdf's bundled version, rebuild, and re-run.`);
  process.exit(1);
}
console.log("All PDF.js version checks passed.");
