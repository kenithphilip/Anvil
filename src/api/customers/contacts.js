// /api/customers/contacts
//
// CRUD for customer_contacts (one row per (customer, person)).
// Migration 065 introduced the table; this is the operator surface.
//
//   GET ?customer_id=...        list contacts for one customer
//   GET ?email=...              find a contact by email (matcher
//                               diagnostics)
//   POST                        create or upsert a contact
//   PATCH ?id=...               update fields
//   DELETE ?id=...              remove (cascades from RLS only;
//                               related inbound_emails.customer_contact_id
//                               nulls out via the FK on delete set null)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const VALID_SOURCES = new Set(["operator", "inbound_email", "erp_sync", "portal", "signup", "other"]);
const VALID_ROLES = new Set(["primary", "procurement", "accounts", "dispatch", "qa", "engineering", "owner", "other"]);

const cleanEmail = (s) => {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase();
  return t.length === 0 ? null : t;
};

const buildRow = (ctx, body) => ({
  tenant_id: ctx.tenantId,
  customer_id: body.customer_id,
  name: body.name ? String(body.name).trim() : null,
  email: cleanEmail(body.email),
  phone: body.phone ? String(body.phone).trim() : null,
  role: VALID_ROLES.has(body.role) ? body.role : (body.role || null),
  is_primary: !!body.is_primary,
  source: VALID_SOURCES.has(body.source) ? body.source : "operator",
  external_ref: body.external_ref || {},
  notes: body.notes || null,
});

// Ensure at most one is_primary contact per customer. If the
// caller asked for is_primary=true, demote the prior primary
// (if any) before the insert/update lands.
const ensureSinglePrimary = async (svc, ctx, customerId, exceptId) => {
  await svc.from("customer_contacts")
    .update({ is_primary: false, updated_at: new Date().toISOString() })
    .eq("tenant_id", ctx.tenantId)
    .eq("customer_id", customerId)
    .eq("is_primary", true)
    .neq("id", exceptId || "00000000-0000-0000-0000-000000000000");
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id || null;

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const customerId = req.query?.customer_id;
      const emailQ = cleanEmail(req.query?.email);
      let q = svc.from("customer_contacts").select("*").eq("tenant_id", ctx.tenantId);
      if (id) q = q.eq("id", id);
      if (customerId) q = q.eq("customer_id", customerId);
      if (emailQ) q = q.ilike("email", emailQ);
      q = q.order("is_primary", { ascending: false }).order("updated_at", { ascending: false }).limit(500);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { contacts: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.customer_id) return json(res, 400, { error: { message: "customer_id required" } });
      // Verify the customer belongs to this tenant before letting
      // the row land. RLS would catch a cross-tenant insert via
      // service-role anyway, but the explicit check returns a
      // clearer 404.
      const cust = await svc.from("customers").select("id").eq("tenant_id", ctx.tenantId).eq("id", body.customer_id).maybeSingle();
      if (cust.error) throw new Error(cust.error.message);
      if (!cust.data) return json(res, 404, { error: { message: "customer not found in this tenant" } });

      const row = buildRow(ctx, body);
      // Upsert on the case-insensitive (tenant, customer, email)
      // unique index. Without an email we fall back to a plain
      // insert (no dedup). The Supabase JS client doesn't expose
      // partial-index-aware onConflict; so we do an explicit
      // lookup-then-update when email is present.
      let outRow;
      if (row.email) {
        const existing = await svc.from("customer_contacts")
          .select("id")
          .eq("tenant_id", ctx.tenantId)
          .eq("customer_id", row.customer_id)
          .ilike("email", row.email)
          .maybeSingle();
        if (existing.data?.id) {
          if (row.is_primary) await ensureSinglePrimary(svc, ctx, row.customer_id, existing.data.id);
          const upd = await svc.from("customer_contacts").update({
            ...row,
            updated_at: new Date().toISOString(),
          }).eq("id", existing.data.id).select("*").single();
          if (upd.error) throw new Error(upd.error.message);
          outRow = upd.data;
        } else {
          if (row.is_primary) await ensureSinglePrimary(svc, ctx, row.customer_id, null);
          const ins = await svc.from("customer_contacts").insert(row).select("*").single();
          if (ins.error) throw new Error(ins.error.message);
          outRow = ins.data;
        }
      } else {
        if (row.is_primary) await ensureSinglePrimary(svc, ctx, row.customer_id, null);
        const ins = await svc.from("customer_contacts").insert(row).select("*").single();
        if (ins.error) throw new Error(ins.error.message);
        outRow = ins.data;
      }
      await recordAudit(ctx, {
        action: "customer_contact_upsert",
        objectType: "customer_contact",
        objectId: outRow.id,
        detail: outRow.email || outRow.phone || outRow.name || "(no contact info)",
      });
      return json(res, 200, { contact: outRow });
    }

    if (!id && (req.method === "PATCH" || req.method === "DELETE")) {
      return json(res, 400, { error: { message: "id required" } });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const patch = {};
      const allowed = ["name", "email", "phone", "role", "is_primary", "source", "external_ref", "notes"];
      for (const k of allowed) if (k in body) patch[k] = body[k];
      if ("email" in patch) patch.email = cleanEmail(patch.email);
      if ("source" in patch && !VALID_SOURCES.has(patch.source)) delete patch.source;
      if ("is_primary" in patch && patch.is_primary) {
        // Need the customer_id to demote the prior primary.
        const cur = await svc.from("customer_contacts").select("customer_id").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
        if (cur.data?.customer_id) await ensureSinglePrimary(svc, ctx, cur.data.customer_id, id);
      }
      patch.updated_at = new Date().toISOString();
      const upd = await svc.from("customer_contacts").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, { action: "customer_contact_update", objectType: "customer_contact", objectId: id });
      return json(res, 200, { contact: upd.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "approve");
      const del = await svc.from("customer_contacts").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (del.error) throw new Error(del.error.message);
      await recordAudit(ctx, { action: "customer_contact_delete", objectType: "customer_contact", objectId: id });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
