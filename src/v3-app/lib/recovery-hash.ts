// Detect whether a URL hash fragment carries a Supabase password-
// recovery payload. The provider ships the recovery email with a
// link of the form:
//
//   https://<host>/#access_token=...&refresh_token=...&type=recovery&...
//
// (The hash fragment, not a query string, so the bytes never reach
// the server-side router. This is by design; Supabase wants the
// browser to handle the token without a server round-trip.)
//
// Without this helper, App.tsx's parseRoute reads the fragment as
// `id = "access_token=..."`, finds no matching route, and falls
// through to the landing page. The recovery flow stalls there.
//
// We accept either the canonical Supabase shape (no leading
// route + a chain of `key=value` params) or the legacy shape
// (`#/reset?access_token=...`) for backward compatibility with
// any operator who hand-edited a redirect URL.

const RECOVERY_PARAM_NAMES = new Set([
  "access_token",
  "refresh_token",
  "type",
  "expires_at",
  "expires_in",
  "token_type",
]);

export const looksLikeRecoveryHash = (hash: string | null | undefined): boolean => {
  if (!hash) return false;
  // Strip route prefix (`#/`) + leading delimiter (`?` or `#`).
  const stripped = hash.replace(/^#\/?/, "").replace(/^[?#]/, "");
  if (!stripped) return false;
  // Cheap check: if neither indicator is present, this is not a
  // recovery URL.
  if (!stripped.includes("access_token=") && !stripped.includes("type=recovery")) {
    return false;
  }
  // Confirm the structure is a key=value param string. A route id
  // that happens to contain "access_token" as a substring is not
  // a recovery URL.
  const firstPair = stripped.split("&")[0];
  const [key] = firstPair.split("=");
  return RECOVERY_PARAM_NAMES.has(key);
};
