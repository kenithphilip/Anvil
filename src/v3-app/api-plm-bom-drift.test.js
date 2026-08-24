// plm_boms was the second write-only table in the PLM mirror.
//
// The sync builds a canonical tree for every assembly Windchill or Arena knows
// about and writes it on every cron tick; nothing had ever read it. #501 gave
// plm_changes a consequence. This is the other half, and the more
// consequential one: an ECO announces a change, but a BOM revision IS the
// change — a child dropped upstream is a part we may still be buying, and one
// added upstream is a part we are not.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { directChildren, ourChildren, compareBom, describeBomDrift, comparable } from "../api/_lib/plm-bom-drift.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

const tree = (children) => ({ part_no: "ASSY-1", qty: 1, children });

describe("directChildren", () => {
  it("takes one level, keyed", () => {
    const kids = directChildren(tree([
      { part_no: "c-1", qty: 2, uom: "ea", children: [{ part_no: "GRANDCHILD", qty: 9 }] },
    ]));
    expect(kids).toHaveLength(1);
    expect(kids[0].key).toBe("C-1");
    expect(kids[0].part_no).toBe("c-1");   // original spelling kept for the human
  });

  it("does NOT descend — a sub-assembly's contents are not the parent's", () => {
    const kids = directChildren(tree([{ part_no: "SUB", qty: 1, children: [{ part_no: "DEEP", qty: 3 }] }]));
    expect(kids.map((k) => k.key)).toEqual(["SUB"]);
  });

  it("sums a child listed twice rather than reporting a phantom mismatch", () => {
    // Every BOM convention worth honouring treats that as one line.
    const kids = directChildren(tree([{ part_no: "C", qty: 2 }, { part_no: "c", qty: 3 }]));
    expect(kids).toHaveLength(1);
    expect(kids[0].qty).toBe(5);
  });

  it("survives a missing or malformed structure", () => {
    expect(directChildren(null)).toEqual([]);
    expect(directChildren({})).toEqual([]);
    expect(directChildren(tree([{ part_no: "" }, { qty: 1 }]))).toEqual([]);
  });
});

describe("compareBom", () => {
  const theirs = directChildren(tree([
    { part_no: "SHARED", qty: 2 },
    { part_no: "THEIRS-ONLY", qty: 1 },
    { part_no: "QTY-MOVED", qty: 4 },
  ]));
  const mine = ourChildren([
    { child_part_no: "SHARED", qty: 2 },
    { child_part_no: "OURS-ONLY", qty: 1 },
    { child_part_no: "QTY-MOVED", qty: 6 },
  ]);

  it("names the three drifts from OUR side", () => {
    // Direction matters: "added"/"removed" is ambiguous about whose BOM moved,
    // and an operator needs to know which list to go and edit.
    const d = compareBom(theirs, mine);
    expect(d.missing_from_ours.map((c) => c.key)).toEqual(["THEIRS-ONLY"]);
    expect(d.not_in_supplier.map((c) => c.key)).toEqual(["OURS-ONLY"]);
    expect(d.qty_differs.map((c) => c.key)).toEqual(["QTY-MOVED"]);
    expect(d.drifted).toBe(true);
  });

  it("reports the quantities in both directions", () => {
    const [q] = compareBom(theirs, mine).qty_differs;
    expect(q.our_qty).toBe(6);
    expect(q.supplier_qty).toBe(4);
  });

  it("is not drifted when the BOMs match", () => {
    const same = ourChildren([{ child_part_no: "shared", qty: 2 }]);
    expect(compareBom(directChildren(tree([{ part_no: "SHARED", qty: 2 }])), same).drifted).toBe(false);
  });

  it("treats an unstated quantity as no disagreement", () => {
    // Otherwise every assembly whose bridge omitted a qty gets a drift alert.
    const noQty = directChildren(tree([{ part_no: "X" }]));
    expect(compareBom(noQty, ourChildren([{ child_part_no: "X", qty: 3 }])).qty_differs).toEqual([]);
  });

  it("honours a quantity tolerance when asked", () => {
    const t = directChildren(tree([{ part_no: "X", qty: 2.001 }]));
    const o = ourChildren([{ child_part_no: "X", qty: 2 }]);
    expect(compareBom(t, o).qty_differs).toHaveLength(1);
    expect(compareBom(t, o, { qtyTolerance: 0.01 }).qty_differs).toHaveLength(0);
  });

  it("survives empty input on either side", () => {
    expect(compareBom([], []).drifted).toBe(false);
    expect(compareBom(null, null).drifted).toBe(false);
  });
});

