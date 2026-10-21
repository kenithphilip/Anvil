// A shared in-memory stand-in for the /api/orders/handoff tests. Each test
// file mocks auth, supabase, the mailer, the PDF renderer and Graph itself
// (vi.mock is hoisted per file) and points them at the state made here.
// Invented fixtures; every address is example.com.

export const T1 = "11111111-1111-4111-8111-111111111111";
export const T2 = "22222222-2222-4222-8222-222222222222";
export const ENGINEER = "e0000000-0000-4000-8000-000000000001";
export const OPERATOR = "e0000000-0000-4000-8000-000000000002";
export const ORDER = "a0000000-0000-4000-8000-000000000001";
export const ORDER_T2 = "a0000000-0000-4000-8000-000000000002";
export const CUSTOMER = "c0000000-0000-4000-8000-000000000001";
export const PO_DOC = "d0000000-0000-4000-8000-000000000001";

// The line prices the email must never print.
export const PRICES = ["1234.5", "4938", "77.25", "772.5", "5710.5"];

export const lines = () => [
  { part_no: "GC100", description: "Gear Case (O/K)", customer_part_number: "CP-1", quantity: 4, uom: "NOS", unitPrice: 1234.5, amount: 4938 },
  { part_no: "EL200-I", description: "Electrode", customer_part_number: "CP-2", quantity: 10, uom: "NOS", unitPrice: 77.25, amount: 772.5 },
];

export const freshState = () => ({
  ctx: null,
  seq: 0,
  writes: [],
  mail: [],
  fetches: [],
  pdf: [],
  mailer: "ok", // "ok" | "off" | "fail"
  graphOn: false,
  users: {
    [ENGINEER]: { id: ENGINEER, email: "eng@example.com", user_metadata: { name: "Test Engineer" } },
    [OPERATOR]: { id: OPERATOR, email: "ops@example.com", user_metadata: { name: "Test Operator" } },
  },
  store: {
    tenant_settings: [
      {
        tenant_id: T1, so_processing_mode: "B",
        order_handoff_enabled: true, order_handoff_to: ["orders-desk@example.com"], order_handoff_cc: [],
        order_handoff_sender: null, order_handoff_template: null,
        terms_check_mode: "off", terms_policy: null,
        postmark_inbound_address: null, graph_mailbox: null, graph_subscription_id: null,
      },
      {
        tenant_id: T2, so_processing_mode: "B",
        order_handoff_enabled: true, order_handoff_to: ["t2-desk@example.com"], order_handoff_cc: [],
        terms_check_mode: "off",
      },
    ],
    orders: [
      {
        id: ORDER, tenant_id: T1, status: "DRAFT", po_number: "PO-T-100", po_date: "2026-10-01",
        customer_id: CUSTOMER, payload_hash: "hash-1", rule_findings: [],
        committed_delivery_date: "2026-11-05", dispatch_mode: null, dispatch_plan: null,
        preflight_payload: { source_document_id: PO_DOC },
        handoff_status: null, handoff_sent_at: null, handoff_sent_by: null, handoff_comm_id: null, handoff_payload: null,
        result: {
          salesOrder: {
            customer: { name: "Test Buyer Ltd", delivery_date: "2026-10-30", contact_name: "Buyer Desk", phone: "+91 00000 11111" },
            lineItems: lines(),
            grandTotal: 5710.5,
          },
        },
      },
      {
        id: ORDER_T2, tenant_id: T2, status: "DRAFT", po_number: "PO-T2-1", payload_hash: "hash-t2",
        handoff_status: null, rule_findings: [], result: { salesOrder: { lineItems: lines() } },
      },
    ],
    customers: [{ id: CUSTOMER, tenant_id: T1, customer_name: "Test Buyer Ltd" }],
    customer_contacts: [],
    tenant_members: [
      { tenant_id: T1, user_id: OPERATOR, role: "operator", status: "approved" },
    ],
    documents: [
      { id: PO_DOC, tenant_id: T1, filename: "po.pdf", mime_type: "application/pdf", storage_bucket: "documents", storage_path: "t1/po.pdf", scan_status: "clean" },
    ],
    order_documents: [],
    order_schedule_lines: [],
    order_term_checks: [],
    order_term_flags: [],
    order_term_decisions: [],
    communications: [],
    audit_events: [],
    processing_events: [],
  },
});

