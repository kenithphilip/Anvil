// The opportunity detail card moves a stage, assigns an owner and records a
// lost reason.
//
// The backend stub here is wired to the REAL handlers (sales/opportunities,
// admin/lost_reasons, admin/members) over an in-memory Supabase, and turns a
// non-2xx reply into the same thrown error the real client throws (message,
// status, body). So the 409 the card shows is the 409 the server sends, and a
// change is checked in the database, not in a spy. auth.js is real except for
// resolveContext. Every name and id here is invented.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitFor, fireEvent, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";
import { createMemoryDb, callHandler } from "../test-memory-supabase";

const H = vi.hoisted(() => ({ db: null as any, ctx: null as any }));

vi.mock("../../api/_lib/auth.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
vi.mock("../../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));

// Imported once, here, so a cold import of the screen and three handlers on a
// busy machine is not charged to the first test's timeout.
const handlers = {
  opps: (await import("../../api/sales/opportunities.js")).default,
  lost: (await import("../../api/admin/lost_reasons.js")).default,
  members: (await import("../../api/admin/members.js")).default,
};
const { default: Opps } = await import("./opps");

const T1 = "10000000-0000-4000-8000-000000000001";
const u = (n: string) => "00000000-0000-4000-8000-0000000000" + n;
const MGR = u("a1"), REP = u("a2"), REP2 = u("a3"), GONE = u("a4");
const O_MINE = u("c3"), O_UNOWNED = u("c2"), O_OWNED = u("c1");

const opp = (id: string, over: any) => ({
  id, tenant_id: T1, customer_id: u("d1"), stage: "RFQ", owner_id: null, lost_reason: null,
  amount_inr: 100000, probability: 50, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...over,
});

let patchCalls = 0;
const mount = async (role: string, oppId: string, me: string, serverRole = role) => {
  H.ctx = { user: { id: me }, tenantId: T1, role: serverRole };
  installRbac(role);
  // What anvil-client's handleResponse does with a reply.
  const call = async (h: any, init: any) => {
    const r = await callHandler(h, init);
    if (r.status >= 400) {
      const err: any = new Error(r.body?.error?.message || "HTTP " + r.status);
      err.status = r.status;
      err.body = r.body;
      throw err;
    }
    return r.body;
  };
  installBackend({
    getSession: () => ({ user: { id: me } }),
    sales: {
      listOpportunities: () => call(handlers.opps, {}),
      updateOpportunity: (body: any) => { patchCalls += 1; return call(handlers.opps, { method: "PATCH", body }); },
    },
    admin: {
      listLostReasons: () => call(handlers.lost, {}),
      listMembers: () => call(handlers.members, {}),
    },
  });
  window.location.hash = "#/opps?id=" + oppId;
  const r = renderScreen(Opps);
  const card = await waitFor(() => r.getByTestId("opportunity-stage-owner"));
  return { ...r, card: within(card) };
};
const row = (id: string) => H.db.tables.opportunities.find((o: any) => o.id === id);
const selectOptions = (el: HTMLElement) => Array.from((el as HTMLSelectElement).options).map((o) => o.textContent);

beforeEach(() => {
  patchCalls = 0;
  H.db = createMemoryDb({
    customers: [{ id: u("d1"), tenant_id: T1, customer_name: "Fixture Axle Works" }],
    tenant_members: [
      { tenant_id: T1, user_id: MGR, role: "sales_manager", status: "approved" },
      { tenant_id: T1, user_id: REP, role: "sales_engineer", status: "approved" },
      { tenant_id: T1, user_id: REP2, role: "sales_engineer", status: "approved" },
      { tenant_id: T1, user_id: GONE, role: "sales_engineer", status: "deactivated" },
    ],
    opportunities: [
      opp(O_MINE, { opportunity_name: "Line 4 retrofit", owner_id: REP }),
      opp(O_UNOWNED, { opportunity_name: "Weld gun spares", stage: "QUALIFICATION" }),
      opp(O_OWNED, { opportunity_name: "Press line cell", owner_id: REP2 }),
    ],
    lost_reason_taxonomy: [
      { id: "lr-1", tenant_id: null, code: "PRICE_HIGH", label: "Quoted price too high", category: "price", active: true },
      { id: "lr-2", tenant_id: null, code: "LEAD_TIME", label: "Lead time too long", category: "lead_time", active: true },
      { id: "lr-3", tenant_id: T1, code: "TOOLING_SLOT", label: "Missed the tooling slot", category: "other", active: true },
      { id: "lr-4", tenant_id: T1, code: "LEAD_TIME", label: "Lead time too long", category: "lead_time", active: false },
    ],
    audit_events: [],
    opportunity_stage_events: [],
  }, {
    [MGR]: { id: MGR, email: "mgr@fixture.test", user_metadata: { name: "Asha Manager" } },
    [REP]: { id: REP, email: "rep@fixture.test", user_metadata: { name: "Ravi Rep" } },
    [REP2]: { id: REP2, email: "rep2@fixture.test", user_metadata: { name: "Meera Rep" } },
    [GONE]: { id: GONE, email: "gone@fixture.test", user_metadata: { name: "Former Rep" } },
  });
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => { window.location.hash = ""; vi.unstubAllGlobals(); });

describe("the stage control", () => {
  it("moves the stage through the API and the card shows the new stage", async () => {
    const { card, container } = await mount("sales_engineer", O_MINE, REP);
    fireEvent.change(card.getByLabelText("Opportunity stage"), { target: { value: "PROPOSAL_PRICE_QUOTE" } });
    fireEvent.click(card.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(row(O_MINE).stage).toBe("PROPOSAL_PRICE_QUOTE"));
    expect(H.db.tables.opportunity_stage_events).toEqual([
      expect.objectContaining({ opportunity_id: O_MINE, from_stage: "RFQ", to_stage: "PROPOSAL_PRICE_QUOTE" }),
    ]);
    // The list reloads, so the card reads the saved stage back.
    await waitFor(() => expect((card.getByLabelText("Opportunity stage") as HTMLSelectElement).value).toBe("PROPOSAL_PRICE_QUOTE"));
    expect(card.getByRole("button", { name: "Move" })).toHaveProperty("disabled", true);
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("shows the server's 409 with both stages, and nothing changes", async () => {
    const { card } = await mount("sales_engineer", O_MINE, REP);
    fireEvent.change(card.getByLabelText("Opportunity stage"), { target: { value: "STRATEGY_CHECK" } });
    fireEvent.click(card.getByRole("button", { name: "Move" }));
    const alert = await waitFor(() => card.getByRole("alert"));
    expect(alert.textContent).toContain("This stage move is not allowed");
    expect(alert.textContent).toContain("Cannot move from RFQ to Strategy check.");
    expect(row(O_MINE).stage).toBe("RFQ");
    expect(H.db.tables.opportunity_stage_events).toEqual([]);
  });
});

describe("the lost-reason picker", () => {
  it("offers this tenant's usable reasons and will not move to lost without one", async () => {
    const { card } = await mount("sales_engineer", O_MINE, REP);
    fireEvent.change(card.getByLabelText("Opportunity stage"), { target: { value: "CLOSE_LOST" } });
    const picker = await waitFor(() => card.getByLabelText("Lost reason"));
    await waitFor(() => expect(selectOptions(picker)).toEqual([
      "Pick a lost reason", "Missed the tooling slot", "Quoted price too high",
    ]));
    fireEvent.click(card.getByRole("button", { name: "Move" }));
    expect((await waitFor(() => card.getByRole("alert"))).textContent).toContain("Pick a lost reason");
    expect(patchCalls).toBe(0);
    expect(row(O_MINE).stage).toBe("RFQ");

    fireEvent.change(picker, { target: { value: "PRICE_HIGH" } });
    fireEvent.click(card.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(row(O_MINE)).toMatchObject({ stage: "CLOSE_LOST", lost_reason: "PRICE_HIGH" }));
    await waitFor(() => expect(card.getByTestId("opportunity-lost-reason").textContent).toBe("Quoted price too high"));
  });
});

describe("the owner control", () => {
  it("lets a manager reassign to an approved member", async () => {
    const { card } = await mount("sales_manager", O_OWNED, MGR);
    const picker = card.getByLabelText("Opportunity owner");
    await waitFor(() => expect(selectOptions(picker)).toEqual(["Unassigned", "Asha Manager", "Meera Rep", "Ravi Rep"]));
    fireEvent.change(picker, { target: { value: REP } });
    fireEvent.click(card.getByRole("button", { name: "Save owner" }));
    await waitFor(() => expect(row(O_OWNED).owner_id).toBe(REP));
    await waitFor(() => expect(card.getByTestId("opportunity-owner-name").textContent).toBe("Ravi Rep"));
  });

  it("shows the server's refusal when the client thinks it may reassign but the server does not", async () => {
    // A role cached in the browser that the server no longer grants.
    const { card } = await mount("sales_manager", O_OWNED, REP, "sales_engineer");
    const picker = card.getByLabelText("Opportunity owner");
    await waitFor(() => expect(selectOptions(picker)).toContain("Ravi Rep"));
    fireEvent.change(picker, { target: { value: REP } });
    fireEvent.click(card.getByRole("button", { name: "Save owner" }));
    expect((await waitFor(() => card.getByRole("alert"))).textContent)
      .toBe("Only a sales manager or admin can reassign an opportunity.");
    expect(row(O_OWNED).owner_id).toBe(REP2);
  });

  it("lets a sales engineer claim an unowned opportunity, and offers no picker", async () => {
    const { card } = await mount("sales_engineer", O_UNOWNED, REP);
    expect(card.queryByLabelText("Opportunity owner")).toBeNull();
    fireEvent.click(card.getByRole("button", { name: "Claim" }));
    await waitFor(() => expect(row(O_UNOWNED).owner_id).toBe(REP));
    await waitFor(() => expect(card.getByTestId("opportunity-owner-name").textContent).toBe("Ravi Rep"));
  });

  it("offers a sales engineer nothing to change on someone else's opportunity", async () => {
    const { card } = await mount("sales_engineer", O_OWNED, REP);
    expect(card.getByTestId("opportunity-owner-name").textContent).toBe("Meera Rep");
    expect(card.queryByLabelText("Opportunity owner")).toBeNull();
    expect(card.queryByRole("button", { name: "Claim" })).toBeNull();
    expect(card.getByText("A sales manager or admin reassigns opportunities.")).toBeTruthy();
  });
});
