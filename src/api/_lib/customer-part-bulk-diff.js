// Bulk CSV / XLSX diff preview for customer-part mappings
// (Wave CM 5.3).
//
// Today's bulk import path (admin/item_customer_parts batch
// mode, Layer D) writes every row directly. That works but
// it's scary: a 5,000-row CSV can flip half the customer's
// mappings without the operator seeing what changed.
//
// This module computes the DIFF between the incoming CSV rows
// and the current state of item_customer_parts for the same
// (tenant, customer, customer_part_number) tuples. The diff
// surfaces:
//
//   - NEW           rows with no prior mapping (clean insert)
//   - UPDATE        rows that map to a DIFFERENT item_id than
//                   the current active mapping (operator must
//                   confirm replacement; the CM 2.1 invariant
//                   requires superseding the prior row)
//   - NOOP          rows already mapped to the same item_id
//   - ERROR         rows whose item_id or part_no can't be
//                   resolved (typo, item_master miss, missing
//                   customer)
//
// The admin UI calls this BEFORE the destructive write so the
// operator approves the diff. The diff itself is pure / cheap;
// the actual write reuses the existing upsert helper.
//
// Validation surface mirrors what the existing admin route does:
//
//   - tenant_id is the caller's.
//   - customer_id either UUID or customer_name (case-insensitive).
//   - item_master_id either UUID or part_no (case-insensitive).
//   - customer_part_number trimmed + uppercased.
//
// Returns the diff structure; the caller decides whether to
// commit.

const norm = (s) => String(s == null ? "" : s).trim();
const normCode = (s) => norm(s).toUpperCase();
const isUuid = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const validateRow = async (svc, { tenantId, row, customerIdCache, itemIdCache, customerByNameCache, itemByPartCache }) => {
  // Resolve customer_id. Either supplied directly or via name.
  // Do NOT pre-filter by isUuid; the DB tenant-scoped lookup
  // is the validator (a non-UUID supplied as customer_id just
  // fails the tenant check below).
  let customerId = row.customer_id || null;
  if (!customerId && row.customer_name) {
    const key = normCode(row.customer_name);
    if (customerByNameCache.has(key)) customerId = customerByNameCache.get(key);
    else {
      const r = await svc.from("customers")
        .select("id")
        .eq("tenant_id", tenantId)
        .ilike("display_name", row.customer_name)
        .maybeSingle();
      customerId = r?.data?.id || null;
      customerByNameCache.set(key, customerId);
    }
  }
  if (!customerId) return { ok: false, error: "customer_not_found" };
  // Validate customer belongs to tenant.
  if (!customerIdCache.has(customerId)) {
    const r = await svc.from("customers")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("id", customerId)
      .maybeSingle();
    customerIdCache.set(customerId, !!r?.data);
  }
  if (!customerIdCache.get(customerId)) return { ok: false, error: "customer_not_in_tenant" };

  // Resolve item_id. Either supplied directly or via part_no.
  let itemId = row.item_master_id || row.item_id || null;
  if (!itemId && row.part_no) {
    const key = normCode(row.part_no);
    if (itemByPartCache.has(key)) itemId = itemByPartCache.get(key);
    else {
      const r = await svc.from("item_master")
        .select("id")
        .eq("tenant_id", tenantId)
        .ilike("part_no", row.part_no)
        .maybeSingle();
      itemId = r?.data?.id || null;
      itemByPartCache.set(key, itemId);
    }
  }
  if (!itemId) return { ok: false, error: "item_master_not_found" };
  if (!itemIdCache.has(itemId)) {
    const r = await svc.from("item_master")
      .select("id, part_no")
      .eq("tenant_id", tenantId)
      .eq("id", itemId)
      .maybeSingle();
    itemIdCache.set(itemId, r?.data || null);
  }
  if (!itemIdCache.get(itemId)) return { ok: false, error: "item_master_not_in_tenant" };

  const partNo = normCode(row.customer_part_number);
  if (!partNo) return { ok: false, error: "customer_part_number_required" };

  return {
    ok: true,
    customer_id: customerId,
    item_id: itemId,
    item_part_no: itemIdCache.get(itemId)?.part_no || null,
    customer_part_number: partNo,
    customer_part_description: row.customer_part_description || null,
  };
};

