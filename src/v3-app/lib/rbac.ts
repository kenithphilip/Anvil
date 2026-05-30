// Anvil v3 — Role-Based Access Control (client-side gating).
// ESM port of src/v3/rbac.js. Server-side enforcement still lives in
// api/_lib/auth.js via `requirePermission(ctx, verb)`. This file mirrors
// that policy on the client so we never offer an action the API would
// refuse with a 403.
//
// The matrix is the canonical source. See docs/RBAC.md for the human-
// readable version. Tests live in rbac.test.js.

export type Role =
  | "sales_engineer"
  | "sales_manager"
  | "procurement"
  | "finance"
  | "admin"
  | "operator"
  | "viewer";

export const ROLES: Role[] = ["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "viewer"];

export type MatrixCell = string; // permission verbs r/w/a/x or empty
export type MatrixRow = Record<Role, MatrixCell>;

// r=read, w=write, a=approve, x=admin-only.
// '' (empty) means hidden / blocked.
export const MATRIX: Record<string, MatrixRow> = {
  home:        { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "r",   admin: "r",  operator: "r",  viewer: "r" },
  intake:      { sales_engineer: "rw",  sales_manager: "rw", procurement: "r",  finance: "r",   admin: "r",  operator: "r",  viewer: "r" },
  quotes:      { sales_engineer: "rw",  sales_manager: "rwa",procurement: "r",  finance: "r",   admin: "rwa",operator: "r",  viewer: "r" },
  so:          { sales_engineer: "rw",  sales_manager: "rw", procurement: "r",  finance: "r",   admin: "r",  operator: "r",  viewer: "r" },
  internal:    { sales_engineer: "r",   sales_manager: "rw", procurement: "r",  finance: "r",   admin: "rw", operator: "rw", viewer: "r" },
  approvals:   { sales_engineer: "r",   sales_manager: "rwa",procurement: "",   finance: "rwa", admin: "rwa",operator: "",   viewer: "r" },
  leads:       { sales_engineer: "rw",  sales_manager: "rw", procurement: "",   finance: "r",   admin: "r",  operator: "",   viewer: "r" },
  opps:        { sales_engineer: "rw",  sales_manager: "rw", procurement: "",   finance: "r",   admin: "r",  operator: "",   viewer: "r" },
  projects:    { sales_engineer: "rw",  sales_manager: "rw", procurement: "r",  finance: "r",   admin: "r",  operator: "",   viewer: "r" },
  shipments:   { sales_engineer: "rw",  sales_manager: "rw", procurement: "rw", finance: "r",   admin: "r",  operator: "r",  viewer: "r" },
  spo:         { sales_engineer: "r",   sales_manager: "r",  procurement: "rwa",finance: "r",   admin: "r",  operator: "",   viewer: "r" },
  spares:      { sales_engineer: "rw",  sales_manager: "r",  procurement: "rw", finance: "r",   admin: "r",  operator: "",   viewer: "r" },
  "svc-visits":{ sales_engineer: "r",   sales_manager: "r",  procurement: "",   finance: "",    admin: "r",  operator: "rw", viewer: "r" },
  amc:         { sales_engineer: "r",   sales_manager: "r",  procurement: "",   finance: "",    admin: "rw", operator: "rw", viewer: "r" },
  car:         { sales_engineer: "r",   sales_manager: "r",  procurement: "",   finance: "",    admin: "rw", operator: "rw", viewer: "r" },
  tally:       { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "rwa", admin: "rw", operator: "",   viewer: "r" },
  einvoice:    { sales_engineer: "r",   sales_manager: "r",  procurement: "",   finance: "rw",  admin: "rw", operator: "",   viewer: "r" },
  invoices:    { sales_engineer: "r",   sales_manager: "rw", procurement: "",   finance: "rwa", admin: "rwa",operator: "",   viewer: "r" },
  "credit-notes":       { sales_engineer: "r",   sales_manager: "rw", procurement: "",   finance: "rwa", admin: "rwa",operator: "",   viewer: "r" },
  "recurring-invoices": { sales_engineer: "r",   sales_manager: "rw", procurement: "",   finance: "rwa", admin: "rwa",operator: "",   viewer: "r" },
  "eway-bills":         { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "rwa", admin: "rwa",operator: "r",  viewer: "r" },
  delays:               { sales_engineer: "r",   sales_manager: "r",  procurement: "rw", finance: "r",   admin: "r",  operator: "r",  viewer: "r" },
  cost:        { sales_engineer: "r",   sales_manager: "rw", procurement: "r",  finance: "rw",  admin: "rw", operator: "",   viewer: "r" },
  customers:   { sales_engineer: "rw",  sales_manager: "rw", procurement: "r",  finance: "r",   admin: "rw", operator: "r",  viewer: "r" },
  items:       { sales_engineer: "r",   sales_manager: "r",  procurement: "rw", finance: "r",   admin: "rw", operator: "r",  viewer: "r" },
  graph:       { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "r",   admin: "r",  operator: "",   viewer: "r" },
  forecasts:   { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "rw",  admin: "rw", operator: "",   viewer: "r" },
  evals:       { sales_engineer: "r",   sales_manager: "r",  procurement: "",   finance: "",    admin: "rw", operator: "",   viewer: "r" },
  studio:      { sales_engineer: "r",   sales_manager: "rw", procurement: "",   finance: "",    admin: "rw", operator: "",   viewer: "r" },
  anomaly:     { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "r",   admin: "rw", operator: "",   viewer: "r" },
  duplicates:  { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "r",   admin: "rw", operator: "",   viewer: "r" },
  "customer-duplicates": { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "r",   admin: "rw", operator: "",   viewer: "r" },
  "pipeline-kanban":     { sales_engineer: "rw",  sales_manager: "rw", procurement: "",   finance: "r",   admin: "r",  operator: "",   viewer: "r" },
  voice:                 { sales_engineer: "r",   sales_manager: "rw", procurement: "r",  finance: "r",   admin: "rw", operator: "rw", viewer: "r" },
  agents:      { sales_engineer: "rw",  sales_manager: "rw", procurement: "rw", finance: "rw",  admin: "rw", operator: "r",  viewer: "r" },
  comms:       { sales_engineer: "rw",  sales_manager: "rw", procurement: "r",  finance: "r",   admin: "rw", operator: "",   viewer: "r" },
  email:       { sales_engineer: "r",   sales_manager: "rw", procurement: "r",  finance: "r",   admin: "rw", operator: "",   viewer: "r" },
  security:    { sales_engineer: "",    sales_manager: "",   procurement: "",   finance: "",    admin: "x",  operator: "",   viewer: "" },
  audit:       { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "r",   admin: "rw", operator: "",   viewer: "r" },
  admin:       { sales_engineer: "",    sales_manager: "",   procurement: "",   finance: "",    admin: "x",  operator: "",   viewer: "" },
  connect:     { sales_engineer: "rw",  sales_manager: "rw", procurement: "rw", finance: "rw",  admin: "rw", operator: "rw", viewer: "rw" },
  onboarding:  { sales_engineer: "rw",  sales_manager: "rw", procurement: "rw", finance: "rw",  admin: "rw", operator: "rw", viewer: "rw" },
  "format-guide": { sales_engineer: "r", sales_manager: "r", procurement: "r",  finance: "r",   admin: "r",  operator: "r",  viewer: "r" },
  // Inventory-planning module (Phase 2 + 3). Procurement owns the
  // POs, so they get full rwa across all surfaces. Sales sees read-
  // only visibility into pipeline-driven shortages. Finance reads
  // for cost reporting.
  "inventory-planning":   { sales_engineer: "r",  sales_manager: "r",   procurement: "rwa", finance: "r",    admin: "rwa", operator: "r",  viewer: "r" },
  "inventory-plans":      { sales_engineer: "",   sales_manager: "r",   procurement: "rwa", finance: "r",    admin: "rwa", operator: "",   viewer: "" },
  "inventory-exceptions": { sales_engineer: "r",  sales_manager: "rw",  procurement: "rwa", finance: "r",    admin: "rwa", operator: "r",  viewer: "r" },
  "inventory-item":       { sales_engineer: "r",  sales_manager: "r",   procurement: "rwa", finance: "r",    admin: "rwa", operator: "r",  viewer: "r" },
  "inventory-allocations":{ sales_engineer: "r",  sales_manager: "rw",  procurement: "rwa", finance: "r",    admin: "rwa", operator: "r",  viewer: "r" },
  "inventory-suppliers":  { sales_engineer: "r",  sales_manager: "r",   procurement: "rwa", finance: "r",    admin: "rwa", operator: "",   viewer: "r" },
  // Bet 7: BRSR value-chain reporting. Supplier side: admin owns
  // the disclosure and the attestation; finance reads for audit
  // pack. Buyer side: admin / finance can read + export; sales
  // manager reads (CFO-adjacent ESG reporting). Operators and
  // viewers are read-only across.
  "brsr-supplier":          { sales_engineer: "",   sales_manager: "r",   procurement: "r",   finance: "rw",   admin: "rwa", operator: "",   viewer: "r" },
  "brsr-buyer-dashboard":   { sales_engineer: "",   sales_manager: "r",   procurement: "r",   finance: "rwa",  admin: "rwa", operator: "",   viewer: "r" },
  "brsr-disclosure-detail": { sales_engineer: "",   sales_manager: "r",   procurement: "r",   finance: "r",    admin: "rwa", operator: "",   viewer: "r" },
  // Bet 6: TReDS receivables loop. Finance owns the factoring decision
  // (which invoice to discount, accepting a bid). Admin can configure
  // partners. Sales manager reads to track AR aging.
  treds:       { sales_engineer: "",   sales_manager: "r",  procurement: "",   finance: "rwa", admin: "rwa",operator: "",   viewer: "r" },
  // Bet 2: format-template marketplace. Operator reads (sees imports
  // in the extraction pipeline). Admin publishes + reverts + reports.
  marketplace: { sales_engineer: "r",  sales_manager: "r",   procurement: "r",   finance: "r",    admin: "rwa", operator: "r",  viewer: "r" },
};

export const ACTIONS: Record<string, Role[]> = {
  "so.push_tally":        ["sales_manager", "finance", "admin"],
  "so.approve":           ["sales_manager", "finance", "admin"],
  "so.cancel":            ["sales_manager", "admin"],
  "so.edit_after_approval":["admin"],
  "customer.edit_gstin":  ["sales_manager", "admin"],
  "customer.edit_profile":["sales_engineer", "sales_manager", "admin"],
  "item.mark_obsolete":   ["procurement", "admin"],
  "spo.record_ack":       ["procurement", "admin"],
  "spo.mark_received":    ["procurement", "admin"],
  "tally.push":           ["finance", "admin"],
  "tally.edit_masters":   ["finance", "admin"],
  "einvoice.generate":    ["finance", "admin"],
  "einvoice.cancel":      ["finance", "admin"],
  "amc.generate_visits":  ["operator", "admin"],
  "service.submit_closure":["operator", "admin"],
  "admin.add_member":     ["admin"],
  "admin.change_role":    ["admin"],
  "security.edit_redaction":["admin"],
  "security.run_test":    ["admin"],
};

// Role is persisted under the `anvil:` prefix; legacy `obara:`
// reads still work via the storage-keys helper.
import { lsGet, lsSet } from "./storage-keys";

const ROLE_KEY = "v3_role";

export const getRole = (): Role => {
  return (lsGet(ROLE_KEY) as Role) || "sales_engineer";
};

export const setRole = (role: Role): void => {
  if (!ROLES.includes(role)) throw new Error("Unknown role: " + role);
  lsSet(ROLE_KEY, role);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("rbac:change", { detail: { role } }));
  }
};

