// Unit tests for src/api/_lib/docai/review-queue.js (Wave 4.1).

import { describe, it, expect } from "vitest";
import {
  classifyForQueue, enqueueReview, updateReviewStatus,
} from "../api/_lib/docai/review-queue.js";

describe("classifyForQueue", () => {
  it("returns null on null", () => {
    expect(classifyForQueue(null)).toBeNull();
  });

  it("returns null on a clean ok run", () => {
    expect(classifyForQueue({ status: "ok", statusReason: "ok", confidenceOverall: 0.95 })).toBeNull();
  });

  it("queues low_confidence runs", () => {
    const out = classifyForQueue({ status: "low_confidence", statusReason: "low_confidence", confidenceOverall: 0.65 });
    expect(out.reason).toBe("low_confidence");
    expect(out.severity).toBe("medium");
  });

  it("escalates very-low confidence to high severity", () => {
    const out = classifyForQueue({ status: "low_confidence", statusReason: "low_confidence", confidenceOverall: 0.4 });
    expect(out.severity).toBe("high");
  });

  it("flags anomalies_has_blockers as critical", () => {
    const out = classifyForQueue({ status: "ok", confidenceOverall: 0.95, anomaliesHasBlockers: true });
    expect(out.reason).toBe("anomalies");
    expect(out.severity).toBe("critical");
  });

  it("flags parse_failed as high", () => {
    const out = classifyForQueue({ status: "failed", statusReason: "parse_failed" });
    expect(out.reason).toBe("parse_failed");
    expect(out.severity).toBe("high");
  });

  it("flags image_pdf_no_text as low (reroute to OCR)", () => {
    const out = classifyForQueue({ status: "failed", statusReason: "image_pdf_no_text" });
    expect(out.severity).toBe("low");
  });

  it("flags strong handwriting suspicion", () => {
    const out = classifyForQueue({
      status: "ok", confidenceOverall: 0.95,
      handwritingDetection: { suspected: true, score: 0.8 },
    });
    expect(out.reason).toBe("handwriting");
  });
});

describe("enqueueReview", () => {
  it("returns ok with queued=false when run is clean", async () => {
    const svc = { from: () => ({ upsert: () => Promise.resolve({ error: null }) }) };
    const out = await enqueueReview(
      svc,
      { tenantId: "t" },
      { runId: "r", status: "ok", confidenceOverall: 0.95 },
    );
    expect(out.ok).toBe(true);
    expect(out.queued).toBe(false);
  });

  it("upserts a row when run needs review", async () => {
    let upsertCalled = false;
    let payload = null;
    const svc = {
      from: () => ({
        upsert: (row, opts) => {
          upsertCalled = true;
          payload = row;
          expect(opts.onConflict).toContain("extraction_run_id");
          return Promise.resolve({ error: null });
        },
      }),
    };
    const out = await enqueueReview(
      svc,
      { tenantId: "t", customerId: "c", caseId: "ord-1" },
      {
        runId: "r1",
        status: "low_confidence",
        statusReason: "low_confidence",
        confidenceOverall: 0.6,
        normalized: { lines: [{ partNumber: "X", quantity: 5 }] },
        anomaliesSummary: { total: 2, error: 0 },
      },
    );
    expect(upsertCalled).toBe(true);
    expect(out.queued).toBe(true);
    expect(payload.reason).toBe("low_confidence");
    expect(payload.tenant_id).toBe("t");
    expect(payload.case_id).toBe("ord-1");
    expect(payload.metrics.confidence_overall).toBe(0.6);
    expect(payload.preview.line_count).toBe(1);
  });

  it("returns ok=false on missing svc / ctx", async () => {
    expect((await enqueueReview(null, {}, {})).ok).toBe(false);
    const svc = { from: () => ({ upsert: () => Promise.resolve({ error: null }) }) };
    expect((await enqueueReview(svc, {}, { runId: "r", status: "failed", statusReason: "parse_failed" })).ok).toBe(false);
  });

  it("surfaces upsert errors", async () => {
    const svc = { from: () => ({ upsert: () => Promise.resolve({ error: { message: "fail" } }) }) };
    const out = await enqueueReview(
      svc,
      { tenantId: "t" },
      { runId: "r", status: "low_confidence", statusReason: "low_confidence", confidenceOverall: 0.6 },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toBe("fail");
  });
});

describe("updateReviewStatus", () => {
  it("updates only provided fields and stamps resolved_at when status=resolved", async () => {
    let payload = null;
    const svc = {
      from: () => ({
        update: (vals) => {
          payload = vals;
          return {
            eq: () => ({
              eq: () => Promise.resolve({ error: null }),
            }),
          };
        },
      }),
    };
    const out = await updateReviewStatus(svc, {
      tenantId: "t", queueId: "q1",
      status: "resolved", resolution: "confirmed", resolvedBy: "u1",
    });
    expect(out.ok).toBe(true);
    expect(payload.status).toBe("resolved");
    expect(payload.resolution).toBe("confirmed");
    expect(payload.resolved_by).toBe("u1");
    expect(payload.resolved_at).toBeDefined();
  });

  it("returns ok=false on missing args", async () => {
    expect((await updateReviewStatus(null, {})).ok).toBe(false);
    expect((await updateReviewStatus({}, { tenantId: null })).ok).toBe(false);
  });
});
