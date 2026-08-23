// plm_changes was written on every cron tick and read by nothing.
//
// One reference in the whole codebase — the upsert in plm/sync.js. So a
// supplier releasing an engineering change against a part we buy produced a
// row and no consequence: the cron ran, the Windchill call was spent, the
// record was written, and nobody was told.
//
// The intersection is the whole feature. A PLM instance carries changes for
// the supplier's entire catalogue; alerting on all of them is the fastest way
// to get alerting switched off. Only an ECO naming a part in item_master is
// worth a person's attention.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { partKey, affectedPartKeys, matchChangesToParts, describeImpact } from "../api/_lib/plm-impact.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

const CHANGE = {
  id: "11111111-1111-1111-1111-111111111111",
  external_id: "ECO-9",
  eco_number: "ECO-0009",
  title: "Shank material change",
  status: "released",
  effective_date: "2026-09-01",
  affected_parts: ["ab-1042-7", "ZZ-NOT-OURS"],
};

describe("partKey", () => {
  it("trims and uppercases, matching the item_master convention", () => {
    expect(partKey("  ab-1042-7 ")).toBe("AB-1042-7");
  });

  it("does NOT strip punctuation or spaces", () => {
    // "AB-1042-7" and "AB10427" may be different parts. A matcher that guesses
    // they are the same raises an alert about a part nobody has.
    expect(partKey("AB-1042-7")).not.toBe(partKey("AB10427"));
  });

  it("survives null and undefined", () => {
    expect(partKey(null)).toBe("");
    expect(partKey(undefined)).toBe("");
  });
});

describe("affectedPartKeys", () => {
  it("collects distinct keys across changes for one bounded lookup", () => {
    const keys = affectedPartKeys([CHANGE, { affected_parts: ["AB-1042-7", "QQ-1"] }]);
    expect(keys.sort()).toEqual(["AB-1042-7", "QQ-1", "ZZ-NOT-OURS"]);
  });

  it("ignores changes with no parts, and empty entries", () => {
    expect(affectedPartKeys([{ affected_parts: null }, { affected_parts: ["", "  "] }, {}])).toEqual([]);
    expect(affectedPartKeys(null)).toEqual([]);
  });
});

describe("matchChangesToParts", () => {
  it("matches case-insensitively against what we hold", () => {
    const [hit] = matchChangesToParts([CHANGE], ["AB-1042-7"]);
    expect(hit.matched).toEqual(["ab-1042-7"]);
  });

  it("returns the ORIGINAL spelling, not the key", () => {
    // This ends up in front of someone who has to find the part on a drawing.
    const [hit] = matchChangesToParts([CHANGE], ["ab-1042-7"]);
    expect(hit.matched[0]).toBe("ab-1042-7");
  });

  it("drops a change that touches nothing we hold", () => {
    // Not returned with an empty list: "this ECO affects none of your parts"
    // is not an alert.
    expect(matchChangesToParts([CHANGE], ["SOMETHING-ELSE"])).toEqual([]);
  });

  it("counts a part named twice as one impact", () => {
    const dup = { ...CHANGE, affected_parts: ["AB-1", "ab-1", " AB-1 "] };
    const [hit] = matchChangesToParts([dup], ["AB-1"]);
    expect(hit.matched).toHaveLength(1);
  });

  it("accepts a Set as well as an array", () => {
    expect(matchChangesToParts([CHANGE], new Set(["AB-1042-7"]))).toHaveLength(1);
  });

  it("is empty for empty input rather than throwing", () => {
    expect(matchChangesToParts(null, null)).toEqual([]);
    expect(matchChangesToParts([CHANGE], [])).toEqual([]);
  });
});

describe("describeImpact", () => {
  it("names the ECO the way the source system does, so it can be looked up", () => {
    const line = describeImpact({ change: CHANGE, matched: ["AB-1042-7"] });
    expect(line).toContain("ECO-0009");
    expect(line).toContain("released");
    expect(line).toContain("2026-09-01");
    expect(line).toContain("AB-1042-7");
  });

  it("lists parts rather than counting them", () => {
    // "affects 3 of your parts" is a number; "affects AB-1042-7" is a thing to
    // go and check.
    expect(describeImpact({ change: CHANGE, matched: ["AB-1", "AB-2"] })).toContain("AB-1, AB-2");
  });

  it("caps the list, because a notification is not a report", () => {
    const many = Array.from({ length: 30 }, (_, i) => "P-" + i);
    const line = describeImpact({ change: CHANGE, matched: many }, { maxParts: 3 });
    expect(line).toContain("and 27 more");
  });

  it("falls back to external_id when there is no ECO number", () => {
    expect(describeImpact({ change: { ...CHANGE, eco_number: null }, matched: ["A"] })).toContain("ECO-9");
  });
});

describe("the sync actually raises it", () => {
  const src = read("src/api/plm/sync.js");

  it("alerts only on changes NEW to us", () => {
    // notifyAdmins dedups on a FIVE-MINUTE window — a flap guard, not an
    // alert-once guarantee. Without this filter every tick would re-raise the
    // same ECO forever.
    expect(src).toMatch(/created_at >= beforeUpsert/);
    expect(src).toMatch(/const beforeUpsert = new Date\(\)\.toISOString\(\)/);
  });

  it("intersects against item_master before alerting", () => {
    expect(src).toMatch(/"item_master"/);
    expect(src).toMatch(/matchChangesToParts\(fresh/);
  });

  it("passes a uuid to object_id, not the text external id", () => {
    // object_id is a uuid column. A text external_id fails the insert, and
    // notifyAdmins catches that and returns { notified: 0 } — the alert would
    // never fire and nothing would say why.
    expect(src).toMatch(/object_id: impact\.change\.id/);
    expect(src).toMatch(/\.select\("id, external_id/);
  });

  it("sends no field admin_notifications does not have", () => {
    // notifyAdmins builds an explicit row rather than spreading the payload,
    // so an invented field is dropped in silence rather than erroring.
    const call = src.slice(src.indexOf("notifyAdmins(svc, tenantId"), src.indexOf("dedupKey: \"plm_change:"));
    expect(call).not.toMatch(/severity:/);
  });

  it("passes NO dedupKey, because notifyAdmins ignores its value", () => {
    // This test previously asserted the opposite and was WRONG — it encoded
    // the bug. notifications.js:42-51 filters on tenant + kind + unresolved +
    // the last five minutes and never compares the key string, so a per-ECO
    // key meant the first impacting change notified and every other one in the
    // same tick was silently swallowed. Idempotency across ticks is the
    // created_at filter, which is real.
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    const call = code.slice(code.indexOf('kind: "plm_change_impacts_stock"'), code.indexOf("return { new_changes: fresh.length, impacting: impacts.length }"));
    expect(call.length).toBeGreaterThan(20);
    expect(call).not.toMatch(/dedupKey/);
  });
});
