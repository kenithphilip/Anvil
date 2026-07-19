// Correction-aware adapter learning (dark spike): the scorer optionally folds
// operator-correction rate (extraction_corrections per run) into the ranking so
// an adapter whose output gets heavily edited ranks below its self-reported
// confidence. Off by default -> existing behaviour.

import { describe, it, expect, beforeEach } from "vitest";
import { rankAdaptersForCustomer, __clearCache, __test } from "../api/_lib/docai/adapter-learning.js";

const T = "tenant-1";
const C = "cust-1";
const nowIso = (hAgo = 0) => new Date(Date.now() - hAgo * 3600 * 1000).toISOString();

// Two-table fake: extraction_runs + extraction_corrections (supports .in()).
const makeSvc = ({ runs, corrections = [] }) => ({
  from(table) {
    const chain = {
      _rows: table === "extraction_corrections" ? [...corrections] : [...runs],
      select() { return this; },
      eq(c, v) { this._rows = this._rows.filter((r) => String(r[c]) === String(v)); return this; },
      gt(c, v) { this._rows = this._rows.filter((r) => String(r[c]) > String(v)); return this; },
      in(c, vals) { const s = new Set(vals.map(String)); this._rows = this._rows.filter((r) => s.has(String(r[c]))); return this; },
      limit() { return this; },
      then(fn) { return Promise.resolve(fn({ data: this._rows, error: null })); },
    };
    return chain;
  },
});

beforeEach(() => { __clearCache(); delete process.env.ADAPTER_LEARNING_CORRECTION_AWARE; });

describe("scoreOne correction penalty", () => {
  const okRuns = (conf, corr, n = 6) =>
    Array.from({ length: n }, () => ({ status: "ok", confidence_overall: conf, correction_count: corr, created_at: nowIso(1) }));

  it("is unchanged when correctionAware is off", () => {
    const now = Date.now();
    const noCorr = __test.scoreOne(okRuns(0.9, 0), now, false);
    const heavyCorr = __test.scoreOne(okRuns(0.9, 5), now, false);
    expect(heavyCorr).toBeCloseTo(noCorr, 6); // correction_count ignored
  });

  it("penalizes adapters with more operator corrections when on", () => {
    const now = Date.now();
    const clean = __test.scoreOne(okRuns(0.9, 0), now, true);   // factor 1
    const edited = __test.scoreOne(okRuns(0.9, 4), now, true);  // factor 1/5
    expect(clean).toBeGreaterThan(edited);
    expect(edited).toBeCloseTo(clean / 5, 5);
  });
});

describe("rankAdaptersForCustomer correction-aware flip", () => {
  // beta has HIGHER confidence but gets 4 corrections/run; alpha is clean.
  const runs = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: "a" + i, tenant_id: T, customer_id: C, adapter_used: "alpha", status: "ok", confidence_overall: 0.9, created_at: nowIso(i) })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: "b" + i, tenant_id: T, customer_id: C, adapter_used: "beta", status: "ok", confidence_overall: 0.95, created_at: nowIso(i) })),
  ];
  // 4 correction rows per beta run.
  const corrections = [];
  for (let i = 0; i < 6; i++) for (let k = 0; k < 4; k++) corrections.push({ tenant_id: T, extraction_run_id: "b" + i });

  it("ranks beta first WITHOUT correction awareness (higher confidence)", async () => {
    const svc = makeSvc({ runs, corrections });
    const order = await rankAdaptersForCustomer({ svc, tenantId: T, customerId: C, correctionAware: false });
    expect(order.indexOf("beta")).toBeLessThan(order.indexOf("alpha"));
  });

  it("ranks alpha first WITH correction awareness (beta gets edited a lot)", async () => {
    const svc = makeSvc({ runs, corrections });
    const order = await rankAdaptersForCustomer({ svc, tenantId: T, customerId: C, correctionAware: true });
    expect(order.indexOf("alpha")).toBeLessThan(order.indexOf("beta"));
  });
});
