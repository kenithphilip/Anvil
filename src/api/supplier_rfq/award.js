// POST /api/supplier_rfq/award
// Body: { rfq_id, awards: [{ line_no, invitation_id }] }
//
// Records the awarded vendor per line and sets RFQ status=awarded. When the
// RFQ is linked to a customer quote (supplier_rfqs.source_quote_id), the
// winning vendor's price + currency + quote reference are fed back into that
// quote's price-composition line (matched line_no -> line_index), so the
// quote-creation team doesn't re-type the chosen supplier. Idempotent: the
// feed UPDATEs the existing composition line, or INSERTs a minimal one if the
// composition hasn't been started yet (operator then opens Composition to
// recompute landed cost + margin).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

// Feed one awarded line into the linked quote's composition. Throws on a hard
// DB error; the caller treats each line best-effort.
const feedCompositionLine = async (svc, ctx, quoteId, line) => {
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
  // No composition row yet -> insert a minimal one keyed by line_index.
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

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.rfq_id || !Array.isArray(body?.awards)) {
      return json(res, 400, { error: { message: "rfq_id and awards required" } });
    }
    const svc = serviceClient();

    const rfqQ = await svc.from("supplier_rfqs").select("id, source_quote_id")
      .eq("tenant_id", ctx.tenantId).eq("id", body.rfq_id).maybeSingle();
    if (rfqQ.error) throw new Error(rfqQ.error.message);
    const sourceQuoteId = rfqQ.data?.source_quote_id || null;

    for (const aw of body.awards) {
      // line_no can be 0 (quote line indices are 0-based) - guard on null,
      // not falsiness, or the first line is silently skipped.
      if (aw.line_no == null || !aw.invitation_id) continue;
      await svc.from("supplier_rfq_lines").update({
        awarded_invitation_id: aw.invitation_id,
      }).eq("tenant_id", ctx.tenantId).eq("rfq_id", body.rfq_id).eq("line_no", aw.line_no);
    }
    await svc.from("supplier_rfqs").update({ status: "awarded" })
      .eq("tenant_id", ctx.tenantId).eq("id", body.rfq_id);

    // Feed winners into the linked quote's composition.
    let fed = 0;
    let eligible = 0;
    const feedErrors = [];
    if (sourceQuoteId) {
      const [quotesQ, linesQ, vendorsQ] = await Promise.all([
        svc.from("supplier_quotes").select("invitation_id, line_no, unit_price, currency, supplier_quote_ref, vendor_id")
          .eq("tenant_id", ctx.tenantId).eq("rfq_id", body.rfq_id),
        svc.from("supplier_rfq_lines").select("line_no, part_number, quantity")
          .eq("tenant_id", ctx.tenantId).eq("rfq_id", body.rfq_id),
        svc.from("vendors").select("id, vendor_name").eq("tenant_id", ctx.tenantId),
      ]);
      const vendorName = new Map((vendorsQ.data || []).map((v) => [v.id, v.vendor_name]));
      const lineMeta = new Map((linesQ.data || []).map((l) => [l.line_no, l]));
      for (const aw of body.awards) {
        if (aw.line_no == null || !aw.invitation_id) continue;
        const win = (quotesQ.data || []).find((q) => q.invitation_id === aw.invitation_id && q.line_no === aw.line_no);
        if (!win) continue;
        eligible += 1;
        const meta = lineMeta.get(aw.line_no) || {};
        try {
          await feedCompositionLine(svc, ctx, sourceQuoteId, {
            line_no: aw.line_no,
            unit_price: win.unit_price,
            currency: win.currency,
            supplier_quote_ref: win.supplier_quote_ref,
            vendor_name: vendorName.get(win.vendor_id) || null,
            part_number: meta.part_number,
            quantity: meta.quantity,
          });
          fed += 1;
        } catch (e) { feedErrors.push(String(e?.message || e)); }
      }
    }

    await recordAudit(ctx, {
      action: "supplier_rfq_awarded",
      objectType: "supplier_rfq",
      objectId: body.rfq_id,
      detail: body.awards.length + " lines awarded" + (sourceQuoteId ? `; ${fed}/${eligible} fed to quote composition` : ""),
    });
    return json(res, 200, { ok: true, fed, eligible, source_quote_id: sourceQuoteId, feed_errors: feedErrors.length ? feedErrors : undefined });
  } catch (err) { sendError(res, err); }
}
