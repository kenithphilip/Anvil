// Uploading a workbook across several requests.
//
// The In Transit workbook normalizes to ~35,000 line rows — 6.2 MB against a
// 1 MB MAX_BODY_BYTES. The client now splits it: shipment rows in the first
// request, line batches after.
//
// That split creates one problem the server has to solve. On a PREVIEW nothing
// is written, so from batch two onward a line whose shipment exists only in
// batch one has no shipment anywhere the server can see — and gets counted as an
// orphan. A preview reporting "31,000 invoices have no shipment" before an
// import that is entirely fine is worse than no preview at all.
//
// `known_invoices` is the client naming what it is importing. It widens counting
// only: persisting a line still needs a real shipment_id.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
let shipments;      // rows already "on file"
let upserted;       // shipment_lines the handler wrote

const makeSvc = () => ({
  from(table) {
    if (table === "shipment_lines") {
      return {
        upsert: async (rows) => { upserted.push(...rows); return { data: rows, error: null }; },
        select: () => ({ eq: () => ({ in: () => ({ then: (fn) => Promise.resolve(fn({ data: [], error: null })) }) }) }),
      };
    }
    let rows = table === "shipments" ? [...shipments] : [];
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      in: (c, vs) => { rows = rows.filter((r) => vs.includes(r[c])); return b; },
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "new" }, error: null }) }) }),
      update: () => ({ eq: () => ({ then: (fn) => Promise.resolve(fn({ data: null, error: null })) }) }),
      maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      then: (fn) => Promise.resolve(fn({ data: rows, error: null })),
    };
    return b;
  },
});

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {},
  handlePreflight: () => false,
  readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: TENANT, userId: "u1", user: { id: "u1" } }),
  requirePermission: () => {},
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));

import handler from "../api/sales/shipment_import.js";

const run = async (body) => {
  const req = { method: "POST", query: {}, _body: body };
  const res = { setHeader() {}, _status: 0, _json: null };
  await handler(req, res);
  return res;
};

const line = (inv, part) => ({
  shipper_invoice_no: inv, part_no: part, description: "cylinder assy", qty: 2, source_country: "KR",
});

beforeEach(() => { shipments = []; upserted = []; });

describe("known_invoices keeps a later batch's lines from reading as orphans", () => {
  it("counts them as orphans without the hint — the bug it prevents", async () => {
    // Batch two of a preview: lines only, and their shipment is still just a
    // pending row sitting in batch one.
    const res = await run({ mode: "preview", pending: [], lines: [line("OK-CO-26-0166", "FOR_UC-K3227")] });
    expect(res._status).toBe(200);
    expect(res._json.summary.orphan_invoices).toBe(1);
  });

  it("does not count them as orphans when the caller declares them", async () => {
    const res = await run({
      mode: "preview",
      pending: [],
      lines: [line("OK-CO-26-0166", "FOR_UC-K3227")],
      known_invoices: ["OK-CO-26-0166"],
    });
    expect(res._json.summary.orphan_invoices).toBe(0);
    // And they are counted as real work, not silently skipped.
    expect(res._json.summary.shipment_lines_matched).toBe(1);
  });

  it("still reports an invoice that is in no batch and on no shipment", async () => {
    // The declaration must not blanket-suppress the warning; an invoice nobody
    // has a summary row for is exactly what the operator needs told.
    const res = await run({
      mode: "preview",
      pending: [],
      lines: [line("OK-CO-26-0166", "A"), line("GHOST-999", "B")],
      known_invoices: ["OK-CO-26-0166"],
    });
    expect(res._json.summary.orphan_invoices).toBe(1);
    expect(res._json.summary.orphan_invoice_sample).toEqual(["GHOST-999"]);
  });

  it("writes nothing for a declared invoice that never materialised", async () => {
    // The safety property: declaring an invoice widens COUNTING. Persisting a
    // line still needs a shipment_id, from this payload's plan or the database.
    const res = await run({
      mode: "apply",
      pending: [],
      lines: [line("OK-CO-26-0166", "FOR_UC-K3227")],
      known_invoices: ["OK-CO-26-0166"],
    });
    expect(res._status).toBe(200);
    expect(upserted).toHaveLength(0);
    expect(res._json.summary.shipment_lines_applied).toBe(0);
  });

  it("writes the lines once the shipment is on file", async () => {
    // Batch one created it; batch two attaches to it. The whole point.
    shipments = [{ id: "s1", tenant_id: TENANT, shipper_invoice_no: "OK-CO-26-0166", source_po_id: null }];
    const res = await run({
      mode: "apply",
      pending: [],
      lines: [line("OK-CO-26-0166", "FOR_UC-K3227")],
      known_invoices: ["OK-CO-26-0166"],
    });
    expect(res._json.summary.shipment_lines_applied).toBe(1);
    expect(upserted[0]).toMatchObject({ shipment_id: "s1", part_no: "FOR_UC-K3227", tenant_id: TENANT });
  });

  it.each([undefined, [], null, ["", null]])("tolerates %p as the declaration", async (v) => {
    const res = await run({
      mode: "preview", pending: [], lines: [line("OK-CO-26-0166", "A")], known_invoices: v,
    });
    expect(res._status).toBe(200);
    expect(res._json.summary.orphan_invoices).toBe(1);
  });
});

describe("a lines-only upload is still accepted", () => {
  it("does not 400 when there are no shipment rows", async () => {
    // The daily workflow: part rows uploaded once, summary refreshed after.
    const res = await run({ mode: "preview", pending: [], lines: [line("OK-CO-26-0166", "A")] });
    expect(res._status).toBe(200);
    expect(res._json.summary.line_rows).toBe(1);
  });

  it("400s only when there is genuinely nothing", async () => {
    const res = await run({ mode: "preview", pending: [], lines: [] });
    expect(res._status).toBe(400);
  });
});
