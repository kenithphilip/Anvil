// Move, assign and lose an opportunity: PATCH /api/sales/opportunities.
//
// The handler runs for real against an in-memory Supabase. auth.js is the
// REAL module (only resolveContext is overridden), so the opportunity.assign
// gate and its SERVER_ACTIONS entry are exercised, not restated. audit.js,
// assignee.js and funnel-analytics.js are real too: audit rows and stage
// events land in the in-memory tables. Every name and id here is invented.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => ({ db: null, ctx: null }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));

const { default: handler } = await import("../api/sales/opportunities.js");
const { SERVER_ACTIONS } = await import("../api/_lib/auth.js");
const { ACTIONS } = await import("./lib/rbac");

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const u = (n) => "00000000-0000-4000-8000-0000000000" + n;
const MGR = u("a1"), REP = u("a2"), REP2 = u("a3"), GONE = u("a4"), ADMIN = u("a5"), FOREIGN = u("b1");
const O_OWNED = u("c1"), O_UNOWNED = u("c2"), O_MINE = u("c3"), O_LOST = u("c4"), O_WON = u("c5"), O_T2 = u("c9");

const opp = (id, over) => ({
  id, tenant_id: T1, customer_id: u("d1"), opportunity_name: "Fixture deal " + id.slice(-2),
  stage: "RFQ", owner_id: null, lost_reason: null, amount_inr: 100000, probability: 50,
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...over,
});

beforeEach(() => {
  H.db = createMemoryDb({
    tenant_members: [
      { tenant_id: T1, user_id: MGR, role: "sales_manager", status: "approved" },
      { tenant_id: T1, user_id: REP, role: "sales_engineer", status: "approved" },
      { tenant_id: T1, user_id: REP2, role: "sales_engineer", status: "approved" },
      { tenant_id: T1, user_id: ADMIN, role: "admin", status: "approved" },
      { tenant_id: T1, user_id: GONE, role: "sales_engineer", status: "deactivated" },
      { tenant_id: T2, user_id: FOREIGN, role: "sales_engineer", status: "approved" },
    ],
    opportunities: [
      opp(O_OWNED, { owner_id: REP2 }),
      opp(O_UNOWNED, { stage: "QUALIFICATION" }),
      opp(O_MINE, { owner_id: REP }),
      opp(O_LOST, { stage: "CLOSE_LOST", lost_reason: "PRICE_HIGH", owner_id: REP }),
      opp(O_WON, { stage: "CLOSE_WON", owner_id: REP }),
      opp(O_T2, { tenant_id: T2, owner_id: FOREIGN }),
    ],
    lost_reason_taxonomy: [
      { id: "lr-1", tenant_id: null, code: "PRICE_HIGH", label: "Quoted price too high", active: true },
      { id: "lr-2", tenant_id: null, code: "LEAD_TIME", label: "Lead time too long", active: true },
      { id: "lr-3", tenant_id: null, code: "BUDGET_CUT", label: "Customer budget cut", active: true },
      { id: "lr-4", tenant_id: T1, code: "TOOLING_SLOT", label: "Missed the tooling slot", active: true },
      // T1 retired the global LEAD_TIME code.
      { id: "lr-5", tenant_id: T1, code: "LEAD_TIME", label: "Lead time too long", active: false },
      { id: "lr-6", tenant_id: T2, code: "OTHER_TENANT_CODE", label: "Not T1's", active: true },
    ],
    audit_events: [],
    opportunity_stage_events: [],
  });
  H.ctx = null;
});

const as = (userId, role) => { H.ctx = { user: { id: userId }, tenantId: T1, role }; };
const patch = (body) => callHandler(handler, { method: "PATCH", body });
const row = (id) => H.db.tables.opportunities.find((o) => o.id === id);
const audits = (action) => H.db.tables.audit_events.filter((a) => a.action === action);
const stageEvents = (id) => H.db.tables.opportunity_stage_events.filter((e) => e.opportunity_id === id);