describe("comparable — refusing a truncated tree", () => {
  // THE defect an adversarial pass caught before this shipped, and it would
  // have been the feature's MODAL output rather than an edge case.
  //
  // plm-client pulls parts INCREMENTALLY ($filter: LastModified ge since) but
  // usage links unfiltered, and buildTree used to silently drop any child not
  // in that page. The alert fires on a revision move — which means the parent
  // is in the page precisely BECAUSE it changed, while its unchanged children
  // are not. So the stored tree arrives gutted, and comparing it reports
  // "the supplier deleted these parts you are still buying". Expensive, wrong,
  // and it teaches the operator to ignore the next one.

  it("refuses a tree with any unresolved child link", () => {
    const r = comparable({ unresolved_children: 3, children: [{ part_no: "A" }] }, 5);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("incomplete_structure");
    expect(r.unresolved).toBe(3);
  });

  it("refuses an empty tree when we hold children — truncation, not deletion", () => {
    expect(comparable({ unresolved_children: 0, children: [] }, 4)).toMatchObject({ ok: false, reason: "empty_structure" });
  });

  it("allows an empty tree when we hold nothing either", () => {
    // Genuinely both empty is agreement, not truncation.
    expect(comparable({ unresolved_children: 0, children: [] }, 0).ok).toBe(true);
  });

  it("allows a fully resolved tree", () => {
    expect(comparable({ unresolved_children: 0, children: [{ part_no: "A" }] }, 1).ok).toBe(true);
  });

  it("treats a missing counter as unresolved-free but still catches emptiness", () => {
    // Rows written before buildTree recorded the count have no field.
    expect(comparable({ children: [{ part_no: "A" }] }, 1).ok).toBe(true);
    expect(comparable({ children: [] }, 2).ok).toBe(false);
  });

  it("survives a null structure", () => {
    expect(comparable(null, 3).ok).toBe(false);
  });
});

describe("buildTree counts what it could not resolve", () => {
  const src = read("src/api/_lib/plm-client.js");

  it("records unresolved_children rather than only dropping them", () => {
    expect(src).toMatch(/if \(!child\) \{ unresolved\+\+; return null; \}/);
    expect(src).toMatch(/unresolved_children: unresolved/);
  });
});

describe("describeBomDrift", () => {
  it("leads with counts and names the parts", () => {
    const d = compareBom(
      directChildren(tree([{ part_no: "NEW-1", qty: 1 }])),
      ourChildren([{ child_part_no: "OLD-1", qty: 1 }]),
    );
    const line = describeBomDrift("ASSY-1", "B", d);
    expect(line).toContain("ASSY-1 rev B");
    expect(line).toContain("they have that we do not (NEW-1)");
    expect(line).toContain("we have that they do not (OLD-1)");
  });

  it("shows a quantity move as our→theirs", () => {
    const d = compareBom(
      directChildren(tree([{ part_no: "X", qty: 4 }])),
      ourChildren([{ child_part_no: "X", qty: 6 }]),
    );
    expect(describeBomDrift("A", null, d)).toContain("X 6→4");
  });

  it("caps the list, because a notification is not a report", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ part_no: "P-" + i, qty: 1 }));
    const d = compareBom(directChildren(tree(many)), []);
    expect(describeBomDrift("A", "1", d, { maxParts: 3 })).toContain("and 17 more");
  });
});

