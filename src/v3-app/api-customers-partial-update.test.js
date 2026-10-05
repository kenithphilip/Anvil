// POST /api/customers is both the create and the edit endpoint for the
// customer master. It used to write `body.x || null` for every column on
// every call, so a PARTIAL body (the customers screen's inline edit sends
// only the fields that changed) erased every column it did not carry:
// parent_customer_id, notes, bill_to, contact details, even the name.
//
// These tests drive the real handler over an in-memory customers table
// whose upsert follows PostgREST: on a (tenant_id, customer_key) conflict
// it overwrites exactly the columns present in the payload. The real
// requireAction / SERVER_ACTIONS gate and the real GSTIN validator run;
// only resolveContext and the Supabase client are replaced.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ ctx: null, tables: {}, writes: [], missingColumns: new Set(), seq: 0 }));
// Column defaults the fake applies on insert (migration 158).
const INSERT_DEFAULTS = vi.hoisted(() => ({ customer_change_requests: { status: "pending" } }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const ds = H.tables[table] || (H.tables[table] = []);
      const filters = [];
      let mode = "select";
      let payload = null;
      let conflict = null;
      let single = false;
      const matching = () => ds.filter((r) => filters.every((f) => f(r)));
      const missing = (row) => Object.keys(row).find((k) => H.missingColumns.has(table + "." + k));
      const terminal = () => {
        if (mode !== "select") {
          const rows = Array.isArray(payload) ? payload : [payload];
          for (const row of rows) {
            const col = missing(row);
            if (col) return { data: null, error: { code: "42703", message: 'column "' + col + '" of relation "' + table + '" does not exist' } };
          }
          for (const row of rows) H.writes.push({ table, mode, payload: { ...row } });
        }
        let out;
        if (mode === "update") {
          out = matching();
          for (const r of out) Object.assign(r, payload);
        } else if (mode === "insert" || mode === "upsert") {
          out = [];
          for (const row of (Array.isArray(payload) ? payload : [payload])) {
            const hit = conflict && ds.find((r) => conflict.every((c) => r[c] === row[c]));
            if (hit) { Object.assign(hit, row); out.push(hit); continue; }
            const fresh = { id: row.id || table + "-new-" + (++H.seq), ...(INSERT_DEFAULTS[table] || {}), ...row };
            ds.push(fresh);
            out.push(fresh);
          }
        } else {
          out = matching();
        }
        const copy = out.map((r) => ({ ...r }));
        return { data: single ? copy[0] || null : copy, error: null };
      };
      const b = {
        select: () => b,
        eq: (c, v) => { filters.push((r) => r[c] === v); return b; },
        in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return b; },
        order: () => b,
        limit: () => b,
        single: () => { single = true; return b; },
        maybeSingle: () => { single = true; return b; },
        update: (p) => { mode = "update"; payload = p; return b; },
        insert: (p) => { mode = "insert"; payload = p; return b; },
        upsert: (p, opts) => { mode = "upsert"; payload = p; conflict = String(opts?.onConflict || "").split(",").filter(Boolean); return b; },
        then: (ok, bad) => Promise.resolve(terminal()).then(ok, bad),
      };
      return b;
    },
  }),
}));

const { default: customersHandler } = await import("../api/customers/index.js");
const { default: changeRequestsHandler } = await import("../api/customers/change_requests.js");

const T1 = "tenant-1";
const T2 = "tenant-2";
const GSTIN_MH = "27AAPFU0939F1ZV";
const GSTIN_TN = "33AAACH7409R1Z8";

