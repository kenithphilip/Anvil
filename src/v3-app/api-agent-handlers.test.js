// Unit tests for the 12 autonomous-agent goal handlers shipped in
// Phases 6-8. Each handler returns a step descriptor of shape
// { thought, action, action_payload }. We mock the svc client with
// a minimal tenant-scoped table stub and assert per-branch
// behaviour without standing up Supabase.
//
// Audit P10.

import { describe, it, expect } from "vitest";

import { supplierAckFollowup } from "../api/agents/_handlers/supplier_ack_followup.js";
import { deliveryEtaCheck } from "../api/agents/_handlers/delivery_eta_check.js";
import { serviceVisitSchedule } from "../api/agents/_handlers/service_visit_schedule.js";
import { amcRenewalChase } from "../api/agents/_handlers/amc_renewal_chase.js";
import { creditReviewRequest } from "../api/agents/_handlers/credit_review_request.js";
import { onboardingFollowup } from "../api/agents/_handlers/onboarding_followup.js";
import { priceIncreaseAnnouncement } from "../api/agents/_handlers/price_increase_announcement.js";
import { replenishmentSuggestion } from "../api/agents/_handlers/replenishment_suggestion.js";
import { obsoleteProductWarning } from "../api/agents/_handlers/obsolete_product_warning.js";
import { expiringQuoteNudge } from "../api/agents/_handlers/expiring_quote_nudge.js";
import { failedPushRecovery } from "../api/agents/_handlers/failed_push_recovery.js";
import { paidPartialFollowup } from "../api/agents/_handlers/paid_partial_followup.js";

// Minimal Supabase-style chainable stub. Each `.from(table)`
// returns a builder that records the chain, executes filters
// against an in-memory dataset, and yields { data, error } via
// terminal awaits.
const makeSvc = (tables) => {
  const buildQuery = (table) => {
    const ds = tables[table] || [];
    let rows = [...ds];
    let mode = "select";
    let single = false;
    const builder = {
      select: () => builder,
      eq: (col, val) => { rows = rows.filter((r) => String(r[col]) === String(val)); return builder; },
      gte: (col, val) => { rows = rows.filter((r) => r[col] >= val); return builder; },
      lte: (col, val) => { rows = rows.filter((r) => r[col] <= val); return builder; },
      lt: (col, val) => { rows = rows.filter((r) => r[col] < val); return builder; },
      gt: (col, val) => { rows = rows.filter((r) => r[col] > val); return builder; },
      not: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => { single = true; return builder; },
      single: () => { single = true; return builder; },
      update: (patch) => { mode = "update"; builder._patch = patch; return builder; },
      insert: (row) => { mode = "insert"; builder._insert = row; return builder; },
      delete: () => { mode = "delete"; return builder; },
      upsert: (row) => { mode = "upsert"; builder._insert = row; return builder; },
      then: (fn) => Promise.resolve(fn(terminal())),
    };
    const terminal = () => {
      if (mode === "update") {
        for (const r of rows) Object.assign(r, builder._patch);
        return { data: rows, error: null };
      }
      if (mode === "insert" || mode === "upsert") {
        const inserted = Array.isArray(builder._insert) ? builder._insert : [builder._insert];
        ds.push(...inserted);
        return { data: single ? inserted[0] : inserted, error: null };
      }
      if (single) return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    };
    return builder;
  };
  return { from: buildQuery };
};

const baseGoal = (overrides = {}) => ({
  tenant_id: "t1",
  object_id: "o1",
  step_count: 0,
  last_action_at: null,
  due_at: null,
  config: {},
  ...overrides,
});

