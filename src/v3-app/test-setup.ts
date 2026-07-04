// Global Vitest setup. Runs once before any test imports a screen.
//
// Order matters here. The legacy anvil-client.js is an IIFE that
// attaches `window.AnvilBackend` on first run; loading it in setup
// guarantees the IIFE has executed BEFORE any test's beforeEach hook
// replaces `window.AnvilBackend` with a stub. Without this, the first
// test that imports a screen would race the IIFE and end up with the
// real client wired in.

import "@testing-library/react";
import "../client/anvil-client.js";
