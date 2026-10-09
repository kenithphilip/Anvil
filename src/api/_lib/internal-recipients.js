// Internal recipients: who on the tenant's own staff receives an email.
//
// The order-processing handoff (docs/SO_TERMS_AND_HANDOFF_SCOPE.md, 8.1) is
// sent to the tenant's own team, not to a customer. comms-routing.js resolves
// customer contacts only, and tenant_settings had no internal address at all,
// so this is the one place that turns an admin's recipient list into email
// addresses.
//
// An entry is either:
//   - an email address, taken as written (a shared mailbox such as the order
//     processing team's need not be a member); or
//   - a role token, "role:<role>", which expands to the APPROVED members of
//     THIS tenant with that role, at the moment of resolution. A pending,
//     denied or deactivated member is never a recipient.
//
// Nothing is dropped silently. Every entry that resolves to no address comes
// back in `dropped` with the reason, so the admin preview (and the handoff
// modal in plan PR 16) can say why a name is missing.
//
// Tenant scoping fails closed: without a tenant id this throws instead of
// reading members, and every member read is filtered by that tenant.

export const ROLE_TOKEN_PREFIX = "role:";

// The roles a token may name: the obara_role enum (migrations 001 and 116),
// the same ten roles as ROLES in src/v3-app/lib/rbac.ts.
export const RECIPIENT_ROLES = Object.freeze([
  "sales_engineer", "sales_manager", "procurement", "finance", "admin",
  "operator", "viewer", "design_engineer", "design_manager", "customer_support",
]);
const ROLE_SET = new Set(RECIPIENT_ROLES);

// RFC 5321 caps a forward path at 254 characters.
const MAX_ADDRESS_LENGTH = 254;
// One address per entry. Commas, semicolons, angle brackets, quotes and
// whitespace are refused outright: they are how two recipients hide in one
// entry, and how a header is injected once the address reaches a mail
// provider.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;

export const isEmailAddress = (value) => {
  const s = String(value == null ? "" : value).trim();
  if (!s || s.length > MAX_ADDRESS_LENGTH) return false;
  return EMAIL_RE.test(s);
};

// Classify one raw entry. Pure, so the settings endpoint validates with the
// same rule the resolver applies.
//   { kind: "address", entry, email }   a literal address, lowercased
//   { kind: "role", entry, role }       a role token for a known role
//   { kind: "invalid", entry, reason }  "empty", "unknown_role" or "invalid_address"
export const parseRecipientEntry = (raw) => {
  const entry = typeof raw === "string" ? raw.trim() : "";
  if (!entry) return { kind: "invalid", entry, reason: "empty" };
  if (entry.toLowerCase().startsWith(ROLE_TOKEN_PREFIX)) {
    const role = entry.slice(ROLE_TOKEN_PREFIX.length).trim().toLowerCase();
    if (!ROLE_SET.has(role)) return { kind: "invalid", entry, reason: "unknown_role" };
    return { kind: "role", entry: ROLE_TOKEN_PREFIX + role, role };
  }
  if (!isEmailAddress(entry)) return { kind: "invalid", entry, reason: "invalid_address" };
  return { kind: "address", entry: entry.toLowerCase(), email: entry.toLowerCase() };
};

const DROP_DETAIL = {
  empty: "Blank entry.",
  invalid_address: "Not a valid email address.",
  unknown_role: "No such role.",
  no_active_members: "No approved member of this tenant has this role.",
  inactive_member: "This member is not approved (pending, denied or deactivated).",
  no_email: "This member has no email address on their account.",
  already_in_to: "Already in To.",
};

const REASON_LABEL = (r) => {
  if (r.kind === "address") return "listed address";
  if (r.kind === "engineer") return "sending engineer";
  return r.entry;
};

const asEntries = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// Approved members of the tenant with any of the given roles, with their
// email from auth. Auth users live in the auth schema, which PostgREST does
// not expose, so the lookup is one getUserById per member (the pattern of
// admin/members.js and _lib/assignee.js). Bounded by the members of the named
// roles in this one tenant; no other tenant's users are read.
const loadRoleMembers = async (svc, tenantId, roles) => {
  if (!roles.length) return [];
  const { data, error } = await svc.from("tenant_members")
    .select("user_id, role, status")
    .eq("tenant_id", tenantId)
    .in("role", roles);
  // A read failure is not "nobody has this role". Say so, so the caller does
  // not report a real team as empty.
  if (error) throw new Error("could not read tenant members: " + error.message);
  const rows = (data || []).filter((m) => m && m.user_id && roles.includes(m.role));
  return Promise.all(rows.map(async (m) => {
    if (m.status !== "approved") return { ...m, email: null, name: null };
    let user = null;
    try {
      const r = await svc.auth.admin.getUserById(m.user_id);
      user = (r && r.data && r.data.user) || null;
    } catch { user = null; }
    const meta = (user && user.user_metadata) || {};
    const email = user && isEmailAddress(user.email) ? String(user.email).trim().toLowerCase() : null;
    return { ...m, email, name: meta.name || meta.full_name || null };
  }));
};

