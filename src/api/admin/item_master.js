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
  // Migration 107: residual Tally + Meridian PO columns.
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
      // A blank cell (present but "") must NOT coerce to 0 — Number("") === 0
      // would silently store 0% GST / ₹0 price / 0 lead-days. Blank/absent/
      // non-numeric -> null; numOr applies a default only when there's no value.
      const num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
      const numOr = (v, d) => { const n = num(v); return n != null ? n : d; };
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
          purchase_price: num(r.purchase_price),
          purchase_quote_no: r.purchase_quote_no || null,
          purchase_quote_validity_start: r.purchase_quote_validity_start || null,
          purchase_quote_validity_end: r.purchase_quote_validity_end || null,
          hsn_sac: r.hsn_sac || null,
          sgst_rate: num(r.sgst_rate),
          cgst_rate: num(r.cgst_rate),
          igst_rate: num(r.igst_rate),
          default_lead_days: num(r.default_lead_days),
          moq: numOr(r.moq, 1),
          pack_size: numOr(r.pack_size, 1),
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
        purchase_price: num(body.purchase_price),
        purchase_quote_no: body.purchase_quote_no || null,
        purchase_quote_validity_start: body.purchase_quote_validity_start || null,
        purchase_quote_validity_end: body.purchase_quote_validity_end || null,
        hsn_sac: body.hsn_sac || null,
        sgst_rate: num(body.sgst_rate),
        cgst_rate: num(body.cgst_rate),
        igst_rate: num(body.igst_rate),
        default_lead_days: num(body.default_lead_days),
        moq: numOr(body.moq, 1),
        pack_size: numOr(body.pack_size, 1),
        lifecycle: LIFECYCLE.has(body.lifecycle) ? body.lifecycle : "ACTIVE",
        is_assembly: !!body.is_assembly,
        notes: body.notes || null,
        // Migration 105 extension fields (alias, print_name,
        // taxability_type, batches, opening balance, ...). Pulled
        // from the body when supplied; left null otherwise.
        ...buildExtensionPatch(body),
        updated_at: new Date().toISOString(),
      };
      // INSERT for a new item (no id), UPDATE-by-id for an edit. The previous
      // blind upsert on (tenant_id, part_no) had two data-loss bugs:
      //  (1) "New item" with an already-existing part_no resolved to an UPDATE
      //      that blanked every column the operator didn't type;
      //  (2) editing an item's part_no did NOT conflict, so it INSERTed a fresh
      //      row — orphaning the original + its item_customer_parts.
      // Keying edits by id renames in place; refusing a duplicate part_no on
      // create (409) stops the silent overwrite.
      const hasId = body.id != null && String(body.id).trim() !== "";
      const doWrite = (legacy) => {
        let payload = row;
        if (legacy) { payload = { ...row }; for (const k of Object.keys(buildExtensionPatch(body))) delete payload[k]; }
        return hasId
          ? svc.from("item_master").update(payload).eq("id", body.id).eq("tenant_id", ctx.tenantId).select("*").maybeSingle()
          : svc.from("item_master").insert(payload).select("*").single();
      };
      if (!hasId) {
        const dup = await svc.from("item_master").select("id").eq("tenant_id", ctx.tenantId).eq("part_no", body.part_no).maybeSingle();
        if (dup.error) throw new Error(dup.error.message);
        if (dup.data) return json(res, 409, { error: { message: "An item with part number '" + body.part_no + "' already exists — open it to edit, or use a different part number.", code: "DUPLICATE_PART_NO" } });
      }
      // Pre-105 deployments reject the extension columns with 42703; retry with
      // only the legacy columns so item creation still works until migration 105.
      let { data, error } = await doWrite(false);
      if (error && (error.code === "42703" || /column .* does not exist/i.test(error.message))) {
        const retry = await doWrite(true);
        data = retry.data; error = retry.error;
        if (!error) {
          // eslint-disable-next-line no-console
          console.warn("[item_master] saved without extension columns; run migration 105 to enable alias/print_name/taxability_type/batches/opening-balance");
        }
      }
      // Renaming a part_no onto one another item already uses (unique
      // tenant_id, part_no) or a create that raced the dup check.
      if (error && (error.code === "23505" || /duplicate key|unique constraint/i.test(error.message))) {
        return json(res, 409, { error: { message: "Part number '" + body.part_no + "' is already used by another item.", code: "DUPLICATE_PART_NO" } });
      }
      if (error) throw new Error(error.message);
      if (hasId && !data) return json(res, 404, { error: { message: "Item not found for this tenant" } });
      await recordAudit(ctx, { action: hasId ? "item_master_update" : "item_master_insert", objectType: "item_master", objectId: data.id, after: data });
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
