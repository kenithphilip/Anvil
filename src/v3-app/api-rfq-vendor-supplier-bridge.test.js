// PR-B (migration 168): an RFQ vendor bridges to a suppliers-master row, so
// awarding a bridged vendor stamps supplier_id onto BOTH the composition line
// (cost) AND the customer quote line — never the sell price. Un-bridged
// vendors fall back to the free-text supplier_name path unchanged.
//
// feedCompositionLine / loadVendorMaps are pure (svc + ctx args), so we test
// them directly against a schema-aware in-memory Supabase fake. The schema set
// lets us simulate a pre-migration DB (missing column -> 42703) and prove the
// strip-retry / graceful-fallback paths.

import { describe, it, expect } from "vitest";
import { feedCompositionLine, loadVendorMaps, isMissingColumn } from "../api/_lib/rfq-composition.js";

describe("isMissingColumn — must not misclassify a FK violation as a missing column", () => {
  it("true for a real undefined-column error (code + message forms)", () => {
    expect(isMissingColumn({ code: "42703" }, "supplier_id")).toBe(true);
    expect(isMissingColumn({ message: 'column price_composition_lines.supplier_id does not exist' }, "supplier_id")).toBe(true);
    expect(isMissingColumn({ message: 'column "supplier_id" of relation "vendors" does not exist' }, "supplier_id")).toBe(true);
  });
  it("false for a FK-constraint violation that merely mentions the column", () => {
    // 23503: linking a vendor to a supplier that doesn't exist. Must surface,
    // not be swallowed as "column missing" (the loose /supplier_id/ regex bug).
    expect(isMissingColumn({ code: "23503", message: 'Key (supplier_id)=(abc) is not present in table "suppliers"' }, "supplier_id")).toBe(false);
    expect(isMissingColumn({ message: "some validation error about supplier_id value" }, "supplier_id")).toBe(false);
    expect(isMissingColumn(null, "supplier_id")).toBe(false);
  });
});

