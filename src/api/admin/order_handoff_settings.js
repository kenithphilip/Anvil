// /api/admin/order_handoff_settings
//
//   GET    the tenant's order-handoff settings, and how the saved To and CC
//          lists resolve right now (role tokens expanded to member emails).
//   PATCH  { order_handoff_enabled?, order_handoff_to?, order_handoff_cc?,
//            order_handoff_sender? }  save any subset; returns the same shape
//          as GET.
//   POST   { to, cc }  preview how a draft list resolves. Saves nothing.
//
// The handoff email goes to the tenant's own order processing team
// (docs/SO_TERMS_AND_HANDOFF_SCOPE.md, 8.1). Each list entry is an email
// address or a role token such as "role:operator"; see
// src/api/_lib/internal-recipients.js.
//
// Admin only, for every method: these lists decide who receives customer
// order data, and the preview returns member email addresses.
//
// This endpoint sends nothing. The send is plan PR 16.
//
// Migrations here are applied by hand, so the live database can lag the
// repo. Without migration 251 GET and PATCH answer 409 MIGRATION_NOT_APPLIED
// and name the file, rather than a raw "column does not exist". The POST
// preview reads no 251 column and works either way.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import {
  parseRecipientEntry, resolveInternalRecipients, RECIPIENT_ROLES, ROLE_TOKEN_PREFIX,
} from "../_lib/internal-recipients.js";

export const MIGRATION_FILE = "251_order_handoff.sql";
const COLUMNS = "order_handoff_enabled, order_handoff_to, order_handoff_cc, order_handoff_sender, order_handoff_template";
const SENDERS = new Set(["graph", "mailer"]);
// A handful of team mailboxes and role tokens. A list longer than this is a
// distribution list's job, not this setting's.
export const MAX_ENTRIES = 20;

const migrationNotApplied = (res) => json(res, 409, {
  error: {
    message: "The order handoff settings are not in this database yet. Apply supabase/migrations/" + MIGRATION_FILE + ", then retry.",
    code: "MIGRATION_NOT_APPLIED",
    migration: MIGRATION_FILE,
  },
});

// 42703 undefined column, PGRST204 column not in the schema cache, 42P01 and
// PGRST205 the same for a table. Only 251's columns are named here, so any
// of them means the migration is missing.
const isMissingSchema = (error) => {
  if (!error) return false;
  if (["42703", "PGRST204", "42P01", "PGRST205"].includes(error.code)) return true;
  const msg = String(error.message || "");
  return /order_handoff_/.test(msg) && /column|schema cache|does not exist/i.test(msg);
};

const shape = (row) => ({
  order_handoff_enabled: row?.order_handoff_enabled === true,
  order_handoff_to: Array.isArray(row?.order_handoff_to) ? row.order_handoff_to : [],
  order_handoff_cc: Array.isArray(row?.order_handoff_cc) ? row.order_handoff_cc : [],
  order_handoff_sender: SENDERS.has(row?.order_handoff_sender) ? row.order_handoff_sender : null,
  order_handoff_template: row?.order_handoff_template ?? null,
});

const respond = async (res, svc, ctx, settings) => {
  const recipients = await resolveInternalRecipients(svc, ctx.tenantId, {
    to: settings.order_handoff_to,
    cc: settings.order_handoff_cc,
  });
  return json(res, 200, {
    applied: true,
    migration: MIGRATION_FILE,
    settings,
    recipients,
    role_tokens: RECIPIENT_ROLES.map((r) => ROLE_TOKEN_PREFIX + r),
  });
};

