// Shared upsert helper for item_customer_parts. Every write path
// (admin drawer add-row, admin bulk CSV/XLSX, recon-table manual
// map, quote SENT learning, LLM-suggest accept) funnels through
// this module so the audit columns introduced by migration 115
// (created_via / created_by / confidence_pct / confirmed_at /
// confirmed_by) land consistently.
//
// Priority rules:
//   manual / bulk_import   = explicit human action, wins
//   llm_suggest            = operator-accepted AI suggestion
//   quote_sent             = bulk learning at quote send
//   cross_customer / legacy / null = least authoritative
//
// On conflict (same composite PK):
//   - If existing is manual/bulk_import AND incoming is non-explicit:
//     noop. We never overwrite a hand-verified row with a quote-
//     sourced or AI-sourced one.
//   - Else: write the new row, refreshing every audit column.
//
// The helper deliberately does NOT call recordAudit. Each caller
// has different ctx + audit verbs, so they wrap the result in
// their own recordAudit/recordEvent.

const VALID_CREATED_VIA = new Set([
  "manual",
  "quote_sent",
  "quote_accepted",
  "bulk_import",
  "llm_suggest",
  "cross_customer",
  "legacy",
]);

const isExplicit = (v) => v === "manual" || v === "bulk_import";

// One-row upsert. Returns { row, action: "insert" | "update" | "noop" }.
// `params` is the new row's logical fields; the helper picks the
// audit columns based on createdVia + actor.
export const upsertCustomerPart = async (svc, params) => {
  const {
    tenantId,
    itemId,
    customerId,
    customerPartNumber,
    customerItemCode = null,
    customerPartDescription = null,
    customerProject = null,
    validFrom = null,
    validTo = null,
    isPrimary = false,
    createdVia,
    createdBy = null,
    confidencePct = null,
    confirmedAt = null,
    confirmedBy = null,
  } = params || {};

  if (!tenantId || !itemId || !customerId || !customerPartNumber) {
    throw new Error("upsertCustomerPart: tenantId/itemId/customerId/customerPartNumber required");
  }
  if (createdVia && !VALID_CREATED_VIA.has(createdVia)) {
    throw new Error("upsertCustomerPart: invalid createdVia " + createdVia);
  }

  const normPart = String(customerPartNumber).trim();
  if (!normPart) {
    throw new Error("upsertCustomerPart: customer_part_number is empty after trim");
  }
  // CM P2b: the buyer's SAP item code, kept in a distinct column.
  const cic = customerItemCode != null && String(customerItemCode).trim()
    ? String(customerItemCode).trim()
    : null;

  // Read existing row (if any) so we can apply the priority rule.
  const existing = await svc
    .from("item_customer_parts")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("item_id", itemId)
    .eq("customer_id", customerId)
    .eq("customer_part_number", normPart)
    .maybeSingle();

  if (existing.error && existing.error.code !== "PGRST116") {
    throw new Error(existing.error.message);
  }

  const prev = existing.data || null;
  const newIsExplicit = isExplicit(createdVia);

  // Preserve manual / bulk_import rows from being overwritten by
  // non-explicit writes (quote_sent, llm_suggest, etc.).
  if (prev && isExplicit(prev.created_via) && !newIsExplicit) {
    return { row: prev, action: "noop" };
  }

  // is_primary demotion: when the new row is primary, every other
  // mapping for this (tenant, item, customer) gets demoted so at
  // most one primary per pair survives. Same behaviour as the
  // existing admin POST.
  if (isPrimary) {
    await svc
      .from("item_customer_parts")
      .update({ is_primary: false })
      .eq("tenant_id", tenantId)
      .eq("item_id", itemId)
      .eq("customer_id", customerId)
      .neq("customer_part_number", normPart);
  }

  // CM P2b: honour the SAP-code invariant (migration 182 partial
  // unique index: one ACTIVE row per (tenant, customer,
  // customer_item_code)). If this SAP code is already active under a
  // DIFFERENT item, supersede that prior mapping (stamp valid_to)
  // before we write the new one, mirroring the mig-129 supersession
  // workflow for customer_part_number. Best-effort + guarded: a
  // 42703 on a pre-migration DB (column absent) must not abort the
  // write, which then falls back to the pre-P2b behaviour.
  if (cic) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      await svc
        .from("item_customer_parts")
        .update({ valid_to: today })
        .eq("tenant_id", tenantId)
        .eq("customer_id", customerId)
        .eq("customer_item_code", cic)
        .is("valid_to", null)
        .neq("item_id", itemId);
    } catch (_) { /* column may not exist pre-migration; degrade */ }
  }

  const row = {
    tenant_id: tenantId,
    item_id: itemId,
    customer_id: customerId,
    customer_part_number: normPart,
    customer_part_description: customerPartDescription,
    customer_project: customerProject,
    valid_from: validFrom,
    valid_to: validTo,
    is_primary: !!isPrimary,
    created_via: createdVia || null,
    created_by: createdBy,
    confidence_pct: confidencePct != null ? Number(confidencePct) : null,
    confirmed_at: confirmedAt,
    confirmed_by: confirmedBy,
  };
  // Only include the SAP column when we actually have a code, so
  // existing callers produce byte-identical rows and pre-migration
  // deployments (column absent) are unaffected.
  if (cic) row.customer_item_code = cic;

  // When inserting (no prev), keep created_by on first write only.
  // When updating, do NOT change the original created_by; refresh
  // only the confirm-side columns.
  if (prev) {
    const patch = {
      customer_part_description: row.customer_part_description != null
        ? row.customer_part_description
        : prev.customer_part_description,
      customer_project: row.customer_project != null ? row.customer_project : prev.customer_project,
      valid_from: row.valid_from != null ? row.valid_from : prev.valid_from,
      valid_to: row.valid_to != null ? row.valid_to : prev.valid_to,
      is_primary: row.is_primary,
      created_via: row.created_via || prev.created_via,
      confidence_pct: row.confidence_pct != null ? row.confidence_pct : prev.confidence_pct,
      confirmed_at: row.confirmed_at || prev.confirmed_at,
      confirmed_by: row.confirmed_by || prev.confirmed_by,
    };
    // CM P2b: backfill the SAP code onto an existing row (only when
    // supplied, so the column stays absent from the patch for
    // pre-P2b callers / pre-migration deployments).
    if (cic) patch.customer_item_code = cic;
    const upd = await svc
      .from("item_customer_parts")
      .update(patch)
      .eq("tenant_id", tenantId)
      .eq("item_id", itemId)
      .eq("customer_id", customerId)
      .eq("customer_part_number", normPart)
      .select("*")
      .single();
    if (upd.error) throw new Error(upd.error.message);
    return { row: upd.data, action: "update" };
  }

  const ins = await svc
    .from("item_customer_parts")
    .insert(row)
    .select("*")
    .single();
  if (ins.error) throw new Error(ins.error.message);
  return { row: ins.data, action: "insert" };
};

