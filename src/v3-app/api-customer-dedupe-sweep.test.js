// Unit tests for src/api/_lib/customer-dedupe-sweep.js (Wave CM 4.2).

import { describe, it, expect } from "vitest";
import {
  scorePair, groupByBlock, sweepTenant, __test,
} from "../api/_lib/customer-dedupe-sweep.js";

describe("__test.identityHash", () => {
  it("returns the same hex on canonical-equal inputs", () => {
    const a = __test.identityHash({ display_name: "Acme Auto", gstin: "27ABC", country: "IN" });
    const b = __test.identityHash({ display_name: " ACME AUTO ", gstin: "27abc", country: "IN" });
    expect(a).toBe(b);
  });
  it("differs on different inputs", () => {
    const a = __test.identityHash({ display_name: "Acme", gstin: "27ABC" });
    const b = __test.identityHash({ display_name: "Beta", gstin: "27ABC" });
    expect(a).not.toBe(b);
  });
});

describe("__test.blockingKey", () => {
  it("composes name prefix + gstin prefix", () => {
    const k = __test.blockingKey({ display_name: "Acme Auto Industries", gstin: "27ABCDEF1Z5" });
    expect(k).toBe("acm|27");
  });
});

describe("__test.observeFeatures", () => {
  it("flags name match on near-identical names", () => {
    const obs = __test.observeFeatures(
      { display_name: "Acme Auto Industries" },
      { display_name: "Acme Auto Industry" },
    );
    expect(obs.name_jaro_high).toBe(true);
  });
  it("flags gstin_match on exact GSTIN", () => {
    const obs = __test.observeFeatures({ gstin: "27ABC" }, { gstin: "27ABC" });
    expect(obs.gstin_match).toBe(true);
  });
  it("flags domain_match when any contact email shares domain", () => {
    const obs = __test.observeFeatures(
      { contact_emails: ["a@acme.com", "b@other.com"] },
      { contact_emails: ["c@acme.com"] },
    );
    expect(obs.domain_match).toBe(true);
  });
  it("flags external_id_match on shared SAP code", () => {
    const obs = __test.observeFeatures(
      { external_ids: [{ system_code: "sap", external_id: "100051" }] },
      { external_ids: [{ system_code: "sap", external_id: "100051" }] },
    );
    expect(obs.external_id_match).toBe(true);
  });
  it("returns null when no signal is present", () => {
    const obs = __test.observeFeatures({}, {});
    expect(obs.gstin_match).toBeNull();
    expect(obs.name_jaro_high).toBeNull();
  });
});

describe("__test.chooseWinner", () => {
  it("prefers is_golden=true", () => {
    const a = { id: "a", is_golden: false };
    const b = { id: "b", is_golden: true };
    expect(__test.chooseWinner(a, b)).toBe("b");
  });
  it("prefers higher contact_count when both golden", () => {
    const a = { id: "a", is_golden: true, contact_count: 1 };
    const b = { id: "b", is_golden: true, contact_count: 5 };
    expect(__test.chooseWinner(a, b)).toBe("b");
  });
  it("prefers more-recent last_active_at on tie", () => {
    const a = { id: "a", is_golden: true, contact_count: 5, last_active_at: "2026-01-01T00:00:00Z" };
    const b = { id: "b", is_golden: true, contact_count: 5, last_active_at: "2026-05-01T00:00:00Z" };
    expect(__test.chooseWinner(a, b)).toBe("b");
  });
});

describe("scorePair", () => {
  it("rises sharply on gstin_match + name_match", () => {
    const { probability } = scorePair(
      { display_name: "Acme Auto", gstin: "27ABC", country: "IN" },
      { display_name: "Acme Auto Industries", gstin: "27ABC", country: "IN" },
    );
    expect(probability).toBeGreaterThan(__test.SUGGEST_PROB);
  });

  it("stays low when no signals match", () => {
    const { probability } = scorePair(
      { display_name: "Acme", gstin: "27ABC" },
      { display_name: "Beta", gstin: "30XYZ" },
    );
    expect(probability).toBeLessThan(__test.SUGGEST_PROB);
  });
});

describe("groupByBlock", () => {
  it("clusters by name+gstin prefix and drops singleton blocks", () => {
    const blocks = groupByBlock([
      { id: "1", display_name: "Acme Auto", gstin: "27ABC" },
      { id: "2", display_name: "Acme Auto Pvt", gstin: "27ABC" },
      { id: "3", display_name: "Beta Corp", gstin: "30XYZ" },
    ]);
    // Singletons (Beta Corp) dropped.
    expect(blocks.size).toBe(1);
    const onlyBlock = Array.from(blocks.values())[0];
    expect(onlyBlock.length).toBe(2);
  });
});

describe("sweepTenant", () => {
  it("returns ok=false on missing args", async () => {
    expect((await sweepTenant(null, { tenantId: "t" })).ok).toBe(false);
    expect((await sweepTenant({}, { tenantId: null })).ok).toBe(false);
  });

  it("returns 0 candidates when fewer than 2 customers exist", async () => {
    const svc = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => Promise.resolve({ data: [{ id: "c1" }], error: null }),
              }),
            }),
          }),
        }),
      }),
    };
    const out = await sweepTenant(svc, { tenantId: "t" });
    expect(out.ok).toBe(true);
    expect(out.candidates_open).toBe(0);
  });
});
