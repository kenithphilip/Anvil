// ESM facade over src/client/obara-client.js.
//
// The legacy client is an IIFE that attaches `window.ObaraBackend` and
// `window.storage`. We pull it in for its side effect, then re-export the
// resulting globals so ESM consumers can `import { ObaraBackend } from
// "@v3-lib/api"` instead of reaching for `window.ObaraBackend`.
//
// The legacy script also runs in the legacy build alongside the babel-
// standalone runtime, so refactoring the client itself is out of scope for
// the Vite migration. This wrapper is the bridge.

import "../../client/obara-client.js";

export const ObaraBackend = (typeof window !== "undefined" ? window.ObaraBackend : undefined);
export const storage = (typeof window !== "undefined" ? window.storage : undefined);

export default ObaraBackend;