// Resolve a customer reference (either UUID or customer_name) to a
// customers.id within the tenant. Returns the id or null on miss.
// Used by the batch import path; the recon-table and quote write
// paths always already have a UUID.
export const resolveCustomerRef = async (svc, tenantId, ref) => {
  if (!ref) return null;
  const s = String(ref).trim();
  if (!s) return null;
  // UUID shape (8-4-4-4-12 hex). Validate then return.
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) {
    const r = await svc.from("customers").select("id").eq("tenant_id", tenantId).eq("id", s).maybeSingle();
    if (r.data) return r.data.id;
    return null;
  }
  // Name lookup, case-insensitive.
  const r = await svc.from("customers").select("id").eq("tenant_id", tenantId).ilike("customer_name", s).maybeSingle();
  if (r.data) return r.data.id;
  return null;
};

// Resolve an item reference (item_master_id UUID OR
// item_master.part_no) to an item_master.id within the tenant.
export const resolveItemRef = async (svc, tenantId, idRef, partNoRef) => {
  if (idRef) {
    const s = String(idRef).trim();
    if (s && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) {
      const r = await svc.from("item_master").select("id").eq("tenant_id", tenantId).eq("id", s).maybeSingle();
      if (r.data) return r.data.id;
    }
  }
  if (partNoRef) {
    const s = String(partNoRef).trim();
    if (s) {
      const r = await svc.from("item_master").select("id").eq("tenant_id", tenantId).ilike("part_no", s).maybeSingle();
      if (r.data) return r.data.id;
    }
  }
  return null;
};

// Batch upsert used by the admin bulk-import path and (in future)
// any other multi-row caller. `rows` may carry either UUID
// references or human-readable names / part numbers; the helper
// resolves them per row and records per-row errors.
//
// Returns { ok, errors }: ok is the count of successful writes,
// errors is an array of { row_index, reason } the caller can
// surface in the UI without aborting the rest of the batch.
export const upsertCustomerPartsBatch = async (svc, ctx, rows) => {
  const errors = [];
  let ok = 0;
  if (!Array.isArray(rows)) return { ok: 0, errors: [{ row_index: -1, reason: "rows must be an array" }] };
  const actor = ctx && ctx.user && ctx.user.id ? ctx.user.id : null;
  const tenantId = ctx && ctx.tenantId;
  if (!tenantId) return { ok: 0, errors: [{ row_index: -1, reason: "ctx.tenantId required" }] };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const itemId = await resolveItemRef(
        svc,
        tenantId,
        r.item_master_id || r.item_id,
        r.item_master_part_no || r.part_no,
      );
      if (!itemId) {
        errors.push({ row_index: i, reason: "item_master not found (id=" + (r.item_master_id || r.item_id || "") + ", part_no=" + (r.item_master_part_no || r.part_no || "") + ")" });
        continue;
      }
      const customerId = await resolveCustomerRef(svc, tenantId, r.customer_id || r.customer_name);
      if (!customerId) {
        errors.push({ row_index: i, reason: "customer not found (" + (r.customer_id || r.customer_name || "") + ")" });
        continue;
      }
      if (!r.customer_part_number || !String(r.customer_part_number).trim()) {
        errors.push({ row_index: i, reason: "customer_part_number required" });
        continue;
      }
      await upsertCustomerPart(svc, {
        tenantId,
        itemId,
        customerId,
        customerPartNumber: r.customer_part_number,
        customerPartDescription: r.customer_part_description || null,
        customerProject: r.customer_project || null,
        validFrom: r.valid_from || null,
        validTo: r.valid_to || null,
        isPrimary: !!r.is_primary,
        createdVia: "bulk_import",
        createdBy: actor,
        confidencePct: 100,
        confirmedAt: new Date().toISOString(),
        confirmedBy: actor,
      });
      ok++;
    } catch (e) {
      errors.push({ row_index: i, reason: (e && e.message) || String(e) });
    }
  }

  return { ok, errors };
};
