// Unit tests for the copilot proposal store (_lib/action-proposals.js):
// create, atomic single-use consume, and the rejection reasons
// (replay / expired / wrong user / wrong tenant), plus cancel.

import { describe, it, expect, beforeEach } from "vitest";
import { createProposal, consumeProposal, cancelProposal } from "../api/_lib/action-proposals.js";

const T1 = "tenant-1";
const T2 = "tenant-2";
const U1 = "user-1";
const U2 = "user-2";

// In-memory svc supporting the chains the lib uses: insert/select/single,
// update with eq + gt filters + select/maybeSingle, select/eq/maybeSingle.
let tables;
const makeSvc = () => ({
  from(table) {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    let mode = "select";
    let patch = null;
    let single = false;
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      gt: (c, v) => { rows = rows.filter((r) => r[c] != null && String(r[c]) > String(v)); return b; },
      single: () => { single = true; return b; },
      maybeSingle: () => { single = true; return b; },
      insert: (row) => { mode = "insert"; patch = row; return b; },
      update: (p) => { mode = "update"; patch = p; return b; },
      then: (fn) => Promise.resolve(fn(terminal())),
    };
    const terminal = () => {
      if (mode === "insert") {
        const arr = (Array.isArray(patch) ? patch : [patch]).map((r) => ({ id: r.id || "id-" + (ds.length + 1), ...r }));
        ds.push(...arr);
        return { data: single ? arr[0] : arr, error: null };
      }
      if (mode === "update") {
        for (const r of rows) Object.assign(r, patch);
        return { data: single ? rows[0] || null : rows, error: null };
      }
      return { data: single ? rows[0] || null : rows, error: null };
    };
    return b;
  },
});

beforeEach(() => { tables = {}; });

const seedProposal = async (svc, over = {}) => {
  const p = await createProposal(svc, { tenantId: T1, userId: U1, action: "create_lead", args: { company_name: "Acme" }, preview: { x: 1 }, ...over });
  return p;
};

describe("createProposal", () => {
  it("inserts a proposed row with a token + future expiry", async () => {
    const svc = makeSvc();
    const p = await seedProposal(svc);
    expect(p.confirm_token).toMatch(/^[0-9a-f]{48}$/);
    expect(new Date(p.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(tables.action_proposals).toHaveLength(1);
    expect(tables.action_proposals[0]).toMatchObject({ tenant_id: T1, created_by: U1, action: "create_lead", status: "proposed" });
  });
});

describe("consumeProposal", () => {
  it("consumes exactly once; a replay is rejected ALREADY_CONSUMED", async () => {
    const svc = makeSvc();
    const p = await seedProposal(svc);
    const first = await consumeProposal(svc, { tenantId: T1, userId: U1, confirmToken: p.confirm_token });
    expect(first.ok).toBe(true);
    expect(first.proposal.action).toBe("create_lead");
    expect(tables.action_proposals[0].status).toBe("consumed");
    const replay = await consumeProposal(svc, { tenantId: T1, userId: U1, confirmToken: p.confirm_token });
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe("ALREADY_CONSUMED");
    expect(replay.status).toBe(409);
  });

  it("rejects a token from another user (WRONG_USER)", async () => {
    const svc = makeSvc();
    const p = await seedProposal(svc);
    const r = await consumeProposal(svc, { tenantId: T1, userId: U2, confirmToken: p.confirm_token });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WRONG_USER");
  });

  it("rejects a token from another tenant (NOT_FOUND)", async () => {
    const svc = makeSvc();
    const p = await seedProposal(svc);
    const r = await consumeProposal(svc, { tenantId: T2, userId: U1, confirmToken: p.confirm_token });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("NOT_FOUND");
  });

  it("rejects an expired proposal (EXPIRED)", async () => {
    const svc = makeSvc();
    const p = await createProposal(svc, { tenantId: T1, userId: U1, action: "create_lead", args: {}, ttlMinutes: -1 });
    const r = await consumeProposal(svc, { tenantId: T1, userId: U1, confirmToken: p.confirm_token });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("EXPIRED");
    expect(r.status).toBe(410);
  });

  it("rejects an unknown token (NOT_FOUND) and a missing token (MISSING_TOKEN)", async () => {
    const svc = makeSvc();
    await seedProposal(svc);
    expect((await consumeProposal(svc, { tenantId: T1, userId: U1, confirmToken: "nope" })).code).toBe("NOT_FOUND");
    expect((await consumeProposal(svc, { tenantId: T1, userId: U1, confirmToken: "" })).code).toBe("MISSING_TOKEN");
  });
});

describe("cancelProposal", () => {
  it("cancels a still-proposed row so it can no longer be consumed", async () => {
    const svc = makeSvc();
    const p = await seedProposal(svc);
    const c = await cancelProposal(svc, { tenantId: T1, userId: U1, confirmToken: p.confirm_token });
    expect(c.ok).toBe(true);
    expect(tables.action_proposals[0].status).toBe("cancelled");
    const r = await consumeProposal(svc, { tenantId: T1, userId: U1, confirmToken: p.confirm_token });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CANCELLED");
  });
});
