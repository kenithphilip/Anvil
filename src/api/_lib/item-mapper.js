// Map extracted PO line items to the tenant's canonical
// item_master via per-customer translation tables.
//
// Different customers refer to the same physical part with
// different codes. Hyundai writes "GD544202603190008" on their
// PO; the tenant's master carries it as "THB-L1-70B-2" with an
// alias "BEND ADAPTER". Faith's PO already uses the tenant's
// own part number directly. Walk every line and try to resolve
// the canonical item so the recon table + Tally voucher emit +
// PDF render get the right print_name / hsn / GST rate /
// taxability without operator hand-mapping.
//
// Resolution order per line (first match wins):
//
//   1. item_customer_parts row matching (customer_id,
//      customer_part_number) when customer_id is known. Most
//      authoritative; the operator has explicitly recorded the
//      translation.
//   2. item_master row whose part_no matches the line's
//      partNumber / itemCode / sku / code. Tenants like OBARA
//      where the customer uses the tenant's own part number
//      directly hit this branch.
//   3. item_master row whose alias matches. Tally users
//      configure aliases on the master so OEM-spec names like
//      "BEND ADAPTER" resolve.
//
// On match: stamp `_mapped_item` on the line with the canonical
// fields (id, part_no, alias, description, hsn_sac, type_of_supply,
// rate_of_duty_pct, taxability_type, stock_group, print_name).
// The recon table renders the mapped print_name when set;
// the Tally composer reads canonical hsn / GST from here. No
// in-place overwrite of the operator-visible value so the
// human-in-the-loop can still inspect the original.

const norm = (s) => String(s == null ? "" : s).trim().toUpperCase();

