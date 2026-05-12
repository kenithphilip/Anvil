// Unit tests for src/api/_lib/docai/image-preprocess.js (Wave 2.1).
//
// sharp is an optional dep. Most CI environments will not have
// it installed; the preprocessor returns skipped_reason in that
// case and the OCR layer downstream still works. These tests
// cover both branches:
//   - the safe-fallback path (sharp absent -> skipped)
//   - the mime-gate (not_an_image -> skipped)
//   - the no-bytes / oversize-input guards

import { describe, it, expect } from "vitest";
import { preprocessImage, __test } from "../api/_lib/docai/image-preprocess.js";

describe("__test.isImageMime", () => {
  it("recognises common image mimes", () => {
    expect(__test.isImageMime("image/jpeg")).toBe(true);
    expect(__test.isImageMime("image/png")).toBe(true);
    expect(__test.isImageMime("image/tiff")).toBe(true);
    expect(__test.isImageMime("image/heic")).toBe(true);
  });
  it("rejects non-image mimes", () => {
    expect(__test.isImageMime("application/pdf")).toBe(false);
    expect(__test.isImageMime("text/plain")).toBe(false);
    expect(__test.isImageMime(null)).toBe(false);
  });
});

describe("preprocessImage", () => {
  it("returns no_bytes for empty buffer", async () => {
    const out = await preprocessImage({ buffer: Buffer.alloc(0), mimeType: "image/png" });
    expect(out.ok).toBe(false);
    expect(out.skipped_reason).toBe("no_bytes");
    expect(out.bytes.length).toBe(0);
  });

  it("returns input_too_large when above 25MB", async () => {
    const big = Buffer.alloc(26_000_000);
    const out = await preprocessImage({ buffer: big, mimeType: "image/jpeg" });
    expect(out.ok).toBe(false);
    expect(out.skipped_reason).toBe("input_too_large");
  });

  it("returns not_an_image for application/pdf", async () => {
    const out = await preprocessImage({
      buffer: Buffer.from("%PDF-1.4 fake"),
      mimeType: "application/pdf",
    });
    expect(out.ok).toBe(false);
    expect(out.skipped_reason).toBe("not_an_image");
  });

  it("returns the original bytes when sharp is unavailable or fails", async () => {
    // We can't reliably install sharp in CI; assert the safe-
    // fallback contract: if preprocessing can't run, the original
    // buffer is returned alongside a skipped_reason. This means
    // the OCR layer downstream always sees usable bytes.
    const buf = Buffer.from([0xff, 0xd8, 0xff]); // jpeg magic
    const out = await preprocessImage({ buffer: buf, mimeType: "image/jpeg" });
    if (out.ok) {
      // sharp is installed; bytes should be a processed buffer
      expect(out.bytes.length).toBeGreaterThan(0);
      expect(Array.isArray(out.applied)).toBe(true);
    } else {
      expect(out.bytes).toBe(buf);
      expect(out.skipped_reason).toBeTruthy();
    }
  });

  it("force flag bypasses the mime gate", async () => {
    // Even when the mime is wrong, opts.force still lets the
    // preprocessor try and (on no-sharp) return the safe fallback.
    const out = await preprocessImage({
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
      mimeType: "application/octet-stream",
      opts: { force: true },
    });
    // Either succeeds (sharp present) or skips with a sharp-
    // specific reason; the gate did NOT short-circuit on mime.
    expect(out.skipped_reason).not.toBe("not_an_image");
  });
});
