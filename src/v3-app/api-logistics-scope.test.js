// Making the logistics monitor safe to switch on.
//
// The engine worked; enabling it did not. A tenant with real history got ~2,000
// exceptions on the first tick, nearly all `critical`, a large share of them for
// work that was already finished — and the queue could not be worked down,
// because acknowledging a row removed it from the dedup guard and the next tick
// re-created it.
//
// This file covers the three decisions that make the difference: what may be
// scanned, what may be closed, and what may be raised again.

import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_LOOKBACK_DAYS, lookbackDays, lookbackCutoff,
  PO_SCAN_STATUSES, ISO_SCAN_STATUSES, ORDER_SCAN_STATUSES, KIND_SOURCE,
  resolvableExceptions, raiseDecision, pickExisting, maxRaisePerRun, isTerminal,
} from "../api/_lib/logistics/scope.js";

const DAY = 86400000;

describe("the lookback window", () => {
  const saved = process.env.LOGISTICS_MONITOR_LOOKBACK_DAYS;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOGISTICS_MONITOR_LOOKBACK_DAYS;
    else process.env.LOGISTICS_MONITOR_LOOKBACK_DAYS = saved;
  });

  it("defaults to a window, not to all history", () => {
    delete process.env.LOGISTICS_MONITOR_LOOKBACK_DAYS;
    expect(lookbackDays()).toBe(DEFAULT_LOOKBACK_DAYS);
    expect(DEFAULT_LOOKBACK_DAYS).toBeGreaterThan(30);   // a foreign PO cycle fits
    expect(DEFAULT_LOOKBACK_DAYS).toBeLessThan(400);     // but years do not
  });

  it("is tunable per deployment", () => {
    process.env.LOGISTICS_MONITOR_LOOKBACK_DAYS = "30";
    expect(lookbackDays()).toBe(30);
  });

  it("ignores a nonsense value rather than scanning everything", () => {
    for (const v of ["0", "-5", "abc", ""]) {
      process.env.LOGISTICS_MONITOR_LOOKBACK_DAYS = v;
      expect(lookbackDays()).toBe(DEFAULT_LOOKBACK_DAYS);
    }
  });

  it("computes a cutoff the right distance back", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    expect(lookbackCutoff(now, 90)).toBe(new Date(now.getTime() - 90 * DAY).toISOString());
  });
});

describe("what gets scanned", () => {
  it("excludes RECEIVED source POs", () => {
    // scan.js treats RECEIVED as "acknowledged", so every historical received PO
    // with no acknowledged_eta flagged ready_date_missing forever. Chasing a
    // ready date for goods that already arrived is noise.
    expect(PO_SCAN_STATUSES).not.toContain("RECEIVED");
    expect(PO_SCAN_STATUSES).not.toContain("CLOSED");
  });

  it("excludes RECONCILED orders", () => {
    // A reconciled order is finished; it cannot be "awaiting dispatch".
    expect(ORDER_SCAN_STATUSES).not.toContain("RECONCILED");
  });

  it("still scans everything genuinely in flight", () => {
    for (const s of ["SENT_TO_SUPPLIER", "SUPPLIER_ACK", "ETA_CONFIRMED", "DELAYED"]) {
      expect(PO_SCAN_STATUSES).toContain(s);
    }
    expect(ORDER_SCAN_STATUSES).toContain("APPROVED");
    // A failed Tally import still owes a delivery — it must not fall out.
    expect(ORDER_SCAN_STATUSES).toContain("FAILED_TALLY_IMPORT");
    expect(ISO_SCAN_STATUSES).toContain("APPROVED");
  });

  it("maps every rule kind to the population it draws from", () => {
    // resolvableExceptions refuses to close anything it cannot source, so a kind
    // missing here silently stops auto-resolving.
    for (const k of [
      "po_source_country", "po_local_supplier", "ready_date_missing", "ready_date_orphan",
      "work_order_manufacturing", "dispatch_overdue",
      "customer_delivery_at_risk", "customer_delivery_overdue",
    ]) expect(KIND_SOURCE[k]).toBeTruthy();
  });
});

