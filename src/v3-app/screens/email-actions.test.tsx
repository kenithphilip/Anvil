// EA-7: the Email Actions screen. The dashboard, the manager tab gate, the
// detail with facts and inferences apart and its controls, the mailboxes and
// the rules views, and the hash filters. The backend is a stub; the server's
// rules are tested in the api-email-*.test.js files.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const action = (extra: Record<string, any> = {}) => ({
  id: "ea-1", work_item_id: "wi-1", version: 3, title: "Investigate: Legal notice on PO 4501",
  status: "pending", status_category: "todo", overdue: false, escalated: false, escalation_level: 0,
  priority: 2, priority_label: "high", due_at: iso(NOW + 3_600_000), due_source: "sla", due_timezone: "Asia/Kolkata",
  assignee_user_id: "u1", assignee_name: "Owner One", backup_user_id: null, account_id: "c1", customer_name: "Customer One",
  order_id: "o1", po_number: "4501", action_type: "investigate", requirement: "manual", business_status: "awaiting_internal",
  consequence: "The customer relationship is at risk.", from_address: "buyer@customer.example", subject: "Legal notice",
  to_addresses: ["rep@seller.example"], cc_addresses: [], received_at: iso(NOW - 3_600_000), web_link: "https://outlook.example/1",
  reasons: [
    { kind: "fact", code: "known_contact", text: "The sender is a contact of the customer." },
    { kind: "inferred", code: "priority", text: "Priority high." },
  ],
  ...extra,
});

