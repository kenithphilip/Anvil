// Unit tests for the logistics monitor pure helpers (Logistics Ops P1):
// rules-over-defaults merge, rule->scan slas mapping, ageing severity, and the
// scan-flag -> logistics_exceptions row shape (fingerprint + SLA clock).

import { describe, it, expect } from "vitest";
import {
  DEFAULT_MONITOR_RULES, mergeRules, rulesToSlas, severityFor, flagToException, __test,
} from "../api/_lib/logistics/monitor.js";

// Minimal chainable Supabase stub: the SELECT chain ends in .limit() (awaited),
// UPDATE ends in .eq() (awaited), INSERT ends in .single(). Captures the update
// payload + insert row so the ratchet behaviour is observable.
function mockSvc({ existingRow, captures }) {
  return {
    from() {
      const state = { op: null };
      const builder = {
        select() { state.op = state.op || "select"; return builder; },
        insert(row) { state.op = "insert"; captures.insert = row; return builder; },
        update(p) { state.op = "update"; captures.update = p; return builder; },
        eq() { return builder; },
        filter() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        single() { return Promise.resolve({ data: { id: "new-id" }, error: null }); },
        then(resolve) {
          if (state.op === "update") return resolve({ error: null });
          return resolve({ data: existingRow ? [existingRow] : [], error: null });
        },
      };
      return builder;
    },
  };
}

const NOW = "2026-07-14T00:00:00.000Z";

describe("mergeRules", () => {
  it("returns the built-in defaults when the tenant has no rows", () => {
    const map = mergeRules([]);
    expect(Object.keys(map).sort()).toEqual(DEFAULT_MONITOR_RULES.map((r) => r.rule_kind).sort());
    expect(map.po_source_country.threshold_days).toBe(14);
  });
  it("overlays a tenant row onto the default for that kind", () => {
    const map = mergeRules([{ rule_kind: "po_local_supplier", threshold_days: 3, severity: "bad", active: true }]);
    expect(map.po_local_supplier.threshold_days).toBe(3);
    expect(map.po_local_supplier.severity).toBe("bad");
    // untouched kinds keep their defaults
    expect(map.po_source_country.threshold_days).toBe(14);
  });
  it("an explicit active=false row disables a default kind", () => {
    const map = mergeRules([{ rule_kind: "ready_date_orphan", active: false }]);
    expect(map.ready_date_orphan.active).toBe(false);
  });
});

describe("rulesToSlas", () => {
  it("maps threshold_days into the keys scan() expects (ready_date -> ready_date_wait)", () => {
    const map = mergeRules([{ rule_kind: "ready_date_missing", threshold_days: 9 }]);
    const slas = rulesToSlas(map);
    expect(slas).toEqual({
      po_source_country: 14,
      po_local_supplier: 7,
      work_order_manufacturing: 5,
      ready_date_wait: 9,
      dispatch_overdue: 3,
      delivery_risk_window: 3,
    });
  });
  it("omits a knob when its threshold is null (orphan has none)", () => {
    const slas = rulesToSlas(mergeRules([]));
    expect(slas.ready_date_wait).toBe(7);
    expect("ready_date_orphan" in slas).toBe(false);
  });
});

describe("severityFor (ages up as the item passes 2x SLA)", () => {
  const rule = { severity: "warn" };
  it("maps scan low/medium onto info/warn honouring the rule floor", () => {
    expect(severityFor({ severity: "low" }, { severity: "info" })).toBe("info");
    expect(severityFor({ severity: "medium" }, rule)).toBe("warn");
    expect(severityFor({ severity: "low" }, rule)).toBe("warn"); // floor lifts info -> warn
  });
  it("escalates one notch when scan severity is high (past 2x SLA)", () => {
    expect(severityFor({ severity: "high" }, { severity: "warn" })).toBe("critical"); // base bad -> bump critical
    expect(severityFor({ severity: "high" }, { severity: "info" })).toBe("critical");
  });
});

describe("flagToException", () => {
  const flag = {
    kind: "po_source_country", severity: "medium", ref_type: "source_po",
    ref_id: "po-1", ref_label: "SPO-1", supplier: "Acme JP", order_id: "o-1",
    elapsed_days: 20, sla_days: 14, detail: "sent 20d ago",
  };
  it("builds a deduped exception row with an SLA clock", () => {
    const rule = { active: true, severity: "warn", sla_hours: 48 };
    const row = flagToException(flag, rule, "t1", NOW);
    expect(row.tenant_id).toBe("t1");
    expect(row.rule_kind).toBe("po_source_country");
    expect(row.object_type).toBe("source_po");
    expect(row.object_id).toBe("po-1");
    expect(row.status).toBe("open");
    expect(row.detail.fingerprint).toBe("po_source_country:po-1"); // no date -> one open row per (kind,object)
    expect(row.detail.elapsed_days).toBe(20);
    // SLA target = now + 48h
    expect(row.sla_target_at).toBe("2026-07-16T00:00:00.000Z");
  });
  it("returns null when the rule is disabled", () => {
    expect(flagToException(flag, { active: false }, "t1", NOW)).toBe(null);
  });
  it("leaves sla_target_at null when the rule has no sla_hours", () => {
    const row = flagToException(flag, { active: true, severity: "info" }, "t1", NOW);
    expect(row.sla_target_at).toBe(null);
  });
});

