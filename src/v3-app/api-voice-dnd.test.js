// Unit tests for the buildRow helper extracted from
// src/api/voice/dnd.js. Covers the validation guards (E.164
// parsing, source whitelist, tenant-scope refusal) and region
// inference.
//
// Audit: DEFERRED_ROADMAP §1 follow-up. The DND CRUD endpoint
// is the operator-facing surface for voice_dnd_list.

import { describe, it, expect } from "vitest";
import { __test as dnd } from "../api/voice/dnd.js";

const baseInput = (overrides) => ({
  tenantId: "t-1",
  addedBy: "u-1",
  phoneNumber: "+919876543210",
  source: "tenant_manual",
  region: null,
  reason: null,
  ...(overrides || {}),
});

describe("dnd.buildRow", () => {
  it("accepts a tenant_manual entry and infers region from E.164", () => {
    const row = dnd.buildRow(baseInput());
    expect(row.tenant_id).toBe("t-1");
    expect(row.phone_number).toBe("+919876543210");
    expect(row.source).toBe("tenant_manual");
    expect(row.region).toBe("IN");
    expect(row.added_by).toBe("u-1");
  });

  it("rejects a bare 10-digit phone with no country code prefix", () => {
    // P2 from May 2026 critic: silently prefixing "+" to a bare
    // local number produced a wrong-region E.164 that missed the
    // DND lookup. Fail-closed instead.
    expect(() => dnd.buildRow(baseInput({ phoneNumber: "9876543210" }))).toThrow(/E\.164/);
  });

  it("accepts the 00-prefix international trunk form", () => {
    const row = dnd.buildRow(baseInput({ phoneNumber: "0091987654321" }));
    expect(row.phone_number).toBe("+91987654321");
  });

  it("rejects garbage that cannot be parsed to E.164", () => {
    expect(() => dnd.buildRow(baseInput({ phoneNumber: "abc" }))).toThrow(/E\.164/);
  });

  it("defaults source to tenant_manual when omitted", () => {
    const row = dnd.buildRow(baseInput({ source: undefined }));
    expect(row.source).toBe("tenant_manual");
  });

  it("rejects an unknown source string", () => {
    expect(() => dnd.buildRow(baseInput({ source: "magic" }))).toThrow(/source must be one of/);
  });

  it("refuses to insert global registry rows from the tenant API", () => {
    expect(() => dnd.buildRow(baseInput({ source: "trai_ndnc" }))).toThrow(/owned by the registry cron loader/);
    expect(() => dnd.buildRow(baseInput({ source: "fcc_dnc" }))).toThrow(/owned by the registry cron loader/);
  });

  it("accepts customer_request as a tenant-owned source", () => {
    const row = dnd.buildRow(baseInput({ source: "customer_request", reason: "Customer asked us to stop calling" }));
    expect(row.source).toBe("customer_request");
    expect(row.reason).toBe("Customer asked us to stop calling");
  });

  it("preserves an explicit region when provided (overrides inference)", () => {
    const row = dnd.buildRow(baseInput({ phoneNumber: "+15555550123", region: "CA" }));
    expect(row.region).toBe("CA");
  });

  it("infers US region for +1 numbers when no region is provided", () => {
    const row = dnd.buildRow(baseInput({ phoneNumber: "+14155550123" }));
    expect(row.region).toBe("US");
  });
});
