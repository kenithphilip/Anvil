// Regression test for the PDF.js API/Worker version pair.
//
// Background:
//   - components/PdfPagePreview.tsx imports the PDF.js worker via
//     `import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"`,
//     which resolves to whatever pdfjs-dist version is hoisted at the
//     top of node_modules.
//   - react-pdf bundles its own pdfjs-dist API internally. At runtime,
//     PDF.js asserts that `pdfjs.version === workerVersion`; mismatch
//     throws "The API version X does not match the Worker version Y"
//     and the Review tab renders the canvas-less fallback banner.
//
// The bug we are guarding against:
//   - Listing `"pdfjs-dist": "^4.x"` in package.json lets npm resolve
//     to a newer 4.x that does not match react-pdf's pinned 4.8.69.
//     The build succeeds but the runtime fails on every PDF.
//
// The fix:
//   - Pin BOTH dependencies to exact versions, and let this test
//     refuse any future drift. When you upgrade react-pdf, you must
//     also bump pdfjs-dist to its bundled version (look up
//     `node_modules/react-pdf/package.json#dependencies["pdfjs-dist"]`).

import { describe, it, expect } from "vitest";
import topPkg from "../../../package.json";
import reactPdfPkg from "react-pdf/package.json";
import pdfjsInstalled from "pdfjs-dist/package.json";

describe("pdfjs version alignment", () => {
  it("react-pdf and the top-level pdfjs-dist resolve to the same version", () => {
    const reactPdfDep = (reactPdfPkg as any).dependencies?.["pdfjs-dist"];
    expect(reactPdfDep, "react-pdf should declare a pdfjs-dist dependency").toBeTruthy();
    expect((pdfjsInstalled as any).version, "installed pdfjs-dist must match react-pdf's expectation")
      .toBe(reactPdfDep);
  });

  it("package.json pins both deps to exact versions (no ^ or ~)", () => {
    const pdfjsPin = ((topPkg as any).dependencies?.["pdfjs-dist"]) as string;
    const reactPdfPin = ((topPkg as any).dependencies?.["react-pdf"]) as string;
    expect(pdfjsPin, "pdfjs-dist must be an exact pin").toMatch(/^\d+\.\d+\.\d+$/);
    expect(reactPdfPin, "react-pdf must be an exact pin").toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("top-level pdfjs-dist pin matches react-pdf's bundled version", () => {
    const pdfjsPin = ((topPkg as any).dependencies?.["pdfjs-dist"]) as string;
    const reactPdfDep = (reactPdfPkg as any).dependencies?.["pdfjs-dist"];
    expect(pdfjsPin).toBe(reactPdfDep);
  });
});
