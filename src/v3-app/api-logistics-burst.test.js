// Does the monitor actually stay bounded when switched on against history?
//
// An adversarial review of the first attempt at this fix answered "no" — by
// SIMULATING the detector rather than reading it. On a dense tenant the
// windowed, newest-first version still produced 938 exceptions, 727 of them
// critical, and auto-resolved nothing at all. Every one of those defects was
// invisible to code review and obvious to a run.
//
// So the claim gets a run. This drives the real detectAllLogistics against an
// in-memory Postgres-ish stub shaped like a tenant with years of history.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectAllLogistics } from "../api/_lib/logistics/monitor.js";

const DAY = 86400000;
const NOW = new Date("2026-08-15T00:00:00.000Z");
const ago = (d) => new Date(NOW.getTime() - d * DAY).toISOString();

// ---- a small query stub -------------------------------------------------
// Supports exactly the chain shapes the detector builds. Filters are applied in
// memory so the test exercises real selection logic, not a hand-fed result set.
const makeSvc = (tables) => {
  const calls = { inserts: [], updates: [] };
  const build = (name) => {
    let rows = [...(tables[name] || [])];
    let pendingUpdate = null;
    let pendingInsert = null;
    const api = {
      select: () => api,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return api; },
      in: (c, vs) => { rows = rows.filter((r) => vs.includes(r[c])); return api; },
      gte: (c, v) => { rows = rows.filter((r) => r[c] != null && String(r[c]) >= String(v)); return api; },
      lte: (c, v) => { rows = rows.filter((r) => r[c] != null && String(r[c]) <= String(v)); return api; },
      is: (c, v) => { rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
      not: (c, _op, v) => { rows = rows.filter((r) => (v === null ? r[c] != null : r[c] !== v)); return api; },
      filter: (c, _op, v) => {
        if (c.includes("->")) return api;                       // jsonb path: not modelled
        rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v));
        return api;
      },
      // `or` is used for the ISO window; approximated as "keep rows inside the
      // window on either clock", which is the semantic under test.
      or: (expr) => {
        const m = /approved_at\.gte\.([^,]+)/.exec(expr);
        if (m) {
          const cutoff = m[1];
          rows = rows.filter((r) => (r.approved_at ? r.approved_at >= cutoff : (r.created_at || "") >= cutoff));
        }
        return api;
      },
      order: (c, o) => {
        const asc = o?.ascending !== false;
        rows.sort((a, b) => String(a[c] ?? "").localeCompare(String(b[c] ?? "")) * (asc ? 1 : -1));
        return api;
      },
      limit: (n) => { rows = rows.slice(0, n); return api; },
      range: (a, b) => { rows = rows.slice(a, b + 1); return api; },
      single: async () => {
        const row = { id: `x${tables.logistics_exceptions.length + 1}`, ...pendingInsert };
        tables.logistics_exceptions.push(row);
        calls.inserts.push(row);
        return { data: row, error: null };
      },
      insert: (payload) => { pendingInsert = payload; calls.inserts.push(payload); return api; },
      update: (patch) => { pendingUpdate = patch; return api; },
      then: (fn) => {
        if (pendingUpdate) {
          for (const r of rows) Object.assign(r, pendingUpdate);
          calls.updates.push({ table: name, patch: pendingUpdate, n: rows.length });
          pendingUpdate = null;
          return Promise.resolve(fn({ data: null, error: null }));
        }
        return Promise.resolve(fn({ data: rows, error: null }));
      },
    };
    // insert().select().single() — select must not wipe the pending payload
    const origSelect = api.select;
    api.select = (...a) => { if (pendingInsert) return api; return origSelect(...a); };
    return api;
  };
  return { from: build, __calls: calls };
};

// A tenant with years of history, dense enough that every population overflows
// the detector's 500-row page inside the 90-day window.
const denseTenant = () => {
  const source_pos = [];
  for (let i = 0; i < 900; i += 1) {
    source_pos.push({
      id: `p${i}`, tenant_id: "t1", order_id: null, reference: `SPO-${i}`,
      supplier: "Acme", country: i % 2 ? "JP" : "IN",
      status: "SENT_TO_SUPPLIER", acknowledged_eta: null,
      created_at: ago(200 + i), updated_at: ago(1 + (i % 85)),
    });
  }
  const orders = [];
  for (let i = 0; i < 900; i += 1) {
    orders.push({
      id: `o${i}`, tenant_id: "t1", po_number: `PO-${i}`, customer_id: "c1",
      status: "APPROVED", committed_delivery_date: ago(5 + (i % 40)).slice(0, 10),
      created_at: ago(200 + i), updated_at: ago(1 + (i % 85)),
    });
  }
  const internal_sales_orders = [];
  for (let i = 0; i < 900; i += 1) {
    internal_sales_orders.push({
      id: `i${i}`, tenant_id: "t1", iso_number: `ISO-${i}`, status: "APPROVED",
      customer_id: "c1", vendor_name: "Mfg", approved_at: ago(6 + (i % 80)), created_at: ago(300 + i),
    });
  }
  return {
    logistics_monitor_rules: [],
    source_pos, orders, internal_sales_orders,
    shipments: [],
    logistics_exceptions: [],
  };
};

