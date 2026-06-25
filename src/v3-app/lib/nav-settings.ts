// Per-role left-nav visibility (client mirror of /api/admin/nav_settings).
//
// An admin chooses, per role, which left-nav items (and the screens behind
// them) are activated. We hold the DISABLED set per role in memory; an item
// is visible to a user when it is NOT in their role's disabled list. New nav
// items therefore ship visible by default (opt-out).
//
// app.tsx loads this once after auth and re-renders the shell on the
// "nav:change" event. isNavEnabled() is intersected with RBAC.canRead() so a
// disabled item is both hidden from the sidebar AND blocked on direct URL
// access (hard gate). Core ids stay reachable for every role so an admin can
// never lock themselves out of the screen that edits this setting.

import { ObaraBackend } from "./api";
import { RBAC, type Role } from "./rbac";

export type NavDisabledMap = Record<string, string[]>;

// Must match CORE_IDS in src/api/admin/nav_settings.js.
export const CORE_NAV_IDS = new Set<string>(["home", "admin"]);

let disabledByRole: NavDisabledMap = {};
let loaded = false;

const emitChange = () => {
  try { window.dispatchEvent(new CustomEvent("nav:change")); } catch (_) { /* noop (SSR / tests) */ }
};

// Fetch the tenant's per-role visibility map. Best-effort: on any failure we
// leave everything visible rather than hiding the whole app.
export const loadNavSettings = async (): Promise<void> => {
  try {
    const resp: any = await ObaraBackend?.admin?.navSettings?.();
    const map = resp?.nav_disabled;
    disabledByRole = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  } catch (_) {
    disabledByRole = {};
  } finally {
    loaded = true;
    emitChange();
  }
};

export const isNavSettingsLoaded = (): boolean => loaded;

// True when nav item `id` is activated for `role` (defaults to current role).
export const isNavEnabled = (id: string, role?: Role | string): boolean => {
  if (CORE_NAV_IDS.has(id)) return true;
  const r = String(role || RBAC.role());
  const list = disabledByRole[r];
  return !(Array.isArray(list) && list.includes(id));
};

// Snapshot for the admin editor (deep-ish copy so edits don't mutate state).
export const getDisabledByRole = (): NavDisabledMap => {
  const out: NavDisabledMap = {};
  for (const [role, ids] of Object.entries(disabledByRole)) out[role] = [...(ids || [])];
  return out;
};

// Apply a freshly-saved map locally so the editing admin's own sidebar
// updates without a reload.
export const applyNavSettingsLocal = (map: NavDisabledMap): void => {
  const next: NavDisabledMap = {};
  for (const [role, ids] of Object.entries(map || {})) {
    const cleaned = (ids || []).filter((id) => !CORE_NAV_IDS.has(id));
    if (cleaned.length) next[role] = cleaned;
  }
  disabledByRole = next;
  emitChange();
};
