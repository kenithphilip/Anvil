// EA-3: the deterministic rules. No LLM, no network, no database.
import { describe, it, expect } from "vitest";
import { classify, exclusionOf, statedDeadline, senderMatches, PRIORITY_RANK } from "../api/_lib/email-accountability/rules.js";
import { addBusinessMinutes } from "../api/_lib/email-accountability/business-time.js";

// Thursday 2026-10-22, 12:00 in India.
const NOW = new Date("2026-10-22T06:30:00Z");
const TZ = "Asia/Kolkata";
const known = { reliable: true, customer_id: "c1", contact_id: "k1", reasons: [{ kind: "fact", code: "known_contact", text: "x" }] };
const unknown = { reliable: false, reasons: [] };
const msg = (extra = {}) => ({
  provider: "outlook", providerId: "p1", internetMessageId: "<m1@mail.example>", direction: "in",
  from: "buyer@customer.example", to: ["rep@seller.example"], cc: [], subject: "", preview: "", ...extra,
});
const ctx = (extra = {}) => ({ now: NOW, timezone: TZ, tenantDomains: new Set(["seller.example"]), rules: [], link: known, ...extra });

describe("phrases", () => {
  const cases = [
    ["Payment overdue for invoice 77", "confirm_payment", "high"],
    ["Please confirm the order", "reply", "high"],
    ["Approval required for the revised drawing", "obtain_approval", "high"],
    ["Documents pending for dispatch", "provide_documents", "high"],
    ["Shipment delayed at port", "investigate", "high"],
    ["Urgent: need the price today", "reply", "critical"],
    ["We will cancel the order", "investigate", "critical"],
  ];
  for (const [subject, type, priority] of cases) {
    it(subject + " -> " + type + ", " + priority, () => {
      const r = classify(msg({ subject }), ctx());
      expect(r.relevant).toBe(true);
      expect(r.priority).toBe(priority);
      expect(r.actions[0].type).toBe(type);
    });
  }

  it("one message can need several actions", () => {
    const r = classify(msg({ subject: "Payment overdue", preview: "Also send the test reports." }), ctx());
    expect(r.actions.map((a) => a.type).sort()).toEqual(["confirm_payment", "provide_documents"]);
  });

  it("'urgent' is high from an unknown sender, and goes to review", () => {
    const r = classify(msg({ subject: "Urgent reply needed" }), ctx({ link: unknown }));
    expect(r).toMatchObject({ relevant: true, priority: "high", review: true });
  });

  it("an escalation from an unknown sender is critical and goes to review, never ignored", () => {
    const r = classify(msg({ from: "someone@new.example", subject: "Legal notice" }), ctx({ link: unknown }));
    expect(r).toMatchObject({ relevant: true, priority: "critical", review: true });
  });
});

describe("what makes no action", () => {
  it("a known contact's request with no phrase is normal; without a request it is nothing", () => {
    expect(classify(msg({ subject: "Can you share the price list?" }), ctx())).toMatchObject({ relevant: true, priority: "normal" });
    expect(classify(msg({ subject: "Thanks for the visit" }), ctx()).relevant).toBe(false);
  });

  it("an unknown sender's request with no phrase is nothing", () => {
    expect(classify(msg({ subject: "Can you send a brochure?" }), ctx({ link: unknown })).relevant).toBe(false);
  });

  const excluded = [
    ["bulk mail", { listUnsubscribe: "<mailto:u@list.example>", subject: "Payment overdue offers" }, "bulk"],
    ["Precedence: bulk", { precedence: "bulk", subject: "Urgent" }, "bulk"],
    ["Auto-Submitted", { autoSubmitted: "auto-replied", subject: "Re: confirm the order" }, "auto_reply"],
    ["out of office", { subject: "Out of Office: urgent matters" }, "auto_reply"],
    ["a no-reply sender", { from: "no-reply@portal.example", subject: "Payment overdue" }, "no_reply"],
    ["an internal sender", { from: "colleague@seller.example", subject: "Urgent: approve" }, "internal"],
  ];
  for (const [name, extra, code] of excluded) {
    it(name + " is excluded", () => {
      const r = classify(msg(extra), ctx());
      expect(r.relevant).toBe(false);
      expect(r.excluded.code).toBe(code);
    });
  }

  it("Auto-Submitted: no is a person's mail", () => {
    expect(exclusionOf(msg({ autoSubmitted: "no" }), ctx())).toBeNull();
  });

  it("an exclusion rule by domain and by phrase", () => {
    const rules = [{ kind: "exclusion", pattern: "@customer.example" }];
    expect(classify(msg({ subject: "Payment overdue" }), ctx({ rules })).excluded.code).toBe("excluded_by_rule");
    const phrase = [{ kind: "exclusion", pattern: "weekly report" }];
    expect(classify(msg({ subject: "Weekly report: urgent items" }), ctx({ rules: phrase })).excluded.code).toBe("excluded_by_rule");
  });

  it("a trusted-sender rule lets an internal sender through and makes it known", () => {
    const rules = [{ kind: "trusted_sender", pattern: "@seller.example" }];
    const r = classify(msg({ from: "plant@seller.example", subject: "Please approve the deviation" }), ctx({ rules, link: unknown }));
    expect(r).toMatchObject({ relevant: true, review: false });
  });
});

