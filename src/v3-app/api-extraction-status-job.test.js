// GET /api/orders/extraction_status now carries the order's latest background
// job (`job`, `job_in_flight`), so the SO workspace knows whether to keep
// polling and how the job ended. The job read is scoped to the caller's
// tenant, and a failed read leaves the event summary standing.
// Invented values.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const OTHER = "00000000-0000-0000-0000-0000000000ff";
const ORDER = "00000000-0000-0000-0000-0000000000b1";

const H = vi.hoisted(() => ({ tables: {}, failJobs: false }));

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const filters = [];
      let desc = null;
      let max = Infinity;
      const run = async () => {
        if (table === "extraction_jobs" && H.failJobs) return { data: null, error: { message: "relation does not exist" } };
        let rows = (H.tables[table] || []).filter((r) => filters.every((f) => f(r)));
        if (desc) rows = [...rows].sort((a, b) => (a[desc] < b[desc] ? 1 : -1));
        return { data: rows.slice(0, max), error: null };
      };
      const api = {
        select() { return api; },
        eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return api; },
        gt(c, v) { filters.push((r) => String(r[c]) > String(v)); return api; },
        order(c, o) { if (o && o.ascending === false) desc = c; return api; },
        limit(n) { max = n; return api; },
        maybeSingle: () => run().then((r) => ({ data: r.data ? r.data[0] || null : null, error: r.error })),
        then: (f, rj) => run().then(f, rj),
      };
      return api;
    },
  }),
}));
vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: "00000000-0000-0000-0000-0000000000aa", user: { id: "u-1" }, role: "sales_engineer" }),
  requirePermission: () => {},
}));

const { default: handler } = await import("../api/orders/extraction_status.js");

const get = async () => {
  const res = { setHeader() {}, end() { return res; } };
  await handler({ method: "GET", headers: {}, query: { order_id: ORDER } }, res);
  return res;
};

const recent = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

beforeEach(() => {
  H.failJobs = false;
  H.tables = {
    processing_events: [
      { tenant_id: TENANT, case_id: ORDER, event_type: "docai_chunk_chunking_complete", detail: { chunk_count: 4, page_count: 80 }, created_at: recent(5) },
      { tenant_id: TENANT, case_id: ORDER, event_type: "docai_chunk_chunk_done", detail: { chunk_index: 0, chunk_count: 4 }, created_at: recent(3) },
    ],
    extraction_jobs: [
      { tenant_id: TENANT, order_id: ORDER, id: "job-old", status: "failed", created_at: recent(60) },
      { tenant_id: TENANT, order_id: ORDER, id: "job-new", status: "extracting", total_pages: 80, next_chunk_index: 1, created_at: recent(6) },
    ],
  };
});

describe("GET /api/orders/extraction_status: the background job", () => {
  it("returns the order's latest job and says it is in flight, beside the event summary", async () => {
    const res = await get();
    expect(res._status).toBe(200);
    expect(res._json.job.id).toBe("job-new");
    expect(res._json.job.status).toBe("extracting");
    expect(res._json.job_in_flight).toBe(true);
    expect(res._json.chunks_total).toBe(4);
    expect(res._json.chunks_done).toBe(1);
  });

  it("says a completed job is no longer in flight", async () => {
    H.tables.extraction_jobs[1].status = "completed";
    const res = await get();
    expect(res._json.job.status).toBe("completed");
    expect(res._json.job_in_flight).toBe(false);
  });

  it("never returns another tenant's job for the same order id", async () => {
    H.tables.extraction_jobs = [
      { tenant_id: OTHER, order_id: ORDER, id: "job-theirs", status: "queued", created_at: recent(1) },
    ];
    const res = await get();
    expect(res._json.job).toBe(null);
    expect(res._json.job_in_flight).toBe(false);
  });

  it("still answers with the event summary when the job read fails", async () => {
    H.failJobs = true;
    const res = await get();
    expect(res._status).toBe(200);
    expect(res._json.job).toBe(null);
    expect(res._json.job_in_flight).toBe(false);
    expect(res._json.chunks_total).toBe(4);
  });
});