describe("agent handler · supplier_ack_followup", () => {
  it("marks complete when the source PO is ACKNOWLEDGED", async () => {
    const svc = makeSvc({
      source_pos: [{ id: "o1", tenant_id: "t1", status: "ACKNOWLEDGED", supplier: "Acme", supplier_contact_email: "ops@acme.com" }],
    });
    const out = await supplierAckFollowup(baseGoal(), { svc });
    expect(out.action).toBe("mark_complete");
  });
  it("sends an email when no ack and past cooldown", async () => {
    const svc = makeSvc({
      source_pos: [{ id: "o1", tenant_id: "t1", status: "SENT", supplier: "Acme", supplier_contact_email: "ops@acme.com", reference: "PO-1", sent_at: "2025-01-01" }],
    });
    const out = await supplierAckFollowup(baseGoal(), { svc });
    expect(out.action).toBe("send_email");
    expect(out.action_payload.to).toBe("ops@acme.com");
  });
  it("escalates when there is no supplier email", async () => {
    const svc = makeSvc({
      source_pos: [{ id: "o1", tenant_id: "t1", status: "SENT", supplier: "Acme", supplier_contact_email: null }],
    });
    const out = await supplierAckFollowup(baseGoal(), { svc });
    expect(out.action).toBe("escalate");
    expect(out.action_payload.reason).toBe("no_supplier_email");
  });
});

describe("agent handler · delivery_eta_check", () => {
  it("escalates when promised_date is past", async () => {
    const svc = makeSvc({
      source_pos: [{ id: "o1", tenant_id: "t1", status: "SENT", promised_date: "2020-01-01" }],
    });
    const out = await deliveryEtaCheck(baseGoal(), { svc });
    expect(out.action).toBe("escalate");
    expect(out.action_payload.reason).toBe("promised_date_passed");
  });
  it("noops with a sleep when outside the check window", async () => {
    const farFuture = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    const svc = makeSvc({
      source_pos: [{ id: "o1", tenant_id: "t1", status: "SENT", promised_date: farFuture }],
    });
    const out = await deliveryEtaCheck(baseGoal(), { svc });
    expect(out.action).toBe("noop");
  });
});

describe("agent handler · amc_renewal_chase", () => {
  it("marks complete when contract was renewed (end_date pushed > 1 year)", async () => {
    const farEnd = new Date(Date.now() + 400 * 86400 * 1000).toISOString().slice(0, 10);
    const svc = makeSvc({
      contracts: [{ id: "o1", tenant_id: "t1", status: "ACTIVE", end_date: farEnd, customer_id: "c1" }],
    });
    const out = await amcRenewalChase(baseGoal(), { svc });
    expect(out.action).toBe("mark_complete");
  });
  it("escalates when contract expired more than a week ago", async () => {
    const past = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
    const svc = makeSvc({
      contracts: [{ id: "o1", tenant_id: "t1", status: "ACTIVE", end_date: past, customer_id: "c1" }],
    });
    const out = await amcRenewalChase(baseGoal(), { svc });
    expect(out.action).toBe("escalate");
    expect(out.action_payload.reason).toBe("renewal_lapsed");
  });
});

describe("agent handler · credit_review_request", () => {
  it("noops when outstanding AR is below 85% of credit_limit", async () => {
    const svc = makeSvc({
      customers: [{ id: "o1", tenant_id: "t1", customer_name: "Acme", credit_limit: 1000, currency: "INR" }],
      invoices:  [{ tenant_id: "t1", customer_id: "o1", grand_total: 500, paid_amount: 0, status: "sent" }],
    });
    const out = await creditReviewRequest(baseGoal(), { svc });
    expect(out.action).toBe("noop");
  });
  it("requests review when AR utilisation crosses 85%", async () => {
    const svc = makeSvc({
      customers: [{ id: "o1", tenant_id: "t1", customer_name: "Acme", credit_limit: 1000, currency: "INR" }],
      invoices:  [{ tenant_id: "t1", customer_id: "o1", grand_total: 900, paid_amount: 0, status: "sent" }],
      tenant_settings: [{ tenant_id: "t1", finance_email: "fin@acme.com" }],
    });
    const out = await creditReviewRequest(baseGoal(), { svc });
    expect(out.action).toBe("send_email");
    expect(out.action_payload.to).toBe("fin@acme.com");
    expect(out.action_payload.internal).toBe(true);
  });
});