describe("a first run on a tenant with history", () => {
  const savedCap = process.env.LOGISTICS_MAX_RAISE_PER_RUN;
  beforeEach(() => { delete process.env.LOGISTICS_MAX_RAISE_PER_RUN; });
  afterEach(() => {
    if (savedCap === undefined) delete process.env.LOGISTICS_MAX_RAISE_PER_RUN;
    else process.env.LOGISTICS_MAX_RAISE_PER_RUN = savedCap;
  });

  it("raises at most the per-run cap, not thousands", async () => {
    // The headline. Before the cap, a measured simulation of this exact shape
    // produced 938 exceptions on the first tick.
    const tables = denseTenant();
    const svc = makeSvc(tables);
    const out = await detectAllLogistics(svc, "t1", { now: NOW });
    expect(out.created).toBeLessThanOrEqual(out.raise_cap);
    expect(out.created).toBe(100);
    expect(out.deferred).toBeGreaterThan(0);
    expect(tables.logistics_exceptions).toHaveLength(100);
  });

  it("reports what it deferred instead of pretending it saw less", async () => {
    const tables = denseTenant();
    const out = await detectAllLogistics(makeSvc(tables), "t1", { now: NOW });
    // detected counts every flag; created + deferred + skipped accounts for them.
    expect(out.detected).toBeGreaterThan(out.created);
    expect(out.created + out.deferred + out.skipped).toBe(out.detected);
  });

  it("drains across successive runs rather than stalling", async () => {
    const tables = denseTenant();
    const svc = makeSvc(tables);
    await detectAllLogistics(svc, "t1", { now: NOW });
    const second = await detectAllLogistics(makeSvc(tables), "t1", { now: NOW });
    // The second run adds another capped batch on top of the first.
    expect(tables.logistics_exceptions.length).toBeGreaterThan(100);
    expect(second.created).toBeGreaterThan(0);
  });

  it("surfaces the window and the truncation honestly", async () => {
    const out = await detectAllLogistics(makeSvc(denseTenant()), "t1", { now: NOW });
    expect(out.lookback_days).toBe(90);
    expect(out.truncated).toEqual(expect.arrayContaining(["source_po", "order"]));
    expect(out.scanned.source_po).toBe(500);
  });
});

describe("the queue can actually be worked down", () => {
  it("does not re-raise what the operator acknowledged", async () => {
    const tables = denseTenant();
    await detectAllLogistics(makeSvc(tables), "t1", { now: NOW });
    const first = tables.logistics_exceptions[0];
    first.status = "acknowledged";
    const before = tables.logistics_exceptions.length;

    await detectAllLogistics(makeSvc(tables), "t1", { now: NOW });
    const dupes = tables.logistics_exceptions.filter(
      (e) => e.detail?.fingerprint === first.detail.fingerprint,
    );
    expect(dupes).toHaveLength(1);
    expect(dupes[0].status).toBe("acknowledged");
    expect(tables.logistics_exceptions.length).toBeGreaterThanOrEqual(before);
  });

  it("closes an exception once its PO is received", async () => {
    // The dominant clearing transition, and the one that removes the PO from
    // the scan population — so it is reachable only via the terminal-status
    // reconciliation pass. Without that pass these stay open forever.
    const tables = denseTenant();
    await detectAllLogistics(makeSvc(tables), "t1", { now: NOW });
    const opened = tables.logistics_exceptions.filter((e) => e.object_type === "source_po");
    expect(opened.length).toBeGreaterThan(0);

    for (const e of opened) {
      const po = tables.source_pos.find((p) => p.id === e.object_id);
      if (po) po.status = "RECEIVED";
    }
    const out = await detectAllLogistics(makeSvc(tables), "t1", { now: NOW });
    expect(out.resolved).toBeGreaterThan(0);
    for (const e of opened) expect(e.status).toBe("resolved");
  });

  it("does not close an exception whose object is still in flight", async () => {
    const tables = denseTenant();
    await detectAllLogistics(makeSvc(tables), "t1", { now: NOW });
    const out = await detectAllLogistics(makeSvc(tables), "t1", { now: NOW });
    // Nothing changed underneath, so nothing may be reported as fixed.
    expect(out.resolved).toBe(0);
  });
});

describe("a small tenant is unaffected by any of this", () => {
  it("raises everything it finds and stays under the cap", async () => {
    const tables = {
      logistics_monitor_rules: [],
      source_pos: [{
        id: "p1", tenant_id: "t1", reference: "SPO-1", supplier: "Acme", country: "IN",
        status: "SENT_TO_SUPPLIER", acknowledged_eta: null,
        created_at: ago(40), updated_at: ago(30),
      }],
      orders: [], internal_sales_orders: [], shipments: [], logistics_exceptions: [],
    };
    const out = await detectAllLogistics(makeSvc(tables), "t1", { now: NOW });
    expect(out.created).toBe(1);
    expect(out.deferred).toBe(0);
    expect(out.truncated).toEqual([]);
    expect(tables.logistics_exceptions[0].rule_kind).toBe("po_local_supplier");
  });

  it("ignores records outside the lookback window", async () => {
    const tables = {
      logistics_monitor_rules: [],
      source_pos: [{
        id: "old", tenant_id: "t1", reference: "SPO-OLD", supplier: "Acme", country: "IN",
        status: "SENT_TO_SUPPLIER", acknowledged_eta: null,
        created_at: ago(900), updated_at: ago(800),
      }],
      orders: [], internal_sales_orders: [], shipments: [], logistics_exceptions: [],
    };
    const out = await detectAllLogistics(makeSvc(tables), "t1", { now: NOW });
    expect(out.created).toBe(0);
    expect(out.scanned.source_po).toBe(0);
  });
});