// A PostgREST-shaped builder over H.store. Every statement records the
// filters it ran with in H.writes (writes) so a test can check tenancy.
export const makeSvc = (H) => ({
  auth: { admin: { getUserById: async (id) => ({ data: { user: H.users[id] || null }, error: null }) } },
  storage: {
    from: () => ({
      download: async () => ({ data: { arrayBuffer: async () => new TextEncoder().encode("%PDF original po").buffer }, error: null }),
    }),
  },
  from(table) {
    if (!H.store[table]) H.store[table] = [];
    const st = { mode: "select", filters: [], cols: [], row: null, limit: null, single: null, after: null };
    const run = () => {
      const ds = H.store[table];
      const hit = () => ds.filter((r) => st.filters.every((f) => f.pred(r)));
      let out;
      if (st.mode === "insert") {
        const rows = (Array.isArray(st.row) ? st.row : [st.row]).map((r) => {
          H.seq += 1;
          return { id: r.id || "f0000000-0000-4000-8000-" + String(H.seq).padStart(12, "0"), created_at: new Date().toISOString(), ...r };
        });
        ds.push(...rows);
        H.writes.push({ table, mode: "insert", rows: rows.map((r) => ({ ...r })) });
        out = rows;
      } else if (st.mode === "update") {
        out = hit();
        for (const r of out) Object.assign(r, st.row);
        H.writes.push({ table, mode: "update", patch: { ...st.row }, filters: st.filters.map((f) => f.desc), count: out.length });
      } else {
        out = hit();
      }
      if (st.limit != null) out = out.slice(0, st.limit);
      out = out.map((r) => JSON.parse(JSON.stringify(r)));
      if (st.single) return { data: out[0] || null, error: st.single === "one" && !out[0] ? { message: "no rows" } : null };
      return { data: out, error: null };
    };
    const add = (desc, pred) => { st.filters.push({ desc, pred }); return b; };
    const b = {
      select(cols) { if (st.mode === "select") st.cols = cols; return b; },
      eq(c, v) { return add(c + "=" + v, (r) => r[c] === v); },
      neq(c, v) { return add(c + "!=" + v, (r) => r[c] != null && r[c] !== v); },
      in(c, vs) { return add(c + " in", (r) => vs.includes(r[c])); },
      is(c, v) { return add(c + " is " + v, (r) => (v === null ? r[c] == null : r[c] === v)); },
      order() { return b; },
      limit(n) { st.limit = n; return b; },
      range(a, z) { st.limit = z - a + 1; return b; },
      insert(row) { st.mode = "insert"; st.row = row; return b; },
      update(row) { st.mode = "update"; st.row = row; return b; },
      maybeSingle() { st.single = "maybe"; return Promise.resolve(run()); },
      single() { st.single = "one"; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  },
});

// The mailer the send core calls: ok, not configured, or a provider refusal.
export const fakeSendEmail = (H) => async (msg) => {
  H.mail.push(msg);
  if (H.mailer === "off") return { ok: false, provider: null, skipped: true, reason: "not_configured" };
  if (H.mailer === "fail") return { ok: false, provider: "brevo", status: 500, detail: "provider down" };
  return { ok: true, provider: "brevo", status: 201, detail: "" };
};

// Graph's two calls: create the draft, then send it.
export const fakeFetch = (H) => async (url, init = {}) => {
  H.fetches.push({ url, body: init.body ? JSON.parse(init.body) : null });
  if (/\/send$/.test(url)) return { ok: true, status: 202, text: async () => "" };
  return { ok: true, status: 201, text: async () => JSON.stringify({ id: "draft-1", conversationId: "conv-1", internetMessageId: "<m1@example.com>" }) };
};

export const asEngineer = (H, extra = {}) => {
  // ctx.userId is set to a different id on purpose: the actor must be
  // ctx.user.id.
  H.ctx = { user: H.users[ENGINEER], userId: "not-the-actor", tenantId: T1, role: "sales_engineer", anonymous: false, ...extra };
};

export const settingsOf = (H, tenantId = T1) => H.store.tenant_settings.find((r) => r.tenant_id === tenantId);
export const orderOf = (H, id = ORDER) => H.store.orders.find((r) => r.id === id);
export const handoffComms = (H) => H.store.communications.filter((c) => c.document_type === "order_handoff");

// Call the real router.
export const callRoute = async (dispatch, method, { query = {}, body = null } = {}) => {
  const qs = new URLSearchParams(query).toString();
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await dispatch({ method, headers: {}, url: "/api/orders/handoff" + (qs ? "?" + qs : ""), query, body: body || {} }, res);
  return { status: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};
