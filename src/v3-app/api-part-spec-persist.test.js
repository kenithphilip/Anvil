// The engineering spec a part drawing already gave us must survive.
//
// finish / heat_treatment / tolerances[] / gdt[] were extracted and consumed by
// NOTHING -- they lived only inside extraction_runs.normalized_extract.
// Migration 224 gives them columns; this is the write path.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { partSpecToItemSpec, mergeItemSpec, persistPartSpec } from "../api/_lib/pdm/part-spec-persist.js";

const spec = (over = {}) => ({
  material: "EN8",
  finish: "Black oxide",
  heat_treatment: "Case harden 58-62 HRC",
  tolerances: [{ feature: "Ø40", nominal: "40", tolerance: "+0.02/-0.01" }],
  gdt: [{ symbol: "⌖", tolerance: "0.05", datum: "A|B" }],
  notes: ["Deburr all edges", "Do not scale"],
  ...over,
});

describe("partSpecToItemSpec", () => {
  it("carries the four fields nothing used to read", () => {
    const p = partSpecToItemSpec(spec());
    expect(p.finish).toBe("Black oxide");
    expect(p.heat_treatment).toBe("Case harden 58-62 HRC");
    expect(p.tolerances).toEqual([{ feature: "Ø40", nominal: "40", tolerance: "+0.02/-0.01" }]);
    expect(p.gdt).toEqual([{ symbol: "⌖", tolerance: "0.05", datum: "A|B" }]);
    expect(p.drawing_notes).toEqual(["Deburr all edges", "Do not scale"]);
  });

  it("OMITS what the drawing did not carry, so a silent extractor never blanks a stored value", () => {
    const p = partSpecToItemSpec({ finish: "Anodised" });
    expect(p).toEqual({ finish: "Anodised" });
    expect("heat_treatment" in p).toBe(false);
    expect("tolerances" in p).toBe(false);
  });

  it("returns null when there is nothing worth storing", () => {
    expect(partSpecToItemSpec({ material: "EN8" })).toBeNull();
    expect(partSpecToItemSpec({})).toBeNull();
    expect(partSpecToItemSpec(null)).toBeNull();
    expect(partSpecToItemSpec({ finish: "   ", tolerances: [] })).toBeNull();
  });

  it("drops malformed records rather than storing junk an engineer would read as authoritative", () => {
    const p = partSpecToItemSpec({
      tolerances: [{ feature: "Ø40", tolerance: "+0.02" }, null, "nonsense", {}, { junk: 1 }],
      gdt: [{ symbol: "⌖" }, 42],
      notes: ["ok", null, "  ", "also ok"],
    });
    expect(p.tolerances).toEqual([{ feature: "Ø40", tolerance: "+0.02" }]);
    expect(p.gdt).toEqual([{ symbol: "⌖" }]);
    expect(p.drawing_notes).toEqual(["ok", "also ok"]);
  });
});

describe("mergeItemSpec — a human's spec is never overwritten by a model", () => {
  const patch = { finish: "Black oxide" };

  it("writes when there is no stored spec", () => {
    const m = mergeItemSpec(null, patch, { extractionRunId: "run-1", now: "2026-08-29T00:00:00Z" });
    expect(m.finish).toBe("Black oxide");
    expect(m.spec_source).toBe("drawing");
    expect(m.spec_extraction_run_id).toBe("run-1");
    expect(m.spec_captured_at).toBe("2026-08-29T00:00:00Z");
  });

  it("REFUSES when a person filled it in (spec_source null + a stored value)", () => {
    expect(mergeItemSpec({ spec_source: null, finish: "Typed by an engineer" }, patch)).toBeNull();
    expect(mergeItemSpec({ spec_source: null, heat_treatment: "Nitrided" }, patch)).toBeNull();
    expect(mergeItemSpec({ spec_source: null, tolerances: [{ feature: "x" }] }, patch)).toBeNull();
  });

  it("DOES overwrite a previous drawing-sourced spec (a newer revision should win)", () => {
    const m = mergeItemSpec({ spec_source: "drawing", finish: "Old" }, patch, { now: "2026-08-29T00:00:00Z" });
    expect(m.finish).toBe("Black oxide");
  });

  it("treats an empty stored row as not human-authored", () => {
    expect(mergeItemSpec({ spec_source: null, tolerances: [], gdt: [] }, patch)).not.toBeNull();
  });
});