const cell = (navId: string): string => {
  const row = MATRIX[navId];
  if (!row) return "";
  return row[getRole()] || "";
};

export const canRead = (navId: string): boolean => /[rwax]/.test(cell(navId));
export const canWrite = (navId: string): boolean => /[wa]/.test(cell(navId));
export const canApprove = (navId: string): boolean => /[a]/.test(cell(navId));
export const isAdmin = (): boolean => /[x]/.test(cell("admin")) || /[x]/.test(cell("security"));

export const canDo = (action: string): boolean => {
  const allow = ACTIONS[action];
  if (!allow) return true;
  const r = getRole();
  return allow.includes(r) || r === "admin";
};

// For the sidebar: filter NAV groups to only entries the user can read.
// Generic so callers retain their concrete NAV item type.
export const filterNav = <T extends { items: Array<{ id: string }> }>(NAV: T[]): T[] => NAV.map((g) => ({
  ...g,
  items: g.items.filter((it) => canRead(it.id)),
})).filter((g) => g.items.length > 0);

// Convenience aggregate so legacy code paths can read RBAC.* unchanged.
export const RBAC = {
  ROLES,
  role: getRole,
  setRole,
  canRead,
  canWrite,
  canApprove,
  isAdmin,
  canDo,
  filterNav,
};
