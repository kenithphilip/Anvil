// Customer external-IDs helper (Wave CM 1.2).
//
// A customer can carry multiple foreign identifiers: SAP business-
// partner ID, NetSuite internal ID, EDI sender, portal vendor
// code, plus per-ERP-connector keys. This helper isolates the
// CRUD + lookup surface so callers (inbound-email matcher,
// dedupe sweep, customer detail drawer, ERP sync) all share one
// implementation.
//
// API:
//   findCustomerByExternalId(svc, tenantId, systemCode, externalId)
//     -> { customer_id, is_primary, source } | null
//   listExternalIds(svc, tenantId, customerId)
//     -> [{ system_code, external_id, is_primary, source, notes }]
//   upsertExternalId(svc, tenantId, customerId, payload)
//     -> { ok, row, error }
//
// Pure I/O. All behaviour pivots on the unique index
// (tenant_id, system_code, lower(external_id)) so a duplicate
// (system, external) for two customers is a constraint violation
// the caller must reconcile (typically by merging the customer
// rows; see CM 4.3).

const ALLOWED_SYSTEMS = new Set([
  "sap", "netsuite", "d365", "acumatica", "tally", "sxe", "eclipse",
  "p21", "sage_x3", "jde", "ifs", "portal", "edi", "internal", "other",
]);

const ALLOWED_SOURCES = new Set([
  "operator", "inbound_email", "erp_sync", "portal", "bulk_import", "other",
]);

export const isValidSystem = (s) => typeof s === "string" && ALLOWED_SYSTEMS.has(s);
export const isValidSource = (s) => typeof s === "string" && ALLOWED_SOURCES.has(s);

// Normalise an external_id so the unique index match is stable.
// We lowercase + trim only; we do NOT strip dashes / spaces
// because some systems (SAP) emit ids like "AT-1234" that must
// preserve the dash to remain unique.
export const normExternalId = (s) => {
  if (s == null) return null;
  return String(s).trim().toLowerCase();
};

// Find the customer that owns (system_code, external_id) within
// a tenant. The lookup uses the unique (tenant_id, system_code,
// lower(external_id)) index for an O(1) probe.
export const findCustomerByExternalId = async (svc, tenantId, systemCode, externalId) => {
  if (!svc || !tenantId || !isValidSystem(systemCode)) return null;
  const norm = normExternalId(externalId);
  if (!norm) return null;
  try {
    const r = await svc.from("customer_external_ids")
      .select("customer_id, is_primary, source, external_id, notes")
      .eq("tenant_id", tenantId)
      .eq("system_code", systemCode)
      .ilike("external_id", norm)
      .maybeSingle();
    return r?.data || null;
  } catch (_e) { return null; }
};

// List every external ID for a customer. The drawer renders this
// grouped by system_code.
export const listExternalIds = async (svc, tenantId, customerId) => {
  if (!svc || !tenantId || !customerId) return [];
  try {
    const r = await svc.from("customer_external_ids")
      .select("id, system_code, external_id, is_primary, source, notes, created_at, updated_at")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId);
    return r?.data || [];
  } catch (_e) { return []; }
};

// Upsert by (tenant_id, system_code, lower(external_id)). When
// is_primary=true is requested, the helper first un-flags any
// other row in the same (customer_id, system_code) so the
// primary invariant holds without a database trigger.
//
// payload shape:
//   { system_code, external_id, is_primary?, source?, notes?,
//     created_by? }
export const upsertExternalId = async (svc, tenantId, customerId, payload) => {
  if (!svc || !tenantId || !customerId) return { ok: false, error: "missing_args" };
  const { system_code, external_id } = payload || {};
  if (!isValidSystem(system_code)) return { ok: false, error: "bad_system_code" };
  const norm = normExternalId(external_id);
  if (!norm) return { ok: false, error: "bad_external_id" };
  const source = isValidSource(payload?.source) ? payload.source : "operator";
  const isPrimary = !!payload?.is_primary;
  const insertRow = {
    tenant_id: tenantId,
    customer_id: customerId,
    system_code,
    external_id: norm,
    is_primary: isPrimary,
    source,
    notes: payload?.notes ?? null,
    created_by: payload?.created_by ?? null,
  };
  try {
    if (isPrimary) {
      // Demote any prior primary for the same (customer, system).
      await svc.from("customer_external_ids")
        .update({ is_primary: false })
        .eq("tenant_id", tenantId)
        .eq("customer_id", customerId)
        .eq("system_code", system_code)
        .eq("is_primary", true);
    }
    const r = await svc.from("customer_external_ids")
      .upsert(insertRow, { onConflict: "tenant_id,system_code,external_id" })
      .select("*")
      .single();
    if (r.error) return { ok: false, error: r.error.message };
    return { ok: true, row: r.data };
  } catch (err) {
    return { ok: false, error: err?.message || "upsert_failed" };
  }
};

export const __test = { ALLOWED_SYSTEMS, ALLOWED_SOURCES };
