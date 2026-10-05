// Rep touch log (scope PR 10): POST /api/communications/log records a call,
// meeting, whatsapp, visit or note against a quote or an opportunity, and
// GET /api/communications filters by object_type / object_id / customer_id.
//
// Every test drives the real handlers against an in-memory table store whose
// query builder APPLIES the filters it is given (eq / lte / gte / order /
// limit), so a missing tenant or status filter in a handler shows up as a
// wrong row, not as a mock that returns whatever it was seeded with.
//
// Covered:
//   * an unknown channel is a 400, and so is a malformed date or body;
//   * a quote or opportunity of ANOTHER tenant is a 404 (the service role
//     bypasses RLS, so the handler's own lookup is the tenant gate);
//   * a logged touch is final: status sent, provider manual, document_type
//     rep_touch, sent_by = ctx.user.id, customer_id copied from the target;
//   * a filtered GET returns only that object's rows (object_type, object_id,
//     customer_id each narrow it), a quote's versions=all widens to every
//     version of that quote in this tenant, and only a touch's body comes back;
//   * the "touch.log" action admits exactly the roles the client shows the form to;
//   * the queued-comms reaper (agents/run.js) does not pick up a touch;
//   * the metric catalog's customer-comms totals do not move when touches land.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const h = vi.hoisted(() => {
  // agents/run.js reads CRON_SECRET once, at module load, so it is set before
  // any import below and put back in afterAll.
  const priorCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "cron-test-secret";
  const state = { tables: {}, seq: 0, clock: Date.parse("2026-10-02T09:00:00Z") };
  const nextId = () => {
    state.seq += 1;
    return "00000000-0000-4000-8000-" + String(state.seq).padStart(12, "0");
  };
  const rowsOf = (t) => (state.tables[t] = state.tables[t] || []);
  const makeQuery = (table) => {
    const st = { op: "select", payload: null, filters: [], order: null, limit: null, single: null, columns: null };
    const match = (r) => st.filters.every((f) => f(r));
    // PostgREST-style projection: "*", plain columns, and "alias:col->>key"
    // (a JSON key read out as text). Applied, not ignored, so a handler that
    // selects too little or too much shows up in what it returns.
    const project = (row) => {
      if (!st.columns || st.columns.trim() === "*") return row;
      const out = {};
      for (const raw of st.columns.split(",")) {
        const tok = raw.trim();
        if (!tok) continue;
        if (tok === "*") { Object.assign(out, row); continue; }
        const [name, expr] = tok.includes(":") ? tok.split(":") : [tok, tok];
        if (expr.includes("->>")) {
          const [col, key] = expr.split("->>");
          const v = row[col] && row[col][key];
          out[name] = v == null ? null : String(v);
        } else {
          out[name] = row[expr] === undefined ? null : row[expr];
        }
      }
      return out;
    };
    const finish = (rawData) => {
      const data = rawData.map(project);
      if (st.single === "single") {
        return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: "expected one row, got " + data.length } };
      }
      if (st.single === "maybe") return { data: data[0] || null, error: null };
      return { data, error: null };
    };
    const exec = () => {
      if (st.op === "insert") {
        const arr = Array.isArray(st.payload) ? st.payload : [st.payload];
        const inserted = arr.map((r) => {
          state.clock += 1000;
          return { id: nextId(), created_at: new Date(state.clock).toISOString(), ...r };
        });
        rowsOf(table).push(...inserted);
        return finish(inserted.map((r) => ({ ...r })));
      }
      if (st.op === "update") {
        const hit = rowsOf(table).filter(match);
        hit.forEach((r) => Object.assign(r, st.payload));
        return finish(hit.map((r) => ({ ...r })));
      }
      let data = rowsOf(table).filter(match).map((r) => ({ ...r }));
      if (st.order) {
        const { k, asc } = st.order;
        data.sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (st.limit != null) data = data.slice(0, st.limit);
      return finish(data);
    };
    const q = {
      select: (cols) => { st.columns = cols == null ? null : String(cols); return q; },
      insert: (p) => { st.op = "insert"; st.payload = p; return q; },
      update: (p) => { st.op = "update"; st.payload = p; return q; },
      eq: (k, v) => { st.filters.push((r) => r[k] === v); return q; },
      in: (k, vs) => { st.filters.push((r) => vs.includes(r[k])); return q; },
      lte: (k, v) => { st.filters.push((r) => r[k] != null && String(r[k]) <= String(v)); return q; },
      gte: (k, v) => { st.filters.push((r) => r[k] != null && String(r[k]) >= String(v)); return q; },
      order: (k, o) => { st.order = { k, asc: !(o && o.ascending === false) }; return q; },
      limit: (n) => { st.limit = n; return q; },
      single: () => { st.single = "single"; return Promise.resolve(exec()); },
      maybeSingle: () => { st.single = "maybe"; return Promise.resolve(exec()); },
      then: (res, rej) => Promise.resolve().then(exec).then(res, rej),
    };
    return q;
  };
  const svc = { from: (t) => makeQuery(t) };
  return { state, rowsOf, svc, ctx: null, priorCronSecret };
});

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => h.svc }));

