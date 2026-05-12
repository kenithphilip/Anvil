// Unit tests for src/api/_lib/eval-attestation.js (Phase 1 F3).
//
// The HMAC receipt makes eval_runs rows tamper-evident. A verifier
// re-computes the receipt from the persisted columns + the same
// secret and compares against attestation_hmac via
// timingSafeEqual. The dashboard renders a "verified" badge only
// when this check passes.

import { describe, it, expect, beforeAll } from "vitest";
import {
  buildReceipt,
  signReceipt,
  verifyReceipt,
  signEvalRun,
} from "../api/_lib/eval-attestation.js";

beforeAll(() => {
  process.env.EVAL_ATTESTATION_HMAC_SECRET = "test-secret-32-bytes-padding-here";
});

describe("buildReceipt", () => {
  it("includes the case_count and sorted case_hashes", () => {
    const r = buildReceipt({
      suite: "po-extraction",
      passed: 18, failed: 2, total_score: 0.9,
      prompt_version: "p1.f3.test",
      model_version: "claude-sonnet-4",
      pipeline_version: "docai.v2.test",
      case_ids: ["hyundai-1", "obara-1", "vh-1"],
    });
    expect(r.case_count).toBe(3);
    expect(r.case_hashes.length).toBe(3);
    // Sorted hashes are deterministic.
    const sorted = [...r.case_hashes].sort();
    expect(r.case_hashes).toEqual(sorted);
    expect(r.total_score).toBe("0.9000");
  });
  it("falls back to default versions when omitted", () => {
    const r = buildReceipt({
      suite: "x", passed: 0, failed: 0, total_score: 0,
      case_ids: [],
    });
    expect(r.prompt_version).toMatch(/^p1\./);
    expect(r.pipeline_version).toMatch(/^docai\./);
  });
});

describe("signReceipt / verifyReceipt", () => {
  it("verifies a receipt signed with the same secret", () => {
    const r = buildReceipt({
      suite: "test", passed: 10, failed: 0, total_score: 1.0,
      case_ids: ["a", "b", "c"],
    });
    const hmac = signReceipt(r);
    expect(verifyReceipt(r, hmac)).toBe(true);
  });
  it("rejects a receipt whose passed count was tampered with", () => {
    const r = buildReceipt({
      suite: "test", passed: 10, failed: 0, total_score: 1.0,
      case_ids: ["a"],
    });
    const hmac = signReceipt(r);
    const tampered = { ...r, passed: 9999 };
    expect(verifyReceipt(tampered, hmac)).toBe(false);
  });
  it("rejects a receipt whose total_score string differs", () => {
    const r = buildReceipt({
      suite: "test", passed: 10, failed: 0, total_score: 1.0,
      case_ids: ["a"],
    });
    const hmac = signReceipt(r);
    const tampered = { ...r, total_score: "0.9999" };
    expect(verifyReceipt(tampered, hmac)).toBe(false);
  });
  it("rejects a receipt signed with a different secret", () => {
    const r = buildReceipt({
      suite: "test", passed: 1, failed: 0, total_score: 1.0,
      case_ids: ["a"],
    });
    const otherSecret = "different-secret-32-bytes-here-x";
    const hmac = signReceipt(r, otherSecret);
    expect(verifyReceipt(r, hmac)).toBe(false);
  });
  it("rejects null / empty hmac", () => {
    const r = buildReceipt({ suite: "t", passed: 0, failed: 0, total_score: 0, case_ids: [] });
    expect(verifyReceipt(r, null)).toBe(false);
    expect(verifyReceipt(r, "")).toBe(false);
  });
});

describe("signEvalRun", () => {
  it("returns the receipt + signed hmac", () => {
    const out = signEvalRun({
      suite: "po-extraction",
      passed: 19, failed: 1, total_score: 0.95,
      prompt_version: "p1",
      model_version: "claude-sonnet-4",
      pipeline_version: "v2",
      case_ids: ["c1", "c2"],
    });
    expect(out.hmac).toBeTruthy();
    expect(verifyReceipt(out.receipt, out.hmac)).toBe(true);
  });
  it("yields different hmacs for different case sets", () => {
    const a = signEvalRun({
      suite: "x", passed: 1, failed: 0, total_score: 1, case_ids: ["a"],
    });
    const b = signEvalRun({
      suite: "x", passed: 1, failed: 0, total_score: 1, case_ids: ["b"],
    });
    expect(a.hmac).not.toEqual(b.hmac);
  });
});