describe("upsertException — aging escalation + dedup", () => {
  const row = (severity) => ({
    tenant_id: "t1", rule_kind: "po_source_country", severity,
    detail: { fingerprint: "po_source_country:po-1" },
  });
  // The prior row is now passed IN rather than looked up here: the caller reads
  // every exception for the tenant once and maps by fingerprint. At ~2,000 flags
  // the old select-per-flag was ~4,000 round-trips inside a 20s handler budget,
  // so detection was killed mid-run and the phases after it never executed.
  const openRow = (severity) => ({ id: "e1", severity, status: "open", detail: {} });

  it("ratchets an open row's severity UP when this tick is higher", async () => {
    const captures = {};
    const svc = mockSvc({ captures });
    const r = await __test.upsertException(svc, row("critical"), openRow("warn"));
    expect(r).toMatchObject({ skipped: true, escalated: true, id: "e1" });
    expect(captures.update).toMatchObject({ severity: "critical" });
    expect(captures.insert).toBeUndefined(); // no duplicate row
  });
  it("never downgrades an already-higher open row", async () => {
    const captures = {};
    const svc = mockSvc({ captures });
    const r = await __test.upsertException(svc, row("warn"), openRow("critical"));
    expect(r).toMatchObject({ skipped: true, id: "e1" });
    expect(r.escalated).toBe(false);
    expect(captures.update).not.toHaveProperty("severity");
    expect(captures.insert).toBeUndefined();
  });
  it("refreshes the detail text on an open row so it does not go stale", async () => {
    // On a dedup hit the update used to set only { severity, updated_at }, so an
    // exception opened weeks ago still read "sent 14d ago" while the real figure
    // climbed — the operator triaged by a number that had stopped moving.
    const captures = {};
    const svc = mockSvc({ captures });
    const fresh = { ...row("warn"), detail: { fingerprint: "po_source_country:po-1", elapsed_days: 41 } };
    await __test.upsertException(svc, fresh, openRow("warn"));
    expect(captures.update.detail).toMatchObject({ elapsed_days: 41 });
  });
  it("carries the notified flags across a refresh, so nothing re-sends", async () => {
    const captures = {};
    const svc = mockSvc({ captures });
    const existing = { id: "e1", severity: "warn", status: "open", detail: { notified: { bell_at: "2026-08-01T00:00:00.000Z" } } };
    await __test.upsertException(svc, row("warn"), existing);
    expect(captures.update.detail.notified).toEqual({ bell_at: "2026-08-01T00:00:00.000Z" });
  });
  it("does NOT re-raise an acknowledged exception", async () => {
    // Dedup was scoped to status='open', so acking dropped the row from the
    // guard and the next tick re-created it — the ack lasted five minutes.
    const captures = {};
    const svc = mockSvc({ captures });
    const r = await __test.upsertException(svc, row("critical"), { id: "e1", status: "acknowledged", severity: "warn" });
    expect(r).toMatchObject({ skipped: true, reason: "acknowledged", id: "e1" });
    expect(captures.insert).toBeUndefined();
    expect(captures.update).toBeUndefined();
  });
  it("honours a suppression", async () => {
    const captures = {};
    const svc = mockSvc({ captures });
    const r = await __test.upsertException(svc, row("critical"), { id: "e1", status: "suppressed", severity: "warn" });
    expect(r).toMatchObject({ skipped: true, reason: "suppressed" });
    expect(captures.insert).toBeUndefined();
  });
  it("raises again after a resolve — a recurrence is real information", async () => {
    const captures = {};
    const svc = mockSvc({ captures });
    const r = await __test.upsertException(svc, row("warn"), { id: "e1", status: "resolved", severity: "warn" });
    expect(r).toMatchObject({ id: "new-id" });
    expect(captures.insert).toMatchObject({ rule_kind: "po_source_country" });
  });
  it("inserts a fresh row when none is open", async () => {
    const captures = {};
    const svc = mockSvc({ existingRow: null, captures });
    const r = await __test.upsertException(svc, row("warn"), null);
    expect(r).toMatchObject({ id: "new-id" });
    expect(captures.insert).toMatchObject({ rule_kind: "po_source_country", severity: "warn" });
  });
});