// resolveContext is the only piece of auth replaced: requirePermission stays
// real, so the role gate the handler declares is the one that runs.
vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, resolveContext: vi.fn(async () => h.ctx) };
});

// The reaper's send core. A spy, so the test sees exactly which rows the
// reaper chose to transmit.
vi.mock("../api/_lib/comms-send.js", () => ({
  sendCommunication: vi.fn(async (_svc, _ctx, id) => ({ communication: { id, status: "sent" } })),
}));

const { default: logHandler } = await import("../api/communications/log.js");
const { default: listHandler } = await import("../api/communications/list.js");
const { computeMetric } = await import("../api/_lib/metrics/catalog.js");
const { RBAC } = await import("./lib/rbac");
const { sendCommunication } = await import("../api/_lib/comms-send.js");
// The whole API router, loaded once at module scope (it imports every handler,
// which is slow under a parallel run and must not eat a test's timeout).
const { dispatch } = await import("../api/router.js");
const { default: runHandler } = await import("../api/agents/run.js");

afterAll(() => {
  if (h.priorCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = h.priorCronSecret;
});

const TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002";
const USER = "11111111-0000-4000-8000-0000000000aa";
const CUST_A = "cccccccc-0000-4000-8000-0000000000a1";
const CUST_A2 = "cccccccc-0000-4000-8000-0000000000a2";
const CUST_B = "cccccccc-0000-4000-8000-0000000000b1";
const QUOTE_A = "dddddddd-0000-4000-8000-0000000000a1";
const QUOTE_A2 = "dddddddd-0000-4000-8000-0000000000a2";
const QUOTE_A_V2 = "dddddddd-0000-4000-8000-0000000002a1";   // Q-1 revised
const QUOTE_B = "dddddddd-0000-4000-8000-0000000000b1";
const QUOTE_B_Q1 = "dddddddd-0000-4000-8000-0000000001b1";   // another tenant's Q-1
const OPP_A = "eeeeeeee-0000-4000-8000-0000000000a1";
const OPP_B = "eeeeeeee-0000-4000-8000-0000000000b1";
const CONTACT_A = "ffffffff-0000-4000-8000-0000000000a1";
const CONTACT_A2 = "ffffffff-0000-4000-8000-0000000000a2";
const CONTACT_FOREIGN = "ffffffff-0000-4000-8000-0000000000b1";

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  send(p) { this.body = p; return this; },
  json(o) { this.body = JSON.stringify(o); return this; },
  end() { return this; },
});