// Validate one list for saving. Entries are trimmed and normalised (lowercase
// address, "role:<role>"), blanks are skipped and repeats collapse. Anything
// that is neither an address nor a known role token is refused, by name: a
// stored typo would only ever resolve to nobody.
export const validateEntries = (label, value) => {
  if (value == null) return { value: [] };
  if (!Array.isArray(value)) return { error: label + " must be an array of email addresses or role tokens" };
  const out = [];
  const bad = [];
  for (const raw of value) {
    if (typeof raw !== "string") { bad.push(String(raw)); continue; }
    if (!raw.trim()) continue;
    const p = parseRecipientEntry(raw);
    if (p.kind === "invalid") { bad.push(raw.trim()); continue; }
    if (!out.includes(p.entry)) out.push(p.entry);
  }
  if (bad.length) {
    return { error: label + ": not an email address or a known role token: " + bad.join(", ") + ". A role token looks like role:operator." };
  }
  if (out.length > MAX_ENTRIES) return { error: label + " cannot have more than " + MAX_ENTRIES + " entries" };
  return { value: out };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    if (!ctx.tenantId) return json(res, 400, { error: { message: "No tenant on this session", code: "TENANT_REQUIRED" } });
    const svc = serviceClient();

    if (req.method === "GET") {
      const r = await svc.from("tenant_settings").select(COLUMNS).eq("tenant_id", ctx.tenantId).maybeSingle();
      if (r.error) {
        if (isMissingSchema(r.error)) return migrationNotApplied(res);
        throw new Error("tenant_settings read: " + r.error.message);
      }
      return respond(res, svc, ctx, shape(r.data));
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const to = Array.isArray(body?.to) ? body.to : [];
      const cc = Array.isArray(body?.cc) ? body.cc : [];
      if (to.length > MAX_ENTRIES || cc.length > MAX_ENTRIES) {
        return json(res, 400, { error: { message: "to and cc can have at most " + MAX_ENTRIES + " entries each" } });
      }
      const recipients = await resolveInternalRecipients(svc, ctx.tenantId, { to, cc });
      return json(res, 200, { preview: true, recipients });
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: { message: "body must be an object" } });
      }
      const updates = {};
      const errors = [];
      const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

      if (has("order_handoff_enabled")) {
        if (typeof body.order_handoff_enabled !== "boolean") errors.push("order_handoff_enabled must be true or false");
        else updates.order_handoff_enabled = body.order_handoff_enabled;
      }
      for (const key of ["order_handoff_to", "order_handoff_cc"]) {
        if (!has(key)) continue;
        const v = validateEntries(key, body[key]);
        if (v.error) errors.push(v.error);
        else updates[key] = v.value;
      }
      if (has("order_handoff_sender")) {
        const s = body.order_handoff_sender;
        if (s == null || s === "") updates.order_handoff_sender = null;
        else if (!SENDERS.has(s)) errors.push("order_handoff_sender must be graph, mailer or empty");
        else updates.order_handoff_sender = s;
      }
      if (errors.length) return json(res, 400, { error: { message: errors.join("; ") } });
      if (!Object.keys(updates).length) {
        return json(res, 400, {
          error: { message: "no recognised keys in body. Allowed: order_handoff_enabled, order_handoff_to, order_handoff_cc, order_handoff_sender" },
        });
      }

      const cur = await svc.from("tenant_settings").select(COLUMNS).eq("tenant_id", ctx.tenantId).maybeSingle();
      if (cur.error) {
        if (isMissingSchema(cur.error)) return migrationNotApplied(res);
        throw new Error("tenant_settings read: " + cur.error.message);
      }
      const before = shape(cur.data);
      const next = { ...before, ...updates };
      // On with nobody to send to is a button that can only fail.
      if (next.order_handoff_enabled && !next.order_handoff_to.length) {
        return json(res, 400, { error: { message: "Add at least one To recipient before turning the handoff on." } });
      }

      const up = await svc.from("tenant_settings")
        .upsert({ tenant_id: ctx.tenantId, ...updates }, { onConflict: "tenant_id" })
        .select(COLUMNS).single();
      if (up.error) {
        if (isMissingSchema(up.error)) return migrationNotApplied(res);
        throw new Error("tenant_settings update: " + up.error.message);
      }
      const saved = shape(up.data);
      const changed = Object.keys(updates);
      await recordAudit(ctx, {
        action: "order_handoff_settings_updated",
        objectType: "tenant_settings",
        objectId: ctx.tenantId,
        detail: changed.join(","),
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, saved[k]])),
      });
      return respond(res, svc, ctx, saved);
    }

    res.setHeader("Allow", "GET, PATCH, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
