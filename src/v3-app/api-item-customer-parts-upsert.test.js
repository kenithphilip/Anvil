// Unit tests for the shared upsert helper at
// src/api/_lib/item-customer-parts.js. The helper is the single
// write path for item_customer_parts and is called from the admin
// drawer, the recon-table manual map, the LLM-suggest accept flow,
// the quote SENT learning hook, and the bulk-import endpoint.
//
// The priority rule the tests guard:
//   manual / bulk_import   never overwritten by non-explicit writes
//   quote_sent / llm_suggest / legacy   always upgraded by manual
//
// Mock: in-memory chainable Supabase-style stub. Mirrors the
// pattern in api-agent-handlers.test.js, extended with `neq` so
// the is_primary demotion query works.

import { describe, it, expect } from "vitest";
import {
  upsertCustomerPart,
  upsertCustomerPartsBatch,
  resolveCustomerRef,
  resolveItemRef,
} from "../api/_lib/item-customer-parts.js";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const ITEM = "00000000-0000-0000-0000-0000000000ee";
const CUST = "00000000-0000-0000-0000-0000000000bb";
const ACTOR = "00000000-0000-0000-0000-0000000000cc";
const OTHER_ITEM = "00000000-0000-0000-0000-0000000000ff";
const PART = "GD544202603190008";
const SAP = "A12060OBAR010003";

