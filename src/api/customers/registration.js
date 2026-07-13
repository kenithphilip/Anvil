// /api/customers/registration
//
// Categorized customer-registration data-point capture (design:
// docs/CUSTOMER_REGISTRATION_DESIGN.md). Tracks every registration field per
// customer in `customer_registration_fields`, grouped by category, with
// per-field provenance + verification metadata. Automation (GSTIN fetch #186,
// document OCR cross-check #187, customer self-service email) lands later and
// writes through this same endpoint with source/verified set.
//
//   GET  ?catalog=1               -> field catalog only (for rendering a blank form)
//   GET  ?customer_id=<id>        -> catalog merged with stored values, grouped
//                                    by category, plus completeness
//   POST { customer_id, fields }  -> upsert field values; fields is a map of
//                                    field_key -> value | { value, source,
//                                    verified, verified_against }

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import {
  CATEGORIES, FIELD_CATALOG, isValidFieldKey, groupByCategory, completeness, normalizeFieldInput,
} from "../_lib/customer-registration.js";
import { computeAndPersistIcp } from "../_lib/icp-compute.js";

const catalogPayload = () => ({ categories: CATEGORIES, fields: FIELD_CATALOG });

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      // Catalog only (no customer yet) for rendering a blank form.
      if (req.query?.catalog === "1" || !req.query?.customer_id) {
        return json(res, 200, { catalog: catalogPayload() });
      }
      const customerId = String(req.query.customer_id);
      const { data, error } = await svc.from("customer_registration_fields")
        .select("field_key, category, value, source, verified, verified_against, updated_at")
        .eq("tenant_id", ctx.tenantId).eq("customer_id", customerId);
      if (error) throw new Error(error.message);
      const rows = data || [];
      return json(res, 200, {
        customer_id: customerId,
        categories: groupByCategory(rows),
        completeness: completeness(rows),
      });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const customerId = body?.customer_id;
      if (!customerId) return json(res, 400, { error: { message: "customer_id required" } });
      const fields = body?.fields;
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
        return json(res, 400, { error: { message: "fields object required" } });
      }

      // Guard: the customer must exist in this tenant (no orphan rows).
      const cust = await svc.from("customers").select("id")
        .eq("tenant_id", ctx.tenantId).eq("id", customerId).maybeSingle();
      if (cust.error) throw new Error(cust.error.message);
      if (!cust.data) return json(res, 404, { error: { message: "Customer not found" } });

      const now = new Date().toISOString();
      const rows = [];
      const rejected = [];
      for (const [key, entry] of Object.entries(fields)) {
        if (!isValidFieldKey(key)) { rejected.push(key); continue; }
        const norm = normalizeFieldInput(entry);
        rows.push({
          tenant_id: ctx.tenantId,
          customer_id: customerId,
          category: FIELD_CATALOG.find((f) => f.key === key).category,
          field_key: key,
          value: norm.value,
          source: norm.source,
          verified: norm.verified,
          verified_against: norm.verified_against,
          updated_by: ctx.user?.id || null,
          updated_at: now,
        });
      }
      if (!rows.length) {
        return json(res, 400, { error: { message: "no valid fields", rejected } });
      }
      const up = await svc.from("customer_registration_fields")
        .upsert(rows, { onConflict: "tenant_id,customer_id,field_key" });
      if (up.error) throw new Error(up.error.message);

      await recordAudit(ctx, {
        action: "customer_registration_update",
        objectType: "customer",
        objectId: customerId,
        after: { fields: rows.map((r) => r.field_key), rejected },
      });

      // The registration fields are the ICP attribute source, so re-score the
      // customer's ICP fit whenever they change. Best-effort: a scoring failure
      // must not fail the field save.
      try { await computeAndPersistIcp(svc, ctx.tenantId, customerId); }
      catch (e) { /* non-fatal: ICP recompute is derived, not authoritative */ }

      // Return the refreshed, grouped view.
      const fresh = await svc.from("customer_registration_fields")
        .select("field_key, category, value, source, verified, verified_against, updated_at")
        .eq("tenant_id", ctx.tenantId).eq("customer_id", customerId);
      const freshRows = (!fresh.error && fresh.data) ? fresh.data : [];
      return json(res, 200, {
        customer_id: customerId,
        saved: rows.length,
        rejected,
        categories: groupByCategory(freshRows),
        completeness: completeness(freshRows),
      });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
