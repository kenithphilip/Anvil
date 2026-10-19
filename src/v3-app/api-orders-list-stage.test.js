// GET /api/orders returns each order's stage (plan R-M1, C-9), slim or not,
// from one mode read and one batched ERP SO read per page: no read per order.
// The REAL handler against the in-memory Supabase, with the select lists
// applied, so a stage column missing from the slim select reads back wrong.
// Invented ids; no real names.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => ({ db: null, ctx: null, reads: [] }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
// Each read is counted. The customer embed is dropped before the select is
// applied, since the memory database does not embed.
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => {
    const svc = H.db.svc();
    return {
      ...svc,
      from: (table) => {
        H.reads.push(table);
        const b = svc.from(table);
        const select = b.select;
        b.select = (cols) => select(typeof cols === "string" ? cols.replace(/,\s*\w+:\w+\([^)]*\)/g, "") : cols);
        return b;
      },
    };
  },
}));

const { default: handler } = await import("../api/orders/index.js");

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const HASH = "hash-1";

const order = (id, over = {}) => ({
  id, tenant_id: T1, status: "DRAFT", po_number: "PO-" + id, created_at: "2026-10-0" + (over.day || 1) + "T05:00:00.000Z",
  updated_at: "2026-10-09T05:00:00.000Z", approval: null, approved_at: null, payload_hash: HASH,
  correction_reason: null, correction_requested_at: null, tally_status: "idle",
  handoff_status: null, handoff_sent_at: null, handoff_payload: null, result: {}, preflight_payload: {}, ...over,
});
const approved = (id, over = {}) => order(id, { status: "APPROVED", approval: { payloadHash: HASH }, approved_at: "2026-10-03T05:00:00.000Z", ...over });

const seed = (mode, orders, links) => {
  H.db = createMemoryDb({
    tenant_settings: [{ tenant_id: T1, so_processing_mode: mode }, { tenant_id: T2, so_processing_mode: "A" }],
    orders,
    order_documents: links,
  }, {}, { project: true });
};

const list = (query = {}) => callHandler(handler, { query });
const stages = (r) => Object.fromEntries(r.body.orders.map((o) => [o.id, o.stage.stage]));
const count = (table) => H.reads.filter((t) => t === table).length;

beforeEach(() => {
  H.ctx = { user: { id: "u-1" }, tenantId: T1, role: "sales_engineer" };
  H.reads = [];
  seed("B", [
    order("o-draft", { day: 1 }),
    order("o-review", { day: 2, status: "PENDING_REVIEW" }),
    approved("o-appr", { day: 3 }),
    approved("o-sent", { day: 4, handoff_status: "sent", handoff_sent_at: "2026-10-04T05:00:00.000Z", handoff_payload: { payload_hash: HASH } }),
    approved("o-keyed", { day: 5 }),
    approved("o-x", { tenant_id: T2, day: 6 }),
  ], [
    { order_id: "o-keyed", document_id: "doc-so-1", role: "sales_order" },
    { order_id: "o-appr", document_id: "doc-po-1", role: "purchase_order" },
    { order_id: "o-x", document_id: "doc-so-x", role: "sales_order" },
  ]);
});

describe("GET /api/orders: the stage on every order", () => {
  for (const slim of [false, true]) {
    it((slim ? "slim" : "full") + ": each order carries its Mode B stage, from one batched ERP SO read", async () => {
      const r = await list(slim ? { slim: "1" } : {});
      expect(r.status).toBe(200);
      expect(stages(r)).toEqual({
        "o-draft": "verifying", "o-review": "in_approval", "o-appr": "approved", "o-sent": "handed_off", "o-keyed": "keyed",
      });
      expect(r.body.orders.find((o) => o.id === "o-keyed").stage).toMatchObject({ evidence_ref: "order_documents:doc-so-1", holder_role: "sales_engineer" });
      expect(count("order_documents")).toBe(1);
      expect(count("tenant_settings")).toBe(1);
    });
  }

  it("Mode A reads the same rows as push states, and another tenant's ERP SO never counts", async () => {
    H.db.tables.tenant_settings[0].so_processing_mode = "A";
    const r = await list({ slim: "1" });
    expect(stages(r)).toMatchObject({ "o-appr": "approved", "o-sent": "approved", "o-keyed": "approved" });
    expect(r.body.orders.map((o) => o.id)).not.toContain("o-x");
  });

  it("a page of 150 orders is still read in chunks, not per order", async () => {
    seed("B", Array.from({ length: 150 }, (_, i) => approved("o-" + i)), [{ order_id: "o-7", document_id: "doc-7", role: "sales_order" }]);
    const r = await list({ slim: "1", limit: "200" });
    expect(r.body.orders).toHaveLength(150);
    expect(r.body.orders.find((o) => o.id === "o-7").stage.stage).toBe("keyed");
    expect(count("order_documents")).toBe(2);
    expect(count("tenant_settings")).toBe(1);
  });

  it("an empty page reads no evidence", async () => {
    H.ctx = { user: { id: "u-1" }, tenantId: "30000000-0000-4000-8000-000000000003", role: "sales_engineer" };
    const r = await list({ slim: "1" });
    expect(r.body.orders).toEqual([]);
    expect(count("order_documents")).toBe(0);
    expect(count("tenant_settings")).toBe(0);
  });
});
