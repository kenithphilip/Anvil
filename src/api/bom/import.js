// POST /api/bom/import
// Body: { asset: { asset_code, name?, asset_type?, customer_id?,
//                  source_format?, revision?, drawing_no?, source_country?,
//                  metadata? },
//         lines: [{ part_no, part_name?, supplier_part_no?, supplier_id?,
//                   material?, size?, qty?, uom?, level?, seq_no?, side?,
//                   std_category?, is_spare?, remarks?, raw? }],
//         project_id?, file_name? }
//
// Ingests an as-imported BOM (Phase 1, see docs/BOM_INGESTION_DESIGN.md):
//   1. upsert bom_assets (by tenant_id, asset_code, revision); track
//      uploader + last import.
//   2. replace bom_lines for the asset (delete-then-insert).
//   3. derive item_master rows (every part accessible to the catalog;
//      fill gaps, never clobber operator-set fields).
//   4. derive bill_of_materials parent->child edges from the level walk
//      (replace this asset's root edges; upsert sub-edges additively).
//   5. optional project link; write a bom_import_events provenance row;
//      audit.
//
// Strictly additive: the legacy /api/bom flat upsert is untouched.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { deriveStructure, computeDiff, itemCandidates } from "../_lib/bom-ingest.js";

const LINE_FIELDS = [
  "level", "part_no", "part_name", "supplier_part_no", "supplier_id",
  "material", "size", "qty", "uom", "side", "std_category", "is_spare", "remarks",
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const asset = body?.asset || {};
    const assetCode = asset.asset_code ? String(asset.asset_code).trim() : "";
    const lines = Array.isArray(body?.lines) ? body.lines : [];
    if (!assetCode) return json(res, 400, { error: { message: "asset.asset_code required" } });
    if (!lines.length) return json(res, 400, { error: { message: "lines[] required" } });

    const svc = serviceClient();
    const tenantId = ctx.tenantId;
    const revision = asset.revision != null ? String(asset.revision) : "";
    const now = new Date().toISOString();

    // ── 1. upsert bom_assets ──────────────────────────────────────────
    const existingAssetQ = await svc.from("bom_assets")
      .select("id, uploaded_by")
      .eq("tenant_id", tenantId).eq("asset_code", assetCode).eq("revision", revision)
      .maybeSingle();
    if (existingAssetQ.error) throw new Error("bom_assets read: " + existingAssetQ.error.message);

    const headerPatch = {
      name: asset.name != null ? asset.name : undefined,
      asset_type: asset.asset_type != null ? asset.asset_type : undefined,
      customer_id: asset.customer_id || undefined,
      source_format: asset.source_format != null ? asset.source_format : undefined,
      drawing_no: asset.drawing_no != null ? asset.drawing_no : undefined,
      source_country: asset.source_country != null ? asset.source_country : undefined,
      metadata: asset.metadata && typeof asset.metadata === "object" ? asset.metadata : undefined,
      last_uploaded_by: ctx.user?.id || null,
      last_imported_at: now,
      updated_at: now,
    };
    Object.keys(headerPatch).forEach((k) => headerPatch[k] === undefined && delete headerPatch[k]);

    let assetId;
    if (existingAssetQ.data) {
      assetId = existingAssetQ.data.id;
      const upd = await svc.from("bom_assets").update(headerPatch)
        .eq("tenant_id", tenantId).eq("id", assetId);
      if (upd.error) throw new Error("bom_assets update: " + upd.error.message);
    } else {
      const ins = await svc.from("bom_assets").insert({
        tenant_id: tenantId,
        asset_code: assetCode,
        revision,
        uploaded_by: ctx.user?.id || null,
        ...headerPatch,
      }).select("id").single();
      if (ins.error) throw new Error("bom_assets insert: " + ins.error.message);
      assetId = ins.data.id;
    }

    // ── 2. diff vs existing lines, then replace ───────────────────────
    const prevLinesQ = await svc.from("bom_lines")
      .select("part_no, qty, part_name, material, size")
      .eq("tenant_id", tenantId).eq("asset_id", assetId);
    if (prevLinesQ.error) throw new Error("bom_lines read: " + prevLinesQ.error.message);
    const diff = computeDiff(prevLinesQ.data || [], lines);

    const { ordered, edges, assemblies } = deriveStructure(assetCode, lines);

    const del = await svc.from("bom_lines").delete().eq("tenant_id", tenantId).eq("asset_id", assetId);
    if (del.error) throw new Error("bom_lines delete: " + del.error.message);

    const rows = ordered
      .filter((ln) => ln && ln.part_no)
      .map((ln, i) => {
        const row = { tenant_id: tenantId, asset_id: assetId, seq_no: i + 1 };
        for (const f of LINE_FIELDS) if (ln[f] !== undefined) row[f] = ln[f];
        row.part_no = String(ln.part_no).trim();
        if (ln.qty != null && Number.isFinite(Number(ln.qty))) row.qty = Number(ln.qty);
        if (ln.raw && typeof ln.raw === "object") row.raw = ln.raw;
        return row;
      });
    for (let i = 0; i < rows.length; i += 100) {
      const ins = await svc.from("bom_lines").insert(rows.slice(i, i + 100));
      if (ins.error) throw new Error("bom_lines insert: " + ins.error.message);
    }

    // ── 3. item_master: ensure every part exists; fill gaps only ──────
    const candidates = itemCandidates(lines, assemblies, asset.source_country);
    let itemsUpserted = 0;
    if (candidates.length) {
      const partNos = candidates.map((c) => c.part_no);
      const existingItemsQ = await svc.from("item_master")
        .select("part_no, is_assembly")
        .eq("tenant_id", tenantId).in("part_no", partNos);
      if (existingItemsQ.error) throw new Error("item_master read: " + existingItemsQ.error.message);
      const existing = new Map((existingItemsQ.data || []).map((r) => [r.part_no, r]));

      const toInsert = [];
      for (const c of candidates) {
        const ex = existing.get(c.part_no);
        if (!ex) {
          toInsert.push({
            tenant_id: tenantId,
            part_no: c.part_no,
            description: c.description,
            uom: c.uom || null,
            source_country: c.source_country || null,
            is_assembly: !!c.is_assembly,
            data_source: "imported",
          });
        } else if (c.is_assembly && !ex.is_assembly) {
          // Safe enrichment only: never clobber operator-set fields.
          const upd = await svc.from("item_master").update({ is_assembly: true })
            .eq("tenant_id", tenantId).eq("part_no", c.part_no);
          if (!upd.error) itemsUpserted += 1;
        }
      }
      for (let i = 0; i < toInsert.length; i += 100) {
        const batch = toInsert.slice(i, i + 100);
        let ins = await svc.from("item_master").insert(batch);
        if (ins.error) {
          // Pre-105 deployments may lack data_source/is_assembly; retry without them.
          const stripped = batch.map(({ data_source, is_assembly, ...r }) => r);
          ins = await svc.from("item_master").insert(stripped);
          if (ins.error) throw new Error("item_master insert: " + ins.error.message);
        }
        itemsUpserted += batch.length;
      }
    }

    // ── 4. bill_of_materials edges: replace this asset's root edges, ──
    //       upsert all derived edges additively. Shared sub-assembly
    //       edges from other assets are never deleted (ref-counting
    //       across assets is deferred), so downstream explosion is safe.
    let edgesUpserted = 0;
    if (edges.length) {
      const delRoot = await svc.from("bill_of_materials").delete()
        .eq("tenant_id", tenantId).eq("parent_part_no", assetCode);
      if (delRoot.error) throw new Error("bill_of_materials prune: " + delRoot.error.message);
      const bomRows = edges.map((e) => ({
        tenant_id: tenantId,
        parent_part_no: e.parent_part_no,
        child_part_no: e.child_part_no,
        qty: e.qty,
        uom: e.uom || null,
      }));
      for (let i = 0; i < bomRows.length; i += 100) {
        const up = await svc.from("bill_of_materials")
          .upsert(bomRows.slice(i, i + 100), { onConflict: "tenant_id,parent_part_no,child_part_no" });
        if (up.error) throw new Error("bill_of_materials upsert: " + up.error.message);
      }
      edgesUpserted = bomRows.length;
    }

    // ── 5. optional project link ──────────────────────────────────────
    if (body.project_id) {
      const link = await svc.from("bom_asset_projects").upsert({
        tenant_id: tenantId,
        asset_id: assetId,
        project_id: body.project_id,
        created_by: ctx.user?.id || null,
      }, { onConflict: "tenant_id,asset_id,project_id" });
      if (link.error) throw new Error("bom_asset_projects link: " + link.error.message);
    }

    // ── provenance event + audit ──────────────────────────────────────
    await svc.from("bom_import_events").insert({
      tenant_id: tenantId,
      asset_id: assetId,
      uploaded_by: ctx.user?.id || null,
      source_format: asset.source_format || null,
      file_name: body.file_name || null,
      line_count: rows.length,
      diff: diff.counts,
    });
    await recordAudit(ctx, {
      action: "bom_import",
      objectType: "bom_asset",
      objectId: assetId,
      detail: "asset=" + assetCode + " lines=" + rows.length + " +" + diff.counts.added + "/-" + diff.counts.removed + "/~" + diff.counts.changed,
    });

    return json(res, 200, {
      ok: true,
      asset_id: assetId,
      lines: rows.length,
      derived: { items_upserted: itemsUpserted, edges_upserted: edgesUpserted },
      diff: diff.counts,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
