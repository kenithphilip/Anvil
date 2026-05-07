// POST /api/customers/merge
// Body: {
//   primary_id,
//   duplicate_ids: [uuid, uuid, ...],
//   delete_duplicates?: true   // default true; set false to keep
//                              // the dup rows around (still moves
//                              // every row pointing at them).
// }
//
// Audit P4.6. Multi-ERP tenants accumulate N rows per physical
// customer because each NetSuite / SAP / D365 sync creates
// customers with vendor-prefixed customer_keys. After P4.5
// surfaces the dups, this endpoint merges them: every foreign-
// keyed row that points at a duplicate is rewritten to point at
// the primary, the duplicate's external_ref is folded into the
// primary's, and the duplicate is hard-deleted (or kept,
// depending on the flag).
//
// Tables touched (every customer_id FK in the schema):
//
//   orders, invoices, einvoices, opportunities, leads,
//   customer_locations, customer_format_profiles,
//   customer_contacts, portal_tokens, portal_quote_acceptances,
//   portal_access_log, inbound_emails, inbound_email_threads,
//   inbound_messages, spare_recommendations.
//
// Some have ON DELETE CASCADE / SET NULL so the post-delete
// state is consistent even if a table is missed; the explicit
// reassignment is the conservative choice that keeps history
// attached to the primary.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const MIGRATE_TABLES = [
  // (table, fk_column). Order matters: leaf rows first so any FK
  // chains within the same group resolve correctly.
  { table: "customer_format_profiles", column: "customer_id" },
  { table: "customer_locations",       column: "customer_id" },
  { table: "customer_contacts",        column: "customer_id" },
  { table: "portal_tokens",            column: "customer_id" },
  { table: "portal_quote_acceptances", column: "customer_id" },
  { table: "portal_access_log",        column: "customer_id" },
  { table: "inbound_emails",           column: "customer_id" },
  { table: "inbound_email_threads",    column: "customer_id" },
  { table: "inbound_messages",         column: "customer_id" },
  { table: "spare_recommendations",    column: "customer_id" },
  { table: "leads",                    column: "account_id" },
  { table: "opportunities",            column: "customer_id" },
  { table: "einvoices",                column: "customer_id" },
  { table: "invoices",                 column: "customer_id" },
  { table: "orders",                   column: "customer_id" },
];

const moveCustomerForeignKeys = async (svc, tenantId, fromId, toId) => {
  const counts = {};
  for (const { table, column } of MIGRATE_TABLES) {
    // Best-effort per table; some tables may not exist on every
    // deployment (vertical packs, etc.). Errors that look like
    // "relation does not exist" are tolerated; everything else
    // bubbles up.
    const upd = await svc.from(table).update({ [column]: toId })
      .eq("tenant_id", tenantId).eq(column, fromId).select("id");
    if (upd.error) {
      const msg = String(upd.error.message || "");
      if (/relation .* does not exist|column .* does not exist/i.test(msg)) {
        counts[table] = "skipped: " + msg.slice(0, 100);
        continue;
      }
      throw new Error(table + " update failed: " + msg);
    }
    counts[table] = (upd.data || []).length;
  }
  return counts;
};

const mergeExternalRef = (primary, duplicates) => {
  const out = { ...(primary?.external_ref || {}) };
  for (const d of duplicates) {
    const dr = d.external_ref || {};
    for (const [k, v] of Object.entries(dr)) {
      if (out[k] == null) out[k] = v;
    }
  }
  return out;
};

const filledOrFallback = (a, b) => (a == null || a === "") ? b : a;

const fillMissingFromDuplicates = (primary, duplicates) => {
  const patch = {};
  const fields = [
    "gstin", "state_code", "contact_email", "contact_phone",
    "currency", "payment_terms", "default_payment_terms",
    "default_incoterms", "default_quote_validity_days",
    "margin_floor_pct", "credit_limit", "bill_to", "ship_to",
    "notes",
  ];
  for (const f of fields) {
    if (primary[f] == null || primary[f] === "") {
      for (const d of duplicates) {
        if (d[f] != null && d[f] !== "") { patch[f] = d[f]; break; }
      }
    }
  }
  return patch;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    // Merge is destructive; require the same level the customer
    // delete path uses.
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    if (!body?.primary_id) return json(res, 400, { error: { message: "primary_id required" } });
    if (!Array.isArray(body.duplicate_ids) || body.duplicate_ids.length === 0) {
      return json(res, 400, { error: { message: "duplicate_ids must be a non-empty array" } });
    }
    if (body.duplicate_ids.includes(body.primary_id)) {
      return json(res, 400, { error: { message: "primary_id cannot also appear in duplicate_ids" } });
    }
    const deleteDups = body.delete_duplicates !== false;
    const svc = serviceClient();

    const primaryQ = await svc.from("customers")
      .select("*")
      .eq("tenant_id", ctx.tenantId).eq("id", body.primary_id).maybeSingle();
    if (primaryQ.error) throw new Error("primary read: " + primaryQ.error.message);
    if (!primaryQ.data) return json(res, 404, { error: { message: "primary customer not found" } });

    const dupsQ = await svc.from("customers")
      .select("*")
      .eq("tenant_id", ctx.tenantId).in("id", body.duplicate_ids);
    if (dupsQ.error) throw new Error("duplicates read: " + dupsQ.error.message);
    if ((dupsQ.data || []).length !== body.duplicate_ids.length) {
      const found = (dupsQ.data || []).map((d) => d.id);
      const missing = body.duplicate_ids.filter((id) => !found.includes(id));
      return json(res, 404, { error: { message: "duplicate_ids not found in tenant: " + missing.join(",") } });
    }

    // Move every foreign key from each dup to the primary.
    const moveCounts = {};
    for (const d of dupsQ.data) {
      moveCounts[d.id] = await moveCustomerForeignKeys(svc, ctx.tenantId, d.id, body.primary_id);
    }

    // Patch the primary with merged external_ref + best-effort
    // backfill of missing fields from the duplicates. Don't
    // clobber a value the operator deliberately set on the
    // primary; only fill nulls.
    const merged = mergeExternalRef(primaryQ.data, dupsQ.data);
    const fill = fillMissingFromDuplicates(primaryQ.data, dupsQ.data);
    const patch = { external_ref: merged, ...fill, updated_at: new Date().toISOString() };
    const upd = await svc.from("customers")
      .update(patch)
      .eq("tenant_id", ctx.tenantId).eq("id", body.primary_id)
      .select("*").single();
    if (upd.error) throw new Error("primary patch: " + upd.error.message);

    // Hard-delete the duplicates if requested. RLS gates apply via
    // service-role; explicit tenant_id filter for defence.
    let deleted = [];
    if (deleteDups) {
      const del = await svc.from("customers")
        .delete()
        .eq("tenant_id", ctx.tenantId).in("id", body.duplicate_ids).select("id");
      if (del.error) throw new Error("duplicate delete: " + del.error.message);
      deleted = (del.data || []).map((r) => r.id);
    }

    await recordAudit(ctx, {
      action: "customer_merge",
      objectType: "customer",
      objectId: body.primary_id,
      detail: "merged " + dupsQ.data.length + " duplicates" + (deleteDups ? "" : " (kept rows)"),
      after: {
        merged_into: body.primary_id,
        merged_from: body.duplicate_ids,
        moved_row_counts: moveCounts,
        deleted,
      },
    });

    return json(res, 200, {
      ok: true,
      primary: upd.data,
      merged_from: body.duplicate_ids,
      moved_row_counts: moveCounts,
      deleted,
    });
  } catch (err) { sendError(res, err); }
}
