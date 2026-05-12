// /api/admin/item_master
//   GET    ?q= part_no/desc search; ?source_country=, ?lifecycle=
//   POST   upsert
//   POST  /bulk  bulk import
//   DELETE ?id=

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const LIFECYCLE = new Set(["ACTIVE","OBSOLETE","DISCONTINUED","NEW","TRIAL"]);
const SUPPLY_TYPES = new Set(["GOODS", "SERVICES"]);
const TAXABILITY = new Set(["TAXABLE", "EXEMPT", "NIL_RATED", "NON_GST", "ZERO_RATED"]);
const DATA_SOURCES = new Set(["manual", "imported", "api", "marketplace_template"]);
const SOURCE_FALLBACK = new Set(["specify", "as_per_company", "not_available"]);

// Pull the migration-105 extension columns off the body and coerce
// types where needed. Returns the partial object to merge into the
// base item_master row. All new columns are nullable so omitting any
// of them is safe; the patch only sets keys the caller supplied.
const buildExtensionPatch = (body) => {
  const patch = {};
  const setStr = (k) => { if (k in body) patch[k] = body[k] || null; };
  const setBool = (k) => { if (k in body) patch[k] = body[k] == null ? null : !!body[k]; };
  const setNum = (k) => { if (k in body) patch[k] = body[k] == null || body[k] === "" ? null : Number(body[k]); };
  setStr("alias");
  setStr("print_name");
  setStr("specification_code");
  setStr("stock_group");
  setBool("gst_applicable");
  if ("taxability_type" in body) {
    const v = (body.taxability_type || "").toUpperCase();
    patch.taxability_type = TAXABILITY.has(v) ? v : null;
  }
  if ("type_of_supply" in body) {
    const v = (body.type_of_supply || "").toUpperCase();
    patch.type_of_supply = SUPPLY_TYPES.has(v) ? v : "GOODS";
  }
  setNum("rate_of_duty_pct");
  setBool("maintain_batches");
  setBool("track_mfg_date");
  setBool("capture_documents");
  setBool("enable_cost_tracking");
  setBool("disable_negative_stock");
  setNum("order_level");
  setNum("min_inventory");
  setNum("opening_qty");
  setNum("opening_rate");
  setStr("opening_per");
  setNum("opening_value");
  setBool("verify_item");
  setBool("approve_item");
  if ("effective_date" in body) patch.effective_date = body.effective_date || null;
  if ("data_source" in body) {
    const v = String(body.data_source || "manual");
    patch.data_source = DATA_SOURCES.has(v) ? v : "manual";
  }
  setBool("alteration_locked");
  // Migration 107: residual Tally + Hyundai PO columns.
  setBool("specification_details");
  setBool("other_details");
  if ("hsn_source" in body) {
    const v = (body.hsn_source || "").toLowerCase();
    patch.hsn_source = SOURCE_FALLBACK.has(v) ? v : null;
  }
  if ("gst_rate_source" in body) {
    const v = (body.gst_rate_source || "").toLowerCase();
    patch.gst_rate_source = SOURCE_FALLBACK.has(v) ? v : null;
  }
  setBool("inspection_required");
  setStr("maker");
  return patch;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const limit = Math.max(1, Math.min(2000, Number(req.query.limit || 500)));
      let q = svc.from("item_master").select("*").eq("tenant_id", ctx.tenantId).order("part_no", { ascending: true }).limit(limit);
      if (req.query.q) {
        // Escape PostgREST .or() and LIKE special chars to prevent filter injection.
        const safe = String(req.query.q).replace(/[%_,()*]/g, "\\$&");
        q = q.or("part_no.ilike.%" + safe + "%,description.ilike.%" + safe + "%");
      }
      if (req.query.source_country) q = q.eq("source_country", req.query.source_country);
      if (req.query.lifecycle && LIFECYCLE.has(req.query.lifecycle)) q = q.eq("lifecycle", req.query.lifecycle);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { items: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const isBulk = req.url.includes("/bulk") || Array.isArray(body.rows);
      if (isBulk) {
        const rows = (body.rows || []).map((r) => ({
          tenant_id: ctx.tenantId,
          part_no: r.part_no,
          description: r.description || null,
          drawing_no: r.drawing_no || null,
          uom: r.uom || null,
          item_group: r.item_group || null,
          item_sub_group: r.item_sub_group || null,
          category: r.category || null,
          sub_category: r.sub_category || null,
          source_country: r.source_country || null,
          source_currency: r.source_currency || null,
          purchase_price: r.purchase_price != null ? Number(r.purchase_price) : null,
          purchase_quote_no: r.purchase_quote_no || null,
          purchase_quote_validity_start: r.purchase_quote_validity_start || null,
          purchase_quote_validity_end: r.purchase_quote_validity_end || null,
          hsn_sac: r.hsn_sac || null,
          sgst_rate: r.sgst_rate != null ? Number(r.sgst_rate) : null,
          cgst_rate: r.cgst_rate != null ? Number(r.cgst_rate) : null,
          igst_rate: r.igst_rate != null ? Number(r.igst_rate) : null,
          default_lead_days: r.default_lead_days != null ? Number(r.default_lead_days) : null,
          moq: r.moq != null ? Number(r.moq) : 1,
          pack_size: r.pack_size != null ? Number(r.pack_size) : 1,
          lifecycle: LIFECYCLE.has(r.lifecycle) ? r.lifecycle : "ACTIVE",
          is_assembly: !!r.is_assembly,
          notes: r.notes || null,
          updated_at: new Date().toISOString(),
        })).filter((r) => r.part_no);
        if (!rows.length) return json(res, 400, { error: { message: "no valid rows" } });
        const out = await svc.from("item_master").upsert(rows, { onConflict: "tenant_id,part_no" });
        if (out.error) throw new Error(out.error.message);
        await recordAudit(ctx, { action: "item_master_bulk", objectType: "item_master", objectId: null, detail: "rows=" + rows.length });
        return json(res, 200, { ok: true, rows: rows.length });
      }
      if (!body.part_no) return json(res, 400, { error: { message: "part_no required" } });
      const row = {
        tenant_id: ctx.tenantId,
        part_no: body.part_no,
        description: body.description || null,
        drawing_no: body.drawing_no || null,
        uom: body.uom || null,
        item_group: body.item_group || null,
        item_sub_group: body.item_sub_group || null,
        category: body.category || null,
        sub_category: body.sub_category || null,
        source_country: body.source_country || null,
        source_currency: body.source_currency || null,
        purchase_price: body.purchase_price != null ? Number(body.purchase_price) : null,
        purchase_quote_no: body.purchase_quote_no || null,
        purchase_quote_validity_start: body.purchase_quote_validity_start || null,
        purchase_quote_validity_end: body.purchase_quote_validity_end || null,
        hsn_sac: body.hsn_sac || null,
        sgst_rate: body.sgst_rate != null ? Number(body.sgst_rate) : null,
        cgst_rate: body.cgst_rate != null ? Number(body.cgst_rate) : null,
        igst_rate: body.igst_rate != null ? Number(body.igst_rate) : null,
        default_lead_days: body.default_lead_days != null ? Number(body.default_lead_days) : null,
        moq: body.moq != null ? Number(body.moq) : 1,
        pack_size: body.pack_size != null ? Number(body.pack_size) : 1,
        lifecycle: LIFECYCLE.has(body.lifecycle) ? body.lifecycle : "ACTIVE",
        is_assembly: !!body.is_assembly,
        notes: body.notes || null,
        // Migration 105 extension fields (alias, print_name,
        // taxability_type, batches, opening balance, ...). Pulled
        // from the body when supplied; left null otherwise.
        ...buildExtensionPatch(body),
        updated_at: new Date().toISOString(),
      };
      // Pre-105 deployments will reject the unknown columns with
      // Postgres code 42703. Catch that case and retry with only the
      // legacy columns so signups still work until the operator runs
      // the migration. The retry log line tells them which migration
      // is missing.
      let { data, error } = await svc.from("item_master").upsert(row, { onConflict: "tenant_id,part_no" }).select("*").single();
      if (error && (error.code === "42703" || /column .* does not exist/i.test(error.message))) {
        const legacyOnly = { ...row };
        for (const k of Object.keys(buildExtensionPatch(body))) delete legacyOnly[k];
        const retry = await svc.from("item_master").upsert(legacyOnly, { onConflict: "tenant_id,part_no" }).select("*").single();
        if (retry.error) throw new Error(retry.error.message);
        // eslint-disable-next-line no-console
        console.warn("[item_master] saved without extension columns; run migration 105 to enable alias/print_name/taxability_type/batches/opening-balance");
        data = retry.data;
        error = null;
      }
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "item_master_upsert", objectType: "item_master", objectId: data.id, after: data });
      return json(res, 200, { item: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("item_master").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "item_master_delete", objectType: "item_master", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