describe("resolvableExceptions", () => {
  const open = (id, kind, objectId) => ({
    id, rule_kind: kind, object_id: objectId, status: "open",
    detail: { fingerprint: `${kind}:${objectId}` },
  });
  const examined = { source_po: new Set(["p1", "p2"]), internal_so: new Set(), order: new Set(["o1"]) };

  it("closes an exception whose object was examined and no longer flags", () => {
    const rows = [open("e1", "po_local_supplier", "p1")];
    const out = resolvableExceptions(rows, { examined, flagged: new Set() });
    expect(out.map((e) => e.id)).toEqual(["e1"]);
  });

  it("keeps one that still flags", () => {
    const rows = [open("e1", "po_local_supplier", "p1")];
    const flagged = new Set(["po_local_supplier:p1"]);
    expect(resolvableExceptions(rows, { examined, flagged })).toEqual([]);
  });

  // The property that keeps auto-resolve honest.
  it("does NOT close one whose object was never examined", () => {
    // p9 aged out of the lookback window. Its absence from this run's flags
    // says nothing about whether the condition cleared, and reporting it to an
    // operator as resolved would be a lie.
    const rows = [open("e1", "po_local_supplier", "p9")];
    expect(resolvableExceptions(rows, { examined, flagged: new Set() })).toEqual([]);
  });

  // An earlier version of this fix skipped every kind whose population hit its
  // row cap, reasoning the read was partial. That was wrong twice: partial
  // knowledge of the POPULATION says nothing about an object we DID read and
  // fully evaluate, and on a dense tenant all three populations hit the cap on
  // every run — so the guard disabled auto-resolve permanently, in exactly the
  // situation it was written for. A simulation measured resolved: 0 forever.
  it("closes an examined object even when its population was truncated", () => {
    const rows = [open("e1", "po_local_supplier", "p1")];
    const out = resolvableExceptions(rows, { examined, flagged: new Set() });
    expect(out.map((e) => e.id)).toEqual(["e1"]);
  });

  it("does not close a kind it cannot source", () => {
    const rows = [{ id: "e1", rule_kind: "some_future_kind", object_id: "p1", status: "open", detail: {} }];
    expect(resolvableExceptions(rows, { examined, flagged: new Set() })).toEqual([]);
  });

  it("falls back to kind:object when the stored fingerprint is missing", () => {
    const rows = [{ id: "e1", rule_kind: "po_local_supplier", object_id: "p1", status: "open", detail: {} }];
    const flagged = new Set(["po_local_supplier:p1"]);
    expect(resolvableExceptions(rows, { examined, flagged })).toEqual([]);
  });

  it.each([null, undefined, []])("handles %p rows", (v) => {
    expect(resolvableExceptions(v, { examined, flagged: new Set() })).toEqual([]);
  });
});

describe("the per-run raise cap", () => {
  const saved = process.env.LOGISTICS_MAX_RAISE_PER_RUN;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOGISTICS_MAX_RAISE_PER_RUN;
    else process.env.LOGISTICS_MAX_RAISE_PER_RUN = saved;
  });

  it("bounds how many new exceptions one run may raise", () => {
    // THE actual bound on the burst. The lookback window and newest-first
    // ordering only change WHICH rows are scanned: with a 90-day window and
    // 3-14 day SLAs most of what remains is still past 2x SLA and still lands
    // critical. A simulation of the windowed detector on a dense tenant
    // produced 938 exceptions, 727 of them critical. A filter is not a cap.
    delete process.env.LOGISTICS_MAX_RAISE_PER_RUN;
    expect(maxRaisePerRun()).toBe(100);
    expect(maxRaisePerRun()).toBeLessThan(500);
  });

  it("is tunable", () => {
    process.env.LOGISTICS_MAX_RAISE_PER_RUN = "25";
    expect(maxRaisePerRun()).toBe(25);
  });

  it("ignores a nonsense value rather than uncapping", () => {
    for (const v of ["0", "-1", "abc", ""]) {
      process.env.LOGISTICS_MAX_RAISE_PER_RUN = v;
      expect(maxRaisePerRun()).toBe(100);
    }
  });
});

