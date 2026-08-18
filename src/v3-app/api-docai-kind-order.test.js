// The only adapter that can read a quote was the one most likely never to run.
//
// Each non-PO document kind is a schema branch INSIDE an adapter, not a
// separate adapter — and only claude.js has those branches. Every other adapter
// silently runs the purchase-order schema whatever `kind` says, so a quotation
// handed to Gemini classifies as non_po and yields nothing usable.
//
// In principle the dispatcher survives that: it keeps the best result, so
// Claude's real parse beats Gemini's empty one. In practice Claude sits LAST in
// the default order — ["gemini","docling","marker","unstructured","azure_di",
// "reducto","claude"] — behind six adapters sharing one 45s run budget, and
// allocateAdapterDeadline SKIPS an adapter outright once its slice drops below
// the floor.

import { describe, it, expect } from "vitest";
import { orderForKind, KIND_CAPABLE_ADAPTERS } from "../api/_lib/docai/index.js";
import { DEFAULT_PROVIDER_ORDER } from "../api/_lib/docai/provider-order.js";

describe("orderForKind", () => {
  it("moves the quote-capable adapter to the front of the default order", () => {
    // The regression: claude is last by default, and quote is claude-only.
    expect(DEFAULT_PROVIDER_ORDER.at(-1)).toBe("claude");
    const out = orderForKind([...DEFAULT_PROVIDER_ORDER], "quote");
    expect(out[0]).toBe("claude");
  });

  it("REORDERS rather than filters, so an unconfigured claude still falls through", () => {
    const out = orderForKind([...DEFAULT_PROVIDER_ORDER], "quote");
    expect(out).toHaveLength(DEFAULT_PROVIDER_ORDER.length);
    expect([...out].sort()).toEqual([...DEFAULT_PROVIDER_ORDER].sort());
  });

  it("preserves the relative order of the rest", () => {
    const out = orderForKind(["gemini", "docling", "claude", "marker"], "quote");
    expect(out).toEqual(["claude", "gemini", "docling", "marker"]);
  });

  it("leaves a kind nobody special-cases exactly as it was", () => {
    // po / rfq / invoice run on every adapter; reordering would be meddling.
    for (const kind of ["po", "rfq", "invoice", "eway_bill"]) {
      expect(orderForKind([...DEFAULT_PROVIDER_ORDER], kind)).toEqual([...DEFAULT_PROVIDER_ORDER]);
    }
  });

  it("leaves the order alone when no capable adapter is present", () => {
    // Nothing to promote — do not invent one.
    const order = ["gemini", "docling"];
    expect(orderForKind(order, "quote")).toEqual(order);
  });

  it("covers the other claude-only kinds too", () => {
    for (const kind of ["supplier_ack", "assembly_bom", "part_drawing"]) {
      expect(orderForKind([...DEFAULT_PROVIDER_ORDER], kind)[0]).toBe("claude");
    }
  });

  it.each([undefined, null, "", "unknown_kind"])("is a no-op for %p", (k) => {
    const order = [...DEFAULT_PROVIDER_ORDER];
    expect(orderForKind(order, k)).toEqual(order);
  });

  it("does not throw on a malformed order", () => {
    expect(orderForKind(null, "quote")).toBeNull();
    expect(orderForKind(undefined, "quote")).toBeUndefined();
  });
});

describe("the capability map", () => {
  it("names only adapters that exist", async () => {
    const { ADAPTER_NAMES } = await import("../api/_lib/docai/index.js");
    for (const list of Object.values(KIND_CAPABLE_ADAPTERS)) {
      for (const a of list) expect(ADAPTER_NAMES).toContain(a);
    }
  });

  it("matches which adapters actually implement a quote branch", async () => {
    // If a quote branch is ever added to another adapter, this test fails until
    // the map is updated — which is the point of listing it by kind.
    const { readFileSync, readdirSync } = await import("node:fs");
    const impl = readdirSync("src/api/_lib/docai")
      .filter((f) => f.endsWith(".js"))
      .filter((f) => /isQuote|expectedKind === "quote"/.test(readFileSync("src/api/_lib/docai/" + f, "utf8")))
      .map((f) => f.replace(/\.js$/, ""));
    expect(impl.sort()).toEqual([...KIND_CAPABLE_ADAPTERS.quote].sort());
  });
});