const stub = (over: Record<string, any> = {}) => {
  const api = {
    list: vi.fn(async (p: any) => (p?.state === "closed"
      ? { actions: [action({ id: "ea-9", title: "Reply: done one", status: "performed", status_category: "done", completed_at: iso(NOW - 3_600_000), business_status: "awaiting_external" })] }
      : { actions: [action({ priority_label: "critical", overdue: true, title: "Investigate: overdue critical" }), action({ id: "ea-2", title: "Reply: no owner", assignee_user_id: null, assignee_name: null, priority_label: "critical" })] })),
    get: vi.fn(async () => ({
      action: action(),
      evidence: [{ id: "ev-1", kind: "outgoing", method: "conversation_only", status: "ambiguous", confidence: "low", recipients: ["buyer@customer.example"], created_at: iso(NOW) }],
      history: [{ action: "email_action_detected", created_at: iso(NOW - 3_600_000) }],
    })),
    update: vi.fn(async () => ({ ok: true })),
    recordEvidence: vi.fn(async () => ({ ok: true })),
    decideEvidence: vi.fn(async () => ({ ok: true })),
    mailboxes: vi.fn(async () => ({
      enabled: true, actions_mode: "observe", providers: { outlook: true, gmail: false },
      mailboxes: [{ id: "m1", provider: "outlook", address: "rep@seller.example", status: "active", pause_reason: "failures", requests_today: 12, daily_request_budget: 1500, consecutive_failures: 3, last_error: "transient: provider HTTP 503" }],
    })),
    connectMailbox: vi.fn(async () => ({ authorize_url: null })),
    updateMailbox: vi.fn(async () => ({ ok: true })),
    disconnectMailbox: vi.fn(async () => ({ ok: true })),
    rules: vi.fn(async () => ({ rules: [], can_edit_tenant_rules: false })),
    addRule: vi.fn(async () => ({ ok: true })),
    updateRule: vi.fn(async () => ({ ok: true })),
    deleteRule: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  installBackend({ emailActions: api, admin: { listMembers: async () => ({ members: [{ user_id: "u2", display_name: "Second Rep", status: "approved" }] }) } });
  return api;
};

const mount = async (hash: string, role = "sales_engineer", over: Record<string, any> = {}) => {
  window.location.hash = hash;
  installRbac(role);
  const api = stub(over);
  const mod = await import("./email-actions");
  return { api, ...renderScreen(mod.default) };
};

beforeEach(() => {
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("prompt", () => null);
});

describe("dashboard", () => {
  it("shows the KPIs and the critical, overdue and recently performed sections", async () => {
    const { api, findByText, getAllByText } = await mount("#/email-actions");
    expect(await findByText("Critical outstanding")).toBeTruthy();
    expect(getAllByText("Investigate: overdue critical").length).toBeGreaterThan(0);
    expect(getAllByText("Reply: done one").length).toBeGreaterThan(0);
    expect(api.list).toHaveBeenCalledWith({});
    expect(api.list).toHaveBeenCalledWith({ state: "closed" });
  });

  it("a row with no owner says so", async () => {
    const { findAllByText } = await mount("#/email-actions");
    expect((await findAllByText("no owner")).length).toBeGreaterThan(0);
  });
});

describe("manager tab", () => {
  it("is hidden from a sales engineer and shown to a sales manager", async () => {
    const se = await mount("#/email-actions");
    await se.findByText("Critical outstanding");
    expect(se.queryByRole("tab", { name: "Manager" })).toBeNull();
    se.unmount();

    const mgr = await mount("#/email-actions?sub=manager", "sales_manager");
    expect(mgr.getByRole("tab", { name: "Manager" })).toBeTruthy();
    expect(await mgr.findByText("Unassigned critical")).toBeTruthy();
    expect(await mgr.findByText("Workload and completion by owner")).toBeTruthy();
    expect(mgr.getAllByText("Owner One").length).toBeGreaterThan(0);
  });
});

describe("detail", () => {
  it("shows facts and inferences apart, the evidence and the history", async () => {
    const { api, findByText, getByText } = await mount("#/email-actions?id=ea-1");
    expect(await findByText("The sender is a contact of the customer.")).toBeTruthy();
    expect(getByText("Facts")).toBeTruthy();
    expect(getByText("Inferences")).toBeTruthy();
    expect(getByText("Priority high.")).toBeTruthy();
    expect(getByText("ambiguous")).toBeTruthy();
    expect(getByText(/detected/)).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith("ea-1");
  });

  it("start sends the version and the new state", async () => {
    const { api, findByRole } = await mount("#/email-actions?id=ea-1");
    fireEvent.click(await findByRole("button", { name: "start" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("ea-1", { version: 3, status: "in_progress" }));
  });

  it("cancel asks for a reason and sends it; no reason sends nothing", async () => {
    const { api, findByRole } = await mount("#/email-actions?id=ea-1");
    fireEvent.click(await findByRole("button", { name: "cancel" }));
    expect(api.update).not.toHaveBeenCalled();
    vi.stubGlobal("prompt", () => "Handled by phone");
    fireEvent.click(await findByRole("button", { name: "cancel" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith("ea-1", { version: 3, status: "cancelled", reason: "Handled by phone" }));
  });

  it("record evidence sends the note", async () => {
    vi.stubGlobal("prompt", () => "Confirmed by phone with the buyer");
    const { api, findByRole } = await mount("#/email-actions?id=ea-1");
    fireEvent.click(await findByRole("button", { name: "record evidence" }));
    await waitFor(() => expect(api.recordEvidence).toHaveBeenCalledWith("ea-1", { note: "Confirmed by phone with the buyer" }));
  });

  it("only a user with email.verify sees confirm and reject on evidence", async () => {
    const se = await mount("#/email-actions?id=ea-1");
    await se.findByText("ambiguous");
    expect(se.queryByRole("button", { name: "confirm" })).toBeNull();
    se.unmount();

    vi.stubGlobal("prompt", () => "Read the reply; it answers the PO");
    const mgr = await mount("#/email-actions?id=ea-1", "sales_manager");
    fireEvent.click(await mgr.findByRole("button", { name: "confirm" }));
    await waitFor(() => expect(mgr.api.decideEvidence).toHaveBeenCalledWith("ea-1", { evidence_id: "ev-1", decision: "confirm", reason: "Read the reply; it answers the PO" }));
  });

  it("an action the server does not return shows not found", async () => {
    const { findByText } = await mount("#/email-actions?id=nope", "sales_engineer", { get: vi.fn(async () => { throw new Error("404"); }) });
    expect(await findByText("Action not found")).toBeTruthy();
  });
});

describe("mailboxes", () => {
  it("shows observe mode and the health; connect, resume and disconnect call the API", async () => {
    const { api, findByText, getByRole } = await mount("#/email-actions?sub=mailboxes");
    expect(await findByText("Observe mode")).toBeTruthy();
    expect(await findByText("paused: failures")).toBeTruthy();
    expect((getByRole("button", { name: /Gmail/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByRole("button", { name: /Outlook/ }));
    await waitFor(() => expect(api.connectMailbox).toHaveBeenCalledWith("outlook"));
    fireEvent.click(getByRole("button", { name: "resume" }));
    await waitFor(() => expect(api.updateMailbox).toHaveBeenCalledWith({ id: "m1", resume: true }));
    fireEvent.click(getByRole("button", { name: "disconnect" }));
    await waitFor(() => expect(api.disconnectMailbox).toHaveBeenCalledWith("m1"));
  });
});

describe("rules", () => {
  it("adds a rule for my mailboxes; the tenant scope is only offered to an admin", async () => {
    const { api, findByLabelText, getByLabelText, getByRole, queryByRole } = await mount("#/email-actions?sub=rules");
    fireEvent.change(await findByLabelText("Pattern"), { target: { value: "rate contract" } });
    fireEvent.change(getByLabelText("Rule priority"), { target: { value: "high" } });
    expect(queryByRole("option", { name: "whole tenant" })).toBeNull();
    fireEvent.click(getByRole("button", { name: /add/ }));
    await waitFor(() => expect(api.addRule).toHaveBeenCalledWith({ kind: "keyword", pattern: "rate contract", scope: "me", effect: { priority: "high" } }));
  });
});

describe("filters", () => {
  it("a filter goes on the hash and into the list call", async () => {
    const { api, findByLabelText } = await mount("#/email-actions");
    fireEvent.change(await findByLabelText("Priority"), { target: { value: "critical" } });
    expect(window.location.hash).toContain("priority=critical");
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ priority: "critical" }));
  });
});
