// Ingest for the per-line despatch mirror (dispatch_lines).
//
// Asserts the two contracts the register depends on:
//   * NORMALISE — any importer vocabulary (qty/part/lr/invoice_no/voucher_ref…)
//     maps onto real columns; unknown keys are rescued into metadata, never
//     dropped; and a per-line source_ref is composed so re-sync is idempotent.
//   * IDEMPOTENT UPSERT — a row with source_ref updates-or-inserts on it; a row
//     without always inserts; the tenant can never be spoofed.
// Plus the migration's null-safe uniqueness (the lesson from the service-report
// template fix: a single-column source_ref, not a null-blind composite).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeDispatchLine, invalidDispatchKeys, upsertDispatchLines,
} from "../api/_lib/dispatch-lines.js";

describe("normalizeDispatchLine maps importer vocabulary", () => {
  it("maps qty/part/lr/invoice/date aliases onto real columns", () => {
    const r = normalizeDispatchLine({
      qty: "40", part: "SIV-21N", lr: "LR4471", invoice_no: "INV-882",
      date: "2026-03-12T00:00:00Z", line: "3", transporter: "VRL",
    });
    expect(r.dispatched_qty).toBe(40);
    expect(r.part_no).toBe("SIV-21N");
    expect(r.lr_number).toBe("LR4471");
    expect(r.invoice_number).toBe("INV-882");
    expect(r.dispatch_date).toBe("2026-03-12");     // trimmed to the date
    expect(r.line_index).toBe(3);
    expect(r.carrier).toBe("VRL");
    expect(invalidDispatchKeys(r)).toEqual([]);
  });

  it("composes source_ref = voucher + line ref when not given", () => {
    expect(normalizeDispatchLine({ voucher_ref: "DN-4471", line: 3, qty: 40 }).source_ref).toBe("DN-4471#3");
    // no line index -> falls back to part_no as the line ref
    expect(normalizeDispatchLine({ delivery_note_no: "DN-9", part: "CBL-2", qty: 1 }).source_ref).toBe("DN-9#CBL-2");
  });

  it("respects an explicit source_ref", () => {
    expect(normalizeDispatchLine({ source_ref: "X#1", qty: 1 }).source_ref).toBe("X#1");
  });

  it("rescues unknown keys into metadata and defaults NOT NULL qty", () => {
    const r = normalizeDispatchLine({ part: "A", grade: "SS304", batch: "B12" });
    expect(r.dispatched_qty).toBe(0);
    expect(r.metadata.grade).toBe("SS304");
    expect(r.metadata.batch).toBe("B12");
    expect(invalidDispatchKeys(r)).toEqual([]);
  });

  it("injects tenant/order from context", () => {
    const r = normalizeDispatchLine({ qty: 1 }, { tenantId: "t1", orderId: "o1" });
    expect(r.tenant_id).toBe("t1");
    expect(r.order_id).toBe("o1");
  });
});

// A minimal in-memory Supabase client covering the calls upsertDispatchLines
// makes: select().eq().eq().maybeSingle(), update().eq().eq(), insert().
const makeSvc = (store) => ({
  from() {
    const state = { op: null, filters: {}, row: null };
    const b = {
      select() { state.op = "select"; return b; },
      insert(row) { state.op = "insert"; state.row = row; return b; },
      update(row) { state.op = "update"; state.row = row; return b; },
      eq(k, v) { state.filters[k] = v; return b; },
      maybeSingle() {
        const f = store.find((x) => x.tenant_id === state.filters.tenant_id && x.source_ref === state.filters.source_ref);
        return Promise.resolve({ data: f ? { id: f.id } : null });
      },
      then(resolve, reject) {
        let out = { error: null };
        if (state.op === "insert") {
          store.push({ id: "row" + (store.length + 1), ...state.row });
        } else if (state.op === "update") {
          const t = store.find((x) => x.id === state.filters.id);
          if (t) Object.assign(t, state.row);
        }
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return b;
  },
});

describe("upsertDispatchLines is idempotent on source_ref", () => {
  it("inserts new source_refs, updates a repeat, and never dupes", async () => {
    const store = [];
    const svc = makeSvc(store);
    const r1 = await upsertDispatchLines(svc, "t1", [
      { voucher_ref: "DN-1", line: 1, qty: 40 },
      { voucher_ref: "DN-1", line: 2, qty: 50 },
    ]);
    expect(r1).toMatchObject({ inserted: 2, updated: 0 });
    expect(store).toHaveLength(2);

    // Re-sync the same delivery note with a corrected qty on line 1.
    const r2 = await upsertDispatchLines(svc, "t1", [{ voucher_ref: "DN-1", line: 1, qty: 45 }]);
    expect(r2).toMatchObject({ inserted: 0, updated: 1 });
    expect(store).toHaveLength(2);                                  // no duplicate
    expect(store.find((x) => x.source_ref === "DN-1#1").dispatched_qty).toBe(45);
  });

  it("a row without source_ref always inserts (manual entry)", async () => {
    const store = [];
    const svc = makeSvc(store);
    await upsertDispatchLines(svc, "t1", [{ part: "A", qty: 1 }]);
    await upsertDispatchLines(svc, "t1", [{ part: "A", qty: 1 }]);
    expect(store).toHaveLength(2);
  });

  it("forces the caller's tenant — an importer cannot spoof tenant_id", async () => {
    const store = [];
    const svc = makeSvc(store);
    await upsertDispatchLines(svc, "t1", [{ tenant_id: "evil", source_ref: "X#1", qty: 1 }]);
    expect(store[0].tenant_id).toBe("t1");
  });
});

describe("migration 193 uniqueness is null-safe", () => {
  const SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations", "193_dispatch_lines.sql"), "utf8");
  it("dedupes on a single-column source_ref, partial where not null", () => {
    expect(SQL).toMatch(/create unique index if not exists dispatch_lines_source_uk[\s\S]*\(tenant_id, source_ref\)[\s\S]*where source_ref is not null/);
    // NOT a null-blind (tenant_id, source_ref, line_index) composite.
    expect(SQL).not.toMatch(/unique index[^\n]*\(tenant_id, source_ref, line_index\)/);
  });
  it("enables RLS with tenant-scoped select + write policies", () => {
    expect(SQL).toMatch(/alter table dispatch_lines enable row level security/);
    expect(SQL).toMatch(/create policy dispatch_lines_select[\s\S]*current_tenant_ids\(\)/);
    expect(SQL).toMatch(/create policy dispatch_lines_write[\s\S]*with check[\s\S]*current_tenant_ids\(\)/);
  });
});
