// Unit tests for the armQuoteAgentGoals helper extracted from
// src/api/quotes/send.js. Verifies that sending a quote arms the
// two autonomous-agent goals (quote_accept_within_14d +
// expiring_quote_nudge), cancels any prior active goals against
// the same quote first, and surfaces upstream errors instead of
// swallowing them.
//
// Audit P10 follow-up.

import { describe, it, expect } from "vitest";
import { __test as send } from "../api/quotes/send.js";

// Build a fake Supabase chain. The PostgREST builder is thenable
// (await resolves the query), so the helper here makes the builder
// itself a Promise via `.then`, capturing the inserts + cancel
// patches into the test arrays for assertion.
const buildSvc = (opts) => {
  const o = opts || {};
  const inserts = [];
  const cancelCalls = [];
  const svc = {
    from: (_table) => {
      const filters = {};
      let mode = null;     // "update" | "insert"
      let updatePatch = null;
      let insertRows = null;
      let withSelect = false;
      const finalize = () => {
        if (mode === "update") {
          cancelCalls.push({ patch: updatePatch, filters: { ...filters } });
          return { data: null, error: o.cancelError || null };
        }
        if (mode === "insert") {
          inserts.push(...insertRows);
          if (o.insertError) {
            return { data: null, error: o.insertError };
          }
          if (!withSelect) return { data: null, error: null };
          return {
            data: insertRows.map((r, i) => ({
              id: "goal-" + (inserts.length - insertRows.length + i + 1),
              goal_type: r.goal_type,
            })),
            error: null,
          };
        }
        return { data: null, error: null };
      };
      const builder = {
        update: (patch) => { mode = "update"; updatePatch = patch; return builder; },
        insert: (rows) => { mode = "insert"; insertRows = Array.isArray(rows) ? rows : [rows]; return builder; },
        select: () => { withSelect = true; return builder; },
        eq: (k, v) => { filters[k] = v; return builder; },
        in: (k, vs) => { filters[k] = vs; return builder; },
        then: (resolve, reject) => {
          try { resolve(finalize()); } catch (err) { reject(err); }
        },
      };
      return builder;
    },
  };
  return { svc, inserts, cancelCalls };
};

describe("armQuoteAgentGoals", () => {
  it("arms the two quote-targeted goals after cancelling any prior ones", async () => {
    const { svc, inserts, cancelCalls } = buildSvc();
    const out = await send.armQuoteAgentGoals(svc, {
      tenantId: "t-1",
      quote: { id: "q-1", sent_at: "2026-05-08T10:00:00Z", version: 2 },
      expiresAt: "2026-06-07T10:00:00Z",
      ownerUserId: "u-1",
    });
    expect(out.error).toBeUndefined();
    expect(inserts.length).toBe(2);
    const types = inserts.map((r) => r.goal_type).sort();
    expect(types).toEqual(["expiring_quote_nudge", "quote_accept_within_14d"]);
    // due_at on quote_accept is sent_at + 14 days.
    const acc = inserts.find((r) => r.goal_type === "quote_accept_within_14d");
    expect(acc.due_at).toBe(new Date("2026-05-22T10:00:00Z").toISOString());
    // due_at on expiring_quote_nudge matches expiresAt.
    const exp = inserts.find((r) => r.goal_type === "expiring_quote_nudge");
    expect(exp.due_at).toBe("2026-06-07T10:00:00Z");
    // Both rows carry the resolved sent_at + version in config.
    expect(acc.config.sent_at).toBe("2026-05-08T10:00:00Z");
    expect(acc.config.cooldown_hours).toBe(send.QUOTE_NUDGE_COOLDOWN_HOURS);
    expect(acc.config.version).toBe(2);
    // Cancelled prior goals targeting this quote.
    expect(cancelCalls.length).toBe(1);
    expect(cancelCalls[0].patch.status).toBe("cancelled");
    expect(cancelCalls[0].filters.object_id).toBe("q-1");
    expect(cancelCalls[0].filters.goal_type).toEqual(send.QUOTE_GOAL_TYPES);
  });

  it("surfaces a cancel error without inserting fresh goals", async () => {
    const { svc, inserts } = buildSvc({ cancelError: { message: "perm denied" } });
    const out = await send.armQuoteAgentGoals(svc, {
      tenantId: "t-1",
      quote: { id: "q-2", sent_at: "2026-05-08T10:00:00Z", version: 1 },
      expiresAt: "2026-06-07T10:00:00Z",
      ownerUserId: null,
    });
    expect(out.error).toMatch(/cancel prior goals.*perm denied/);
    expect(inserts.length).toBe(0);
  });

  it("surfaces an insert error", async () => {
    const { svc } = buildSvc({ insertError: { message: "constraint violation" } });
    const out = await send.armQuoteAgentGoals(svc, {
      tenantId: "t-1",
      quote: { id: "q-3", sent_at: "2026-05-08T10:00:00Z", version: 1 },
      expiresAt: "2026-06-07T10:00:00Z",
      ownerUserId: null,
    });
    expect(out.error).toMatch(/insert goals.*constraint violation/);
  });

  it("falls back to now() when the quote row has no sent_at yet", async () => {
    const { svc, inserts } = buildSvc();
    const before = Date.now();
    const out = await send.armQuoteAgentGoals(svc, {
      tenantId: "t-1",
      quote: { id: "q-4", version: 1 },
      expiresAt: "2026-06-07T10:00:00Z",
      ownerUserId: null,
    });
    expect(out.error).toBeUndefined();
    const acc = inserts.find((r) => r.goal_type === "quote_accept_within_14d");
    const sentAtMs = new Date(acc.config.sent_at).getTime();
    expect(sentAtMs).toBeGreaterThanOrEqual(before);
    expect(sentAtMs).toBeLessThanOrEqual(Date.now());
  });
});