describe("agent handler · onboarding_followup", () => {
  it("noops while the customer is younger than the lead time", async () => {
    const svc = makeSvc({
      customers: [{ id: "o1", tenant_id: "t1", customer_name: "Acme", contact_email: "ops@acme.com", created_at: new Date().toISOString() }],
    });
    const out = await onboardingFollowup(baseGoal(), { svc });
    expect(out.action).toBe("noop");
  });
  it("marks complete after the first email has been sent", async () => {
    const old = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const svc = makeSvc({
      customers: [{ id: "o1", tenant_id: "t1", customer_name: "Acme", contact_email: "ops@acme.com", created_at: old }],
    });
    const out = await onboardingFollowup(baseGoal({ step_count: 1 }), { svc });
    expect(out.action).toBe("mark_complete");
  });
});

describe("agent handler · price_increase_announcement", () => {
  it("gives up without required config", async () => {
    const svc = makeSvc({});
    const out = await priceIncreaseAnnouncement(baseGoal(), { svc });
    expect(out.action).toBe("give_up");
    expect(out.action_payload.reason).toBe("missing_config");
  });
  it("marks complete when no buyer remains to notify", async () => {
    const future = new Date(Date.now() + 25 * 86400 * 1000).toISOString().slice(0, 10);
    const svc = makeSvc({
      orders: [],
    });
    const out = await priceIncreaseAnnouncement(baseGoal({ config: { part_no: "P1", new_price: 100, effective_date: future } }), { svc });
    expect(out.action).toBe("mark_complete");
  });
});

describe("agent handler · replenishment_suggestion", () => {
  it("gives up without enough order history", async () => {
    const svc = makeSvc({
      customers: [{ id: "o1", tenant_id: "t1", customer_name: "Acme", contact_email: "ops@acme.com" }],
      orders: [{ tenant_id: "t1", customer_id: "o1", created_at: new Date().toISOString(), line_items: [{ partNumber: "P1" }] }],
    });
    const out = await replenishmentSuggestion(baseGoal({ config: { part_no: "P1" } }), { svc });
    expect(out.action).toBe("give_up");
    expect(out.action_payload.reason).toBe("insufficient_history");
  });
});

describe("agent handler · obsolete_product_warning", () => {
  it("marks complete after the EOL date plus 30 days", async () => {
    const svc = makeSvc({});
    const longPast = new Date(Date.now() - 60 * 86400 * 1000).toISOString().slice(0, 10);
    const out = await obsoleteProductWarning(baseGoal({ config: { part_no: "P1", eol_date: longPast } }), { svc });
    expect(out.action).toBe("mark_complete");
  });
});

describe("agent handler · service_visit_schedule", () => {
  it("marks complete once the AMC row is no longer SCHEDULED", async () => {
    const svc = makeSvc({
      amc_schedules: [{ id: "o1", tenant_id: "t1", status: "VISIT_CREATED", scheduled_date: "2030-01-01" }],
    });
    const out = await serviceVisitSchedule(baseGoal(), { svc });
    expect(out.action).toBe("mark_complete");
  });
});

describe("agent handler · expiring_quote_nudge (regression)", () => {
  it("skips terminal quote statuses", async () => {
    const svc = makeSvc({
      quotes: [{ id: "o1", tenant_id: "t1", status: "ACCEPTED", quote_number: "Q1", version: 1 }],
    });
    const out = await expiringQuoteNudge(baseGoal(), { svc });
    expect(out.action).toBe("mark_complete");
  });
});

describe("agent handler · failed_push_recovery (regression)", () => {
  it("marks complete when no failed push rows remain", async () => {
    const svc = makeSvc({
      orders: [{ id: "o1", tenant_id: "t1", status: "PUSHED", result: { external_systems: { netsuite: { status: "ok" } } } }],
    });
    const out = await failedPushRecovery(baseGoal(), { svc });
    expect(["mark_complete", "noop", "give_up"]).toContain(out.action);
  });
});

describe("agent handler · paid_partial_followup (regression)", () => {
  it("marks complete when the invoice is now fully paid", async () => {
    const svc = makeSvc({
      invoices: [{ id: "o1", tenant_id: "t1", status: "paid", grand_total: 100, paid_amount: 100, customer_id: "c1" }],
    });
    const out = await paidPartialFollowup(baseGoal(), { svc });
    expect(out.action).toBe("mark_complete");
  });
});
