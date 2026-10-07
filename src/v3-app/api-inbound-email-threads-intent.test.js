// /api/inbound/email/threads returns the email classifier's verdict.
//
// The Email Triage screen labels every row by intent. The endpoint used to
// select neither classified_intent nor classification_confidence, so a
// complaint reached the screen with no intent at all. The fake below
// projects the selected columns the way PostgREST does, so a column the
// endpoint forgets to select is absent from the response. Fixtures are
// invented.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ store: {} }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const q = {
        _cols: null, _filters: [], _limit: null,
        select(cols) { this._cols = cols; return this; },
        eq(col, val) { this._filters.push((r) => r[col] === val); return this; },
        in(col, arr) { this._filters.push((r) => arr.includes(r[col])); return this; },
        order() { return this; },
        limit(n) { this._limit = n; return this; },
        _project(r) {
          if (!this._cols || this._cols === "*") return { ...r };
          const out = {};
          for (const c of this._cols.split(",").map((s) => s.trim())) if (c in r) out[c] = r[c];
          return out;
        },
        _exec(single) {
          let hit = (H.store[table] || []).filter((r) => this._filters.every((f) => f(r)));
          if (this._limit != null) hit = hit.slice(0, this._limit);
          hit = hit.map((r) => this._project(r));
          return Promise.resolve({ data: single ? (hit[0] || null) : hit, error: null });
        },
        maybeSingle() { const self = this; return { then: (res, rej) => self._exec(1).then(res, rej) }; },
        then(resolve, reject) { return this._exec(0).then(resolve, reject); },
      };
      return q;
    },
  }),
}));

const { default: threads } = await import("../api/inbound/email/threads.js");

const run = async (url) => {
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await threads({ method: "GET", headers: {}, url }, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

const email = (id, intent, conf, extra = {}) => ({
  id, tenant_id: "t-1", thread_id: "th-" + id, status: "parsed", priority_score: 50,
  customer_id: null, customer_tier: "standard", from_address: id + "@buyer.example",
  subject: "Subject " + id, received_at: "2026-10-01T10:00:00Z",
  classified_intent: intent, classification_confidence: conf, ...extra,
});

beforeEach(() => {
  H.store = {
    inbound_emails: [
      email("e-rfq", "rfq", 0.91),
      email("e-cmp", "complaint", 0.87),
      email("e-sup", "support_question", 0.66),
      email("e-po", "purchase_order", 0.95),
      email("e-new", null, null),
      email("e-other-tenant", "complaint", 0.9, { tenant_id: "t-2" }),
    ],
    inbound_email_threads: [{ id: "th-e-cmp", tenant_id: "t-1" }],
  };
});

describe("GET /api/inbound/email/threads: classifier verdict", () => {
  it("returns classified_intent and classification_confidence on every row", async () => {
    const out = await run("/api/inbound/email/threads?limit=50");
    expect(out.statusCode).toBe(200);
    const byId = Object.fromEntries(out.body.messages.map((m) => [m.id, m]));
    expect(byId["e-cmp"].classified_intent).toBe("complaint");
    expect(byId["e-cmp"].classification_confidence).toBe(0.87);
    expect(byId["e-sup"].classified_intent).toBe("support_question");
    expect(byId["e-rfq"].classified_intent).toBe("rfq");
    // A row the classifier has not reached yet comes back as null, not absent.
    expect(byId["e-new"]).toHaveProperty("classified_intent", null);
  });

  it("narrows to the requested intents, inside this tenant", async () => {
    const out = await run("/api/inbound/email/threads?limit=50&intent=complaint,support_question");
    expect(out.body.messages.map((m) => m.id).sort()).toEqual(["e-cmp", "e-sup"]);
  });

  it("applies the intent filter before the limit", async () => {
    // Two RFQs rank ahead of the complaint. limit=1 must still find it.
    H.store.inbound_emails = [email("e-rfq", "rfq", 0.9), email("e-rfq2", "rfq", 0.9), email("e-cmp", "complaint", 0.8)];
    const out = await run("/api/inbound/email/threads?limit=1&intent=complaint");
    expect(out.body.messages.map((m) => m.id)).toEqual(["e-cmp"]);
  });

  it("ignores an intent value the classifier never emits", async () => {
    const out = await run("/api/inbound/email/threads?limit=50&intent=bogus");
    expect(out.body.messages).toHaveLength(5);   // no filter applied, all of t-1
  });

  it("returns the intent on a thread's messages too", async () => {
    const out = await run("/api/inbound/email/threads?id=th-e-cmp&messages=true");
    expect(out.statusCode).toBe(200);
    expect(out.body.messages[0].classified_intent).toBe("complaint");
    expect(out.body.messages[0].classification_confidence).toBe(0.87);
  });
});
