// "How many times has this been delayed, and is it still going to make the date?"
//
// The workbook answers the first half with a hand-maintained "No. of Delays"
// column. Mirroring that into a column would have imported a number Anvil could
// never verify and that could silently disagree with the dates beside it — so
// the count is DERIVED from an append-only observation log instead.
//
// The count is also not the thing to act on. A shipment revised five times that
// still lands three weeks inside its commitment needs nobody; one revised once
// that now lands two days late is the emergency. This module supplies the slip;
// float against the customer's date (P2) decides whether it matters.

import { describe, it, expect } from "vitest";
import {
  dayDelta, etaChanged, buildObservation, summarise, describe as describeSlip, resolvePromise,
} from "../api/_lib/logistics/eta-history.js";

const obs = (o) => ({ kind: "revision", observed_at: "2026-08-01T00:00:00.000Z", ...o });

describe("dayDelta", () => {
  it("counts whole days, positive when later", () => {
    expect(dayDelta("2026-08-01", "2026-08-09")).toBe(8);
    expect(dayDelta("2026-08-09", "2026-08-01")).toBe(-8);
    expect(dayDelta("2026-08-01", "2026-08-01")).toBe(0);
  });

  it("is null unless both dates parse", () => {
    for (const [a, b] of [[null, "2026-08-01"], ["2026-08-01", null], ["x", "2026-08-01"], [null, null]]) {
      expect(dayDelta(a, b)).toBeNull();
    }
  });

  it("is not thrown off by a timestamp against a date", () => {
    expect(dayDelta("2026-08-01", "2026-08-03T00:00:00.000Z")).toBe(2);
  });
});

describe("etaChanged — the write gate", () => {
  it("is true for the first observation", () => {
    expect(etaChanged(null, { eta_port: "2026-08-01" })).toBe(true);
  });

  it("is false when nothing moved, so a re-import writes nothing", () => {
    // The daily workbook is re-uploaded whole. Every row must not become a
    // revision, or the count is just "how many times we imported".
    const prev = { eta_port: "2026-08-01", eta_store: "2026-08-09" };
    expect(etaChanged(prev, { ...prev })).toBe(false);
  });

  it("is true when either hop moves", () => {
    const prev = { eta_port: "2026-08-01", eta_store: "2026-08-09" };
    expect(etaChanged(prev, { ...prev, eta_port: "2026-08-04" })).toBe(true);
    expect(etaChanged(prev, { ...prev, eta_store: "2026-08-14" })).toBe(true);
  });

  // The one that would manufacture slip out of a formatting accident.
  it("is false when the new sheet just left the cell blank", () => {
    // Sheets drop columns and blank cells routinely. Treating that as a
    // revision would invent a delay nobody reported.
    const prev = { eta_port: "2026-08-01", eta_store: "2026-08-09" };
    expect(etaChanged(prev, { eta_port: null, eta_store: null })).toBe(false);
    expect(etaChanged(prev, { eta_port: "2026-08-01", eta_store: null })).toBe(false);
  });

  it("is false for a missing observation entirely", () => {
    expect(etaChanged({ eta_port: "2026-08-01" }, null)).toBe(false);
    expect(etaChanged(null, {})).toBe(false);
  });
});

describe("buildObservation", () => {
  const meta = { tenantId: "t1", shipmentId: "s1", observedAt: "2026-08-07T00:00:00.000Z" };

  it("marks the first row as the baseline", () => {
    const row = buildObservation(null, { eta_port: "2026-08-01", eta_store: "2026-08-09" }, meta);
    expect(row.kind).toBe("baseline");
    expect(row.prev_eta_port).toBeNull();
    expect(row.slip_port_days).toBeNull();   // nothing to slip from yet
  });

  it("records the movement and what it moved from", () => {
    const prev = { eta_port: "2026-08-01", eta_store: "2026-08-09" };
    const row = buildObservation(prev, { eta_port: "2026-08-04", eta_store: "2026-08-14" }, meta);
    expect(row.kind).toBe("revision");
    expect(row.prev_eta_port).toBe("2026-08-01");
    expect(row.slip_port_days).toBe(3);
    expect(row.slip_store_days).toBe(5);
  });

  it("returns null when nothing moved", () => {
    const prev = { eta_port: "2026-08-01", eta_store: "2026-08-09" };
    expect(buildObservation(prev, { ...prev }, meta)).toBeNull();
  });

  it("carries a blank field forward instead of recording a regression to null", () => {
    const prev = { eta_port: "2026-08-01", eta_store: "2026-08-09" };
    const row = buildObservation(prev, { eta_port: "2026-08-04", eta_store: null }, meta);
    expect(row.eta_store).toBe("2026-08-09");   // held, not nulled
    expect(row.slip_store_days).toBe(0);
  });

  it("records a pull-in as negative slip", () => {
    const prev = { eta_store: "2026-08-20" };
    const row = buildObservation(prev, { eta_store: "2026-08-14" }, meta);
    expect(row.slip_store_days).toBe(-6);
  });
});

