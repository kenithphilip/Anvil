// Map awarded supplier-RFQ winners into a quote's price composition.
//
// Shared by /api/supplier_rfq/award (feeds on award) and
// /api/supplier_rfq/sync_composition (re-derives on demand from the
// persisted awarded_invitation_id, so it also repairs RFQs that were
// awarded before the feed existed / a feed that previously failed).
//
// Matches RFQ line_no -> price_composition_lines.line_index (the quote
// line index). UPDATEs the existing composition line's supplier fields, or
// INSERTs a minimal row if the composition has not been started yet.

// True only for a Postgres "undefined column" error (code 42703). The message
// fallback is deliberately anchored to the real error shape —
//   column <table>.<col> does not exist   /   column "<col>" of relation ...
// — so it does NOT misfire on a FK-constraint violation (23503,
// "Key (supplier_id)=(..) is not present ...") that merely mentions the column
// name. Matching that loosely would silently swallow a real FK error.
export const isMissingColumn = (err, col) =>
  !!err && (err.code === "42703" || new RegExp("column\\s+[\"'\\w.]*" + col + "\\b", "i").test(err.message || ""));

// Load id->vendor_name and id->supplier_id maps for a tenant's vendors.
// Tolerates a pre-168 DB that lacks vendors.supplier_id: falls back to
// name-only so awards/sync keep working (supplier ids simply resolve null,
// i.e. the name-slug fallback path) until migration 168 is applied.
export const loadVendorMaps = async (svc, ctx) => {
  let vq = await svc.from("vendors").select("id, vendor_name, supplier_id").eq("tenant_id", ctx.tenantId);
  if (vq.error && isMissingColumn(vq.error, "supplier_id")) {
    vq = await svc.from("vendors").select("id, vendor_name").eq("tenant_id", ctx.tenantId);
  }
  const rows = vq.data || [];
  return {
    vendorName: new Map(rows.map((v) => [v.id, v.vendor_name])),
    vendorSupplier: new Map(rows.map((v) => [v.id, v.supplier_id || null])),
  };
};

// Stamp the chosen supplier onto the customer quote LINE too (migration 168
// bridge). Cost/supplier ONLY — the sell price (listed/discounted_unit_price)
// is the customer-facing quote and is never touched here. No-op when the
// winning vendor isn't bridged (line.supplier_id null) or no quote line
// matches this line_index — quote lines are owned by the quote, not the RFQ,
// so we never insert one. Tolerates a pre-167 DB (missing column) so the feed
// still succeeds while the migration hasn't been applied.
const stampQuoteLineSupplier = async (svc, ctx, quoteId, line) => {
  if (!line.supplier_id) return;
  const ql = await svc.from("quote_lines")
    .update({ supplier_id: line.supplier_id, updated_at: new Date().toISOString() })
    .eq("tenant_id", ctx.tenantId).eq("quote_id", quoteId).eq("line_index", line.line_no)
    .select("id");
  if (ql.error && !isMissingColumn(ql.error, "supplier_id")) throw new Error(ql.error.message);
};

// Feed one line. Throws on a hard DB error; callers treat it best-effort.
export const feedCompositionLine = async (svc, ctx, quoteId, line) => {
  const fields = {
    supplier_name: line.vendor_name || null,
    supplier_unit_price: line.unit_price != null ? Number(line.unit_price) : null,
    supplier_currency: line.currency || null,
    supplier_quote_no: line.supplier_quote_ref || null,
    updated_at: new Date().toISOString(),
  };
  // FK bridge (168): a bridged winning vendor stamps supplier_id on the
  // composition line. Guarded (not `|| null`) so re-feeding an un-bridged
  // vendor never wipes a previously-resolved id (161 slug backfill / manual).
  if (line.supplier_id) fields.supplier_id = line.supplier_id;

  let upd = await svc.from("price_composition_lines")
    .update(fields)
    .eq("tenant_id", ctx.tenantId).eq("quote_id", quoteId).eq("line_index", line.line_no)
    .select("id");
  // Pre-161 deployments lack supplier_id on composition lines; strip + retry.
  if (upd.error && "supplier_id" in fields && isMissingColumn(upd.error, "supplier_id")) {
    delete fields.supplier_id;
    upd = await svc.from("price_composition_lines").update(fields)
      .eq("tenant_id", ctx.tenantId).eq("quote_id", quoteId).eq("line_index", line.line_no)
      .select("id");
  }
  if (upd.error) throw new Error(upd.error.message);
  if (upd.data && upd.data.length) { await stampQuoteLineSupplier(svc, ctx, quoteId, line); return; }

  const insRow = {
    tenant_id: ctx.tenantId,
    quote_id: quoteId,
    line_index: line.line_no,
    part_no: line.part_number || null,
    qty: line.quantity != null ? Number(line.quantity) : null,
    ...fields,
  };
  let ins = await svc.from("price_composition_lines").insert(insRow).select("id");
  if (ins.error && "supplier_id" in insRow && isMissingColumn(ins.error, "supplier_id")) {
    delete insRow.supplier_id;
    ins = await svc.from("price_composition_lines").insert(insRow).select("id");
  }
  if (ins.error) throw new Error(ins.error.message);
  await stampQuoteLineSupplier(svc, ctx, quoteId, line);
};

// Re-derive the whole quote composition from its linked RFQs' awarded lines.
// Returns { fed, eligible, rfqs }.
export const syncQuoteCompositionFromAwards = async (svc, ctx, quoteId) => {
  const rfqsQ = await svc.from("supplier_rfqs").select("id")
    .eq("tenant_id", ctx.tenantId).eq("source_quote_id", quoteId);
  if (rfqsQ.error) throw new Error(rfqsQ.error.message);
  const rfqIds = (rfqsQ.data || []).map((r) => r.id);
  if (!rfqIds.length) return { fed: 0, eligible: 0, rfqs: 0 };

  const [linesQ, quotesQ, vendorMaps] = await Promise.all([
    svc.from("supplier_rfq_lines").select("rfq_id, line_no, part_number, quantity, awarded_invitation_id")
      .eq("tenant_id", ctx.tenantId).in("rfq_id", rfqIds),
    svc.from("supplier_quotes").select("invitation_id, line_no, unit_price, currency, supplier_quote_ref, vendor_id, rfq_id")
      .eq("tenant_id", ctx.tenantId).in("rfq_id", rfqIds),
    loadVendorMaps(svc, ctx),
  ]);
  if (linesQ.error) throw new Error(linesQ.error.message);
  const { vendorName, vendorSupplier } = vendorMaps;

  let fed = 0;
  let eligible = 0;
  const errors = [];
  for (const ln of (linesQ.data || [])) {
    if (!ln.awarded_invitation_id) continue;
    const win = (quotesQ.data || []).find((q) => q.invitation_id === ln.awarded_invitation_id && q.line_no === ln.line_no);
    if (!win) continue;
    eligible += 1;
    try {
      await feedCompositionLine(svc, ctx, quoteId, {
        line_no: ln.line_no,
        unit_price: win.unit_price,
        currency: win.currency,
        supplier_quote_ref: win.supplier_quote_ref,
        vendor_name: vendorName.get(win.vendor_id) || null,
        supplier_id: vendorSupplier.get(win.vendor_id) || null,
        part_number: ln.part_number,
        quantity: ln.quantity,
      });
      fed += 1;
    } catch (e) { errors.push(String(e?.message || e)); }
  }
  return { fed, eligible, rfqs: rfqIds.length, errors: errors.length ? errors : undefined };
};