// Minimal Supabase-shaped fake. Each table has a column allow-set; an
// insert/update/select that references a column not in the set resolves to a
// PostgREST 42703 error, exactly like an unapplied migration.
const makeSvc = (store, schema) => {
  store.__seq = 0;
  return {
    from(table) {
      const cols = schema[table] || new Set();
      const rows = (store[table] = store[table] || []);
      const q = {
        _op: "select", _payload: null, _filters: [], _selCols: null,
        select(c) { this._selCols = c; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        update(p) { this._op = "update"; this._payload = p; return this; },
        eq(c, v) { this._filters.push([c, v]); return this; },
        _match(r) { return this._filters.every(([c, v]) => r[c] === v); },
        _badCol() {
          if (this._op === "insert" || this._op === "update") {
            const bad = Object.keys(this._payload).find((c) => !cols.has(c));
            if (bad) return bad;
          }
          if (this._selCols) {
            const bad = this._selCols.split(",").map((s) => s.trim()).find((c) => !cols.has(c));
            if (bad) return bad;
          }
          return null;
        },
        _exec() {
          const bad = this._badCol();
          if (bad) return Promise.resolve({ data: null, error: { code: "42703", message: `column ${table}.${bad} does not exist` } });
          if (this._op === "update") {
            const hits = rows.filter((r) => this._match(r));
            hits.forEach((r) => Object.assign(r, this._payload));
            return Promise.resolve({ data: hits.map((r) => ({ id: r.id })), error: null });
          }
          if (this._op === "insert") {
            const rec = { id: "id-" + (++store.__seq), ...this._payload };
            rows.push(rec);
            return Promise.resolve({ data: [{ id: rec.id }], error: null });
          }
          return Promise.resolve({ data: rows.filter((r) => this._match(r)), error: null });
        },
        then(res, rej) { return this._exec().then(res, rej); },
      };
      return q;
    },
  };
};

const CTX = { tenantId: "t-1" };
const FULL_PCL = new Set(["id", "tenant_id", "quote_id", "line_index", "part_no", "qty", "supplier_name", "supplier_unit_price", "supplier_currency", "supplier_quote_no", "supplier_id", "updated_at"]);
const FULL_QL = new Set(["id", "tenant_id", "quote_id", "line_index", "listed_unit_price", "discounted_unit_price", "supplier_id", "updated_at"]);
const FULL_VENDORS = new Set(["id", "tenant_id", "vendor_name", "supplier_id", "active"]);

const winLine = (over = {}) => ({
  line_no: 0, unit_price: 50, currency: "USD", supplier_quote_ref: "VQ1",
  vendor_name: "Acme", supplier_id: "sup-9", part_number: "P1", quantity: 2, ...over,
});

describe("feedCompositionLine — supplier bridge write-back", () => {
  it("stamps supplier_id on composition line AND quote line, leaving sell price untouched", async () => {
    const store = {
      price_composition_lines: [{ id: "pcl-1", tenant_id: "t-1", quote_id: "q-1", line_index: 0 }],
      quote_lines: [{ id: "ql-1", tenant_id: "t-1", quote_id: "q-1", line_index: 0, listed_unit_price: 100, discounted_unit_price: 90 }],
    };
    await feedCompositionLine(makeSvc(store, { price_composition_lines: FULL_PCL, quote_lines: FULL_QL }), CTX, "q-1", winLine());
    const pcl = store.price_composition_lines[0];
    expect(pcl.supplier_id).toBe("sup-9");
    expect(pcl.supplier_unit_price).toBe(50);
    expect(pcl.supplier_name).toBe("Acme");
    const ql = store.quote_lines[0];
    expect(ql.supplier_id).toBe("sup-9");
    expect(ql.listed_unit_price).toBe(100);      // sell price NEVER touched
    expect(ql.discounted_unit_price).toBe(90);
  });

  it("un-bridged vendor (supplier_id null): feeds cost only, never clobbers a prior supplier_id", async () => {
    const store = {
      price_composition_lines: [{ id: "pcl-1", tenant_id: "t-1", quote_id: "q-1", line_index: 0, supplier_id: "sup-existing" }],
      quote_lines: [{ id: "ql-1", tenant_id: "t-1", quote_id: "q-1", line_index: 0, supplier_id: "sup-existing" }],
    };
    await feedCompositionLine(makeSvc(store, { price_composition_lines: FULL_PCL, quote_lines: FULL_QL }), CTX, "q-1", winLine({ supplier_id: null, vendor_name: "Beta" }));
    expect(store.price_composition_lines[0].supplier_id).toBe("sup-existing");  // not wiped
    expect(store.price_composition_lines[0].supplier_name).toBe("Beta");        // cost still fed
    expect(store.quote_lines[0].supplier_id).toBe("sup-existing");              // quote line untouched
  });

  it("inserts a composition line (with supplier_id) when none exists yet", async () => {
    const store = { price_composition_lines: [], quote_lines: [] };
    await feedCompositionLine(makeSvc(store, { price_composition_lines: FULL_PCL, quote_lines: FULL_QL }), CTX, "q-1", winLine());
    expect(store.price_composition_lines).toHaveLength(1);
    expect(store.price_composition_lines[0].supplier_id).toBe("sup-9");
    expect(store.price_composition_lines[0].part_no).toBe("P1");
  });

  it("no matching quote line: no throw, no row inserted into quote_lines", async () => {
    const store = {
      price_composition_lines: [{ id: "pcl-1", tenant_id: "t-1", quote_id: "q-1", line_index: 0 }],
      quote_lines: [],  // no quote line at index 0
    };
    await expect(
      feedCompositionLine(makeSvc(store, { price_composition_lines: FULL_PCL, quote_lines: FULL_QL }), CTX, "q-1", winLine())
    ).resolves.toBeUndefined();
    expect(store.quote_lines).toHaveLength(0);            // never inserts a quote line
    expect(store.price_composition_lines[0].supplier_id).toBe("sup-9");
  });

  it("pre-167 DB (quote_lines lacks supplier_id): feed still succeeds, composition still stamped", async () => {
    const QL_NO_SUP = new Set(["id", "tenant_id", "quote_id", "line_index", "listed_unit_price", "updated_at"]);
    const store = {
      price_composition_lines: [{ id: "pcl-1", tenant_id: "t-1", quote_id: "q-1", line_index: 0 }],
      quote_lines: [{ id: "ql-1", tenant_id: "t-1", quote_id: "q-1", line_index: 0, listed_unit_price: 100 }],
    };
    await expect(
      feedCompositionLine(makeSvc(store, { price_composition_lines: FULL_PCL, quote_lines: QL_NO_SUP }), CTX, "q-1", winLine())
    ).resolves.toBeUndefined();
    expect(store.price_composition_lines[0].supplier_id).toBe("sup-9");
    expect(store.quote_lines[0].supplier_id).toBeUndefined();   // column absent, gracefully skipped
  });

  it("pre-161 DB (composition lacks supplier_id): strip-retry keeps the cost feed working", async () => {
    const PCL_NO_SUP = new Set(["id", "tenant_id", "quote_id", "line_index", "part_no", "qty", "supplier_name", "supplier_unit_price", "supplier_currency", "supplier_quote_no", "updated_at"]);
    const store = {
      price_composition_lines: [{ id: "pcl-1", tenant_id: "t-1", quote_id: "q-1", line_index: 0 }],
      quote_lines: [{ id: "ql-1", tenant_id: "t-1", quote_id: "q-1", line_index: 0, listed_unit_price: 100 }],
    };
    await expect(
      feedCompositionLine(makeSvc(store, { price_composition_lines: PCL_NO_SUP, quote_lines: FULL_QL }), CTX, "q-1", winLine())
    ).resolves.toBeUndefined();
    expect(store.price_composition_lines[0].supplier_name).toBe("Acme");     // cost fed despite missing FK column
    expect(store.price_composition_lines[0].supplier_id).toBeUndefined();
  });
});

describe("loadVendorMaps", () => {
  it("builds name + supplier_id maps", async () => {
    const store = { vendors: [
      { id: "v-1", tenant_id: "t-1", vendor_name: "Acme", supplier_id: "sup-9" },
      { id: "v-2", tenant_id: "t-1", vendor_name: "Beta", supplier_id: null },
    ] };
    const { vendorName, vendorSupplier } = await loadVendorMaps(makeSvc(store, { vendors: FULL_VENDORS }), CTX);
    expect(vendorName.get("v-1")).toBe("Acme");
    expect(vendorSupplier.get("v-1")).toBe("sup-9");
    expect(vendorSupplier.get("v-2")).toBeNull();
  });

  it("pre-168 DB (vendors lacks supplier_id): falls back to name-only, supplier ids null", async () => {
    const VENDORS_NO_SUP = new Set(["id", "tenant_id", "vendor_name", "active"]);
    const store = { vendors: [{ id: "v-1", tenant_id: "t-1", vendor_name: "Acme" }] };
    const { vendorName, vendorSupplier } = await loadVendorMaps(makeSvc(store, { vendors: VENDORS_NO_SUP }), CTX);
    expect(vendorName.get("v-1")).toBe("Acme");           // names still resolve
    expect(vendorSupplier.get("v-1")).toBeNull();         // bridge inert until migrated
  });
});
