// Shared session helpers. Currently exposes a single sign-out action
// used by the Shell's settings popover and the legacy /connect screen
// banner. Lives in `lib/` (not `app.tsx`) so the Shell can import it
// without creating an `app -> Shell -> app` cycle.

import { AnvilBackend } from "./api";
import { lsRemove } from "./storage-keys";

const INTENDED_ROUTE_KEY_SUFFIX = "v3_intended_route";

// Clears the stored session, removes cached auth profile +
// intended-route from local storage, and bounces the visitor back to
// the marketing landing. A microtask-deferred reload ensures any
// in-flight fetches see the null session before the next route mounts.
export const signOutAndRedirect = (): void => {
  try {
    AnvilBackend?.setSession?.(null);
    lsRemove("auth_profile");
    lsRemove(INTENDED_ROUTE_KEY_SUFFIX);
  } catch (_) {
    // Storage may be unavailable (private mode, locked-down browsers).
    // setSession still clears sessionStorage and dispatches "anvil:session",
    // so the auth gate flips even when localStorage is sealed off.
  }
  if (typeof window !== "undefined") {
    window.location.hash = "#/landing";
    setTimeout(() => { try { window.location.reload(); } catch (_) {} }, 0);
  }
};
