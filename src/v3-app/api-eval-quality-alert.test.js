// CM P4: extraction-quality alerting — raises the admin bell when the
// operator-corrected DPMO breaches threshold, with sample-size + 24h-dedup
// guards. notifyAdmins is mocked; computeExtractionQuality runs for real over a
// stub svc.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_lib/notifications.js", () => ({ notifyAdmins: vi.fn(async () => ({ notified: 1 })) }));

import { notifyAdmins } from "../api/_lib/notifications.js";
import { runQualityAlerts } from "../api/cron/eval_quality_alert.js";

const fcLines = (n) => { const o = { overall: 0.9 }; for (let i = 0; i < n; i++) o["lines[" + i + "]"] = 0.8; return o; };

const makeSvc = ({ runs, corrections, priorAlerts = [] }) => ({
  from(table) {
    const b = {
      select() { return b; }, eq() { return b; }, gte() { return b; }, limit() { return b; },
      then(resolve) {
        const data = table === "extraction_runs" ? runs
          : table === "extraction_corrections" ? corrections
            : table === "admin_notifications" ? priorAlerts
              : [];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return b;
  },
});

// One 10-line shipped run → opportunities = 5 header + 10×5 = 55.
const runs = [{ id: "A", status_reason: "ok", field_confidences: fcLines(10) }];
const oneDefect = [{ extraction_run_id: "A", field_path: "lines[0].partNumber" }]; // 1/55 ≈ 18,181 DPMO
const cfg = (over = {}) => ({ dpmoThreshold: 6210, windowDays: 30, minShippedRuns: 1, minOpportunities: 1, ...over });

beforeEach(() => vi.clearAllMocks());

describe("runQualityAlerts", () => {
  it("raises an admin notification when DPMO breaches the threshold", async () => {
    const res = await runQualityAlerts(makeSvc({ runs, corrections: oneDefect }), { tenants: ["t1"], config: cfg() });
    expect(res[0].breach).toBe(true);
    expect(res[0].notified).toBe(1);
    expect(notifyAdmins).toHaveBeenCalledOnce();
    expect(notifyAdmins.mock.calls[0][1]).toBe("t1");                       // tenant
    expect(notifyAdmins.mock.calls[0][2].kind).toBe("extraction_quality_alert");
    expect(notifyAdmins.mock.calls[0][2].link_route).toBe("evals");
  });

  it("does not alert when DPMO is within target", async () => {
    const res = await runQualityAlerts(makeSvc({ runs, corrections: [] }), { tenants: ["t1"], config: cfg() });
    expect(res[0].ok).toBe(true);
    expect(res[0].dpmo).toBe(0);
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it("skips a sample too small to be meaningful", async () => {
    const res = await runQualityAlerts(makeSvc({ runs, corrections: oneDefect }), { tenants: ["t1"], config: cfg({ minShippedRuns: 100 }) });
    expect(res[0].skipped).toBe("insufficient_sample");
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it("dedups: does not re-alert while an unresolved alert exists in the window", async () => {
    const res = await runQualityAlerts(makeSvc({ runs, corrections: oneDefect, priorAlerts: [{ id: "n1" }] }), { tenants: ["t1"], config: cfg() });
    expect(res[0].breach).toBe(true);
    expect(res[0].deduped).toBe(true);
    expect(notifyAdmins).not.toHaveBeenCalled();
  });
});
