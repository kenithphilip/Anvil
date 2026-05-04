// LocalStorage key migration helper for the rebrand.
//
// Pre-rebrand keys used `obara:` as the prefix. Post-rebrand we use
// `anvil:`. Every read tries the new key first, falls back to the
// legacy key, and migrates the value forward so subsequent reads
// don't pay the fallback cost. Every write goes to the new key and
// removes the legacy duplicate. Browsers that have neither key
// behave as if the value was never set.
//
// This file deliberately mirrors `src/client/anvil-client.js` lsGet
// / lsSet so a screen can pick whichever import is closer.

const NEW_PREFIX = "anvil:";
const OLD_PREFIX = "obara:";

const safe = <T>(fn: () => T): T | null => {
  try { return fn(); } catch (_) { return null; }
};

export const lsGet = (suffix: string): string | null => {
  const fresh = safe(() => localStorage.getItem(NEW_PREFIX + suffix));
  if (fresh != null) return fresh;
  const legacy = safe(() => localStorage.getItem(OLD_PREFIX + suffix));
  if (legacy != null) {
    safe(() => localStorage.setItem(NEW_PREFIX + suffix, legacy));
    return legacy;
  }
  return null;
};

// Keys that older screens still read directly under the legacy
// prefix (e.g. 16 screens with inline `obara:backend_config` reads).
// We dual-write these so the legacy reads keep finding fresh data
// during the cross-screen migration window.
const DUAL_WRITE_SUFFIXES = new Set(["backend_config", "backend_session"]);

export const lsSet = (suffix: string, value: string): void => {
  safe(() => localStorage.setItem(NEW_PREFIX + suffix, value));
  if (DUAL_WRITE_SUFFIXES.has(suffix)) {
    safe(() => localStorage.setItem(OLD_PREFIX + suffix, value));
  } else {
    safe(() => localStorage.removeItem(OLD_PREFIX + suffix));
  }
};

export const lsRemove = (suffix: string): void => {
  safe(() => localStorage.removeItem(NEW_PREFIX + suffix));
  safe(() => localStorage.removeItem(OLD_PREFIX + suffix));
};

// The full key both prefixes resolve to. Useful when you need the
// final string (e.g. as a `key` for window.addEventListener("storage")).
export const lsKey = (suffix: string): string => NEW_PREFIX + suffix;
export const lsLegacyKey = (suffix: string): string => OLD_PREFIX + suffix;
