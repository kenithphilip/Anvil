// Shared BOM-ingestion core (extracted from src/api/bom/import.js).
//
// This is the persistence half of a BOM import: given an already-parsed
// { asset, lines } payload it upserts the asset header, replaces the asset's
// bom_lines, and derives item_master rows + bill_of_materials edges + the
// provenance event. It is pure orchestration over the injected service client
// (no req/res), so BOTH the /api/bom/import handler (XLSX/CSV imports) and the
// P1 assembly-drawing extractor (/api/bom/from-drawing) feed the SAME
// derivation chain instead of duplicating ~180 lines — and both inherit the
// stale-schema strip-and-retry self-heals (migrations apply MANUALLY here, so
// the live DB can lag the repo).
//
// The pure derivation lives in bom-ingest.js (deriveStructure/computeDiff/
// itemCandidates); this module only adds the I/O. Callers validate their own
// inputs and decide how to surface a thrown DB error.

import { deriveStructure, computeDiff, itemCandidates } from "./bom-ingest.js";

const LINE_FIELDS = [
  "level", "part_no", "part_name", "supplier_part_no", "supplier_id",
  "material", "size", "qty", "uom", "side", "std_category", "is_spare", "remarks",
  // PDM P0 (migration 183): the assembly drawing's balloon/find number — the
  // customer-facing spare identity. Persisted when the caller (a BOM import or
  // the assembly-drawing extractor) supplies it.
  "balloon_no", "find_no",
];

// importBom({ svc, ctx, tenantId, asset, lines, projectId?, fileName? })
//   -> { asset_id, lines, derived: { items_upserted, edges_upserted }, diff }
// Throws on any DB error (message prefixed with the failing step). Assumes the
// caller has already validated asset.asset_code + a non-empty lines[].
export async function importBom({ svc, ctx, tenantId, asset, lines, projectId = null, fileName = null }) {
  const assetCode = asset.asset_code ? String(asset.asset_code).trim() : "";
  const revision = asset.revision != null ? String(asset.revision) : "";
  const now = new Date().toISOString();
  const actorId = ctx?.user?.id || null;

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
    last_uploaded_by: actorId,
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
      uploaded_by: actorId,
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
    const batch = rows.slice(i, i + 100);
    let ins = await svc.from("bom_lines").insert(batch);
    // PDM P0: balloon_no/find_no (migration 183) may not be applied yet on a
    // given deployment. Strip them and retry once so a BOM import that carries
    // balloon numbers doesn't hard-fail on a stale schema cache.
    if (ins.error && (ins.error.code === "42703" || ins.error.code === "PGRST204"
        || /balloon_no|find_no|schema cache/i.test(ins.error.message || ""))) {
      const stripped = batch.map((r) => { const c = { ...r }; delete c.balloon_no; delete c.find_no; return c; });
      ins = await svc.from("bom_lines").insert(stripped);
    }
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
  if (projectId) {
    const link = await svc.from("bom_asset_projects").upsert({
      tenant_id: tenantId,
      asset_id: assetId,
      project_id: projectId,
      created_by: actorId,
    }, { onConflict: "tenant_id,asset_id,project_id" });
    if (link.error) throw new Error("bom_asset_projects link: " + link.error.message);
  }

  // ── provenance event ──────────────────────────────────────────────
  await svc.from("bom_import_events").insert({
    tenant_id: tenantId,
    asset_id: assetId,
    uploaded_by: actorId,
    source_format: asset.source_format || null,
    file_name: fileName || null,
    line_count: rows.length,
    diff: diff.counts,
  });

  return {
    asset_id: assetId,
    lines: rows.length,
    derived: { items_upserted: itemsUpserted, edges_upserted: edgesUpserted },
    diff,
  };
}
