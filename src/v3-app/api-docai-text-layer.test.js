// Phase A: L1 deterministic text-layer extractor.
//
// We test the surface that doesn't require unpdf to be installed:
//   - PDF magic-byte detection (looksLikePdf)
//   - SHA-256 content hashing (contentHash)
//   - Threshold table is exported and stable
//   - extractTextLayer fails soft when bytes are invalid / empty
//
// The unpdf round-trip itself is exercised as an integration test
// only when unpdf is available; otherwise we assert the
// fail-soft path returns extract_failed instead of throwing.

import { describe, it, expect } from "vitest";
import {
  extractTextLayer,
  contentHash,
  looksLikePdf,
  TEXT_LAYER_THRESHOLDS,
} from "../api/_lib/docai/text_layer.js";

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

describe("text_layer / looksLikePdf", () => {
  it("returns true for %PDF- header bytes", () => {
    expect(looksLikePdf(PDF_MAGIC)).toBe(true);
  });

  it("returns false for empty / non-PDF bytes", () => {
    expect(looksLikePdf(null)).toBe(false);
    expect(looksLikePdf(Buffer.from([]))).toBe(false);
    expect(looksLikePdf(Buffer.from("not a pdf"))).toBe(false);
  });
});

describe("text_layer / contentHash", () => {
  it("returns a stable 64-char hex sha256 for the same bytes", async () => {
    const a = await contentHash(Buffer.from("hello world"));
    const b = await contentHash(Buffer.from("hello world"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns different hashes for different bytes", async () => {
    const a = await contentHash(Buffer.from("hello world"));
    const b = await contentHash(Buffer.from("hello WORLD"));
    expect(a).not.toBe(b);
  });

  it("returns null on empty input", async () => {
    expect(await contentHash(null)).toBeNull();
    expect(await contentHash(Buffer.from([]))).toBeNull();
  });
});

describe("text_layer / thresholds", () => {
  it("exposes the usable / per-page / body-text-bytes constants", () => {
    expect(TEXT_LAYER_THRESHOLDS.usable).toBeGreaterThan(0);
    expect(TEXT_LAYER_THRESHOLDS.perPage).toBeGreaterThan(0);
    expect(TEXT_LAYER_THRESHOLDS.bodyTextBytes).toBeGreaterThan(0);
    expect(TEXT_LAYER_THRESHOLDS.usable).toBeGreaterThanOrEqual(TEXT_LAYER_THRESHOLDS.perPage);
  });
});

describe("text_layer / extractTextLayer fail-soft paths", () => {
  it("returns extract_failed when no bytes are passed", async () => {
    const out = await extractTextLayer({ bytes: null });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("extract_failed");
    expect(out.error).toMatch(/no bytes/i);
  });

  it("returns extract_failed when bytes are not a PDF", async () => {
    const out = await extractTextLayer({ bytes: Buffer.from("not a pdf"), mime: "text/plain" });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("extract_failed");
    expect(out.error).toMatch(/not a pdf/i);
  });

  it("does not throw when unpdf is missing or rejects the bytes", async () => {
    // Pass a near-empty PDF so the extractor reaches the unpdf
    // call. Either unpdf is installed (then it returns
    // extract_failed because the doc is malformed) or unpdf is
    // missing (then we return extract_failed with the not-installed
    // error). Either way, no throw.
    const fakePdf = Buffer.concat([PDF_MAGIC, Buffer.from("\n%EOF")]);
    const out = await extractTextLayer({ bytes: fakePdf, mime: "application/pdf" });
    expect(out.ok).toBe(false);
    expect(out.status).toBe("extract_failed");
    expect(out.latency_ms).toBeGreaterThanOrEqual(0);
  });
});
