// GET    /api/spare_matrix/<id>   -> { matrix, columns[], rows[], recommended[] }
// PATCH  /api/spare_matrix/<id>   bulk save { header?, columns?, rows? }
//                                 reconciles children BY ID (upsert present,
//                                 delete absent) — never delete-and-reinsert,
//                                 so recommended_spares.quote_id refs stay stable.
//                                 recommended_spares is NOT touched here (it is
//                                 managed by recompute_recommended in PR4).
// DELETE /api/spare_matrix/<id>   deletes the matrix (children cascade).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const HEADER_FIELDS = ["customer_id", "project_name", "name", "drawing_base_url", "notes"];
const COL_FIELDS = ["col_name", "category", "position", "locked"];
const ROW_TEXT = ["sr_no", "line", "station_no", "robot_no", "gun_no", "gun_type", "timer", "atd", "bom_asset_id"];
const ROW_NUM = ["l_qty", "r_qty", "qty"];

const numOrNull = (v) => (v === "" || v == null ? null : Number(v));

const loadFull = async (svc, tenantId, id) => {
  const [h, cols, rows, rec] = await Promise.all([
    svc.from("spare_matrix").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(),
    svc.from("spare_matrix_columns").select("*").eq("tenant_id", tenantId).eq("matrix_id", id).order("position", { ascending: true }),
    svc.from("spare_matrix_rows").select("*").eq("tenant_id", tenantId).eq("matrix_id", id).order("position", { ascending: true }),
    svc.from("recommended_spares").select("*").eq("tenant_id", tenantId).eq("matrix_id", id).order("sr_no", { ascending: true, nullsFirst: false }),
  ]);
  return { matrix: h.data || null, columns: cols.data || [], rows: rows.data || [], recommended: rec.data || [] };
};

// Reconcile a child collection by id: delete rows no longer present, upsert the rest.
const reconcile = async (svc, table, tenantId, matrixId, incoming, mapFn) => {
  const existing = await svc.from(table).select("id").eq("tenant_id", tenantId).eq("matrix_id", matrixId);
  if (existing.error) throw new Error(existing.error.message);
  const keepIds = new Set((incoming || []).filter((x) => x && x.id).map((x) => x.id));
  const toDelete = (existing.data || []).map((r) => r.id).filter((id) => !keepIds.has(id));
  if (toDelete.length) {
    const del = await svc.from(table).delete().eq("tenant_id", tenantId).in("id", toDelete);
    if (del.error) throw new Error(del.error.message);
  }
  const upserts = (incoming || []).map((x, i) => mapFn(x, i));
  // Split by id: a bulk upsert that MIXES rows-with-id and rows-without-id
  // makes PostgREST unify columns and send id=null on the new rows (the
  // uuid default only fires when the column is omitted) -> NOT NULL
  // violation. Insert the id-less (new) rows plainly, upsert the rest.
  const withId = upserts.filter((r) => r.id != null);
  const withoutId = upserts.filter((r) => r.id == null);
  if (withId.length) {
    const up = await svc.from(table).upsert(withId).select("id");
    if (up.error) throw new Error(up.error.message);
  }
  if (withoutId.length) {
    const ins = await svc.from(table).insert(withoutId).select("id");
    if (ins.error) throw new Error(ins.error.message);
  }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query.id;
    if (!id) return json(res, 400, { error: { message: "matrix id required" } });

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const full = await loadFull(svc, ctx.tenantId, id);
      if (!full.matrix) return json(res, 404, { error: { message: "Matrix not found" } });
      return json(res, 200, full);
    }

    if (req.method === "PATCH" || req.method === "PUT") {
      requirePermission(ctx, "write");
      const body = await readBody(req);

      // Confirm the matrix exists + belongs to this tenant before touching children.
      const head = await svc.from("spare_matrix").select("id").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (head.error) throw new Error(head.error.message);
      if (!head.data) return json(res, 404, { error: { message: "Matrix not found" } });

      if (body.header && typeof body.header === "object") {
        const patch = { updated_by: (ctx.user && ctx.user.id) || null, updated_at: new Date().toISOString() };
        for (const f of HEADER_FIELDS) if (f in body.header) patch[f] = body.header[f] ?? null;
        const up = await svc.from("spare_matrix").update(patch).eq("tenant_id", ctx.tenantId).eq("id", id);
        if (up.error) throw new Error(up.error.message);
      }

      if (Array.isArray(body.columns)) {
        await reconcile(svc, "spare_matrix_columns", ctx.tenantId, id, body.columns, (c, i) => {
          const row = { tenant_id: ctx.tenantId, matrix_id: id, position: c.position != null ? c.position : i };
          if (c.id) row.id = c.id;
          for (const f of COL_FIELDS) if (f in c) row[f] = c[f];
          if (!row.col_name) row.col_name = c.col_name || "";
          return row;
        });
      }

      if (Array.isArray(body.rows)) {
        await reconcile(svc, "spare_matrix_rows", ctx.tenantId, id, body.rows, (r, i) => {
          const row = { tenant_id: ctx.tenantId, matrix_id: id, position: r.position != null ? r.position : i };
          if (r.id) row.id = r.id;
          for (const f of ROW_TEXT) if (f in r) row[f] = r[f] || null;
          for (const f of ROW_NUM) if (f in r) row[f] = numOrNull(r[f]);
          row.spare_values = r.spare_values && typeof r.spare_values === "object" ? r.spare_values : {};
          row.updated_at = new Date().toISOString();
          return row;
        });
      }

      await recordAudit(ctx, { action: "spare_matrix_save", objectType: "spare_matrix", objectId: id,
        detail: { columns: Array.isArray(body.columns) ? body.columns.length : undefined, rows: Array.isArray(body.rows) ? body.rows.length : undefined } });

      const full = await loadFull(svc, ctx.tenantId, id);
      return json(res, 200, full);
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const del = await svc.from("spare_matrix").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (del.error) throw new Error(del.error.message);
      await recordAudit(ctx, { action: "spare_matrix_delete", objectType: "spare_matrix", objectId: id });
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