describe("summarise", () => {
  it("reports zero revisions for a shipment observed once", () => {
    // Counting ROWS would say 1 and overstate every shipment in the system by
    // one: a first promise is not a delay.
    const s = summarise([obs({ kind: "baseline", eta_store: "2026-08-09" })]);
    expect(s.revisions).toBe(0);
    expect(s.has_history).toBe(true);
    expect(s.slip_store_days).toBe(0);
  });

  it("counts revisions and cumulative slip against the baseline", () => {
    const s = summarise([
      obs({ kind: "baseline", eta_store: "2026-08-01", observed_at: "2026-07-01T00:00:00Z" }),
      obs({ eta_store: "2026-08-08", slip_store_days: 7, observed_at: "2026-07-10T00:00:00Z" }),
      obs({ eta_store: "2026-08-15", slip_store_days: 7, observed_at: "2026-07-20T00:00:00Z" }),
    ]);
    expect(s.revisions).toBe(2);
    expect(s.baseline_eta_store).toBe("2026-08-01");
    expect(s.current_eta_store).toBe("2026-08-15");
    expect(s.slip_store_days).toBe(14);
  });

  // The reason slip is measured against the baseline, not summed.
  it("nets out a slip that was partly recovered", () => {
    const s = summarise([
      obs({ kind: "baseline", eta_store: "2026-08-01", observed_at: "2026-07-01T00:00:00Z" }),
      obs({ eta_store: "2026-08-15", slip_store_days: 14, observed_at: "2026-07-10T00:00:00Z" }),
      obs({ eta_store: "2026-08-08", slip_store_days: -7, observed_at: "2026-07-20T00:00:00Z" }),
    ]);
    // Summing absolute movements would call this 21 days late. It is 7.
    expect(s.slip_store_days).toBe(7);
    expect(s.worst_single_slip_days).toBe(14);
    expect(s.improving).toBe(true);
  });

  it("orders by observation time, not array order", () => {
    const s = summarise([
      obs({ eta_store: "2026-08-15", observed_at: "2026-07-20T00:00:00Z" }),
      obs({ kind: "baseline", eta_store: "2026-08-01", observed_at: "2026-07-01T00:00:00Z" }),
    ]);
    expect(s.baseline_eta_store).toBe("2026-08-01");
    expect(s.current_eta_store).toBe("2026-08-15");
  });

  it("reports no history rather than zeros for a shipment never observed", () => {
    // A shipment with no log has not been "on time" — it is unknown, and the UI
    // must be able to tell the difference.
    for (const v of [[], null, undefined]) {
      const s = summarise(v);
      expect(s.has_history).toBe(false);
      expect(s.slip_store_days).toBeNull();
    }
  });
});

