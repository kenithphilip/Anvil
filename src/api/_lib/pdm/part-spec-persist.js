// Persist the engineering spec a part drawing already gave us.
//
// The part_drawing extractor reads finish, heat treatment, the tolerance table
// and the GD&T frames; nothing consumed them, so they lived and died inside
// extraction_runs.normalized_extract. Migration 224 gives them columns on
// item_specifications; this writes them there.
//
// TWO RULES, both about not destroying what a person knows:
//   1. A human-entered spec is never overwritten by an extraction. If
//      spec_source is null and the row already has a value, the drawing loses.
//   2. A missing field never blanks a stored one. An extractor that could not
//      read the heat treatment is silent about it, not asserting "none".

const s = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t : null;
};

// Keep only well-formed records, so a malformed model output cannot put junk in
// a column an engineer will read as authoritative.
// `required` is the key without which the record says nothing: a tolerance row
// with no tolerance, or a feature-control frame with no symbol, is not a
// partial record -- it is noise in a table an engineer reads as authoritative.
// The extractor emits all keys with nulls, so "any key survived" would have
// stored exactly that noise.
const cleanList = (rows, keys, required) => {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const rec = {};
    for (const k of keys) {
      const v = s(r[k]);
      if (v != null) rec[k] = v;
    }
    if (rec[required] != null) out.push(rec);
  }
  return out;
};

const cleanNotes = (notes) => {
  if (!Array.isArray(notes)) return [];
  return notes.map(s).filter((n) => n != null);
};

// Pure: the engineering-spec patch a part_spec implies. Returns null when the
// drawing carried nothing worth storing, so the caller can skip the write.
export const partSpecToItemSpec = (partSpec) => {
  const ps = partSpec || {};
  const patch = {};
  const finish = s(ps.finish);
  const heat = s(ps.heat_treatment);
  const tolerances = cleanList(ps.tolerances, ["feature", "nominal", "tolerance"], "tolerance");
  const gdt = cleanList(ps.gdt, ["symbol", "tolerance", "datum"], "symbol");
  const notes = cleanNotes(ps.notes);
  if (finish != null) patch.finish = finish;
  if (heat != null) patch.heat_treatment = heat;
  if (tolerances.length) patch.tolerances = tolerances;
  if (gdt.length) patch.gdt = gdt;
  if (notes.length) patch.drawing_notes = notes;
  return Object.keys(patch).length ? patch : null;
};

// Decide what actually gets written, given what is already stored.
// Pure, so the precedence rule is testable without a database.
export const mergeItemSpec = (existing, patch, { extractionRunId = null, now = null } = {}) => {
  if (!patch) return null;
  const cur = existing || {};
  // Rule 1: a human-entered spec wins. spec_source null + any stored engineering
  // value means a person filled this in; an extraction must not overwrite it.
  const humanAuthored = !cur.spec_source && (
    s(cur.finish) != null || s(cur.heat_treatment) != null
    || (Array.isArray(cur.tolerances) && cur.tolerances.length > 0)
    || (Array.isArray(cur.gdt) && cur.gdt.length > 0)
  );
  if (humanAuthored) return null;
  const stamp = now || new Date().toISOString();
  // Rule 2: only fields the drawing actually carried (patch already omits the
  // rest), so a silent extractor never blanks a stored value.
  return {
    ...patch,
    spec_source: "drawing",
    // Do NOT inherit the previous run's id: these values are being REWRITTEN,
    // so citing the run that produced the old ones would point an engineer at
    // an extraction whose content contradicts the value beside it.
    spec_extraction_run_id: extractionRunId || null,
    spec_captured_at: stamp,
    updated_at: stamp,
  };
};

// Write it. Resolves the item by part_no within the tenant; a part that is not
// in item_master yet is skipped rather than created -- this is enrichment of a
// known item, not a back door into the item master.
//
// Best-effort and non-fatal by contract: the raw-material determination is the
// caller's primary job and must not fail because a spec could not be stored.
// Returns { stored, reason }.
export const persistPartSpec = async (svc, tenantId, { finishedPartNo, partSpec, extractionRunId = null }) => {
  const patch = partSpecToItemSpec(partSpec);
  if (!patch) return { stored: false, reason: "nothing_to_store" };
  if (!finishedPartNo) return { stored: false, reason: "no_part_no" };
  try {
    const item = await svc.from("item_master").select("id")
      .eq("tenant_id", tenantId).eq("part_no", finishedPartNo).maybeSingle();
    if (item.error) return { stored: false, reason: "item_lookup_failed: " + item.error.message };
    if (!item.data) return { stored: false, reason: "item_not_found" };
    const itemId = item.data.id;
    const cur = await svc.from("item_specifications")
      .select("finish, heat_treatment, tolerances, gdt, spec_source, spec_extraction_run_id")
      .eq("tenant_id", tenantId).eq("item_id", itemId).maybeSingle();
    // FAIL CLOSED. An unchecked read error yields data:null, which reads as "no
    // stored spec" -- so the guard that exists to protect a hand-entered spec
    // would overwrite it precisely when it cannot see what it is protecting.
    // (Most likely on an environment where migration 224 is not yet applied:
    // the select 42703s and every human spec gets clobbered.)
    if (cur.error) return { stored: false, reason: "read_failed: " + cur.error.message };
    const merged = mergeItemSpec(cur.data, patch, { extractionRunId });
    if (!merged) return { stored: false, reason: "human_authored_spec_preserved" };
    const up = await svc.from("item_specifications")
      .upsert({ tenant_id: tenantId, item_id: itemId, ...merged }, { onConflict: "item_id" });
    if (up.error) return { stored: false, reason: "write_failed: " + up.error.message };
    return { stored: true, reason: "ok", fields: Object.keys(patch) };
  } catch (e) {
    return { stored: false, reason: "threw: " + (e?.message || String(e)) };
  }
};
