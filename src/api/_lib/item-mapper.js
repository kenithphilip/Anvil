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

// Exported so the orders PATCH server hook (Layer A) and the
// quote-SENT hook (Layer B) can extract the same customer-part
// candidate the resolver matches on, keeping the read and write
// sides of the loop symmetric.
export const norm = (s) => String(s == null ? "" : s).trim().toUpperCase();

// Extract every plausible part-number-like value from a line.
// Order matters: the most authoritative alias is tried first.
// Exported alongside `norm` so callers (server hooks, batch
// learners) can pick the first candidate to use as
// item_customer_parts.customer_part_number.
export const lineCandidates = (line) => {
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

// Extract specification / drawing-style codes (alphanumeric with
// dashes, 4-15 chars). The Hyundai PO format prints these in a
// separate "Specification" cell (e.g. "4-ET31062", "403A7K1172")
// distinct from the buyer's item code. Tenants whose
// item_master.specification_code matches will resolve here.
const lineSpecCandidates = (line) => {
  if (!line) return [];
  const out = [];
  for (const v of [
    line.specification_code,
    line.specificationCode,
    line.specification,
    line.spec_code,
    line.specCode,
    line.drawing_number,
    line.drawingNumber,
  ]) {
    const n = norm(v);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
};

// Normalised description for fuzzy matching. Lowercase, collapse
// whitespace, strip parens content. "GUIDE ASSY (THB-L1)" -> "guide assy".
const normDescription = (s) => {
  if (s == null) return "";
  return String(s)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
};

// Whole-word containment test: does descA contain every word of descB?
// Used to match a buyer description ("GUIDE ASSY") against a master
// description / print_name ("Guide Assembly THB-L1-70B-2").
const descriptionMatches = (long, short) => {
  if (!long || !short) return false;
  const a = normDescription(long);
  const b = normDescription(short);
  if (!a || !b) return false;
  // Require at least 2 non-trivial words to match to avoid
  // false positives on common single words ("BOLT", "WASHER").
  const words = b.split(" ").filter((w) => w.length >= 3);
  if (words.length < 1) return false;
  return words.every((w) => a.includes(w));
};

// Look up item_customer_parts and item_master once, then iterate
// the lines in memory. Single read per table; cheap for orders
// up to ~200 lines.
//
// CM 1.4: opts.context (default 'sales_order') gates the tier-1
// customer_part lookup against item_customer_parts.applies_to.
// Purchase-order / manufacturing contexts pass context='purchase_order'
// (or any non-sales_order value) and the resolver skips tier-1
// entirely so a customer's SAP code never bleeds into a Tally PO.
// Accepted contexts: 'sales_order' | 'quote' | 'rfq' | 'internal_so'.
// Anything else routes to tiers 2..5 only.
export const mapLinesToItemMaster = async (svc, tenantId, customerId, lines, opts = {}) => {
  if (!Array.isArray(lines) || !lines.length) return lines || [];
  const context = typeof opts.context === "string" && opts.context.length
    ? opts.context
    : "sales_order";
  const allCodes = new Set();
  for (const ln of lines) {
    for (const c of lineCandidates(ln)) allCodes.add(c);
  }
  if (!allCodes.size) return lines;
  const codes = [...allCodes];

  // Per-customer override table: best authority on what part
  // means what when the buyer's terminology differs. Filtered
  // by applies_to (CM 1.4) so PO / manufacturing paths can't
  // pick up SO-only mappings, and by valid_to (CM 2.1) so
  // operator-superseded rows are invisible to the resolver.
  let cpMap = new Map(); // code(uppercase) -> { item_id, customer_part_description }
  if (customerId) {
    try {
      const cp = await svc.from("item_customer_parts")
        .select("item_id, customer_part_number, customer_part_description, applies_to, valid_to, confirmed_at")
        .eq("tenant_id", tenantId)
        .eq("customer_id", customerId)
        .in("customer_part_number", codes)
        .contains("applies_to", [context]);
      if (cp && !cp.error && Array.isArray(cp.data)) {
        // CM 2.1: drop superseded rows in JS (valid_to < today).
        // We don't push the filter to PostgREST because the chain
        // is .or() syntax which complicates the .contains() above;
        // the candidate set is tiny (typically <20 rows) so the
        // post-filter cost is negligible.
        const today = new Date().toISOString().slice(0, 10);
        const active = cp.data.filter((row) => !row.valid_to || row.valid_to >= today);
        // CM 2.1 invariant: at most one active mapping per
        // (customer, customer_part_number). If two rows survive
        // the filter (race condition pre-migration-129), prefer
        // the most-recent confirmed_at to give the operator's
        // latest decision authority.
        active.sort((a, b) => {
          const ta = a?.confirmed_at ? Date.parse(a.confirmed_at) : 0;
          const tb = b?.confirmed_at ? Date.parse(b.confirmed_at) : 0;
          return tb - ta;
        });
        for (const row of active) {
          const key = norm(row.customer_part_number);
          if (key && !cpMap.has(key)) cpMap.set(key, row);
        }
      }
    } catch (_) { /* best-effort */ }
  }

  // item_master by part_no / alias / specification_code. We pull
  // every plausible hit in one query so the per-line loop runs
  // entirely in memory.
  let imByCode = new Map();
  let imByAlias = new Map();
  let imBySpec = new Map();
  let imById = new Map();
  // Also pull every item_master row for description-based fuzzy
  // matching (last-resort tier). Cap the scan at a reasonable
  // ceiling so a 50k-row master doesn't blow the request.
  let imAll = [];
  // Specification codes harvested from the lines (Hyundai-style).
  const specCodes = new Set();
  for (const ln of lines) for (const s of lineSpecCandidates(ln)) specCodes.add(s);
  const specs = [...specCodes];
  try {
    const im = await svc.from("item_master")
      .select("id, part_no, description, hsn_sac, uom, source_country, sgst_rate, cgst_rate, igst_rate, alias, print_name, gst_applicable, taxability_type, type_of_supply, rate_of_duty_pct, stock_group, specification_code")
      .eq("tenant_id", tenantId)
      .or(
        "part_no.in.(" + codes.map((c) => `"${c.replace(/"/g, '""')}"`).join(",") + ")"
        + ",alias.in.(" + codes.map((c) => `"${c.replace(/"/g, '""')}"`).join(",") + ")"
        + (specs.length ? ",specification_code.in.(" + specs.map((c) => `"${c.replace(/"/g, '""')}"`).join(",") + ")" : "")
      );
    if (im && !im.error && Array.isArray(im.data)) {
      for (const row of im.data) {
        imById.set(row.id, row);
        if (row.part_no) imByCode.set(norm(row.part_no), row);
        if (row.alias) imByAlias.set(norm(row.alias), row);
        if (row.specification_code) imBySpec.set(norm(row.specification_code), row);
      }
    }
    // Description-fallback pool: tenants typically have hundreds
    // to low thousands of items. 5000 is a comfortable cap; the
    // fallback only fires when every other tier missed.
    const imDesc = await svc.from("item_master")
      .select("id, part_no, description, hsn_sac, uom, source_country, alias, print_name, gst_applicable, taxability_type, type_of_supply, rate_of_duty_pct, stock_group, specification_code")
      .eq("tenant_id", tenantId)
      .limit(5000);
    if (imDesc && !imDesc.error && Array.isArray(imDesc.data)) {
      imAll = imDesc.data;
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
      // Hyundai-style: the PO row has a separate "Specification"
      // column distinct from the buyer item code. Match the
      // specification value against item_master.specification_code
      // before falling through to alias / fuzzy tiers.
      for (const code of lineSpecCandidates(line)) {
        const im = imBySpec.get(code);
        if (im) { match = im; matchVia = "item_master.specification_code"; break; }
      }
    }
    if (!match) {
      for (const code of candidates) {
        const im = imByAlias.get(code);
        if (im) { match = im; matchVia = "item_master.alias"; break; }
      }
    }
    if (!match) {
      // Last-resort description fuzzy match. Anchors mappings
      // like "GUIDE ASSY" -> "Guide Assembly THB-L1-70B-2" when
      // the customer's part-number translation table is not
      // populated. Only fires when the line description has at
      // least two non-trivial words (single-word descriptions
      // like "BOLT" are too ambiguous to auto-map).
      const desc = line.description || line.name || line.item || "";
      if (normDescription(desc).split(" ").filter((w) => w.length >= 3).length >= 2) {
        for (const row of imAll) {
          if (descriptionMatches(row.print_name, desc)
              || descriptionMatches(row.alias, desc)
              || descriptionMatches(row.description, desc)) {
            match = row;
            matchVia = "item_master.description_fuzzy";
            break;
          }
        }
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
export const __mapLinesPure = (
  lines,
  {
    cpMap = new Map(),
    imByCode = new Map(),
    imByAlias = new Map(),
    imBySpec = new Map(),
    imById = new Map(),
    imAll = [],
  } = {},
) => {
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
      for (const code of lineSpecCandidates(line)) {
        const im = imBySpec.get(code);
        if (im) { match = im; matchVia = "item_master.specification_code"; break; }
      }
    }
    if (!match) {
      for (const code of candidates) {
        const im = imByAlias.get(code);
        if (im) { match = im; matchVia = "item_master.alias"; break; }
      }
    }
    if (!match) {
      const desc = line.description || line.name || line.item || "";
      if (normDescription(desc).split(" ").filter((w) => w.length >= 3).length >= 2) {
        for (const row of imAll) {
          if (descriptionMatches(row.print_name, desc)
              || descriptionMatches(row.alias, desc)
              || descriptionMatches(row.description, desc)) {
            match = row;
            matchVia = "item_master.description_fuzzy";
            break;
          }
        }
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