const call = async (handler, req) => {
  const res = makeRes();
  await handler({ headers: {}, query: {}, ...req }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const postLog = (body) => call(logHandler, { method: "POST", body });
const getList = (query) => call(listHandler, { method: "GET", query });

const touch = (over = {}) => ({
  object_type: "quote",
  object_id: QUOTE_A,
  channel: "call",
  body: "Spoke to maintenance",
  metadata: { next_followup_at: "2026-10-07" },
  ...over,
});

beforeEach(() => {
  h.state.tables = {
    quotes: [
      { id: QUOTE_A, tenant_id: TENANT_A, customer_id: CUST_A, quote_number: "Q-1", version: 1 },
      { id: QUOTE_A2, tenant_id: TENANT_A, customer_id: CUST_A2, quote_number: "Q-2", version: 1 },
      { id: QUOTE_A_V2, tenant_id: TENANT_A, customer_id: CUST_A, quote_number: "Q-1", version: 2, prior_version_id: QUOTE_A },
      { id: QUOTE_B, tenant_id: TENANT_B, customer_id: CUST_B, quote_number: "Q-B", version: 1 },
      { id: QUOTE_B_Q1, tenant_id: TENANT_B, customer_id: CUST_B, quote_number: "Q-1", version: 1 },
    ],
    opportunities: [
      { id: OPP_A, tenant_id: TENANT_A, customer_id: CUST_A, opportunity_name: "Line 4 retrofit" },
      { id: OPP_B, tenant_id: TENANT_B, customer_id: CUST_B, opportunity_name: "Other tenant" },
    ],
    customer_contacts: [
      { id: CONTACT_A, tenant_id: TENANT_A, customer_id: CUST_A, name: "Asha Rao" },
      { id: CONTACT_A2, tenant_id: TENANT_A, customer_id: CUST_A2, name: "Vikram Shah" },
      // Another tenant's contact row that names this tenant's customer id.
      { id: CONTACT_FOREIGN, tenant_id: TENANT_B, customer_id: CUST_A, name: "Not ours" },
    ],
    communications: [],
    audit_events: [],
  };
  h.state.seq = 0;
  h.ctx = { user: { id: USER }, tenantId: TENANT_A, role: "sales_engineer", anonymous: false };
  vi.mocked(sendCommunication).mockClear();
});

describe("POST /api/communications/log", () => {
  it("records a final, manual rep touch with the target's customer and the actor", async () => {
    const r = await postLog(touch());
    expect(r.status).toBe(200);
    const rows = h.rowsOf("communications");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: TENANT_A,
      object_type: "quote",
      object_id: QUOTE_A,
      customer_id: CUST_A,               // copied from the quote, not sent by the client
      document_type: "rep_touch",
      direction: "outbound",
      channel: "call",
      status: "sent",
      provider: "manual",
      sent_by: USER,                     // ctx.user.id
      body: "Spoke to maintenance",
      metadata: { next_followup_at: "2026-10-07" },
    });
    expect(typeof rows[0].sent_at).toBe("string");
    expect(r.body.communication.id).toBe(rows[0].id);
    // The touch lands on the quote's audit trail too.
    expect(h.rowsOf("audit_events")).toEqual([
      expect.objectContaining({ action: "rep_touch_logged", object_type: "quote", object_id: QUOTE_A, actor: USER }),
    ]);
  });

  it("records a touch against an opportunity of this tenant", async () => {
    const r = await postLog(touch({ object_type: "opportunity", object_id: OPP_A, channel: "visit", metadata: undefined }));
    expect(r.status).toBe(200);
    expect(h.rowsOf("communications")[0]).toMatchObject({ object_type: "opportunity", object_id: OPP_A, customer_id: CUST_A, channel: "visit" });
  });

  it("refuses an unknown channel with a 400", async () => {
    for (const channel of ["email", "sms", "Call", ""]) {
      const r = await postLog(touch({ channel }));
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/channel must be one of: call, meeting, whatsapp, visit, note/);
    }
    // Every channel the form offers is accepted.
    for (const channel of ["call", "meeting", "whatsapp", "visit", "note"]) {
      expect((await postLog(touch({ channel }))).status).toBe(200);
    }
    expect(h.rowsOf("communications").map((r) => r.channel)).toEqual(["call", "meeting", "whatsapp", "visit", "note"]);
  });

  it("refuses an object type it cannot resolve to a tenant table", async () => {
    const r = await postLog(touch({ object_type: "invoice" }));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/object_type must be one of: quote, opportunity/);
  });

  it("returns 404 for another tenant's quote or opportunity, and for an unknown id", async () => {
    const foreignQuote = await postLog(touch({ object_id: QUOTE_B }));
    expect(foreignQuote.status).toBe(404);
    expect(foreignQuote.body.error.message).toBe("quote not found");
    const foreignOpp = await postLog(touch({ object_type: "opportunity", object_id: OPP_B }));
    expect(foreignOpp.status).toBe(404);
    expect(foreignOpp.body.error.message).toBe("opportunity not found");
    // An opportunity id posted as a quote is not found either: the type picks the table.
    expect((await postLog(touch({ object_type: "quote", object_id: OPP_A }))).status).toBe(404);
    // The same body against this tenant's own quote succeeds, so the 404s above
    // are the tenant gate and not a broken lookup.
    expect((await postLog(touch())).status).toBe(200);
    expect(h.rowsOf("communications").map((r) => r.object_id)).toEqual([QUOTE_A]);
  });

  it("validates the body text, the next date and the ids", async () => {
    expect((await postLog(touch({ body: "   " }))).status).toBe(400);
    expect((await postLog(touch({ body: undefined }))).status).toBe(400);
    const badDate = await postLog(touch({ metadata: { next_followup_at: "2026-02-30" } }));
    expect(badDate.status).toBe(400);
    expect(badDate.body.error.message).toMatch(/next_followup_at/);
    expect((await postLog(touch({ metadata: { next_followup_at: "07/10/2026" } }))).status).toBe(400);
    expect((await postLog(touch({ object_id: "q-1" }))).status).toBe(400);
    const tooLong = await postLog(touch({ body: "x".repeat(10001) }));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.message).toBe("body is longer than 10000 characters");
    // No next date is fine: the date is optional.
    const noDate = await postLog(touch({ metadata: {} }));
    expect(noDate.status).toBe(200);
    // The longest note allowed is stored whole.
    expect((await postLog(touch({ body: "y".repeat(10000) }))).status).toBe(200);
    expect(h.rowsOf("communications").map((r) => r.body.length)).toEqual(["Spoke to maintenance".length, 10000]);
  });

  it("stores a contact of the target's customer and refuses any other", async () => {
    const other = await postLog(touch({ customer_contact_id: CONTACT_A2 }));
    expect(other.status).toBe(400);
    expect(other.body.error.message).toMatch(/not a contact of this quote's customer/);
    // A contact row in ANOTHER tenant is refused even when it names this
    // quote's customer id: the lookup is tenant-scoped, not customer-scoped only.
    const foreign = await postLog(touch({ customer_contact_id: CONTACT_FOREIGN }));
    expect(foreign.status).toBe(400);
    expect(h.rowsOf("communications")).toHaveLength(0);
    const ok = await postLog(touch({ customer_contact_id: CONTACT_A }));
    expect(ok.status).toBe(200);
    expect(h.rowsOf("communications")[0].customer_contact_id).toBe(CONTACT_A);
  });

  it("is a write: a viewer cannot log a touch", async () => {
    h.ctx = { ...h.ctx, role: "viewer" };
    const r = await postLog(touch());
    expect(r.status).toBe(403);
  });

  it("admits exactly the roles the client offers the Log form to", async () => {
    // TouchLog shows the form when RBAC.canDo("touch.log"). Drive the real
    // handler as every role and compare: a role that sees the form must be
    // able to log, and a role the server refuses must not see it.
    const admitted = {};
    const shown = {};
    for (const role of RBAC.ROLES) {
      h.ctx = { user: { id: USER }, tenantId: TENANT_A, role, anonymous: false };
      const r = await postLog(touch());
      expect([200, 403]).toContain(r.status);
      admitted[role] = r.status === 200;
      window.localStorage.setItem("anvil:v3_role", role);
      shown[role] = RBAC.canDo("touch.log");
    }
    window.localStorage.removeItem("anvil:v3_role");
    expect(shown).toEqual(admitted);
    // Not vacuous: both outcomes occur.
    expect(admitted.sales_engineer).toBe(true);
    expect(admitted.viewer).toBe(false);
    expect(admitted.customer_support).toBe(false);
  });

  it("enforces the registered touch.log action, so narrowing it narrows who can log", async () => {
    // Today touch.log equals the coarse write roles. The handler must still
    // consult it: otherwise a later narrowing would hide the form (rbac.ts)
    // while the endpoint kept accepting the role.
    const { SERVER_ACTIONS } = await import("../api/_lib/auth.js");
    h.ctx = { ...h.ctx, role: "procurement" };
    expect((await postLog(touch())).status).toBe(200);
    SERVER_ACTIONS["touch.log"].delete("procurement");
    try {
      const r = await postLog(touch());
      expect(r.status).toBe(403);
      expect(r.body.error.message).toMatch(/touch\.log/);
    } finally {
      SERVER_ACTIONS["touch.log"].add("procurement");
    }
    expect(h.rowsOf("communications")).toHaveLength(1);
  });
});

