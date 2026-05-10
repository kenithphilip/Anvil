// Phase D: customer format template tests.
//
// We test the pure helpers (anchor inference, scoring) and the
// build / apply paths against an in-memory svc shim. The shim
// records every supabase call so we can assert the side-effects
// without a real DB.

import { describe, it, expect } from "vitest";
import { buildTemplate, applyTemplate, __test__ } from "../api/_lib/docai/templates.js";

describe("templates / inferAnchor", () => {
  it("builds a label-anchored regex from a body snippet", () => {
    const body = "Customer GSTIN: 27AAACA1234B1Z5\nState: 27";
    const a = __test__.inferAnchor(body, "27AAACA1234B1Z5");
    expect(a).not.toBeNull();
    expect(a.label).toMatch(/GSTIN/i);
    expect(a.capture_group).toBe(1);
    // Roundtrip: the regex must match the same value.
    const re = new RegExp(a.pattern, "im");
    const m = body.match(re);
    expect(m && m[a.capture_group].trim()).toBe("27AAACA1234B1Z5");
  });

  it("returns null when there is no recognisable label preceding the value", () => {
    // Purely numeric prefix.
    const body = "9999999999  27AAACA1234B1Z5";
    expect(__test__.inferAnchor(body, "27AAACA1234B1Z5")).toBeNull();
  });
});

describe("templates / matchAnchor", () => {
  it("captures via String.prototype.match", () => {
    const body = "PO Number : PO-12345";
    const captured = __test__.matchAnchor("PO\\s+Number\\s*[:\\-]?\\s*(.{1,80}?)(?:\\r?\\n|$)", 1, body);
    expect(captured).toBe("PO-12345");
  });

  it("returns null when the regex is invalid", () => {
    expect(__test__.matchAnchor("[unbalanced", 1, "anything")).toBeNull();
  });
});

describe("templates / scoreAnchor", () => {
  it("counts hits across runs whose normalized matches the captured value", () => {
    const anchor = {
      pattern: "GSTIN\\s*[:\\-]?\\s*(.{1,80}?)(?:\\r?\\n|$)",
      capture_group: 1,
    };
    const runs = [
      { body_text: "GSTIN: 27AAACA1234B1Z5\n", normalized_extract: { customer: { gstin: "27AAACA1234B1Z5" } } },
      { body_text: "GSTIN : 27AAACA1234B1Z5\n", normalized_extract: { customer: { gstin: "27AAACA1234B1Z5" } } },
      { body_text: "no match here", normalized_extract: { customer: { gstin: "X" } } },
    ];
    expect(__test__.scoreAnchor(anchor, runs, "customer.gstin")).toBe(2);
  });
});

