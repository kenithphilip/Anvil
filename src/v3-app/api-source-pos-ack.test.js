// POST /api/source_pos/ack, driven through the real handler over a small
// in-memory table set. The Source POs screen now sends
//   { sourcePoId, ack: { confirmedPrice, confirmedEta, supplierRef, remarks } }
// and this pins what the handler does with that body: it writes the ack onto
// the source PO and logs a source_po_events row, inside the caller's tenant.

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const tables = {};
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  let idc = 0;
  const from = (table) => {
    if (!tables[table]) tables[table] = [];
    const filters = [];
    let op = "select";
    let payload = null;
    const rows = () => tables[table].filter((r) => filters.every(([c, v]) => r[c] === v));
    const exec = () => {
      if (op === "insert") {
        const ins = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: "row-" + (++idc), ...clone(p) }));
        tables[table].push(...ins);
        return ins.map(clone);
      }
      if (op === "update") {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, clone(payload)));
        return hit.map(clone);
      }
      return rows().map(clone);
    };
    const q = {
      select: () => q,
      eq: (c, v) => { filters.push([c, v]); return q; },
      insert: (p) => { op = "insert"; payload = p; return q; },
      update: (p) => { op = "update"; payload = p; return q; },
      single: async () => {
        const out = exec();
        return out[0] ? { data: out[0], error: null } : { data: null, error: { message: "no rows" } };
      },
      maybeSingle: async () => ({ data: exec()[0] || null, error: null }),
      then: (resolve, reject) => { try { exec(); resolve({ data: null, error: null }); } catch (e) { reject(e); } },
    };
    return q;
  };
  return {
    tables,
    from,
    reset() { for (const k of Object.keys(tables)) delete tables[k]; idc = 0; },
    seed(t, list) { tables[t] = list.map(clone); },
  };
});

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-buyer" }, tenantId: "t-1", role: "procurement" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => ({ from: H.from }) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}), recordEvent: vi.fn(async () => {}) }));

const { requirePermission } = await import("../api/_lib/auth.js");
const handler = (await import("../api/source_pos/ack.js")).default;

const post = async (body) => {
  let status = 200;
  let sent = "";
  const res = {
    setHeader: () => {},
    status(c) { status = c; return res; },
    send(p) { sent = p; return res; },
    end() { return res; },
  };
  await handler({ method: "POST", headers: {}, query: {}, url: "/api/source_pos/ack", body }, res);
  return { status, body: sent ? JSON.parse(sent) : null };
};

const SPO = {
  id: "spo-1",
  tenant_id: "t-1",
  order_id: "ord-1",
  reference: "SPO-REF-1",
  supplier: "Acme Robotics",
  country: "DE",
  currency: "EUR",
  total_foreign: 1000,
  acknowledged_eta: "2026-11-01",
  status: "SENT_TO_SUPPLIER",
  payload: {},
};

beforeEach(() => {
  H.reset();
  H.seed("source_pos", [SPO, { ...SPO, id: "spo-other", tenant_id: "t-2", reference: "OTHER-TENANT" }]);
  H.seed("source_po_events", []);
  H.seed("supplier_scorecards", []);
  vi.mocked(requirePermission).mockClear();
});

describe("POST /api/source_pos/ack", () => {
  it("accepts the screen's body, writes the ack, and logs a source_po_events row", async () => {
    const ack = { confirmedPrice: 1000, confirmedEta: "2026-11-03", supplierRef: "ACK-77", remarks: "confirmed by mail" };
    const r = await post({ sourcePoId: "spo-1", ack });

    expect(r.status).toBe(200);
    expect(r.body.status).toBe("SUPPLIER_ACK");
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), "write");

    const row = H.tables.source_pos.find((p) => p.id === "spo-1");
    expect(row.status).toBe("SUPPLIER_ACK");
    expect(row.ack_payload).toEqual(ack);
    expect(row.acknowledged_price).toBe(1000);
    expect(row.acknowledged_eta).toBe("2026-11-03");
    expect(row.eta_variance_days).toBe(2);
    expect(row.price_variance_pct).toBe(0);
    expect(typeof row.ack_received_at).toBe("string");

    expect(H.tables.source_po_events).toHaveLength(1);
    expect(H.tables.source_po_events[0]).toMatchObject({
      tenant_id: "t-1",
      source_po_id: "spo-1",
      from_status: "SENT_TO_SUPPLIER",
      to_status: "SUPPLIER_ACK",
      actor: "u-buyer",
    });
  });

  it("marks a changed PO total as PRICE_CHANGED", async () => {
    const r = await post({ sourcePoId: "spo-1", ack: { confirmedPrice: 1100, confirmedEta: null } });

    expect(r.status).toBe(200);
    const row = H.tables.source_pos.find((p) => p.id === "spo-1");
    expect(row.status).toBe("PRICE_CHANGED");
    expect(row.price_variance_pct).toBe(10);
    expect(H.tables.source_po_events[0].to_status).toBe("PRICE_CHANGED");
  });

  it("refuses a source PO from another tenant, and writes nothing", async () => {
    const r = await post({ sourcePoId: "spo-other", ack: { confirmedPrice: 1000 } });

    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe("Source PO not found");
    expect(H.tables.source_pos.find((p) => p.id === "spo-other").status).toBe("SENT_TO_SUPPLIER");
    expect(H.tables.source_po_events).toHaveLength(0);
  });

  it("still refuses a body with no ack (what the screen used to send)", async () => {
    // ack({ sourcePoId, ack }) against ack(sourcePoId, ack) put the whole
    // object in sourcePoId and left ack undefined, which JSON drops.
    const r = await post(JSON.parse(JSON.stringify({ sourcePoId: { sourcePoId: "spo-1", ack: {} }, ack: undefined })));

    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("sourcePoId and ack required");
    expect(H.tables.source_po_events).toHaveLength(0);
  });
});
