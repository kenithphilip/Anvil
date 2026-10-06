// One canonical adapter order.
//
// It lived in TWO places that disagreed about where gemini belongs:
//
//   index.js          ["gemini", "docling", ...,  "claude"]   <- gemini FIRST
//   adapter-learning  ["docling", ..., "claude", "gemini"]    <- gemini LAST
//
// The dispatcher always passes its own order into rankAdaptersForCustomer, so
// the learning module's copy was only the parameter default and never used on
// the production path. That is precisely what made it dangerous: dead enough
// that nobody maintained it, live enough that a caller omitting `defaultOrder`
// would silently get gemini last — after migration 208 deliberately flipped the
// column default the other way, and after a whole class of extraction failures
// was traced to a legacy claude-first order dead-ending on Claude.
//
// A duplicated constant does not announce itself when it drifts. It surfaces
// months later as a run nobody can explain.

import { describe, it, expect } from "vitest";
import { DEFAULT_PROVIDER_ORDER } from "../api/_lib/docai/provider-order.js";
import { DEFAULT_PROVIDER_ORDER as FROM_INDEX, ADAPTER_NAMES } from "../api/_lib/docai/index.js";
import { __test as learning } from "../api/_lib/docai/adapter-learning.js";

describe("there is exactly one default order", () => {
  it("index.js re-exports the canonical list, it does not redeclare it", () => {
    expect(FROM_INDEX).toBe(DEFAULT_PROVIDER_ORDER);
  });

  // The regression this file exists for.
  it("adapter-learning uses the same list, not its own copy", () => {
    expect(learning.DEFAULT_ORDER).toBe(DEFAULT_PROVIDER_ORDER);
  });

  it("agrees on where gemini goes — the thing the two copies disagreed about", () => {
    expect(DEFAULT_PROVIDER_ORDER[0]).toBe("gemini");
    expect(learning.DEFAULT_ORDER[0]).toBe("gemini");
    expect(learning.DEFAULT_ORDER.at(-1)).not.toBe("gemini");
  });
});

describe("the order itself", () => {
  it("names only adapters that exist in the registry", () => {
    for (const n of DEFAULT_PROVIDER_ORDER) expect(ADAPTER_NAMES).toContain(n);
  });

  it("has no duplicates", () => {
    expect(new Set(DEFAULT_PROVIDER_ORDER).size).toBe(DEFAULT_PROVIDER_ORDER.length);
  });

  it("puts gemini first and claude last of the always-on set", () => {
    // Gemini is the cheapest capable multimodal model and what migration 208
    // made the column default; Claude is the expensive last resort.
    expect(DEFAULT_PROVIDER_ORDER[0]).toBe("gemini");
    expect(DEFAULT_PROVIDER_ORDER.at(-1)).toBe("claude");
  });

  it("omits llamaparse, which is opt-in and appended at runtime", () => {
    // ensureLlmFallbacks adds it only when a key exists. Listing it here would
    // make an unkeyed tenant reserve budget for an adapter that always skips.
    expect(DEFAULT_PROVIDER_ORDER).not.toContain("llamaparse");
    expect(DEFAULT_PROVIDER_ORDER).not.toContain("openrouter");
  });

  it("is frozen, so nothing can mutate the shared array", () => {
    // Two modules now hold the SAME array reference; a push in one would
    // silently reorder the other.
    expect(Object.isFrozen(DEFAULT_PROVIDER_ORDER)).toBe(true);
    expect(() => { DEFAULT_PROVIDER_ORDER.push("nope"); }).toThrow();
  });
});
