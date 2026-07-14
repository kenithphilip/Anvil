// Unit tests for the logistics monitor pure helpers (Logistics Ops P1):
// rules-over-defaults merge, rule->scan slas mapping, ageing severity, and the
// scan-flag -> logistics_exceptions row shape (fingerprint + SLA clock).

import { describe, it, expect } from "vitest";
import {
  DEFAULT_MONITOR_RULES, mergeRules, rulesToSlas, severityFor, flagToException,
} from "../api/_lib/logistics/monitor.js";

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
