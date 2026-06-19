// Unit tests for the connector-agnostic drift detector
// (_lib/connector-drift.js). Proves detectDrift works off one shared
// implementation across Tally-style and full-connector-style field maps,
// and that liveFieldSet extracts the field set from every response shape
// our connector clients return.

import { describe, it, expect } from "vitest";
import { detectDrift, liveFieldSet } from "../api/_lib/connector-drift.js";

describe("liveFieldSet", () => {
  it("extracts keys from an OData v4 value[] response", () => {
    const s = liveFieldSet({ value: [{ Material: "X", RequestedQuantity: 1 }] });
    expect([...s].sort()).toEqual(["Material", "RequestedQuantity"]);
  });

  it("extracts keys from a Fusion/REST items[] response", () => {
    expect(liveFieldSet({ items: [{ OrderNumber: "1", BuyingPartyName: "Acme" }] }).has("OrderNumber")).toBe(true);
  });

  it("extracts keys from an OData v2 d.results[] response", () => {
    expect(liveFieldSet({ d: { results: [{ SOH: "1", BPCNUM: "C1" }] } }).has("BPCNUM")).toBe(true);
  });

  it("extracts keys from a bare array and a plain object", () => {
    expect(liveFieldSet([{ a: 1, b: 2 }]).has("a")).toBe(true);
    expect(liveFieldSet({ a: 1, b: 2 }).has("b")).toBe(true);
  });

  it("returns an empty set for null / empty / non-object samples", () => {
    expect(liveFieldSet(null).size).toBe(0);
    expect(liveFieldSet({ value: [] }).size).toBe(0);
    expect(liveFieldSet("nope").size).toBe(0);
  });
});

describe("detectDrift", () => {
  it("returns no findings when every mapped target exists (full-connector / SAP style)", () => {
    const map = { partNumber: "Material", qty: "RequestedQuantity" };
    const schema = ["Material", "RequestedQuantity", "SalesOrderItem"];
    expect(detectDrift(map, schema)).toEqual([]);
  });

  it("flags a mapped target that is absent from the live schema", () => {
    const map = { partNumber: "Material", qty: "RequestedQuantity" };
    const schema = new Set(["MaterialNumber", "RequestedQuantity"]); // Material renamed
    const findings = detectDrift(map, schema);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      finding_kind: "mapped_field_absent",
      severity: "error",
      field: "partNumber",
      expected: { target: "Material" },
      actual: { present: false },
    });
  });

  it("works against a raw sample record (Tally-style total/gstin map)", () => {
    const map = { grand_total: "AMOUNT", customer_gstin: "PARTYGSTIN" };
    const present = detectDrift(map, { value: [{ AMOUNT: 100, PARTYGSTIN: "27AAA", VCHNO: "1" }] });
    expect(present).toEqual([]);
    const drifted = detectDrift(map, { value: [{ AMOUNT: 100, VCHNO: "1" }] }); // PARTYGSTIN gone
    expect(drifted.map((f) => f.field)).toEqual(["customer_gstin"]);
  });

  it("treats a dotted target as present when its head container exists", () => {
    const map = { customer: "Header.CustomerNo" };
    expect(detectDrift(map, ["Header", "Lines"])).toEqual([]);
    expect(detectDrift(map, { "Header.CustomerNo": "C1" })).toEqual([]); // exact key also ok
    expect(detectDrift(map, ["Lines"])).toHaveLength(1); // head missing -> drift
  });

  it("returns [] (no false alarms) when the map is empty or the schema is unknown", () => {
    expect(detectDrift({}, ["Material"])).toEqual([]);
    expect(detectDrift({ partNumber: "Material" }, [])).toEqual([]);
    expect(detectDrift({ partNumber: "Material" }, null)).toEqual([]);
  });

  it("skips non-string / empty target values without throwing", () => {
    const map = { a: "Material", b: "", c: null, d: 42 };
    expect(detectDrift(map, ["RequestedQuantity"])).toHaveLength(1); // only 'a' assessed
  });
});
