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

import { AnvilBackend } from "./api";
import { MATRIX, RBAC, type BaseRole, type Role } from "./rbac";
import { NAV } from "./nav";

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
    const resp: any = await AnvilBackend?.admin?.navSettings?.();
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

// The sidebar and the phone tabs: RBAC read access intersected with this
// setting. app.tsx passes the result to both Shell and MobileShell.
export const visibleNav = <T extends { items: Array<{ id: string }> }>(groups: T[]): T[] =>
  RBAC.filterNav(groups)
    .map((g) => ({ ...g, items: g.items.filter((it) => isNavEnabled(it.id)) }))
    .filter((g) => g.items.length > 0);

// True when the base role's RBAC cell reaches nav item `navId` at all.
export const hasRoleAccess = (navId: string, role: string): boolean =>
  /[rwax]/.test((MATRIX[navId] && MATRIX[navId][role as BaseRole]) || "");

// The Mode B pilot nav (docs/SO_EXECUTION_COHESION.md, C-D9): the ids each
// pilot role keeps, and null keeps every item. New PO is the Inbox (intake).
// Orders is Sales Orders (so), which holds the Register. The clerk is an
// operator seat (C-D5).
// shortcut: fixed to the C-D5 and C-D9 defaults, change it after DISC-1 with the pilot team.
export const PILOT_NAV_KEEP: Record<string, string[] | null> = {
  sales_engineer: ["home", "intake", "so", "approvals"],
  operator: ["home", "so"],
  admin: null,
};

// The visibility map after the pilot preset, and what it hides and shows for
// each pilot role. As in the Navigation editor, only items the role can reach
// by RBAC are stored or listed. Other roles keep their entries.
export const pilotNavPreset = (current: NavDisabledMap): {
  next: NavDisabledMap;
  changes: Array<{ role: string; hide: string[]; show: string[] }>;
} => {
  const next: NavDisabledMap = { ...current };
  const changes = Object.entries(PILOT_NAV_KEEP).map(([role, keep]) => {
    const reachable = NAV.flatMap((g) => g.items.map((i) => i.id))
      .filter((id) => !CORE_NAV_IDS.has(id) && hasRoleAccess(id, role));
    const before = new Set(current[role] || []);
    const off = keep ? reachable.filter((id) => !keep.includes(id)).sort() : [];
    if (off.length) next[role] = off; else delete next[role];
    return {
      role,
      hide: off.filter((id) => !before.has(id)),
      show: reachable.filter((id) => before.has(id) && !off.includes(id)),
    };
  });
  return { next, changes };
};