describe("persistPartSpec", () => {
  const makeSvc = (over = {}) => {
    const state = { item: { id: "it-1" }, spec: null, upserted: null, ...over };
    const svc = {
      state,
      from(table) {
        const api = {
          select: () => api, eq: () => api,
          maybeSingle: async () => ({
            data: table === "item_master" ? state.item : state.spec,
            error: state.error || null,
          }),
          upsert: async (row) => { state.upserted = row; return { error: state.upsertError || null }; },
        };
        return api;
      },
    };
    return svc;
  };

  it("stores the spec against the item and stamps provenance", async () => {
    const svc = makeSvc();
    const r = await persistPartSpec(svc, "t-1", { finishedPartNo: "P-1", partSpec: spec(), extractionRunId: "run-9" });
    expect(r.stored).toBe(true);
    expect(svc.state.upserted.item_id).toBe("it-1");
    expect(svc.state.upserted.tenant_id).toBe("t-1");
    expect(svc.state.upserted.spec_source).toBe("drawing");
    expect(svc.state.upserted.spec_extraction_run_id).toBe("run-9");
    expect(r.fields).toEqual(expect.arrayContaining(["finish", "heat_treatment", "tolerances", "gdt"]));
  });

  it("does NOT create an item — enrichment only, never a back door into the item master", async () => {
    const svc = makeSvc({ item: null });
    const r = await persistPartSpec(svc, "t-1", { finishedPartNo: "UNKNOWN", partSpec: spec() });
    expect(r.stored).toBe(false);
    expect(r.reason).toBe("item_not_found");
    expect(svc.state.upserted).toBeNull();
  });

  it("preserves a human-authored spec", async () => {
    const svc = makeSvc({ spec: { spec_source: null, finish: "Typed" } });
    const r = await persistPartSpec(svc, "t-1", { finishedPartNo: "P-1", partSpec: spec() });
    expect(r.stored).toBe(false);
    expect(r.reason).toBe("human_authored_spec_preserved");
    expect(svc.state.upserted).toBeNull();
  });

  it("is non-fatal: a write failure or a throw is reported, never raised", async () => {
    const bad = makeSvc({ upsertError: { message: "boom" } });
    const r = await persistPartSpec(bad, "t-1", { finishedPartNo: "P-1", partSpec: spec() });
    expect(r.stored).toBe(false);
    expect(r.reason).toMatch(/write_failed/);
    const thrower = { from: () => { throw new Error("db down"); } };
    const r2 = await persistPartSpec(thrower, "t-1", { finishedPartNo: "P-1", partSpec: spec() });
    expect(r2.stored).toBe(false);
    expect(r2.reason).toMatch(/threw/);
  });

  it("skips cleanly when there is nothing to store or no part number", async () => {
    expect((await persistPartSpec(makeSvc(), "t-1", { finishedPartNo: "P-1", partSpec: {} })).reason).toBe("nothing_to_store");
    expect((await persistPartSpec(makeSvc(), "t-1", { finishedPartNo: null, partSpec: spec() })).reason).toBe("no_part_no");
  });
});

describe("migration 224 gives the spec somewhere to live", () => {
  it("adds the columns the extractor's own comment promised", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/224_item_engineering_spec.sql"), "utf8");
    for (const col of ["finish", "heat_treatment", "tolerances", "gdt", "drawing_notes", "spec_source", "spec_extraction_run_id"]) {
      expect(sql).toMatch(new RegExp("add column if not exists " + col));
    }
    expect(sql).toMatch(/alter table item_specifications/);
  });
});

describe("provenance must not outlive the value it cites", () => {
  it("does NOT inherit the previous run's id onto values it did not produce", () => {
    // Citing run A beside a value run C wrote points an engineer at an
    // extraction whose content contradicts the field next to it.
    const m = mergeItemSpec(
      { spec_source: "drawing", finish: "Old", spec_extraction_run_id: "run-A" },
      { finish: "Black oxide" },
      { extractionRunId: null },
    );
    expect(m.finish).toBe("Black oxide");
    expect(m.spec_extraction_run_id).toBeNull();
  });
});

describe("the guard must FAIL CLOSED", () => {
  it("refuses to write when it cannot READ what it is protecting", async () => {
    // Most likely on an environment where migration 224 is not yet applied: the
    // select 42703s, data comes back null, and "no stored spec" would have let
    // the drawing clobber a hand-entered one.
    const svc = {
      from: (table) => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => (
          table === "item_master"
            ? { data: { id: "it-1" }, error: null }
            : { data: null, error: { message: 'column "finish" does not exist' } }
        ) }) }) }),
        upsert: async () => { throw new Error("must not be reached"); },
      }),
    };
    const r = await persistPartSpec(svc, "t-1", { finishedPartNo: "P-1", partSpec: spec() });
    expect(r.stored).toBe(false);
    expect(r.reason).toMatch(/read_failed/);
  });
});

describe("a record with no load-bearing value is noise, not a partial record", () => {
  it("drops a tolerance row with no tolerance and a frame with no symbol", () => {
    // normalizePartDrawing emits every key with nulls, so "any key survived"
    // would have stored a tolerance-table row carrying no tolerance.
    const p = partSpecToItemSpec({
      tolerances: [{ feature: "bore dia", nominal: null, tolerance: null }, { feature: "OD", tolerance: "+0.01" }],
      gdt: [{ symbol: null, datum: "A" }, { symbol: "⌖", datum: "B" }],
    });
    expect(p.tolerances).toEqual([{ feature: "OD", tolerance: "+0.01" }]);
    expect(p.gdt).toEqual([{ symbol: "⌖", datum: "B" }]);
  });
});
