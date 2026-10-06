// A failed extraction must not blank the order.
//
// The bug, on a live order: runExtraction wrote `lineItems: lines`
// unconditionally, so a run that returned nothing replaced 44 good extracted
// lines with an empty array. Nothing warned; the recon table simply showed
// "0 lines" afterwards.
//
// The unit tests for mergeExtractedLines cannot catch this, because the guard
// lives at the CALL SITE — merge is simply not invoked on an empty run. This
// asserts the PATCH that actually goes over the wire.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

const EXISTING = [
  { customerItemCode: "A12060OBAR010003", quantity: 1, unitPrice: 1000.8, lineTotal: 1180.94 },
  { customerItemCode: "A44146OBAR010001", quantity: 1, unitPrice: 963.9, lineTotal: 1137.4 },
];

const orderWith = (lineItems: any[]) => ({
  id: "ord-preserve-1",
  status: "DRAFT",
  po_number: "0066026562",
  customer_id: "cust-1",
  customer_name: "Fixture Customer",
  result: { salesOrder: { lineItems } },
  preflight_payload: { source_document_id: "doc-1" },
  documents: [{ id: "doc-1" }],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

// Drive the screen's own "run extraction" control and return every PATCH it made.
const runExtraction = async (order: any, extractResult: any) => {
  const original = window.location.hash;
  const update = vi.fn(async (..._args: any[]) => ({}));
  try {
    window.location.hash = "#/so?id=" + order.id;
    installBackend({
      orders: { get: vi.fn(async () => ({ order })), update },
      docai: { extract: vi.fn(async () => extractResult) },
      audit: { list: vi.fn(async () => []) },
      events: { list: vi.fn(async () => []) },
      cost: { breakdown: vi.fn(async () => null) },
    });
    const mod = await import("./so-workspace");
    const { container } = renderScreen(mod.default);
    await waitFor(() => { expect(container.innerHTML).toContain("run extraction"); });
    const btn = [...container.querySelectorAll("button")]
      .find((b) => (b.textContent || "").trim().toLowerCase() === "run extraction");
    expect(btn).toBeTruthy();
    btn!.click();
    await waitFor(() => { expect(update).toHaveBeenCalled(); });
    return update.mock.calls.map((c: any[]) => c[1]) as any[];
  } finally {
    window.location.hash = original;
  }
};

describe("a run that extracts nothing", () => {
  it("leaves the existing lines exactly as they were", async () => {
    const patches = await runExtraction(
      orderWith(EXISTING),
      { ok: false, normalized: { lines: [] }, adapter_used: "llamaparse" },
    );
    expect(patches.length).toBeGreaterThan(0);
    // The patch still carries salesOrder (it spreads the previous one to update
    // customer + metadata), so the invariant is not "lineItems is absent" — it
    // is that the lines are UNCHANGED. Asserting absence would pass for a patch
    // that wrote `lineItems: []`, which is the bug.
    for (const p of patches as any[]) {
      const li = p?.result?.salesOrder?.lineItems;
      if (li === undefined) continue;
      expect(li).toEqual(EXISTING);
      expect(li).not.toEqual([]);
    }
  });

  it("never writes an empty lineItems array — the exact shape of the bug", async () => {
    const patches = await runExtraction(
      orderWith(EXISTING),
      { ok: false, normalized: { lines: [] }, adapter_used: "llamaparse" },
    );
    for (const p of patches as any[]) {
      const li = p?.result?.salesOrder?.lineItems;
      if (Array.isArray(li)) expect(li.length).toBe(EXISTING.length);
    }
  });

  it("still records the run metadata, so the failure is visible", async () => {
    const patches = await runExtraction(
      orderWith(EXISTING),
      { ok: false, normalized: { lines: [] }, adapter_used: "llamaparse" },
    );
    const withPreflight: any = patches.find((p: any) => p?.preflight_payload);
    expect(withPreflight?.preflight_payload?.last_extracted_at).toBeTruthy();
  });

  it("does not stamp extraction_run_id on an empty result", async () => {
    // Pre-existing guard; asserted here so the two stay consistent.
    const patches = await runExtraction(
      orderWith(EXISTING),
      { ok: false, normalized: { lines: [] }, run_id: "run-9", adapter_used: "llamaparse" },
    );
    for (const p of patches as any[]) {
      expect(p?.preflight_payload?.extraction_run_id).toBeUndefined();
    }
  });
});

describe("a run that extracts lines", () => {
  it("writes the new lines", async () => {
    const fresh = [{ customerItemCode: "NEW-1", quantity: 2, unitPrice: 50 }];
    const patches = await runExtraction(
      orderWith(EXISTING),
      { ok: true, normalized: { lines: fresh }, adapter_used: "gemini" },
    );
    const written: any = patches.find((p: any) => p?.result?.salesOrder?.lineItems);
    expect(written?.result.salesOrder.lineItems.map((l: any) => l.customerItemCode)).toEqual(["NEW-1"]);
  });

  it("carries forward a manually added line the extractor still cannot see", async () => {
    const withManual = [...EXISTING, { customerItemCode: "A44127OBAR010012", quantity: 1, unitPrice: 20070, _origin: "operator_recovered" }];
    const fresh = [{ customerItemCode: "A12060OBAR010003", quantity: 1, unitPrice: 1000.8 }];
    const patches = await runExtraction(
      orderWith(withManual),
      { ok: true, normalized: { lines: fresh }, adapter_used: "gemini" },
    );
    const written: any = patches.find((p: any) => p?.result?.salesOrder?.lineItems);
    const codes = written?.result.salesOrder.lineItems.map((l: any) => l.customerItemCode);
    expect(codes).toContain("A44127OBAR010012");   // the operator's line survived
    expect(codes).toContain("A12060OBAR010003");   // the fresh line is there
    expect(codes).not.toContain("A44146OBAR010001"); // a stale EXTRACTED line is gone
  });
});