// In-memory svc shim. Each method returns a thenable that mimics
// the Supabase JS query builder enough for the templates module's
// usage. We populate runs + body_text fixtures inside the shim
// state so build/apply can exercise the full path.
const buildSvcShim = (state) => {
  const builder = (table) => {
    const ctx = { table, filters: [], updates: null, orderField: null };
    const api = {
      select(_cols, opts) {
        ctx.select = _cols; ctx.opts = opts || null;
        return api;
      },
      eq(col, val) { ctx.filters.push({ col, op: "eq", val }); return api; },
      in(col, vals) { ctx.filters.push({ col, op: "in", val: vals }); return api; },
      order(col, _o) { ctx.orderField = col; return api; },
      limit(n) { ctx.limit = n; return api; },
      maybeSingle() {
        const rows = state.runHandler(ctx);
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      single() {
        const rows = state.runHandler(ctx);
        if (!rows.length) return Promise.resolve({ data: null, error: { message: "no row" } });
        return Promise.resolve({ data: rows[0], error: null });
      },
      then(resolve, reject) {
        try {
          const rows = state.runHandler(ctx);
          resolve({ data: rows, error: null });
        } catch (e) { reject(e); }
        return { catch: () => ({}), finally: () => ({}) };
      },
      update(values) { ctx.action = "update"; ctx.updates = values; return api; },
      insert(values) {
        ctx.action = "insert"; ctx.values = values;
        return {
          select: () => ({
            single: () => {
              const inserted = state.runHandler(ctx);
              return Promise.resolve({ data: inserted[0], error: null });
            },
          }),
          then: (resolve) => { resolve({ data: state.runHandler(ctx), error: null }); return { catch: () => ({}) }; },
        };
      },
    };
    return api;
  };
  return { from: builder };
};

describe("templates / buildTemplate", () => {
  it("requires at least 3 successful runs", async () => {
    const state = {
      runHandler: (ctx) => {
        if (ctx.table === "extraction_runs") return [];
        return [];
      },
    };
    const out = await buildTemplate(buildSvcShim(state), {
      tenantId: "t1", customerId: "c1", kind: "po",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("not_enough_runs");
  });

  it("skips when text layer has no body for any run", async () => {
    const state = {
      runHandler: (ctx) => {
        if (ctx.table === "extraction_runs") {
          return [
            { id: "r1", source_id: "d1", normalized_extract: { customer: { po_number: "PO-1" } } },
            { id: "r2", source_id: "d2", normalized_extract: { customer: { po_number: "PO-2" } } },
            { id: "r3", source_id: "d3", normalized_extract: { customer: { po_number: "PO-3" } } },
          ];
        }
        // No body_text rows: extraction_text_layer + extraction_ocr_layer return empty.
        return [];
      },
    };
    const out = await buildTemplate(buildSvcShim(state), {
      tenantId: "t1", customerId: "c1", kind: "po",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("not_enough_text");
  });

  it("infers anchors and inserts an active template when 3+ runs share a layout", async () => {
    const state = {
      runHandler: (ctx) => {
        if (ctx.table === "extraction_runs") {
          return [
            { id: "r1", source_id: "d1", normalized_extract: { customer: { po_number: "PO-AAA-100" } } },
            { id: "r2", source_id: "d2", normalized_extract: { customer: { po_number: "PO-AAA-101" } } },
            { id: "r3", source_id: "d3", normalized_extract: { customer: { po_number: "PO-AAA-102" } } },
          ];
        }
        if (ctx.table === "extraction_text_layer") {
          return [
            { document_id: "d1", body_text: "PO Number: PO-AAA-100\nDate: 2025-04-01" },
            { document_id: "d2", body_text: "PO Number: PO-AAA-101\nDate: 2025-04-02" },
            { document_id: "d3", body_text: "PO Number: PO-AAA-102\nDate: 2025-04-03" },
          ];
        }
        if (ctx.table === "customer_format_templates" && ctx.action === "update") {
          return [];
        }
        if (ctx.table === "customer_format_templates" && ctx.action === "insert") {
          return [{ id: "tpl-1", ...ctx.values }];
        }
        return [];
      },
    };
    const out = await buildTemplate(buildSvcShim(state), {
      tenantId: "t1", customerId: "c1", kind: "po",
    });
    expect(out.ok).toBe(true);
    expect(out.template).toBeTruthy();
    expect(out.anchors_inferred).toBeGreaterThanOrEqual(1);
  });
});

describe("templates / applyTemplate", () => {
  it("returns used=false when no active template exists", async () => {
    const state = { runHandler: () => [] };
    const out = await applyTemplate(buildSvcShim(state), {
      tenantId: "t1", customerId: "c1", kind: "po", bodyText: "anything",
    });
    expect(out.used).toBe(false);
  });

  it("captures fields when anchors match the body", async () => {
    const tpl = {
      id: "tpl-1",
      anchors: [
        { field: "customer.po_number",
          pattern: "PO\\s+Number\\s*[:\\-]?\\s*(.{1,80}?)(?:\\r?\\n|$)",
          capture_group: 1,
        },
      ],
      hit_count: 0, miss_count: 0,
    };
    let updated = null;
    const state = {
      runHandler: (ctx) => {
        if (ctx.table === "customer_format_templates" && ctx.action !== "update") return [tpl];
        if (ctx.table === "customer_format_templates" && ctx.action === "update") {
          updated = ctx.updates;
          return [];
        }
        return [];
      },
    };
    const out = await applyTemplate(buildSvcShim(state), {
      tenantId: "t1", customerId: "c1", kind: "po",
      bodyText: "PO Number: PO-AAA-104\nDate: 2025-04-04",
    });
    expect(out.used).toBe(true);
    expect(out.normalized.customer.po_number).toBe("PO-AAA-104");
    expect(out.confidences["customer.po_number"]).toBe(0.95);
    expect(updated).toMatchObject({ hit_count: 1 });
  });
});
