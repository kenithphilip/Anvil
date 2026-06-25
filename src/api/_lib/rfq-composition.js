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

// Feed one line. Throws on a hard DB error; callers treat it best-effort.
export const feedCompositionLine = async (svc, ctx, quoteId, line) => {
  const fields = {
    supplier_name: line.vendor_name || null,
    supplier_unit_price: line.unit_price != null ? Number(line.unit_price) : null,
    supplier_currency: line.currency || null,
    supplier_quote_no: line.supplier_quote_ref || null,
    updated_at: new Date().toISOString(),
  };
  const upd = await svc.from("price_composition_lines")
    .update(fields)
    .eq("tenant_id", ctx.tenantId).eq("quote_id", quoteId).eq("line_index", line.line_no)
    .select("id");
  if (upd.error) throw new Error(upd.error.message);
  if (upd.data && upd.data.length) return;
  const ins = await svc.from("price_composition_lines").insert({
    tenant_id: ctx.tenantId,
    quote_id: quoteId,
    line_index: line.line_no,
    part_no: line.part_number || null,
    qty: line.quantity != null ? Number(line.quantity) : null,
    ...fields,
  }).select("id");
  if (ins.error) throw new Error(ins.error.message);
};

// Re-derive the whole quote composition from its linked RFQs' awarded lines.
// Returns { fed, eligible, rfqs }.
export const syncQuoteCompositionFromAwards = async (svc, ctx, quoteId) => {
  const rfqsQ = await svc.from("supplier_rfqs").select("id")
    .eq("tenant_id", ctx.tenantId).eq("source_quote_id", quoteId);
  if (rfqsQ.error) throw new Error(rfqsQ.error.message);
  const rfqIds = (rfqsQ.data || []).map((r) => r.id);
  if (!rfqIds.length) return { fed: 0, eligible: 0, rfqs: 0 };

  const [linesQ, quotesQ, vendorsQ] = await Promise.all([
    svc.from("supplier_rfq_lines").select("rfq_id, line_no, part_number, quantity, awarded_invitation_id")
      .eq("tenant_id", ctx.tenantId).in("rfq_id", rfqIds),
    svc.from("supplier_quotes").select("invitation_id, line_no, unit_price, currency, supplier_quote_ref, vendor_id, rfq_id")
      .eq("tenant_id", ctx.tenantId).in("rfq_id", rfqIds),
    svc.from("vendors").select("id, vendor_name").eq("tenant_id", ctx.tenantId),
  ]);
  if (linesQ.error) throw new Error(linesQ.error.message);
  const vendorName = new Map((vendorsQ.data || []).map((v) => [v.id, v.vendor_name]));

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
        part_number: ln.part_number,
        quantity: ln.quantity,
      });
      fed += 1;
    } catch (e) { errors.push(String(e?.message || e)); }
  }
  return { fed, eligible, rfqs: rfqIds.length, errors: errors.length ? errors : undefined };
};