describe("routing", () => {
  it("the API router serves POST /api/communications/log and the filtered GET", async () => {
    const viaRouter = async (url, req) => {
      const res = makeRes();
      await dispatch({ headers: {}, url, ...req }, res);
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };
    const posted = await viaRouter("/api/communications/log", { method: "POST", body: touch() });
    expect(posted.status).toBe(200);
    expect(posted.body.communication).toMatchObject({ document_type: "rep_touch", object_id: QUOTE_A });
    const listed = await viaRouter("/api/communications?object_type=quote&object_id=" + QUOTE_A, { method: "GET" });
    expect(listed.status).toBe(200);
    expect(listed.body.communications.map((c) => c.id)).toEqual([posted.body.communication.id]);
  });
});

describe("GET /api/communications filters", () => {
  const seed = () => {
    h.state.tables.communications = [
      { id: "c-1", tenant_id: TENANT_A, object_type: "quote", object_id: QUOTE_A, customer_id: CUST_A, document_type: "rep_touch", created_at: "2026-10-01T10:00:00Z" },
      { id: "c-2", tenant_id: TENANT_A, object_type: "quote", object_id: QUOTE_A, customer_id: CUST_A, document_type: "quote_email", created_at: "2026-10-02T10:00:00Z" },
      { id: "c-3", tenant_id: TENANT_A, object_type: "quote", object_id: QUOTE_A2, customer_id: CUST_A2, document_type: "rep_touch", created_at: "2026-10-02T11:00:00Z" },
      { id: "c-4", tenant_id: TENANT_A, object_type: "opportunity", object_id: OPP_A, customer_id: CUST_A, document_type: "rep_touch", created_at: "2026-10-03T10:00:00Z" },
      // Another tenant's row filed against the SAME object id.
      { id: "c-5", tenant_id: TENANT_B, object_type: "quote", object_id: QUOTE_A, customer_id: CUST_B, document_type: "rep_touch", created_at: "2026-10-04T10:00:00Z" },
      // Same object id, different object type: object_type must narrow too.
      { id: "c-6", tenant_id: TENANT_A, object_type: "opportunity", object_id: QUOTE_A, customer_id: CUST_A2, document_type: "rep_touch", created_at: "2026-10-05T10:00:00Z" },
    ];
  };

  it("returns only that object's rows, newest first", async () => {
    seed();
    const r = await getList({ object_type: "quote", object_id: QUOTE_A });
    expect(r.status).toBe(200);
    expect(r.body.communications.map((c) => c.id)).toEqual(["c-2", "c-1"]);
  });

  it("filters by customer_id", async () => {
    seed();
    const r = await getList({ customer_id: CUST_A });
    expect(r.body.communications.map((c) => c.id)).toEqual(["c-4", "c-2", "c-1"]);
  });

  it("keeps the order_id filter the ThreadDrawer uses", async () => {
    h.state.tables.communications = [
      { id: "o-1", tenant_id: TENANT_A, order_id: "ord-1", created_at: "2026-10-01T10:00:00Z" },
      { id: "o-2", tenant_id: TENANT_A, order_id: "ord-2", created_at: "2026-10-01T11:00:00Z" },
    ];
    const r = await getList({ order_id: "ord-1" });
    expect(r.body.communications.map((c) => c.id)).toEqual(["o-1"]);
  });

  it("refuses a malformed uuid filter with a 400 instead of a database error", async () => {
    const r = await getList({ object_id: "q-1" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("object_id must be a uuid");
    const c = await getList({ customer_id: "c-1" });
    expect(c.status).toBe(400);
    expect(c.body.error.message).toBe("customer_id must be a uuid");
  });

  it("returns a touch logged through POST when filtered to its quote", async () => {
    await postLog(touch({ customer_contact_id: CONTACT_A }));
    await postLog(touch({ object_id: QUOTE_A2, body: "Different quote" }));
    const r = await getList({ object_type: "quote", object_id: QUOTE_A });
    expect(r.body.communications).toHaveLength(1);
    // Every field TouchLog reads off a row: the contact feeds the opportunity's
    // contact prefill and the "with <name>" on the timeline.
    expect(r.body.communications[0]).toMatchObject({
      object_id: QUOTE_A, document_type: "rep_touch", body: "Spoke to maintenance",
      channel: "call", customer_contact_id: CONTACT_A, next_followup_at: "2026-10-07",
    });
    expect(typeof r.body.communications[0].sent_at).toBe("string");
    expect(typeof r.body.communications[0].created_at).toBe("string");
    // Only the next date is read out of metadata.
    expect(r.body.communications[0]).not.toHaveProperty("metadata");
  });

  it("returns a touch's body but not a quote email's, whose text carries the portal link", async () => {
    const PORTAL = "https://portal.example/q/accept?token=secret-bearer";
    h.state.tables.communications = [
      {
        id: "e-1", tenant_id: TENANT_A, object_type: "quote", object_id: QUOTE_A, document_type: "quote_email",
        channel: "email", status: "sent", subject: "Quotation Q-1 v1", created_at: "2026-10-01T10:00:00Z",
        body: "Hello,\n\nView quotation: https://files.example/signed\n\nAccept this quotation: " + PORTAL,
        metadata: { share_url: "https://files.example/signed", portal_url: PORTAL },
      },
    ];
    await postLog(touch());
    const r = await getList({ object_type: "quote", object_id: QUOTE_A });
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.communications.map((c) => [c.document_type, c]));
    expect(byId.rep_touch.body).toBe("Spoke to maintenance");
    expect(byId.quote_email).toMatchObject({ id: "e-1", subject: "Quotation Q-1 v1", body: null });
    expect(JSON.stringify(r.body)).not.toContain("secret-bearer");
  });

  it("versions=all lists every version of the quote in this tenant, and nothing else", async () => {
    await postLog(touch({ body: "Called on v1", channel: "call" }));                 // v1 of Q-1
    await postLog(touch({ object_id: QUOTE_A_V2, body: "Sent revised drawing", channel: "whatsapp" }));
    await postLog(touch({ object_id: QUOTE_A2, body: "Other quote" }));               // Q-2
    // A row in THIS tenant pointing at another tenant's quote that happens to
    // share the number Q-1: the chain lookup is tenant-scoped, so it stays out.
    h.state.tables.communications.push({
      id: "x-1", tenant_id: TENANT_A, object_type: "quote", object_id: QUOTE_B_Q1, document_type: "rep_touch",
      body: "Not this chain", created_at: "2026-10-09T10:00:00Z",
    });

    const chain = await getList({ object_type: "quote", object_id: QUOTE_A_V2, versions: "all" });
    expect(chain.status).toBe(200);
    expect(chain.body.communications.map((c) => c.body)).toEqual(["Sent revised drawing", "Called on v1"]);

    // Without versions=all the filter is the one row id, as before.
    const one = await getList({ object_type: "quote", object_id: QUOTE_A_V2 });
    expect(one.body.communications.map((c) => c.body)).toEqual(["Sent revised drawing"]);

    // versions is refused, not ignored, outside its one supported form.
    for (const query of [
      { object_type: "opportunity", object_id: OPP_A, versions: "all" },
      { object_type: "quote", versions: "all" },
      { object_type: "quote", object_id: QUOTE_A, versions: "latest" },
    ]) {
      const r = await getList(query);
      expect(r.status).toBe(400);
      expect(r.body.error.message).toBe("versions=all needs object_type=quote and an object_id");
    }
  });
});

describe("the queued-comms reaper never emails a touch", () => {
  it("fires the queued nudge on the same quote and leaves the touch alone", async () => {
    // A touch, logged through the real handler.
    const logged = await postLog(touch());
    expect(logged.status).toBe(200);
    const touchId = logged.body.communication.id;
    // An automatic nudge on the same quote, queued the way agents/run.js
    // send_email queues it.
    h.state.tables.communications.push({
      id: "nudge-1", tenant_id: TENANT_A, object_type: "quote", object_id: QUOTE_A,
      document_type: "agent_message", direction: "outbound", channel: "email",
      to_addr: "buyer@customer.example", status: "queued", created_at: "2026-10-02T10:00:00Z",
    });
    // A due goal for the tenant. Its goal_type is unknown, so the runner skips
    // the step itself but still reaps the tenant's queue.
    h.state.tables.agent_goals = [{
      id: "goal-1", tenant_id: TENANT_A, goal_type: "not_a_registered_goal", status: "active",
      next_run_at: "2026-01-01T00:00:00Z",
    }];

    const sendSpy = vi.mocked(sendCommunication);
    const r = await call(runHandler, { method: "POST", headers: { authorization: "Bearer cron-test-secret" } });

    expect(r.status).toBe(200);
    expect(r.body.reaped).toEqual([{ tenant_id: TENANT_A, fired: 1, errors: 0 }]);
    const sentIds = sendSpy.mock.calls.map((c) => c[2]);
    expect(sentIds).toEqual(["nudge-1"]);
    expect(sentIds).not.toContain(touchId);
    // The touch is untouched: still sent, never flipped to failed for want of a recipient.
    expect(h.rowsOf("communications").find((c) => c.id === touchId).status).toBe("sent");
  });
});

describe("customer-comms metrics ignore rep touches", () => {
  const NOW = Date.parse("2026-10-05T00:00:00Z");
  const CUSTOMER_METRICS = ["comms_sent", "comms_delivery_rate", "comms_reply_rate", "time_to_first_response_median", "dispatch_register_cadence", "payment_followups_sent"];
  const snapshot = async () => {
    const out = {};
    for (const id of CUSTOMER_METRICS) {
      const a = await computeMetric(h.svc, TENANT_A, id, { window_days: 30 }, NOW);
      out[id] = { value: a.value, count: a.count, denominator: a.denominator, breakdown: a.breakdown };
    }
    return out;
  };

  it("leaves every customer-comms total where it was after touches land", async () => {
    h.state.tables.communications = [
      { id: "m-1", tenant_id: TENANT_A, document_type: "quote_email", direction: "outbound", status: "sent", created_at: "2026-10-01T10:00:00Z", sent_at: "2026-10-01T10:00:00Z" },
      { id: "m-2", tenant_id: TENANT_A, document_type: "quote_email", direction: "outbound", status: "queued", created_at: "2026-10-01T11:00:00Z" },
      { id: "m-3", tenant_id: TENANT_A, document_type: "dispatch_register", direction: "outbound", status: "replied", created_at: "2026-10-01T12:00:00Z", sent_at: "2026-10-01T12:00:00Z", metadata: { replied_at: "2026-10-03T12:00:00Z" } },
      { id: "m-4", tenant_id: TENANT_A, document_type: "payment_reminder", direction: "outbound", status: "sent", created_at: "2026-10-01T13:00:00Z", sent_at: "2026-10-01T13:00:00Z" },
    ];
    const before = await snapshot();
    // The baseline is not empty, so "unchanged" is a real comparison.
    expect(before.comms_sent.value).toBe(4);
    expect(before.comms_delivery_rate).toMatchObject({ count: 3, denominator: 4 });

    // Touches written by the real handler, sent status and all.
    await postLog(touch());
    await postLog(touch({ channel: "meeting" }));
    await postLog(touch({ object_type: "opportunity", object_id: OPP_A, channel: "visit" }));
    expect(h.rowsOf("communications").filter((c) => c.document_type === "rep_touch")).toHaveLength(3);

    expect(await snapshot()).toEqual(before);
  });
});