describe("owner reassignment", () => {
  it("a sales manager reassigns someone else's opportunity, with an owner-change audit row", async () => {
    as(MGR, "sales_manager");
    const r = await patch({ id: O_OWNED, owner_id: REP });
    expect(r.status).toBe(200);
    expect(r.body.opportunity.owner_id).toBe(REP);
    expect(row(O_OWNED).owner_id).toBe(REP);
    expect(audits("opp_owner_change")).toEqual([
      expect.objectContaining({ object_id: O_OWNED, actor: MGR, before_payload: { owner_id: REP2 }, after_payload: { owner_id: REP } }),
    ]);
    // An owner change is not a stage change: no stage event, so funnel dwell
    // times are not reset by a reassignment.
    expect(stageEvents(O_OWNED)).toEqual([]);
  });

  it("an admin may reassign, and may clear an owner", async () => {
    as(ADMIN, "admin");
    expect((await patch({ id: O_OWNED, owner_id: MGR })).status).toBe(200);
    expect((await patch({ id: O_MINE, owner_id: null })).status).toBe(200);
    expect(row(O_OWNED).owner_id).toBe(MGR);
    expect(row(O_MINE).owner_id).toBeNull();
  });

  it("a sales engineer cannot reassign someone else's opportunity", async () => {
    as(REP, "sales_engineer");
    const r = await patch({ id: O_OWNED, owner_id: REP });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain("opportunity.assign");
    expect(row(O_OWNED).owner_id).toBe(REP2);
    expect(H.db.tables.audit_events).toEqual([]);
  });

  it("a sales engineer cannot give an opportunity away, clear its owner, or hand an unowned one to someone else", async () => {
    as(REP, "sales_engineer");
    expect((await patch({ id: O_MINE, owner_id: REP2 })).status).toBe(403);
    expect((await patch({ id: O_MINE, owner_id: null })).status).toBe(403);
    expect((await patch({ id: O_UNOWNED, owner_id: REP2 })).status).toBe(403);
    expect(row(O_MINE).owner_id).toBe(REP);
    expect(row(O_UNOWNED).owner_id).toBeNull();
  });

  it("a sales engineer may claim an unowned opportunity for themselves", async () => {
    as(REP, "sales_engineer");
    const r = await patch({ id: O_UNOWNED, owner_id: REP });
    expect(r.status).toBe(200);
    expect(row(O_UNOWNED).owner_id).toBe(REP);
    expect(audits("opp_owner_change")).toHaveLength(1);
  });

  it("refuses an owner from another tenant, an inactive member, and a non-id", async () => {
    as(MGR, "sales_manager");
    for (const owner_id of [FOREIGN, GONE, "not-a-user"]) {
      const r = await patch({ id: O_OWNED, owner_id });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("INVALID_OWNER");
    }
    expect(row(O_OWNED).owner_id).toBe(REP2);
    expect(H.db.tables.audit_events).toEqual([]);
  });

  it("leaves the owner alone when owner_id is absent, or unchanged", async () => {
    as(REP, "sales_engineer");
    expect((await patch({ id: O_OWNED, amount_inr: 120000 })).status).toBe(200);
    expect((await patch({ id: O_OWNED, owner_id: REP2 })).status).toBe(200);
    expect(row(O_OWNED)).toMatchObject({ owner_id: REP2, amount_inr: 120000 });
    expect(audits("opp_owner_change")).toEqual([]);
  });

  it("cannot touch another tenant's opportunity", async () => {
    as(MGR, "sales_manager");
    const r = await patch({ id: O_T2, owner_id: MGR, stage: "CLOSE_WON" });
    expect(r.status).toBe(404);
    expect(row(O_T2)).toMatchObject({ owner_id: FOREIGN, stage: "RFQ" });
  });
});

