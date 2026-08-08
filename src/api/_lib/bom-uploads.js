// Pure aggregation for the Item-Master "Uploads" view — provenance + storage:
//   - who uploaded how many BOMs / parts, and when (by_uploader)
//   - KPIs: guns/BOM assets uploaded, upload events, parts ingested, items
//     created (total + imported), documents + storage bytes
//   - a recent-uploads feed
//
// Pure / no I/O so it is unit-testable; bom/uploads.js does the fetch. Uploader
// ids stay ids here; the client resolves them to names via admin.listMembers().

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export const computeUploadsSummary = ({ assets, events, docs, itemsTotal, itemsImported } = {}) => {
  const ev = Array.isArray(events) ? events : [];

  const byRep = new Map();
  let partsIngested = 0;
  for (const e of ev) {
    partsIngested += num(e.line_count);
    const k = e.uploaded_by || "unknown";
    const cur = byRep.get(k) || { uploader_id: k, uploads: 0, parts: 0, last_at: null };
    cur.uploads += 1;
    cur.parts += num(e.line_count);
    if (!cur.last_at || String(e.created_at) > String(cur.last_at)) cur.last_at = e.created_at || null;
    byRep.set(k, cur);
  }
  const by_uploader = Array.from(byRep.values())
    .sort((a, b) => (b.uploads - a.uploads) || (b.parts - a.parts));

  const storageBytes = (Array.isArray(docs) ? docs : []).reduce((s, d) => s + num(d.size_bytes), 0);

  const recent = ev.slice(0, 50).map((e) => ({
    uploaded_by: e.uploaded_by || null,
    file_name: e.file_name || null,
    line_count: e.line_count ?? null,
    source_format: e.source_format || null,
    created_at: e.created_at || null,
    asset_id: e.asset_id || null,
  }));

  return {
    kpis: {
      assets_uploaded: (Array.isArray(assets) ? assets : []).length,
      upload_events: ev.length,
      parts_ingested: partsIngested,
      items_created: num(itemsTotal),
      items_imported: num(itemsImported),
      documents: (Array.isArray(docs) ? docs : []).length,
      storage_bytes: storageBytes,
    },
    by_uploader,
    recent,
  };
};