const makeSvc = (tables) => {
  const buildQuery = (table) => {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    let mode = "select";
    let single = false;
    const builder = {
      select: () => builder,
      eq: (col, val) => { rows = rows.filter((r) => String(r[col]) === String(val)); return builder; },
      neq: (col, val) => { rows = rows.filter((r) => String(r[col]) !== String(val)); return builder; },
      is: (col, val) => { rows = rows.filter((r) => (r[col] === undefined ? null : r[col]) === val); return builder; },
      ilike: (col, val) => {
        const pat = String(val).toLowerCase();
        rows = rows.filter((r) => String(r[col] || "").toLowerCase() === pat);
        return builder;
      },
      in: (col, vals) => {
        const set = new Set(vals.map(String));
        rows = rows.filter((r) => set.has(String(r[col])));
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => { single = true; return builder; },
      single: () => { single = true; return builder; },
      update: (patch) => { mode = "update"; builder._patch = patch; return builder; },
      insert: (row) => { mode = "insert"; builder._insert = row; return builder; },
      delete: () => { mode = "delete"; return builder; },
      upsert: (row) => { mode = "upsert"; builder._insert = row; return builder; },
      then: (fn) => Promise.resolve(fn(terminal())),
    };
    const terminal = () => {
      if (mode === "update") {
        for (const r of rows) Object.assign(r, builder._patch);
        return { data: single ? rows[0] || null : rows, error: null };
      }
      if (mode === "insert" || mode === "upsert") {
        const inserted = Array.isArray(builder._insert) ? builder._insert : [builder._insert];
        ds.push(...inserted);
        return { data: single ? inserted[0] : inserted, error: null };
      }
      if (mode === "delete") {
        for (const r of rows) {
          const idx = ds.indexOf(r);
          if (idx !== -1) ds.splice(idx, 1);
        }
        return { data: null, error: null };
      }
      if (single) return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    };
    return builder;
  };
  return { from: buildQuery, _tables: tables };
};

describe("upsertCustomerPart", () => {
  it("inserts a new manual row with full audit columns", async () => {
    const svc = makeSvc({ item_customer_parts: [] });
    const { row, action } = await upsertCustomerPart(svc, {
      tenantId: TENANT,
      itemId: ITEM,
      customerId: CUST,
      customerPartNumber: PART,
      createdVia: "manual",
      createdBy: ACTOR,
      confidencePct: 100,
      confirmedAt: "2026-05-12T00:00:00Z",
      confirmedBy: ACTOR,
    });
    expect(action).toBe("insert");
    expect(row.created_via).toBe("manual");
    expect(row.created_by).toBe(ACTOR);
    expect(row.confidence_pct).toBe(100);
    expect(row.confirmed_by).toBe(ACTOR);
    expect(svc._tables.item_customer_parts.length).toBe(1);
  });

  it("upgrades a quote_sent row when a manual write lands", async () => {
    const svc = makeSvc({
      item_customer_parts: [{
        tenant_id: TENANT, item_id: ITEM, customer_id: CUST,
        customer_part_number: PART, is_primary: false,
        created_via: "quote_sent", created_by: ACTOR,
        confidence_pct: 95, confirmed_at: "2026-05-01T00:00:00Z", confirmed_by: ACTOR,
      }],
    });
    const { row, action } = await upsertCustomerPart(svc, {
      tenantId: TENANT, itemId: ITEM, customerId: CUST,
      customerPartNumber: PART,
      createdVia: "manual", createdBy: ACTOR,
      confidencePct: 100,
      confirmedAt: "2026-05-12T00:00:00Z", confirmedBy: ACTOR,
    });
    expect(action).toBe("update");
    expect(row.created_via).toBe("manual");
    expect(row.confidence_pct).toBe(100);
    expect(row.confirmed_at).toBe("2026-05-12T00:00:00Z");
  });

  it("does not downgrade a manual row when a quote_sent write lands (noop)", async () => {
    const svc = makeSvc({
      item_customer_parts: [{
        tenant_id: TENANT, item_id: ITEM, customer_id: CUST,
        customer_part_number: PART, is_primary: false,
        created_via: "manual", created_by: ACTOR,
        confidence_pct: 100, confirmed_at: "2026-05-12T00:00:00Z", confirmed_by: ACTOR,
      }],
    });
    const { action } = await upsertCustomerPart(svc, {
      tenantId: TENANT, itemId: ITEM, customerId: CUST,
      customerPartNumber: PART,
      createdVia: "quote_sent", createdBy: ACTOR,
      confidencePct: 95,
      confirmedAt: "2026-05-15T00:00:00Z", confirmedBy: ACTOR,
    });
    expect(action).toBe("noop");
    // Underlying row not touched.
    expect(svc._tables.item_customer_parts[0].confidence_pct).toBe(100);
    expect(svc._tables.item_customer_parts[0].confirmed_at).toBe("2026-05-12T00:00:00Z");
  });

  it("does not downgrade a bulk_import row when an llm_suggest write lands (noop)", async () => {
    const svc = makeSvc({
      item_customer_parts: [{
        tenant_id: TENANT, item_id: ITEM, customer_id: CUST,
        customer_part_number: PART, is_primary: false,
        created_via: "bulk_import", created_by: ACTOR,
        confidence_pct: 100, confirmed_at: "2026-05-12T00:00:00Z", confirmed_by: ACTOR,
      }],
    });
    const { action } = await upsertCustomerPart(svc, {
      tenantId: TENANT, itemId: ITEM, customerId: CUST,
      customerPartNumber: PART,
      createdVia: "llm_suggest", createdBy: ACTOR,
      confidencePct: 87, confirmedAt: "2026-05-15T00:00:00Z", confirmedBy: ACTOR,
    });
    expect(action).toBe("noop");
  });

  it("rejects an invalid created_via", async () => {
    const svc = makeSvc({ item_customer_parts: [] });
    await expect(upsertCustomerPart(svc, {
      tenantId: TENANT, itemId: ITEM, customerId: CUST,
      customerPartNumber: PART, createdVia: "not_a_real_source",
    })).rejects.toThrow(/invalid createdVia/);
  });

  it("rejects an empty customer_part_number after trim", async () => {
    const svc = makeSvc({ item_customer_parts: [] });
    await expect(upsertCustomerPart(svc, {
      tenantId: TENANT, itemId: ITEM, customerId: CUST,
      customerPartNumber: "   ", createdVia: "manual",
    })).rejects.toThrow(/empty after trim/);
  });

  // CM P2b: the buyer SAP item code is persisted in its own column
  // and honours the one-active-item-per-(customer,SAP-code) invariant.
  it("persists customer_item_code on insert", async () => {
    const svc = makeSvc({ item_customer_parts: [] });
    const { row, action } = await upsertCustomerPart(svc, {
      tenantId: TENANT, itemId: ITEM, customerId: CUST,
      customerPartNumber: PART, customerItemCode: SAP,
      createdVia: "manual", createdBy: ACTOR,
    });
    expect(action).toBe("insert");
    expect(row.customer_item_code).toBe(SAP);
    expect(svc._tables.item_customer_parts[0].customer_item_code).toBe(SAP);
  });

  it("omits customer_item_code entirely when no SAP code is supplied", async () => {
    const svc = makeSvc({ item_customer_parts: [] });
    const { row } = await upsertCustomerPart(svc, {
      tenantId: TENANT, itemId: ITEM, customerId: CUST,
      customerPartNumber: PART, createdVia: "manual",
    });
    expect("customer_item_code" in row).toBe(false);
  });

  it("supersedes a prior active mapping when the same SAP code moves to a new item", async () => {
    const svc = makeSvc({
      item_customer_parts: [{
        tenant_id: TENANT, item_id: OTHER_ITEM, customer_id: CUST,
        customer_part_number: "OLDPART", customer_item_code: SAP,
        valid_to: null, is_primary: false, created_via: "llm_suggest",
      }],
    });
    const { action } = await upsertCustomerPart(svc, {
      tenantId: TENANT, itemId: ITEM, customerId: CUST,
      customerPartNumber: "NEWPART", customerItemCode: SAP,
      createdVia: "manual", createdBy: ACTOR,
    });
    expect(action).toBe("insert");
    const rows = svc._tables.item_customer_parts;
    const prior = rows.find((r) => r.item_id === OTHER_ITEM);
    const fresh = rows.find((r) => r.item_id === ITEM);
    // Prior SAP->OTHER_ITEM mapping retired (valid_to stamped) so the
    // mig-182 partial unique index permits the new active row.
    expect(prior.valid_to).not.toBeNull();
    expect(fresh.customer_item_code).toBe(SAP);
    expect(fresh.valid_to == null).toBe(true);
  });

  it("does not supersede the same item re-confirming its own SAP code", async () => {
    const svc = makeSvc({
      item_customer_parts: [{
        tenant_id: TENANT, item_id: ITEM, customer_id: CUST,
        customer_part_number: PART, customer_item_code: SAP,
        valid_to: null, is_primary: false, created_via: "manual",
      }],
    });
    await upsertCustomerPart(svc, {
      tenantId: TENANT, itemId: ITEM, customerId: CUST,
      customerPartNumber: PART, customerItemCode: SAP,
      createdVia: "manual", createdBy: ACTOR,
    });
    // The one existing row (same item) stays active — .neq(item_id)
    // excludes it from supersession.
    expect(svc._tables.item_customer_parts[0].valid_to == null).toBe(true);
  });
});

describe("resolveCustomerRef + resolveItemRef", () => {
  it("returns null when the ref is missing or empty", async () => {
    const svc = makeSvc({});
    expect(await resolveCustomerRef(svc, TENANT, null)).toBeNull();
    expect(await resolveCustomerRef(svc, TENANT, "")).toBeNull();
    expect(await resolveItemRef(svc, TENANT, null, null)).toBeNull();
  });

  it("resolves a UUID customer ref via id", async () => {
    const svc = makeSvc({ customers: [{ id: CUST, tenant_id: TENANT, customer_name: "Summit" }] });
    expect(await resolveCustomerRef(svc, TENANT, CUST)).toBe(CUST);
  });

  it("resolves a name-shaped customer ref via ilike", async () => {
    const svc = makeSvc({ customers: [{ id: CUST, tenant_id: TENANT, customer_name: "Summit" }] });
    expect(await resolveCustomerRef(svc, TENANT, "Summit")).toBe(CUST);
  });

  it("resolves an item by part_no when no UUID provided", async () => {
    const svc = makeSvc({ item_master: [{ id: ITEM, tenant_id: TENANT, part_no: "THB-L1-70B-2" }] });
    expect(await resolveItemRef(svc, TENANT, null, "THB-L1-70B-2")).toBe(ITEM);
  });
});

describe("upsertCustomerPartsBatch", () => {
  it("returns per-row errors without aborting the batch", async () => {
    const svc = makeSvc({
      item_master: [{ id: ITEM, tenant_id: TENANT, part_no: "THB-L1-70B-2" }],
      customers: [{ id: CUST, tenant_id: TENANT, customer_name: "Summit" }],
      item_customer_parts: [],
    });
    const ctx = { tenantId: TENANT, user: { id: ACTOR } };
    const { ok, errors } = await upsertCustomerPartsBatch(svc, ctx, [
      { customer_name: "Summit", item_master_part_no: "THB-L1-70B-2", customer_part_number: PART },
      { customer_name: "Summit", item_master_part_no: "DOES-NOT-EXIST", customer_part_number: "X" },
      { customer_name: "MissingCustomer", item_master_part_no: "THB-L1-70B-2", customer_part_number: "Y" },
      { customer_name: "Summit", item_master_part_no: "THB-L1-70B-2", customer_part_number: "   " },
    ]);
    expect(ok).toBe(1);
    expect(errors.length).toBe(3);
    expect(errors.find((e) => e.row_index === 1).reason).toMatch(/item_master not found/);
    expect(errors.find((e) => e.row_index === 2).reason).toMatch(/customer not found/);
    expect(errors.find((e) => e.row_index === 3).reason).toMatch(/customer_part_number required/);
    expect(svc._tables.item_customer_parts.length).toBe(1);
    expect(svc._tables.item_customer_parts[0].created_via).toBe("bulk_import");
  });
});
