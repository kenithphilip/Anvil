// Anvil v3 — Role-Based Access Control (client-side gating)
//
// Server-side enforcement lives in api/_lib/auth.js via
// `requirePermission(ctx, verb)`. This file mirrors that policy on the
// client so we never offer an action the API would refuse with a 403.
//
// The matrix is the canonical source. See docs/RBAC.md for human-readable
// version + reasoning.

(function () {
  // 7 roles, lowercase keys match the obara_role enum + 'operator'
  const ROLES = ["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "viewer"];

  // r=read, w=write, a=approve, x=admin-only
  // Each cell is a string of allowed verbs for that role on that route.
  // '' (empty) means hidden / blocked.
  const MATRIX = {
    home:        { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "r",   admin: "r",  operator: "r",  viewer: "r" },
    intake:      { sales_engineer: "rw",  sales_manager: "rw", procurement: "r",  finance: "r",   admin: "r",  operator: "r",  viewer: "r" },
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
    cost:        { sales_engineer: "r",   sales_manager: "rw", procurement: "r",  finance: "rw",  admin: "rw", operator: "",   viewer: "r" },
    customers:   { sales_engineer: "rw",  sales_manager: "rw", procurement: "r",  finance: "r",   admin: "rw", operator: "r",  viewer: "r" },
    items:       { sales_engineer: "r",   sales_manager: "r",  procurement: "rw", finance: "r",   admin: "rw", operator: "r",  viewer: "r" },
    graph:       { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "r",   admin: "r",  operator: "",   viewer: "r" },
    forecasts:   { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "rw",  admin: "rw", operator: "",   viewer: "r" },
    evals:       { sales_engineer: "r",   sales_manager: "r",  procurement: "",   finance: "",    admin: "rw", operator: "",   viewer: "r" },
    studio:      { sales_engineer: "r",   sales_manager: "rw", procurement: "",   finance: "",    admin: "rw", operator: "",   viewer: "r" },
    anomaly:     { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "r",   admin: "rw", operator: "",   viewer: "r" },
    duplicates:  { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "r",   admin: "rw", operator: "",   viewer: "r" },
    comms:       { sales_engineer: "rw",  sales_manager: "rw", procurement: "r",  finance: "r",   admin: "rw", operator: "",   viewer: "r" },
    email:       { sales_engineer: "r",   sales_manager: "rw", procurement: "r",  finance: "r",   admin: "rw", operator: "",   viewer: "r" },
    security:    { sales_engineer: "",    sales_manager: "",   procurement: "",   finance: "",    admin: "x",  operator: "",   viewer: "" },
    audit:       { sales_engineer: "r",   sales_manager: "r",  procurement: "r",  finance: "r",   admin: "rw", operator: "",   viewer: "r" },
    admin:       { sales_engineer: "",    sales_manager: "",   procurement: "",   finance: "",    admin: "x",  operator: "",   viewer: "" },
  };

  // Action-level overrides keyed by stable string id.
  // Empty list = no role can do it. A role with admin still gets a pass
  // unless explicitly excluded.
  const ACTIONS = {
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

  // Current role: read from localStorage (set by the role pill) or from the
  // verified Supabase session's tenant_members row.
  const ROLE_KEY = "obara:v3_role";
  const getRole = () => {
    try { return localStorage.getItem(ROLE_KEY) || "sales_engineer"; }
    catch (_) { return "sales_engineer"; }
  };
  const setRole = (role) => {
    if (!ROLES.includes(role)) throw new Error("Unknown role: " + role);
    try { localStorage.setItem(ROLE_KEY, role); } catch (_) {}
    window.dispatchEvent(new CustomEvent("rbac:change", { detail: { role } }));
  };

  const cell = (navId) => {
    const row = MATRIX[navId];
    if (!row) return "";
    return row[getRole()] || "";
  };

  const RBAC = {
    ROLES,
    role: getRole,
    setRole,
    canRead: (navId) => /[rwax]/.test(cell(navId)),
    canWrite: (navId) => /[wa]/.test(cell(navId)),
    canApprove: (navId) => /[a]/.test(cell(navId)),
    isAdmin: () => /[x]/.test(cell("admin")) || /[x]/.test(cell("security")),
    canDo: (action) => {
      const allow = ACTIONS[action];
      if (!allow) return true; // unknown action: don't gate (server will catch)
      const r = getRole();
      return allow.includes(r) || r === "admin";
    },
    // For the sidebar: filter NAV groups to only entries the user can read.
    filterNav: (NAV) => NAV.map((g) => ({
      ...g,
      items: g.items.filter((it) => RBAC.canRead(it.id)),
    })).filter((g) => g.items.length > 0),
  };

  if (typeof window !== "undefined") window.RBAC = RBAC;
})();