const call = async (handler, { method = "POST", body, query = {}, role = "admin" }) => {
  H.ctx = { tenantId: T1, role, user: { id: "user-" + role }, anonymous: false };
  const res = {
    statusCode: 0,
    body: null,
    setHeader() { return this; },
    status(c) { this.statusCode = c; return this; },
    send(p) { this.body = typeof p === "string" ? JSON.parse(p) : p; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
  await handler({ method, headers: {}, query, body }, res);
  return res;
};
const post = (body, role) => call(customersHandler, { body, role });

const ACME = () => ({
  id: "c-acme",
  tenant_id: T1,
  customer_key: "acme",
  customer_name: "Acme Motors",
  gstin: GSTIN_MH,
  state_code: "27",
  country: "IN",
  tax_id: null,
  tax_id_type: null,
  customer_type: "AUTO_OEM",
  currency: "INR",
  payment_terms: "Net 60",
  default_payment_terms: "Net 60",
  default_incoterms: "FOB",
  default_quote_validity_days: 45,
  notes: "Plant visit every quarter",
  bill_to: "Plot 4, MIDC\nPune 411019",
  ship_to: "Gate 2, Chakan\nPune 410501",
  contact_email: "buyer@acme.example",
  contact_phone: "+91 20 5555 0101",
  margin_floor_pct: 12,
  parent_customer_id: "c-group",
  owner_user_id: "owner-1",
  ai_health_score: 81,
  updated_at: "2026-09-01T00:00:00Z",
});
const GROUP = () => ({ id: "c-group", tenant_id: T1, customer_key: "acme-group", customer_name: "Acme Group", parent_customer_id: null });

const row = (id) => H.tables.customers.find((r) => r.id === id);
// Every stored column of the seeded customer except the ones named.
const untouched = (exceptKeys) => {
  const base = ACME();
  for (const k of exceptKeys) delete base[k];
  return base;
};

beforeEach(() => {
  H.tables = { customers: [ACME(), GROUP()] };
  H.writes = [];
  H.missingColumns = new Set();
  H.seq = 0;
});

describe("POST /api/customers updates only the keys the body carries", () => {
  it("an inline edit sending only {id, customer_name} renames and leaves parent_customer_id, notes and the rest intact", async () => {
    const res = await post({ id: "c-acme", customer_name: "Acme Motors India" });
    expect(res.statusCode).toBe(200);
    expect(res.body.customer.customer_name).toBe("Acme Motors India");
    expect(row("c-acme")).toEqual({ ...ACME(), customer_name: "Acme Motors India" });
    expect(row("c-acme").parent_customer_id).toBe("c-group");
    expect(row("c-acme").notes).toBe("Plant visit every quarter");
    // Edited in place: no second customer was minted from the new name's slug.
    expect(H.tables.customers.map((r) => r.id)).toEqual(["c-acme", "c-group"]);
  });

  it("the screen's key-addressed partial edit persists customer_type and clobbers nothing", async () => {
    const res = await post({ customer_key: "acme", customer_type: "TIER_ONE" });
    expect(res.statusCode).toBe(200);
    expect(row("c-acme")).toEqual({ ...ACME(), customer_type: "TIER_ONE" });
    expect(H.writes).toEqual([{ table: "customers", mode: "update", payload: { customer_type: "TIER_ONE" } }]);
  });

  it("an explicit null clears that column and only that column", async () => {
    const res = await post({ id: "c-acme", notes: null, parent_customer_id: null });
    expect(res.statusCode).toBe(200);
    expect(row("c-acme")).toEqual({ ...untouched(["notes", "parent_customer_id"]), notes: null, parent_customer_id: null });
  });

  it("ship_to still falls back to bill_to when the body sends ship_to empty, and is left alone when absent", async () => {
    const both = await post({ id: "c-acme", bill_to: "Plot 9, Bhosari\nPune 411026", ship_to: null });
    expect(both.statusCode).toBe(200);
    expect(row("c-acme").ship_to).toBe("Plot 9, Bhosari\nPune 411026");

    H.tables.customers = [ACME(), GROUP()];
    const billOnly = await post({ id: "c-acme", bill_to: "Plot 9, Bhosari\nPune 411026" });
    expect(billOnly.statusCode).toBe(200);
    expect(row("c-acme").ship_to).toBe("Gate 2, Chakan\nPune 410501");
  });

  it("canonicalises a customer_type to the migration 006 enum and refuses a value outside it", async () => {
    const ok = await post({ id: "c-acme", customer_type: " line_builder " });
    expect(ok.statusCode).toBe(200);
    expect(row("c-acme").customer_type).toBe("LINE_BUILDER");

    const bad = await post({ id: "c-acme", customer_type: "auto oem" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "INVALID_CUSTOMER_TYPE", field: "customer_type" });
    expect(row("c-acme").customer_type).toBe("LINE_BUILDER");
  });

  it("refuses to blank a named customer's name", async () => {
    const res = await post({ id: "c-acme", customer_name: null });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({ code: "CUSTOMER_NAME_REQUIRED", field: "customer_name" });
    expect(row("c-acme")).toEqual(ACME());
  });

  it("refuses to rewrite customer_key on an id-addressed edit", async () => {
    const res = await post({ id: "c-acme", customer_key: "acme-motors", notes: "x" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({ code: "CUSTOMER_KEY_IMMUTABLE" });
    expect(row("c-acme")).toEqual(ACME());
  });

  it("an id from another tenant is not found and nothing is written", async () => {
    H.tables.customers.push({ ...ACME(), id: "c-foreign", tenant_id: T2, customer_key: "foreign" });
    const res = await post({ id: "c-foreign", notes: "hijack" });
    expect(res.statusCode).toBe(404);
    expect(row("c-foreign").notes).toBe("Plant visit every quarter");
    expect(H.writes).toEqual([]);
  });

  it("never writes owner_user_id or read-only columns, even from a whole-object body", async () => {
    const res = await post({ ...ACME(), owner_user_id: "someone-else", ai_health_score: 5, parent_customer_id: null });
    expect(res.statusCode).toBe(200);
    expect(row("c-acme")).toEqual({ ...untouched(["parent_customer_id"]), parent_customer_id: null });
    const customerWrites = H.writes.filter((w) => w.table === "customers");
    expect(customerWrites).toHaveLength(1);
    expect(Object.keys(customerWrites[0].payload)).not.toContain("owner_user_id");
    expect(Object.keys(customerWrites[0].payload)).not.toContain("ai_health_score");
  });

  it("an empty edit writes nothing and returns the stored row", async () => {
    const res = await post({ id: "c-acme" });
    expect(res.statusCode).toBe(200);
    expect(res.body.customer).toEqual(ACME());
    expect(H.writes).toEqual([]);
  });
});

describe("GSTIN gate on an edit", () => {
  it("clearing a stored GSTIN needs customer.edit_gstin", async () => {
    const res = await post({ id: "c-acme", gstin: null }, "sales_engineer");
    expect(res.statusCode).toBe(403);
    expect(row("c-acme").gstin).toBe(GSTIN_MH);

    const blank = await post({ id: "c-acme", gstin: "   " }, "sales_engineer");
    expect(blank.statusCode).toBe(403);
    expect(row("c-acme").gstin).toBe(GSTIN_MH);

    const admin = await post({ id: "c-acme", gstin: "   " }, "admin");
    expect(admin.statusCode).toBe(200);
    expect(row("c-acme")).toEqual({ ...ACME(), gstin: null });
  });

  it("resending the stored GSTIN unchanged is not a GSTIN edit", async () => {
    const res = await post({ customer_key: "acme", gstin: GSTIN_MH.toLowerCase(), notes: "Updated by SE" }, "sales_engineer");
    expect(res.statusCode).toBe(200);
    expect(row("c-acme")).toEqual({ ...ACME(), notes: "Updated by SE" });
  });

  it("a new GSTIN is still gated and validated", async () => {
    const se = await post({ id: "c-acme", gstin: GSTIN_TN }, "sales_engineer");
    expect(se.statusCode).toBe(403);
    const typo = await post({ id: "c-acme", gstin: "33AAACH7409R1Z9" }, "admin");
    expect(typo.statusCode).toBe(400);
    expect(row("c-acme").gstin).toBe(GSTIN_MH);
    const ok = await post({ id: "c-acme", gstin: GSTIN_TN.toLowerCase() }, "admin");
    expect(ok.statusCode).toBe(200);
    expect(row("c-acme").gstin).toBe(GSTIN_TN);
  });
});

describe("create keeps its defaults", () => {
  it("a name-only create derives the key and writes every column with its default", async () => {
    const res = await post({ customer_name: "Zen Robotics Pvt Ltd", bill_to: "Unit 3, Hinjewadi\nPune 411057", currency: "INR" });
    expect(res.statusCode).toBe(200);
    const created = H.tables.customers.find((r) => r.customer_key === "zen-robotics-pvt-ltd");
    expect(created).toMatchObject({
      tenant_id: T1,
      customer_name: "Zen Robotics Pvt Ltd",
      currency: "INR",
      bill_to: "Unit 3, Hinjewadi\nPune 411057",
      ship_to: "Unit 3, Hinjewadi\nPune 411057",
      notes: null,
      gstin: null,
      parent_customer_id: null,
      default_quote_validity_days: null,
    });
    expect(res.body.customer.id).toBe(created.id);
    expect(H.tables.customer_locations).toEqual([
      expect.objectContaining({ tenant_id: T1, customer_id: created.id, location_code: "default_bill", pincode: "411057" }),
    ]);
    expect(row("c-acme")).toEqual(ACME());
  });

  it("a create may set customer_type", async () => {
    const res = await post({ customer_name: "Weld Line Builders", customer_type: "LINE_BUILDER" });
    expect(res.statusCode).toBe(200);
    expect(H.tables.customers.find((r) => r.customer_key === "weld-line-builders").customer_type).toBe("LINE_BUILDER");
  });
});

describe("every caller of POST /api/customers", () => {
  it("so-intake edit (full form, no notes / parent / default_* keys) keeps those columns", async () => {
    const res = await post({
      customer_name: "Acme Motors",
      customer_key: "acme",
      country: "in",
      gstin: GSTIN_MH,
      state_code: "27",
      tax_id: null,
      tax_id_type: null,
      currency: "INR",
      payment_terms: "Net 45",
      margin_floor_pct: null,
      bill_to: "Plot 4, MIDC\nPune 411019",
      ship_to: "Gate 2, Chakan\nPune 410501",
      contact_email: "buyer@acme.example",
      contact_phone: null,
    });
    expect(res.statusCode).toBe(200);
    expect(row("c-acme")).toEqual({
      ...ACME(),
      payment_terms: "Net 45",
      margin_floor_pct: null,
      contact_phone: null,
    });
  });

  it("studio profile save keeps currency, addresses and the parent, and still versions the profile", async () => {
    const c = ACME();
    const res = await post({
      customer_key: c.customer_key,
      customer_name: c.customer_name,
      gstin: c.gstin,
      state_code: c.state_code,
      default_payment_terms: c.default_payment_terms,
      default_incoterms: c.default_incoterms,
      default_quote_validity_days: c.default_quote_validity_days,
      notes: c.notes,
      profile: { version: 2, fingerprint: { header: "ACME PO" }, trusted: true },
    }, "sales_manager");
    expect(res.statusCode).toBe(200);
    expect(row("c-acme")).toEqual(ACME());
    expect(res.body.profile).toMatchObject({ customer_id: "c-acme", version: 3, is_current: true, trusted: true });
  });

  it("hierarchy panel (whole customer object) sets the parent and changes nothing else", async () => {
    const res = await post({ ...ACME(), parent_customer_id: null });
    expect(res.statusCode).toBe(200);
    const again = await post({ ...row("c-acme"), parent_customer_id: "c-group" });
    expect(again.statusCode).toBe(200);
    expect(row("c-acme")).toEqual(ACME());
  });

  it("a pre-061 deployment retries an edit with only the legacy columns it carried", async () => {
    H.missingColumns = new Set(["customers.currency"]);
    const res = await post({ id: "c-acme", currency: "USD", notes: "Switching to USD" });
    expect(res.statusCode).toBe(200);
    expect(res.body.warning).toBe("optional_fields_unavailable");
    expect(row("c-acme")).toEqual({ ...ACME(), notes: "Switching to USD" });
  });

  it("the change-request path still applies an approved partial update", async () => {
    const submit = await call(changeRequestsHandler, {
      method: "POST",
      role: "sales_engineer",
      body: { change_type: "update", target_customer_id: "c-acme", payload: { customer_name: "Acme Motors Ltd" } },
    });
    expect(submit.statusCode).toBe(200);
    const requestId = submit.body.request.id;
    const decide = await call(changeRequestsHandler, {
      method: "PATCH",
      role: "sales_manager",
      query: { id: requestId },
      body: { decision: "approve" },
    });
    expect(decide.statusCode).toBe(200);
    expect(decide.body.request).toMatchObject({ status: "approved", applied_customer_id: "c-acme" });
    expect(row("c-acme")).toEqual({ ...ACME(), customer_name: "Acme Motors Ltd" });
  });
});