describe("rules from the tenant", () => {
  it("a keyword rule adds an action with its priority", () => {
    const rules = [{ kind: "keyword", pattern: "rate contract", effect: { priority: "critical", action_type: "obtain_approval" } }];
    const r = classify(msg({ subject: "New rate contract attached" }), ctx({ rules }));
    expect(r).toMatchObject({ priority: "critical" });
    expect(r.actions[0].type).toBe("obtain_approval");
  });

  it("a customer rule raises the floor for that customer only", () => {
    const rules = [{ kind: "customer", pattern: "c1", effect: { priority: "critical" } }];
    expect(classify(msg({ subject: "Please confirm the order" }), ctx({ rules })).priority).toBe("critical");
    expect(classify(msg({ subject: "Please confirm the order" }), ctx({ rules, link: { ...known, customer_id: "c2" } })).priority).toBe("high");
  });

  it("a deadline rule sets the due time for an action type", () => {
    const rules = [{ id: "r9", kind: "deadline", pattern: "reply", effect: { due_hours: 2 } }];
    const r = classify(msg({ subject: "Please confirm the order" }), ctx({ rules }));
    expect(r.actions[0].due.at.toISOString()).toBe("2026-10-22T08:30:00.000Z");
    expect(r.actions[0].due.basis.rule).toBe("r9");
  });

  it("senderMatches: an address, a domain and its subdomains", () => {
    expect(senderMatches("@customer.example", "a@plant.customer.example")).toBe(true);
    expect(senderMatches("@customer.example", "a@notcustomer.example")).toBe(false);
    expect(senderMatches("a@customer.example", "A@Customer.example")).toBe(true);
  });
});

describe("reasons keep facts apart from inferences", () => {
  it("phrases, links and deadlines are facts; priority and review are inferences", () => {
    const r = classify(msg({ subject: "Payment overdue, please pay by 25 Oct" }), ctx({ link: unknown }));
    const kinds = Object.fromEntries(r.reasons.map((x) => [x.code, x.kind]));
    expect(kinds["phrase:payment_overdue"]).toBe("fact");
    expect(kinds.stated_deadline).toBe("fact");
    expect(kinds.priority).toBe("inferred");
  });
});

describe("deadlines and due times", () => {
  it("a stated date is a fact and sets the due time to close of business that day", () => {
    const r = classify(msg({ subject: "Confirm the order by 25 Oct" }), ctx());
    expect(r.actions[0].due).toMatchObject({ source: "customer_commit", at: new Date("2026-10-25T12:00:00Z") });
  });

  it("parses the stated forms", () => {
    expect(statedDeadline("send it by tomorrow", NOW, TZ).at.toISOString()).toBe("2026-10-23T12:00:00.000Z");
    expect(statedDeadline("reply by EOD", NOW, TZ).at.toISOString()).toBe("2026-10-22T12:00:00.000Z");
    expect(statedDeadline("before 05/11/2026", NOW, TZ).at.toISOString()).toBe("2026-11-05T12:00:00.000Z");
    expect(statedDeadline("due by Nov 3rd", NOW, TZ).at.toISOString()).toBe("2026-11-03T12:00:00.000Z");
    expect(statedDeadline("within 2 working days", NOW, TZ).at.toISOString()).toBe("2026-10-26T06:30:00.000Z");
    expect(statedDeadline("within 6 hours", NOW, TZ).at.toISOString()).toBe("2026-10-22T12:30:00.000Z");
  });

  it("a date with no year that is well past means next year; an impossible date is no deadline", () => {
    expect(statedDeadline("by 10 Jan", NOW, TZ).at.toISOString()).toBe("2027-01-10T12:00:00.000Z");
    expect(statedDeadline("by 31 Feb", NOW, TZ)).toBeNull();
    expect(statedDeadline("we met on 25 Oct", NOW, TZ)).toBeNull();
  });

  it("policy due times count business hours only", () => {
    // Friday 16:00 India + 4 business hours = Monday 12:00 India.
    const fri = new Date("2026-10-23T10:30:00Z");
    expect(addBusinessMinutes(fri, 240, TZ).toISOString()).toBe("2026-10-26T06:30:00.000Z");
    // Saturday counts nothing: it starts Monday 09:30.
    expect(addBusinessMinutes(new Date("2026-10-24T05:00:00Z"), 60, TZ).toISOString()).toBe("2026-10-26T05:00:00.000Z");
    const r = classify(msg({ subject: "Legal notice" }), ctx({ now: fri }));
    expect(r.actions[0].due).toMatchObject({ source: "sla", at: new Date("2026-10-26T06:30:00Z") });
  });

  it("a normal request with a deadline inside one business day becomes high", () => {
    const r = classify(msg({ subject: "Can you share the price list by tomorrow?" }), ctx());
    expect(r.priority).toBe("high");
    expect(r.reasons.some((x) => x.code === "deadline_soon" && x.kind === "inferred")).toBe(true);
  });
});

describe("follow-ups", () => {
  it("an action type already open in the thread is a follow-up, not a new action", () => {
    const r = classify(msg({ subject: "Re: payment overdue", preview: "Also send the test reports" }), ctx({ openTypesInThread: new Set(["confirm_payment"]) }));
    expect(r.followUpTypes).toEqual(["confirm_payment"]);
    expect(r.actions.map((a) => a.type)).toEqual(["provide_documents"]);
  });

  it("priority ranks", () => {
    expect(PRIORITY_RANK).toEqual({ critical: 1, high: 2, normal: 3, informational: 4 });
  });
});
