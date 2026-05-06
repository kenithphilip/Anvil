// Shared session helpers. Currently exposes a single sign-out action
// used by the Shell's settings popover and the legacy /connect screen
// banner. Lives in `lib/` (not `app.tsx`) so the Shell can import it
// without creating an `app -> Shell -> app` cycle.

import { ObaraBackend } from "./api";
import { lsRemove } from "./storage-keys";

const INTENDED_ROUTE_KEY_SUFFIX = "v3_intended_route";

// Clears the in-memory Supabase session, removes cached auth profile +
// intended-route from local storage, and bounces the visitor back to
// the marketing landing. A microtask-deferred reload ensures any
// in-flight fetches see the null session before the next route mounts.
export const signOutAndRedirect = (): void => {
  try {
    ObaraBackend?.setSession?.(null);
    lsRemove("auth_profile");
    lsRemove(INTENDED_ROUTE_KEY_SUFFIX);
  } catch (_) {
    // Storage may be unavailable (private mode, locked-down browsers).
    // The setSession call above clears the in-memory session even when
    // localStorage is sealed off, so the auth gate still flips.
  }
  if (typeof window !== "undefined") {
    window.location.hash = "#/landing";
    setTimeout(() => { try { window.location.reload(); } catch (_) {} }, 0);
  }
};