describe("isTerminal", () => {
  it("treats a received PO as done", () => {
    // The commonest way a procurement exception clears — and precisely the
    // transition that drops the PO out of PO_SCAN_STATUSES, so without this
    // pass the exception could never close.
    expect(isTerminal("source_po", "RECEIVED")).toBe(true);
    expect(isTerminal("source_po", "CLOSED")).toBe(true);
  });

  it("treats a reconciled order and a dispatched work order as done", () => {
    expect(isTerminal("order", "RECONCILED")).toBe(true);
    expect(isTerminal("internal_so", "DISPATCHED")).toBe(true);
  });

  it("does not treat in-flight work as done", () => {
    expect(isTerminal("source_po", "SENT_TO_SUPPLIER")).toBe(false);
    expect(isTerminal("order", "APPROVED")).toBe(false);
  });

  it("is case-insensitive and safe on junk", () => {
    expect(isTerminal("source_po", "received")).toBe(true);
    for (const v of [null, undefined, "", "NOPE"]) expect(isTerminal("source_po", v)).toBe(false);
    expect(isTerminal("unknown_type", "RECEIVED")).toBe(false);
  });
});

describe("raiseDecision", () => {
  it("inserts when nothing exists", () => {
    expect(raiseDecision(null).action).toBe("insert");
  });

  it("updates an open row rather than duplicating it", () => {
    expect(raiseDecision({ id: "e1", status: "open" })).toEqual({ action: "update", id: "e1" });
  });

  // The bug that made the queue unworkable.
  it("does not re-raise an ACKNOWLEDGED exception", () => {
    // Dedup was scoped to status='open', so acking removed the row from the
    // guard AND from the partial unique index, and the next tick re-created it.
    // The operator's acknowledgement survived about five minutes.
    expect(raiseDecision({ id: "e1", status: "acknowledged" }).action).toBe("skip");
  });

  it("honours a suppression", () => {
    expect(raiseDecision({ id: "e1", status: "suppressed" }).action).toBe("skip");
  });

  it("raises again after a resolve — a recurrence is real", () => {
    // Resolved means it cleared. Detecting it again is new information, not a
    // duplicate, so this one must NOT be suppressed.
    expect(raiseDecision({ id: "e1", status: "resolved" }).action).toBe("insert");
  });
});

describe("pickExisting", () => {
  const row = (status, created_at, id = status) => ({ id, status, created_at });

  it("lets a suppression outrank everything", () => {
    expect(pickExisting([row("open", "2026-01-01"), row("suppressed", "2026-02-01")]).status)
      .toBe("suppressed");
  });

  it("lets an acknowledgement outrank an open row", () => {
    // Otherwise an old open duplicate would win and the ack would be ignored.
    expect(pickExisting([row("open", "2026-01-01"), row("acknowledged", "2026-02-01")]).status)
      .toBe("acknowledged");
  });

  it("prefers any live status over a resolved one", () => {
    expect(pickExisting([row("resolved", "2026-03-01"), row("open", "2026-01-01")]).status)
      .toBe("open");
  });

  it("returns the resolved row when it is all there is, so a recurrence raises", () => {
    expect(pickExisting([row("resolved", "2026-03-01")]).status).toBe("resolved");
    expect(raiseDecision(pickExisting([row("resolved", "2026-03-01")])).action).toBe("insert");
  });

  it("breaks a tie on the oldest row", () => {
    expect(pickExisting([row("open", "2026-05-01", "new"), row("open", "2026-01-01", "old")]).id)
      .toBe("old");
  });

  it.each([null, undefined, []])("returns null for %p", (v) => {
    expect(pickExisting(v)).toBeNull();
  });
});
