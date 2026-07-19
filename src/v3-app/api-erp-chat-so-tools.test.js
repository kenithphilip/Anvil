// MCP / copilot grounding tools for SO processing:
// verify_customer_gstin, resolve_item, lookup_customer_parts.
// In-memory Supabase fake; hybrid search mocked (no RPC).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { gstinChecksumChar } from "../api/_lib/gstin.js";

const H = vi.hoisted(() => ({ store: {} }));

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => svc }));
vi.mock("../api/_lib/hybrid-item-search.js", () => ({
  searchItemsHybrid: vi.fn(async (_svc, { queryText }) => [
    { id: "i-tip", part_no: "TIP-CU-12", description: "contact tip 1.2mm", score: 0.94, _q: queryText },
  ]),
}));

// Minimal chainable fake supporting eq/ilike/in/limit/maybeSingle/await.
const svc = {
  from(table) {
    H.store[table] = H.store[table] || [];
    const q = {
      _f: [],
      select() { return this; },
      eq(c, v) { this._f.push((r) => r[c] === v); return this; },
      ilike(c, pat) { const re = new RegExp("^" + String(pat).replace(/%/g, ".*") + "$", "i"); this._f.push((r) => re.test(String(r[c] ?? ""))); return this; },
      in(c, vals) { const s = new Set(vals); this._f.push((r) => s.has(r[c])); return this; },
      limit() { return this; },
      _hits() { return (H.store[table] || []).filter((r) => this._f.every((fn) => fn(r))); },
      maybeSingle() { const s = this; return { then: (res) => res({ data: s._hits()[0] || null, error: null }) }; },
      then(res) { return res({ data: this._hits(), error: null }); },
    };
    return q;
  },
};

const { dispatchErpChatTool, erpChatToolNames, erpChatReadScopes } = await import("../api/_lib/erp-chat-tools.js");

// A checksum-valid GSTIN (first 14 chars + computed Mod-36 check char).
const BASE14 = "27AAACA1234B1Z";
const GSTIN = BASE14 + gstinChecksumChar(BASE14);

beforeEach(() => {
  H.store = {
    customers: [{ id: "c-1", tenant_id: "t-1", customer_name: "Acme Steels", state_code: "27", gstin: GSTIN }],
    item_customer_parts: [
      { tenant_id: "t-1", customer_id: "c-1", customer_part_number: "ACME-TIP-9", customer_part_description: "tip", item_id: "i-tip", is_primary: true },
    ],
    item_master: [{ id: "i-tip", tenant_id: "t-1", part_no: "TIP-CU-12" }],
  };
});

describe("verify_customer_gstin", () => {
  it("flags an invalid GSTIN (bad checksum)", async () => {
    const r = await dispatchErpChatTool("t-1", "verify_customer_gstin", { gstin: "27AAACA1234B1Z9" });
    expect(r.valid).toBe(false);
    expect(r.verdict).toBe("invalid");
  });
  it("resolves a valid GSTIN to a known customer + derives state", async () => {
    const r = await dispatchErpChatTool("t-1", "verify_customer_gstin", { gstin: GSTIN });
    expect(r.valid).toBe(true);
    expect(r.verdict).toBe("known_customer");
    expect(r.matched).toEqual({ id: "c-1", customer_name: "Acme Steels" });
    expect(r.state_code).toBe("27");
  });
  it("returns valid_unknown for a checksum-valid but unregistered GSTIN", async () => {
    H.store.customers = []; // no registry match
    const r = await dispatchErpChatTool("t-1", "verify_customer_gstin", { gstin: GSTIN });
    expect(r.valid).toBe(true);
    expect(r.verdict).toBe("valid_unknown");
    expect(r.matched).toBeNull();
  });
});

describe("resolve_item", () => {
  it("returns hybrid-search candidates for a line query", async () => {
    const r = await dispatchErpChatTool("t-1", "resolve_item", { query: "weld gun contact tip 1.2" });
    expect(r.source).toBe("item_master_hybrid");
    expect(r.rows[0].part_no).toBe("TIP-CU-12");
  });
  it("requires a query", async () => {
    const r = await dispatchErpChatTool("t-1", "resolve_item", {});
    expect(r.error).toMatch(/query/);
  });
});

describe("lookup_customer_parts", () => {
  it("lists a customer's aliases joined to the canonical part_no", async () => {
    const r = await dispatchErpChatTool("t-1", "lookup_customer_parts", { customer_id: "c-1" });
    expect(r.source).toBe("item_customer_parts");
    expect(r.rows[0]).toMatchObject({ customer_part_number: "ACME-TIP-9", canonical_part_no: "TIP-CU-12", is_primary: true });
  });
});

describe("registration + scope", () => {
  it("registers the three tools under read.* scopes", () => {
    const names = erpChatToolNames();
    expect(names).toEqual(expect.arrayContaining(["verify_customer_gstin", "resolve_item", "lookup_customer_parts"]));
    const reads = erpChatReadScopes();
    expect(reads).toEqual(expect.arrayContaining(["read.customers", "read.inventory"]));
  });
  it("enforces scope: a token without read.customers cannot call verify_customer_gstin", async () => {
    const r = await dispatchErpChatTool("t-1", "verify_customer_gstin", { gstin: GSTIN }, { scopes: ["read.orders"] });
    expect(r.error).toMatch(/scope not allowed/);
  });
});