// Public: compute the diff. Returns:
//   {
//     new: [{ row_index, customer_id, item_id, part_no, customer_part_number, ... }],
//     update: [{ row_index, customer_id, item_id, prior_item_id, prior_part_no, ... }],
//     noop: [{ row_index, customer_id, item_id, customer_part_number }],
//     errors: [{ row_index, error, row }],
//     summary: { total, new_count, update_count, noop_count, error_count }
//   }
export const buildBulkDiff = async (svc, { tenantId, rows = [] }) => {
  if (!svc || !tenantId) return { ok: false, error: "missing_args" };
  if (!Array.isArray(rows)) return { ok: false, error: "rows_required" };
  const customerIdCache = new Map();
  const itemIdCache = new Map();
  const customerByNameCache = new Map();
  const itemByPartCache = new Map();

  // Validate every row.
  const validated = [];
  for (let i = 0; i < rows.length; i++) {
    const v = await validateRow(svc, {
      tenantId, row: rows[i], customerIdCache, itemIdCache,
      customerByNameCache, itemByPartCache,
    });
    validated.push({ row_index: i, row: rows[i], ...v });
  }

  // Pull prior mappings for every (customer, part) the validated
  // rows refer to so we can classify each as new / update / noop.
  const partKeys = new Set();
  for (const v of validated) {
    if (!v.ok) continue;
    partKeys.add(v.customer_id + "::" + v.customer_part_number);
  }
  const priorByKey = new Map();
  if (partKeys.size) {
    // Pull in chunks of 200 to keep the IN clause reasonable.
    const allKeys = [...partKeys];
    for (let c = 0; c < allKeys.length; c += 200) {
      const chunk = allKeys.slice(c, c + 200);
      const customerIds = [...new Set(chunk.map((k) => k.split("::")[0]))];
      const partNumbers = [...new Set(chunk.map((k) => k.split("::")[1]))];
      try {
        const r = await svc.from("item_customer_parts")
          .select("customer_id, customer_part_number, item_id, valid_to")
          .eq("tenant_id", tenantId)
          .in("customer_id", customerIds)
          .in("customer_part_number", partNumbers);
        const today = new Date().toISOString().slice(0, 10);
        for (const row of r?.data || []) {
          if (row.valid_to && row.valid_to < today) continue;       // superseded
          const k = row.customer_id + "::" + normCode(row.customer_part_number);
          priorByKey.set(k, row);
        }
      } catch (_e) { /* fall through */ }
    }
  }

  // Classify.
  const result = {
    new: [],
    update: [],
    noop: [],
    errors: [],
  };
  for (const v of validated) {
    if (!v.ok) {
      result.errors.push({ row_index: v.row_index, error: v.error, row: v.row });
      continue;
    }
    const key = v.customer_id + "::" + v.customer_part_number;
    const prior = priorByKey.get(key);
    if (!prior) {
      result.new.push({
        row_index: v.row_index,
        customer_id: v.customer_id,
        item_id: v.item_id,
        item_part_no: v.item_part_no,
        customer_part_number: v.customer_part_number,
        customer_part_description: v.customer_part_description,
      });
    } else if (prior.item_id === v.item_id) {
      result.noop.push({
        row_index: v.row_index,
        customer_id: v.customer_id,
        item_id: v.item_id,
        customer_part_number: v.customer_part_number,
      });
    } else {
      result.update.push({
        row_index: v.row_index,
        customer_id: v.customer_id,
        item_id: v.item_id,
        item_part_no: v.item_part_no,
        prior_item_id: prior.item_id,
        customer_part_number: v.customer_part_number,
        customer_part_description: v.customer_part_description,
      });
    }
  }
  const summary = {
    total: rows.length,
    new_count: result.new.length,
    update_count: result.update.length,
    noop_count: result.noop.length,
    error_count: result.errors.length,
  };
  return { ok: true, ...result, summary };
};

export const __test = { validateRow, norm, normCode, isUuid };