describe("stage moves", () => {
  it("moves forward and writes a stage event with from and to", async () => {
    as(REP, "sales_engineer");
    const r = await patch({ id: O_MINE, stage: "PROPOSAL_PRICE_QUOTE" });
    expect(r.status).toBe(200);
    expect(row(O_MINE).stage).toBe("PROPOSAL_PRICE_QUOTE");
    expect(stageEvents(O_MINE)).toEqual([
      expect.objectContaining({ from_stage: "RFQ", to_stage: "PROPOSAL_PRICE_QUOTE", changed_by: REP, owner_id: REP }),
    ]);
    expect(audits("opp_stage_change")).toHaveLength(1);
  });

  it("refuses an illegal move with 409 and both stages, and changes nothing", async () => {
    as(REP, "sales_engineer");
    const back = await patch({ id: O_MINE, stage: "STRATEGY_CHECK" });
    expect(back.status).toBe(409);
    expect(back.body.error).toMatchObject({ code: "INVALID_STAGE_TRANSITION", from: "RFQ", to: "STRATEGY_CHECK" });
    const reopen = await patch({ id: O_WON, stage: "RFQ" });
    expect(reopen.status).toBe(409);
    expect(reopen.body.error).toMatchObject({ from: "CLOSE_WON", to: "RFQ" });
    expect(row(O_MINE).stage).toBe("RFQ");
    expect(row(O_WON).stage).toBe("CLOSE_WON");
    expect(H.db.tables.opportunity_stage_events).toEqual([]);
  });
});

describe("lost requires a reason", () => {
  it("refuses CLOSE_LOST without a lost_reason", async () => {
    as(REP, "sales_engineer");
    for (const body of [{ id: O_MINE, stage: "CLOSE_LOST" }, { id: O_MINE, stage: "CLOSE_LOST", lost_reason: "  " }]) {
      const r = await patch(body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("LOST_REASON_REQUIRED");
    }
    expect(row(O_MINE).stage).toBe("RFQ");
    expect(stageEvents(O_MINE)).toEqual([]);
  });

  it("stores a global or a tenant code and writes the stage event", async () => {
    as(REP, "sales_engineer");
    expect((await patch({ id: O_MINE, stage: "CLOSE_LOST", lost_reason: "PRICE_HIGH" })).status).toBe(200);
    expect(row(O_MINE)).toMatchObject({ stage: "CLOSE_LOST", lost_reason: "PRICE_HIGH" });
    expect(stageEvents(O_MINE)).toEqual([expect.objectContaining({ from_stage: "RFQ", to_stage: "CLOSE_LOST" })]);
    expect((await patch({ id: O_OWNED, stage: "CLOSE_LOST", lost_reason: "TOOLING_SLOT" })).status).toBe(200);
    expect(row(O_OWNED).lost_reason).toBe("TOOLING_SLOT");
  });

  it("refuses an unknown code, another tenant's code, and a default this tenant retired", async () => {
    as(REP, "sales_engineer");
    for (const lost_reason of ["MADE_UP", "OTHER_TENANT_CODE", "LEAD_TIME", 7]) {
      const r = await patch({ id: O_MINE, stage: "CLOSE_LOST", lost_reason });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("INVALID_LOST_REASON");
    }
    expect(row(O_MINE)).toMatchObject({ stage: "RFQ", lost_reason: null });
  });

  it("will not clear the reason of a lost opportunity, but lets it be changed", async () => {
    as(REP, "sales_engineer");
    const r = await patch({ id: O_LOST, lost_reason: null });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("LOST_REASON_REQUIRED");
    expect(row(O_LOST).lost_reason).toBe("PRICE_HIGH");
    expect((await patch({ id: O_LOST, lost_reason: "BUDGET_CUT" })).status).toBe(200);
    expect(row(O_LOST).lost_reason).toBe("BUDGET_CUT");
  });
});

describe("opportunity.assign is registered on both sides", () => {
  it("names the same roles in SERVER_ACTIONS and rbac.ts ACTIONS (the #547 D2 manager roles)", () => {
    expect(SERVER_ACTIONS["opportunity.assign"]).toBeInstanceOf(Set);
    expect([...SERVER_ACTIONS["opportunity.assign"]].sort()).toEqual(["admin", "sales_manager"]);
    expect([...ACTIONS["opportunity.assign"]].sort()).toEqual(["admin", "sales_manager"]);
  });
});