// Extract every plausible part-number-like value from a line.
// Order matters: the most authoritative alias is tried first.
const lineCandidates = (line) => {
  if (!line) return [];
  const out = [];
  for (const v of [
    line.itemCode,
    line.partNumber,
    line.partNo,
    line.sku,
    line.code,
    line.customer_part_number,
    line.tallyItemName,
    line.itemName,
  ]) {
    const n = norm(v);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
};

// Look up item_customer_parts and item_master once, then iterate
// the lines in memory. Single read per table; cheap for orders
// up to ~200 lines.
export const mapLinesToItemMaster = async (svc, tenantId, customerId, lines) => {
  if (!Array.isArray(lines) || !lines.length) return lines || [];
  const allCodes = new Set();
  for (const ln of lines) {
    for (const c of lineCandidates(ln)) allCodes.add(c);
  }
  if (!allCodes.size) return lines;
  const codes = [...allCodes];

  // Per-customer override table: best authority on what part
  // means what when the buyer's terminology differs.
  let cpMap = new Map(); // code(uppercase) -> { item_id, customer_part_description }
  if (customerId) {
    try {
      const cp = await svc.from("item_customer_parts")
        .select("item_id, customer_part_number, customer_part_description")
        .eq("tenant_id", tenantId)
        .eq("customer_id", customerId)
        .in("customer_part_number", codes);
      if (cp && !cp.error && Array.isArray(cp.data)) {
        for (const row of cp.data) {
          const key = norm(row.customer_part_number);
          if (key && !cpMap.has(key)) cpMap.set(key, row);
        }
      }
    } catch (_) { /* best-effort */ }
  }

  // item_master by part_no or alias. We pull every plausible
  // hit in one query.
  let imByCode = new Map();
  let imByAlias = new Map();
  let imById = new Map();
  try {
    const im = await svc.from("item_master")
      .select("id, part_no, description, hsn_sac, uom, source_country, sgst_rate, cgst_rate, igst_rate, alias, print_name, gst_applicable, taxability_type, type_of_supply, rate_of_duty_pct, stock_group, specification_code")
      .eq("tenant_id", tenantId)
      .or(
        "part_no.in.(" + codes.map((c) => `"${c.replace(/"/g, '""')}"`).join(",") + ")"
        + ",alias.in.(" + codes.map((c) => `"${c.replace(/"/g, '""')}"`).join(",") + ")"
      );
    if (im && !im.error && Array.isArray(im.data)) {
      for (const row of im.data) {
        imById.set(row.id, row);
        if (row.part_no) imByCode.set(norm(row.part_no), row);
        if (row.alias) imByAlias.set(norm(row.alias), row);
      }
    }
    // Also pull item_master rows referenced by item_customer_parts
    // (their item_id may not be in the part_no / alias hit set).
    const cpItemIds = [...cpMap.values()].map((r) => r.item_id).filter((id) => id && !imById.has(id));
    if (cpItemIds.length) {
      const im2 = await svc.from("item_master")
        .select("id, part_no, description, hsn_sac, uom, source_country, sgst_rate, cgst_rate, igst_rate, alias, print_name, gst_applicable, taxability_type, type_of_supply, rate_of_duty_pct, stock_group, specification_code")
        .eq("tenant_id", tenantId)
        .in("id", cpItemIds);
      if (im2 && !im2.error && Array.isArray(im2.data)) {
        for (const row of im2.data) {
          imById.set(row.id, row);
          if (row.part_no) imByCode.set(norm(row.part_no), row);
          if (row.alias) imByAlias.set(norm(row.alias), row);
        }
      }
    }
  } catch (_) { /* best-effort */ }

  // Resolve per line.
  return lines.map((line) => {
    const candidates = lineCandidates(line);
    let match = null;
    let matchVia = null;
    let customerPartDesc = null;
    for (const code of candidates) {
      const cp = cpMap.get(code);
      if (cp && imById.has(cp.item_id)) {
        match = imById.get(cp.item_id);
        matchVia = "customer_part";
        customerPartDesc = cp.customer_part_description || null;
        break;
      }
    }
    if (!match) {
      for (const code of candidates) {
        const im = imByCode.get(code);
        if (im) { match = im; matchVia = "item_master.part_no"; break; }
      }
    }
    if (!match) {
      for (const code of candidates) {
        const im = imByAlias.get(code);
        if (im) { match = im; matchVia = "item_master.alias"; break; }
      }
    }
    if (!match) return { ...line, _mapped_item: null };
    return {
      ...line,
      // Backfill canonical values only when the line is missing
      // them; never overwrite operator-visible numbers.
      hsn: line.hsn || line.hsn_sac || match.hsn_sac || null,
      uom: line.uom || line.unit || match.uom || null,
      _mapped_item: {
        id: match.id,
        part_no: match.part_no,
        alias: match.alias || null,
        print_name: match.print_name || null,
        description: match.description || null,
        customer_part_description: customerPartDesc,
        hsn_sac: match.hsn_sac || null,
        uom: match.uom || null,
        source_country: match.source_country || null,
        gst_applicable: match.gst_applicable || null,
        taxability_type: match.taxability_type || null,
        type_of_supply: match.type_of_supply || null,
        rate_of_duty_pct: match.rate_of_duty_pct != null ? Number(match.rate_of_duty_pct) : null,
        stock_group: match.stock_group || null,
        specification_code: match.specification_code || null,
        match_via: matchVia,
      },
    };
  });
};

// Exported for tests; pure transform that takes the lookup maps
// directly instead of doing DB I/O.
export const __mapLinesPure = (lines, { cpMap = new Map(), imByCode = new Map(), imByAlias = new Map(), imById = new Map() } = {}) => {
  return lines.map((line) => {
    const candidates = lineCandidates(line);
    let match = null;
    let matchVia = null;
    let customerPartDesc = null;
    for (const code of candidates) {
      const cp = cpMap.get(code);
      if (cp && imById.has(cp.item_id)) {
        match = imById.get(cp.item_id);
        matchVia = "customer_part";
        customerPartDesc = cp.customer_part_description || null;
        break;
      }
    }
    if (!match) {
      for (const code of candidates) {
        const im = imByCode.get(code);
        if (im) { match = im; matchVia = "item_master.part_no"; break; }
      }
    }
    if (!match) {
      for (const code of candidates) {
        const im = imByAlias.get(code);
        if (im) { match = im; matchVia = "item_master.alias"; break; }
      }
    }
    if (!match) return { ...line, _mapped_item: null };
    return {
      ...line,
      hsn: line.hsn || line.hsn_sac || match.hsn_sac || null,
      uom: line.uom || line.unit || match.uom || null,
      _mapped_item: {
        id: match.id,
        part_no: match.part_no,
        alias: match.alias || null,
        print_name: match.print_name || null,
        description: match.description || null,
        customer_part_description: customerPartDesc,
        hsn_sac: match.hsn_sac || null,
        uom: match.uom || null,
        match_via: matchVia,
      },
    };
  });
};