describe("the sync raises it on the right trigger", () => {
  const src = read("src/api/plm/sync.js");

  it("fires on a REVISION move, not on still-being-different", () => {
    // A drifted BOM stays drifted until somebody fixes it, so "still different"
    // is true on every tick forever. notifyAdmins dedups on five minutes and
    // would re-raise it all day. A revision that moved is new information.
    expect(src).toMatch(/priorRev/);
    expect(src).toMatch(/\(priorRev\.get\(r\.external_id\) \?\? null\) !== \(r\.revision \?\? null\)/);
  });

  it("reads the prior revision BEFORE the upsert overwrites it", () => {
    // Ordering, not syntax: which statement runs first is the whole point, and
    // an earlier version of this test pinned the exact query string and broke
    // on a refactor that changed nothing about the behaviour.
    const priorIdx = src.indexOf('"plm_boms", "external_id, revision"');
    const upsertIdx = src.indexOf('.upsert(rows, { onConflict: "tenant_id,source_system,external_id" })');
    expect(priorIdx).toBeGreaterThan(-1);
    expect(upsertIdx).toBeGreaterThan(-1);
    expect(priorIdx).toBeLessThan(upsertIdx);
  });

  it("treats an assembly new to us as worth comparing", () => {
    expect(src).toMatch(/if \(!priorRev\.has\(r\.external_id\)\) return true;/);
  });

  it("only compares assemblies we hold a BOM for", () => {
    // Alerting where we have nothing to drift FROM would fire for the
    // supplier's entire catalogue.
    expect(src).toMatch(/"bill_of_materials"/);
    expect(src).toMatch(/if \(!mine \|\| !mine\.length\) continue;/);
  });

  it("does not pass a non-uuid to object_id", () => {
    // object_id is uuid. A text part number fails the insert, and notifyAdmins
    // catches that and reports { notified: 0 } — the alert would never fire.
    const call = src.slice(src.indexOf('kind: "plm_bom_drift"'), src.indexOf('dedupKey: "plm_bom_drift:'));
    expect(call).not.toMatch(/object_id:/);
  });

  it("bounds every .in() — PostgREST puts the list in the URL", () => {
    // plmFetchBoms pulls up to 500 parts ($top), so an unchunked .in() on 500
    // part numbers is a ~7.5KB query string against a cap usually set at 8KB.
    // It works in testing and fails on somebody's larger catalogue.
    expect(src).toMatch(/const IN_BATCH = 100;/);
    expect(src).not.toMatch(/\.in\("part_no", keys\)/);
    expect(src).not.toMatch(/\.in\("parent_part_no", parents\)/);
    expect((src.match(/selectIn\(svc/g) || []).length).toBe(3);
  });

  it("cannot fail the sync it rides on", () => {
    // Both alert helpers sit inside the try whose catch sets result.error and
    // flips plm_sync_state to errored. The mirror is the job; telling somebody
    // is a side benefit, and one malformed structure must not report a BOM
    // pull that worked as broken.
    expect(src).toMatch(/try \{[\s\S]{0,400}alertOnBomDrift/);
    expect(src).toMatch(/try \{ result\.impact = await alertOnImpact/);
  });

  it("refuses to compare an incomplete tree", () => {
    expect(src).toMatch(/const safe = comparable\(r\.structure, mine\.length\)/);
    expect(src).toMatch(/if \(!safe\.ok\) \{ skipped\[safe\.reason\]/);
  });

  it("caps the alerts, because the tail is lost permanently if the budget kills it", () => {
    // The plm_boms upsert COMMITS BEFORE this loop, so a budget kill mid-loop
    // leaves the revisions recorded, the next tick sees them unchanged, and the
    // un-alerted remainder never fires again.
    expect(src).toMatch(/const MAX_ALERTS = 25/);
    expect(src).toMatch(/if \(drifted >= MAX_ALERTS\) break;/);
    expect(src).toMatch(/More supplier BOM drift than could be listed/);
  });

  it("passes NO dedupKey, because notifyAdmins ignores its value", () => {
    // A per-assembly key looks like it separates alerts and does the reverse:
    // notifications.js:42-51 never compares the string, so the first drifted
    // assembly would notify and the rest of the tick would vanish.
    // Line comments stripped first: the code's own comment EXPLAINS why there
    // is no dedupKey, and matching prose instead of code is how an assertion
    // ends up testing the wrong thing. Only `//` is stripped — a blanket
    // block-comment strip is unsafe on files carrying a MIME wildcard.
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    const call = code.slice(code.indexOf('kind: "plm_bom_drift"'), code.indexOf("return { revised: revised.length, drifted }"));
    expect(call.length).toBeGreaterThan(20);
    expect(call).not.toMatch(/dedupKey/);
  });

  it("matches the PARENT the same way it matches children", () => {
    // Children go through partKey; the parent was raw text on both sides, so
    // a supplier "assy-1" against our "ASSY-1" was silently never compared and
    // the feature simply never fired.
    expect(src).toMatch(/byParent\.get\(partKey\(r\.part_number\)\)/);
    expect(src).toMatch(/const key = partKey\(r\.parent_part_no\)/);
  });

  it("fails closed when the prior-revision read fails", () => {
    // selectIn returns { error } with no data, so an unchecked failure leaves
    // priorRev empty, every assembly looks new, and the whole catalogue alerts
    // at once.
    expect(src).toMatch(/priorRevUsable = false/);
    expect(src).toMatch(/skipped: "prior_revision_read_failed"/);
  });
});

// ── Making the comparison actually fire ──────────────────────────────
//
// The truncation guard made the feature CORRECT. It also made it nearly
// silent: the incremental pull rarely returns a revised parent's unchanged
// children, so comparable() refused almost every tree. Resolving the missing
// children is what turns a correct-but-quiet feature into a working one.

describe("the pull resolves the children the incremental page left behind", () => {
  const src = read("src/api/_lib/plm-client.js");

  it("fetches missing child parts for Windchill", () => {
    expect(src).toMatch(/const resolveMissingChildren = async/);
    expect(src).toMatch(/\.filter\(\(id\) => id && !have\.has\(id\)\)/);
  });

  it("takes Arena's child from the BOM row, which already carries it", () => {
    // Arena returns childItem inline, so a child outside the incremental items
    // page is already in hand. The old code read only .guid and threw the rest
    // away, truncating the tree with the data to complete it on the same
    // response.
    expect(src).toMatch(/arenaChildParts\.push\(\{/);
    expect(src).toMatch(/number: kid\.number \?\? kid\.itemNumber/);
  });

  it("declares the Arena accumulators at FUNCTION scope", () => {
    // Declared inside the arena branch they are invisible where the results
    // are merged, so the merge silently never happens and the fix is dead
    // code that reads as live.
    // Searched FROM the function, not from the top of the file: the
    // resolveMissingChildren helper above it contains the same branch string,
    // so a plain indexOf pointed backwards and sliced an empty string — a test
    // that passes on nothing.
    const fnStart = src.indexOf("export const plmFetchBoms");
    const head = src.slice(fnStart, src.indexOf('if (s.system === "windchill")', fnStart));
    expect(head).toMatch(/const arenaChildParts = \[\];/);
    expect(head).toMatch(/const arenaSeen = new Set\(\);/);
  });

  it("escapes the id before putting it in an OData filter", () => {
    expect(src).toMatch(/replace\(\/'\/g, "''"\)/);
  });

  it("bounds the work — this runs inside a 20s cron budget", () => {
    expect(src).toMatch(/const MAX_RESOLVE_IDS = 200/);
    expect(src).toMatch(/const RESOLVE_CHUNK = 20/);
  });

  it("degrades to today's behaviour rather than to a false deletion", () => {
    // Anything still unresolved stays counted, so comparable() still refuses
    // the tree. A wrong filter syntax makes the pass a no-op, not a hazard —
    // which matters because this cannot be tested against a real Windchill.
    expect(src).toMatch(/catch \(_e\) \{ \/\* leave them unresolved/);
  });

  it("reports how much it could assemble, so quiet is distinguishable from broken", () => {
    // "0 drifted" reads identically whether every BOM matched or every tree
    // was refused. Those call for opposite responses.
    expect(src).toMatch(/boms\.resolution = resolution;/);
    expect(read("src/api/plm/sync.js")).toMatch(/result\.bom_resolution = boms\.resolution/);
  });
});
