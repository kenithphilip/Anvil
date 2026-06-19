// Unit tests for the ERP export idempotency ledger (_lib/erp-export-ledger.js).
//
// Covers the guard's three outcomes (idempotent no-op, blocked on changed
// hash, proceed) plus recordExport round-tripping, against a small
// in-memory svc that mimics the PostgREST chain the helper uses.

import { describe, it, expect } from "vitest";
import { checkExportIdempotency, recordExport, orderPayloadHash } from "../api/_lib/erp-export-ledger.js";

// Minimal in-memory stand-in for the Supabase service client. Supports
// the exact chains the helper builds: select().eq()...maybeSingle(),
// select().eq()...order().limit().maybeSingle(), and upsert() with the
// unique key as onConflict.
const makeSvc = (seed = []) => {
  const store = seed.map((r) => ({ ...r }));
  const svc = {
    _rows: store,
    from() {
      const b = {
        _filters: [],
        _order: null,
        select() { return b; },
        eq(col, val) { b._filters.push([col, val]); return b; },
        order(col, opts) { b._order = [col, opts]; return b; },
        limit() { return b; },
        async maybeSingle() {
          let rows = store.filter((row) => b._filters.every(([c, v]) => row[c] === v));
          if (b._order) {
            const [c, o] = b._order;
            rows = [...rows].sort((a, z) => (a[c] < z[c] ? 1 : -1) * (o?.ascending ? -1 : 1));
          }
          return { data: rows[0] || null, error: null };
        },
        async upsert(row, { onConflict } = {}) {
          const keys = (onConflict || "").split(",").map((s) => s.trim());
          const idx = store.findIndex((r) => keys.every((k) => r[k] === row[k]));
          if (idx >= 0) store[idx] = { ...store[idx], ...row };
          else store.push({ ...row });
          return { error: null };
        },
      };
      return b;
    },
  };
  return svc;
};

const base = { tenantId: "t1", orderId: "o1", connector: "sap" };

describe("orderPayloadHash", () => {
  it("prefers the order column, then the approval blob, then null", () => {
    expect(orderPayloadHash({ payload_hash: "h1", approval: { payloadHash: "h2" } })).toBe("h1");
    expect(orderPayloadHash({ approval: { payloadHash: "h2" } })).toBe("h2");
    expect(orderPayloadHash({})).toBeNull();
    expect(orderPayloadHash(null)).toBeNull();
  });
});

describe("checkExportIdempotency", () => {
  it("returns idempotent + prior external id for an exact (order, connector, hash) match", async () => {
    const svc = makeSvc([{ tenant_id: "t1", order_id: "o1", connector: "sap", payload_hash: "h1", external_id: "SAP-100", status: "success" }]);
    const r = await checkExportIdempotency(svc, { ...base, payloadHash: "h1", allowReexport: false });
    expect(r).toEqual({ idempotent: true, external_id: "SAP-100" });
  });

  it("proceeds when there is no prior export at all", async () => {
    const svc = makeSvc([]);
    const r = await checkExportIdempotency(svc, { ...base, payloadHash: "h1", allowReexport: false });
    expect(r).toEqual({ proceed: true });
  });

  it("blocks a changed-hash re-export with PAYLOAD_HASH_CHANGED", async () => {
    const svc = makeSvc([{ tenant_id: "t1", order_id: "o1", connector: "sap", payload_hash: "OLD", external_id: "SAP-1", status: "success", last_pushed_at: "2026-01-01" }]);
    const r = await checkExportIdempotency(svc, { ...base, payloadHash: "NEW", allowReexport: false });
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("PAYLOAD_HASH_CHANGED");
    expect(r.body.error.prior_external_id).toBe("SAP-1");
  });

  it("proceeds on a changed hash when re-export is explicitly allowed", async () => {
    const svc = makeSvc([{ tenant_id: "t1", order_id: "o1", connector: "sap", payload_hash: "OLD", external_id: "SAP-1", status: "success" }]);
    const r = await checkExportIdempotency(svc, { ...base, payloadHash: "NEW", allowReexport: true });
    expect(r).toEqual({ proceed: true });
  });

  it("does not block across connectors (same order, different ERP)", async () => {
    const svc = makeSvc([{ tenant_id: "t1", order_id: "o1", connector: "sap", payload_hash: "h1", external_id: "SAP-1", status: "success" }]);
    const r = await checkExportIdempotency(svc, { ...base, connector: "netsuite", payloadHash: "h1", allowReexport: false });
    expect(r).toEqual({ proceed: true });
  });

  it("proceeds without a DB hit when no payload hash is available", async () => {
    const svc = makeSvc([]);
    const r = await checkExportIdempotency(svc, { ...base, payloadHash: null, allowReexport: false });
    expect(r).toEqual({ proceed: true });
  });
});

describe("recordExport + round trip", () => {
  it("records a success row that a subsequent exact check treats as idempotent", async () => {
    const svc = makeSvc([]);
    await recordExport(svc, { ...base, payloadHash: "h1", externalId: "SAP-200" });
    expect(svc._rows).toHaveLength(1);
    const r = await checkExportIdempotency(svc, { ...base, payloadHash: "h1", allowReexport: false });
    expect(r).toEqual({ idempotent: true, external_id: "SAP-200" });
  });

  it("upsert on the unique key does not duplicate a repeated same-hash export", async () => {
    const svc = makeSvc([]);
    await recordExport(svc, { ...base, payloadHash: "h1", externalId: "SAP-1" });
    await recordExport(svc, { ...base, payloadHash: "h1", externalId: "SAP-1" });
    expect(svc._rows).toHaveLength(1);
  });

  it("is a no-op when there is no payload hash to key on", async () => {
    const svc = makeSvc([]);
    await recordExport(svc, { ...base, payloadHash: null, externalId: "SAP-1" });
    expect(svc._rows).toHaveLength(0);
  });
});
