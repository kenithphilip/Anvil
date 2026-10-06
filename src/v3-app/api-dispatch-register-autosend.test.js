// P3 auto-send: maybeAutoSendDispatchRegister gates an OUTWARD customer email.
// These assert the guardrails — OFF by default, only when configured, stricter
// recipients, send-once-per-order, best-effort — the pure register builder is
// mocked so only the gating logic is under test.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/_lib/mailer.js", () => ({ emailConfigured: vi.fn(() => true) }));
vi.mock("../api/_lib/graph-client.js", () => ({ graphIsConnected: vi.fn(() => false) }));
vi.mock("../api/_lib/comms-send.js", () => ({ sendCommunication: vi.fn(async () => ({ communication: { status: "sent" } })) }));
vi.mock("../api/_lib/comms-routing.js", () => ({
  resolveForCustomer: vi.fn(async () => ({ to: ["stores@acme.com"], cc: ["accounts@acme.com"], bcc: [], unresolved: false, fallback_used: null })),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../api/_lib/dispatch-register.js", () => ({
  buildDispatchRegister: vi.fn(() => ({ po_number: "PO-1", lines: [{ part_no: "X" }], summary: { line_count: 1, dispatched_line_count: 1 } })),
  renderDispatchRegisterText: vi.fn(() => "dispatch register body"),
  dispatchRegisterSubject: vi.fn(() => "Dispatch register: PO-1"),
  isDispatchRegisterEmpty: vi.fn((r) => !r || !Array.isArray(r.lines) || r.lines.length === 0),
  extractPoLines: vi.fn(() => []),
}));

const { emailConfigured } = await import("../api/_lib/mailer.js");
const { sendCommunication } = await import("../api/_lib/comms-send.js");
const { resolveForCustomer } = await import("../api/_lib/comms-routing.js");
const { isDispatchRegisterEmpty } = await import("../api/_lib/dispatch-register.js");
const { maybeAutoSendDispatchRegister } = await import("../api/_lib/dispatch-register-send.js");

const makeSvc = (store) => ({
  from(table) {
    const rows = () => store[table] || [];
    const q = {
      _f: [], _mode: null, _payload: null,
      select() { return this; },
      eq(c, v) { this._f.push((r) => r[c] === v); return this; },
      order() { return this; },
      limit() { return this; },
      insert(p) { this._mode = "insert"; this._payload = p; return this; },
      _match() { return rows().filter((r) => this._f.every((fn) => fn(r))); },
      _run(single) {
        if (this._mode === "insert") {
          const created = { id: "comm-1", ...this._payload };
          (store[table] = store[table] || []).push(created);
          return { data: single ? created : [created], error: null };
        }
        const hit = this._match();
        return { data: single ? (hit[0] || null) : hit, error: null };
      },
      maybeSingle() { return Promise.resolve(this._run(true)); },
      single() { return Promise.resolve(this._run(true)); },
      then(res, rej) { return Promise.resolve(this._run(false)).then(res, rej); },
    };
    return q;
  },
});

const ctx = { tenantId: "t-1", user: { id: "u1" } };
let store;

const baseStore = (flag) => ({
  tenant_settings: [{ tenant_id: "t-1", dispatch_register_auto_send_enabled: flag }],
  orders: [{ id: "o1", tenant_id: "t-1", customer_id: "c1", result: {} }],
  dispatch_lines: [], shipments: [],
  customers: [{ id: "c1", tenant_id: "t-1", customer_name: "Acme" }],
  invoices: [], einvoices: [], communications: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(emailConfigured).mockReturnValue(true);
  vi.mocked(resolveForCustomer).mockResolvedValue({ to: ["stores@acme.com"], cc: ["accounts@acme.com"], bcc: [], unresolved: false, fallback_used: null });
  vi.mocked(isDispatchRegisterEmpty).mockImplementation((r) => !r || !Array.isArray(r.lines) || r.lines.length === 0);
  store = baseStore(true);
});

describe("maybeAutoSendDispatchRegister guardrails", () => {
  it("is OFF by default — flag false skips and never sends", async () => {
    store = baseStore(false);
    const r = await maybeAutoSendDispatchRegister(makeSvc(store), ctx, "o1");
    expect(r.skipped).toBe("flag_off");
    expect(sendCommunication).not.toHaveBeenCalled();
  });

  it("skips when the mailer is not configured (and no Graph)", async () => {
    vi.mocked(emailConfigured).mockReturnValue(false);
    const r = await maybeAutoSendDispatchRegister(makeSvc(store), ctx, "o1");
    expect(r.skipped).toBe("not_configured");
    expect(sendCommunication).not.toHaveBeenCalled();
  });

  it("flag on + configured + resolved + no prior → drafts and sends", async () => {
    const r = await maybeAutoSendDispatchRegister(makeSvc(store), ctx, "o1");
    expect(r.sent).toBe(true);
    expect(sendCommunication).toHaveBeenCalledTimes(1);
    expect(sendCommunication).toHaveBeenCalledWith(expect.anything(), ctx, "comm-1");
    // a dispatch_register comm was drafted for the order
    expect(store.communications.some((c) => c.document_type === "dispatch_register" && c.order_id === "o1")).toBe(true);
  });

  it("sends once per order — a prior sent register is not re-sent", async () => {
    store.communications.push({ id: "old", tenant_id: "t-1", order_id: "o1", document_type: "dispatch_register", status: "sent" });
    const r = await maybeAutoSendDispatchRegister(makeSvc(store), ctx, "o1");
    expect(r.skipped).toBe("already_sent");
    expect(sendCommunication).not.toHaveBeenCalled();
  });

  it("does not send into the operator fallback — unresolved routing skips", async () => {
    vi.mocked(resolveForCustomer).mockResolvedValue({ to: [], cc: [], bcc: [], unresolved: true, fallback_used: "operator" });
    const r = await maybeAutoSendDispatchRegister(makeSvc(store), ctx, "o1");
    expect(r.skipped).toBe("recipient_unresolved");
    expect(sendCommunication).not.toHaveBeenCalled();
  });

  it("skips when nothing has been despatched (empty register)", async () => {
    vi.mocked(isDispatchRegisterEmpty).mockReturnValue(true);
    const r = await maybeAutoSendDispatchRegister(makeSvc(store), ctx, "o1");
    expect(r.skipped).toBe("nothing_despatched");
    expect(sendCommunication).not.toHaveBeenCalled();
  });

  it("skips a missing order id", async () => {
    const r = await maybeAutoSendDispatchRegister(makeSvc(store), ctx, null);
    expect(r.skipped).toBe("no_order");
  });
});