// resolveInternalRecipients(svc, tenantId, spec)
//
// spec:
//   to        array of entries (addresses or role tokens)
//   cc        array of entries
//   engineer  optional { email, user_id, name }: the person sending. Added to
//             CC (unless already a recipient) and returned as reply_to, as
//             section 8.1 sets for the handoff.
//
// Returns:
//   to, cc    [{ email, name, user_id, reason, reasons: [{ kind, entry, role? }] }]
//             one row per address, deduped case-insensitively within and
//             across the lists (To wins over CC); `reasons` lists every entry
//             that produced the address.
//   reply_to  the engineer's address, or null.
//   dropped   [{ list, entry, reason, detail, user_id?, status? }] every entry
//             or member that produced no address, and why.
export const resolveInternalRecipients = async (svc, tenantId, spec = {}) => {
  if (!tenantId) {
    const err = new Error("resolveInternalRecipients: a tenant id is required");
    err.status = 400;
    err.code = "TENANT_REQUIRED";
    throw err;
  }
  const lists = {
    to: asEntries(spec && spec.to).map(parseRecipientEntry),
    cc: asEntries(spec && spec.cc).map(parseRecipientEntry),
  };
  const roles = [...new Set([...lists.to, ...lists.cc].filter((p) => p.kind === "role").map((p) => p.role))];
  const members = await loadRoleMembers(svc, tenantId, roles);

  const out = { to: [], cc: [], reply_to: null, dropped: [] };
  const byEmail = new Map(); // email -> { list, row }
  const drop = (list, entry, reason, extra = {}) => {
    out.dropped.push({ list, entry, reason, detail: DROP_DETAIL[reason] || reason, ...extra });
  };
  const add = (list, email, reason, who = {}) => {
    const seen = byEmail.get(email);
    if (seen) {
      // The same address from a second entry in the same list: one row, both
      // reasons. A CC entry that is already in To stays in To only.
      if (seen.list === list) {
        seen.row.reasons.push(reason);
        seen.row.reason = seen.row.reasons.map(REASON_LABEL).join("; ");
      } else if (list === "cc" && reason.kind !== "engineer") {
        drop("cc", reason.entry, "already_in_to");
      }
      if (!seen.row.user_id && who.user_id) seen.row.user_id = who.user_id;
      if (!seen.row.name && who.name) seen.row.name = who.name;
      return;
    }
    const row = { email, name: who.name || null, user_id: who.user_id || null, reason: REASON_LABEL(reason), reasons: [reason] };
    byEmail.set(email, { list, row });
    out[list].push(row);
  };

  for (const list of ["to", "cc"]) {
    for (const p of lists[list]) {
      if (p.kind === "invalid") { drop(list, p.entry, p.reason); continue; }
      if (p.kind === "address") { add(list, p.email, { kind: "address", entry: p.entry }); continue; }
      const withRole = members
        .filter((m) => m.role === p.role)
        .sort((a, b) => String(a.email || a.user_id).localeCompare(String(b.email || b.user_id)));
      let produced = 0;
      for (const m of withRole) {
        if (m.status !== "approved") {
          drop(list, p.entry, "inactive_member", { user_id: m.user_id, status: m.status || null });
          continue;
        }
        if (!m.email) {
          drop(list, p.entry, "no_email", { user_id: m.user_id });
          continue;
        }
        add(list, m.email, { kind: "role", entry: p.entry, role: p.role }, { user_id: m.user_id, name: m.name });
        produced += 1;
      }
      if (!produced && !withRole.some((m) => m.status === "approved")) drop(list, p.entry, "no_active_members");
    }
  }

  const eng = spec && spec.engineer;
  if (eng && eng.email != null) {
    if (isEmailAddress(eng.email)) {
      const email = String(eng.email).trim().toLowerCase();
      add("cc", email, { kind: "engineer", entry: "engineer" }, { user_id: eng.user_id || null, name: eng.name || null });
      out.reply_to = email;
    } else {
      drop("cc", String(eng.email), "invalid_address");
    }
  }
  return out;
};
