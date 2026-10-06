// The canonical adapter order, in one place.
//
// It used to live in TWO places that disagreed:
//
//   index.js          ["gemini", "docling", "marker", "unstructured",
//                      "azure_di", "reducto", "claude"]        <- gemini FIRST
//   adapter-learning  ["docling", "marker", "unstructured", "reducto",
//                      "azure_di", "claude", "gemini"]         <- gemini LAST
//
// The dispatcher passes its own order into rankAdaptersForCustomer, so the
// learning module's copy was only ever the parameter default and never used on
// the production path. That is exactly what made it dangerous: dead enough that
// nobody maintained it, live enough that any caller omitting `defaultOrder`
// would silently get gemini last — after migration 208 deliberately flipped the
// column default the other way, and after a whole class of extraction failures
// was traced to a legacy claude-first order dead-ending on Claude.
//
// A second copy of a value like this does not announce itself when it drifts.
// It surfaces months later as a run nobody can explain.
//
// This module is deliberately dependency-free so both importers can take it
// without a cycle: index.js already imports adapter-learning.js, so
// adapter-learning.js cannot import index.js back.

// Gemini first: cheapest capable multimodal model, and the one migration 208
// made the column default. Deterministic parsers next, Claude last of the
// always-on set. LlamaParse is appended at runtime by ensureLlmFallbacks when
// a key exists — it is opt-in, so it is not listed here.
export const DEFAULT_PROVIDER_ORDER = Object.freeze([
  "gemini", "docling", "marker", "unstructured", "azure_di", "reducto", "claude",
]);