describe("describe", () => {
  const sum = (rows) => summarise(rows);

  it("says nothing has moved when nothing has", () => {
    expect(describeSlip(sum([obs({ kind: "baseline", eta_store: "2026-08-09" })])))
      .toBe("ETA unchanged since first reported");
  });

  it("reads naturally for one revision", () => {
    const s = sum([
      obs({ kind: "baseline", eta_store: "2026-08-01", observed_at: "2026-07-01T00:00:00Z" }),
      obs({ eta_store: "2026-08-04", slip_store_days: 3, observed_at: "2026-07-10T00:00:00Z" }),
    ]);
    expect(describeSlip(s)).toBe("Revised once, now 3d later than first promised");
  });

  it("reads naturally for several, and for a recovery", () => {
    const s = sum([
      obs({ kind: "baseline", eta_store: "2026-08-10", observed_at: "2026-07-01T00:00:00Z" }),
      obs({ eta_store: "2026-08-20", slip_store_days: 10, observed_at: "2026-07-05T00:00:00Z" }),
      obs({ eta_store: "2026-08-05", slip_store_days: -15, observed_at: "2026-07-09T00:00:00Z" }),
    ]);
    expect(describeSlip(s)).toBe("Revised 2 times, now 5d earlier than first promised");
  });

  it("does not claim a severity it cannot know", () => {
    // Whether a slip matters depends on float against the customer's date,
    // which this module has no access to. Saying "3 days late" here would be a
    // claim about the commitment, not about the promise.
    const s = sum([
      obs({ kind: "baseline", eta_store: "2026-08-01", observed_at: "2026-07-01T00:00:00Z" }),
      obs({ eta_store: "2026-08-04", slip_store_days: 3, observed_at: "2026-07-10T00:00:00Z" }),
    ]);
    // Word boundaries: "3d later than first promised" is the wording we WANT —
    // it describes movement of the promise. "late" would be a claim about the
    // commitment, which this module cannot see.
    expect(describeSlip(s)).not.toMatch(/\b(late|overdue|urgent|critical|risk|breach)\b/i);
    expect(describeSlip(s)).toMatch(/later than first promised/);
  });

  it("returns null when there is no history to describe", () => {
    expect(describeSlip(summarise([]))).toBeNull();
    expect(describeSlip(null)).toBeNull();
  });
});

// The frontend parses the workbook client-side and the server uses those rows
// as-is, so a field added server-side only exists if the BROWSER is current.
// A tab opened before the deploy posted rows without `eta_port_current`; the
// naive read produced { null, null }, etaChanged said "nothing moved", and the
// import recorded NOTHING while reporting success. Confirmed in production:
// migration applied, import run, zero rows, no error.
describe("resolvePromise — surviving a stale client bundle", () => {
  it("uses the current-ETA fields when the client provides them", () => {
    const r = resolvePromise({ eta_port_current: "2026-08-22", eta_store_current: "2026-08-29", eta_india: "2026-07-29" });
    expect(r).toEqual({ eta_port: "2026-08-22", eta_store: "2026-08-29", degraded: false });
  });

  it("falls back to the legacy fields when the client is old", () => {
    // Those carry the ORIGINAL promise, which is exactly right for a baseline —
    // so an old client still seeds the log instead of writing nothing.
    const r = resolvePromise({ eta_india: "2026-07-29", eta_store: "2026-08-06" });
    expect(r).toEqual({ eta_port: "2026-07-29", eta_store: "2026-08-06", degraded: true });
  });

  it("decides on the KEY, not the value", () => {
    // A current bundle sets both keys even for a shipment with no ETA on the
    // sheet. Testing truthiness would misread that as a stale client and then
    // silently record the legacy value instead.
    const r = resolvePromise({ eta_port_current: "", eta_store_current: "", eta_india: "2026-07-29" });
    expect(r.degraded).toBe(false);
    expect(r.eta_port).toBeNull();
  });

  it("writes a real observation from a stale client rather than nothing", () => {
    // The regression this exists for, end to end.
    const stale = { eta_india: "2026-07-29", eta_store: "2026-08-06" };
    const obs = buildObservation(null, resolvePromise(stale), { tenantId: "t", shipmentId: "s" });
    expect(obs).not.toBeNull();
    expect(obs.kind).toBe("baseline");
    expect(obs.eta_port).toBe("2026-07-29");
  });

  it("detects the revision once the browser updates", () => {
    // Baseline seeded by the old bundle, then the real current ETA arrives.
    const baseline = buildObservation(null, resolvePromise({ eta_india: "2026-07-29", eta_store: "2026-08-06" }), { tenantId: "t", shipmentId: "s" });
    const fresh = resolvePromise({ eta_port_current: "2026-08-22", eta_store_current: "2026-08-29" });
    const rev = buildObservation(baseline, fresh, { tenantId: "t", shipmentId: "s" });
    expect(rev.kind).toBe("revision");
    expect(rev.slip_port_days).toBe(24);
  });

  it.each([null, undefined, {}])("returns nulls for %p without throwing", (v) => {
    const r = resolvePromise(v);
    expect(r.eta_port).toBeNull();
    expect(r.eta_store).toBeNull();
  });
});
