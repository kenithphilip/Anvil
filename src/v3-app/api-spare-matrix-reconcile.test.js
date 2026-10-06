// Spare-matrix autosave used to delete every row and column, every time.
//
// The server's reconcile() keeps rows whose id appears in the payload — but
// toServer() omitted child ids entirely, so the keep-set was always empty and
// "reconcile" meant DELETE ALL, then re-insert with fresh uuids.
//
// spares.tsx carried a comment asserting this was safe "(recommended_spares keys
// on matrix_id+part_no+description, not on row/col ids — no id round-trip)".
// That was wrong. Migration 197:
//
//   gun_drawings.row_id uuid references spare_matrix_rows(id) on delete set null
//
// so every autosave nulled the link between a drawing and the gun row it
// belonged to. The drawings survived; which gun they described did not.
//
// Deletes also ran BEFORE the writes, with no transaction across PostgREST
// calls, so a delete that succeeded followed by a failed insert lost the rows
// outright.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const spares = readFileSync("src/v3-app/screens/spares.tsx", "utf8");
const handler = readFileSync("src/api/spare_matrix/[id].js", "utf8");

describe("the client round-trips server ids", () => {
  it("sends an id on both rows and columns", () => {
    // The regression. Without these the keep-set is empty and everything is
    // deleted on every debounce tick.
    expect(spares).toMatch(/columns:[^\n]*\bid: serverId\(c\.id\)/);
    expect(spares).toMatch(/rows:[\s\S]{0,80}?\bid: serverId\(r\.id\)/);
  });

  it("never sends a browser-local id as a server id", () => {
    // smUid()s are "mx_"-prefixed; the column is uuid-typed, and inventing one
    // would orphan the real row rather than update it.
    expect(spares).toContain('!id.startsWith("mx_")');
    expect(spares).toMatch(/const serverId = \(id\) =>/);
  });

  it("no longer claims child ids are omitted", () => {
    expect(spares).not.toContain("toServer() OMITS child ids");
    expect(spares).not.toContain("no id round-trip");
  });
});

describe("serverId", () => {
  // Mirrors the implementation; kept here so the contract is executable and not
  // only asserted as a source string.
  const serverId = (id) => (typeof id === "string" && id && !id.startsWith("mx_")) ? id : undefined;

  it("passes a real uuid through", () => {
    expect(serverId("3f7c1e40-0b2a-4c5e-9f11-2a6d8e4b7c33")).toBe("3f7c1e40-0b2a-4c5e-9f11-2a6d8e4b7c33");
  });

  it("drops a browser-local id", () => {
    expect(serverId("mx_ab12cd34ef56")).toBeUndefined();
  });

  it.each([null, undefined, "", 42, {}])("drops %p", (v) => {
    expect(serverId(v)).toBeUndefined();
  });
});

describe("reconcile writes before it deletes", () => {
  it("performs the delete after both the upsert and the insert", () => {
    // There is no transaction across PostgREST calls, so ordering is the only
    // protection: a mid-way failure must leave the prior state intact.
    const upsertAt = handler.indexOf(".upsert(withId)");
    const insertAt = handler.indexOf(".insert(withoutId)");
    const deleteAt = handler.indexOf('.delete().eq("tenant_id", tenantId).in("id", toDelete)');
    expect(upsertAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(upsertAt);
    expect(deleteAt).toBeGreaterThan(insertAt);
  });

  it("still deletes only the rows that are genuinely gone", () => {
    // The keep-set semantics are what make a stable id meaningful; losing this
    // would turn every save back into a full replace.
    expect(handler).toContain("const keepIds = new Set(");
    expect(handler).toContain("filter((id) => !keepIds.has(id))");
  });

  it("still splits ids from non-ids before writing", () => {
    // PostgREST unifies columns across a mixed array and sends id=null on the
    // new rows, which violates NOT NULL. (Same shape as the shipment-import
    // upsert bug.)
    expect(handler).toContain("const withId = upserts.filter((r) => r.id != null);");
    expect(handler).toContain("const withoutId = upserts.filter((r) => r.id == null);");
  });
});

describe("the drawing link this protects", () => {
  it("gun_drawings really does key off a spare_matrix_rows id", () => {
    // If this FK ever goes away the fix is still correct, but the severity
    // argument in the comments would need revisiting.
    const mig = readFileSync("supabase/migrations/197_gun_drawings.sql", "utf8");
    expect(mig).toMatch(/row_id uuid references spare_matrix_rows\(id\)/);
  });
});
