// POST /api/spare_matrix/<id>/to_quote
//
// Turns a spare matrix's Recommended Spares sheet into a DRAFT quote.
// Only rows with recommended_qty > 0 are fed. Prices are left at 0 —
// pricing happens downstream (price_composition), so this is a pure
// "here is what to quote, and how many" hand-off.
//
// CRITICAL: a quote is read from TWO places depending on the consumer —
//   - quotes.line_items (JSONB)  : list/drawer/pdf render
//   - quote_lines rows           : convert.js -> sales order, admin editor
// so we MUST write BOTH or the fed lines look empty / drop on convert.
// We reuse the exact helpers the quotes API uses (computeTotals /
// generateQuoteNumber / buildQuoteLineRow) so the number, totals, and
// line shape are identical to a hand-created quote.
//
// Idempotent-ish: if a DRAFT quote already points at this matrix
// (quotes.source_matrix_id) we return it instead of spawning a duplicate,
// unless the caller passes { force: true }.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { computeTotals, generateQuoteNumber, buildQuoteLineRow } from "../quotes/_lib/quote-build.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const id = req.query.id;
    if (!id) return json(res, 400, { error: { message: "matrix id required" } });
    const body = (await readBody(req)) || {};
    const svc = serviceClient();

    // Matrix header (tenant scope + customer for the quote).
    const head = await svc.from("spare_matrix")
      .select("id, customer_id, project_name, name")
      .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
    if (head.error) throw new Error(head.error.message);
    if (!head.data) return json(res, 404, { error: { message: "Matrix not found" } });
    const matrix = head.data;
    if (!matrix.customer_id) {
      return json(res, 400, { error: { message: "Set a customer on the spare matrix before feeding a quote." } });
    }

    // Recommended rows worth quoting.
    const recQ = await svc.from("recommended_spares")
      .select("*")
      .eq("tenant_id", ctx.tenantId).eq("matrix_id", id)
      .order("sr_no", { ascending: true, nullsFirst: false });
    if (recQ.error) throw new Error(recQ.error.message);
    const feedRows = (recQ.data || []).filter((r) => Number(r.recommended_qty) > 0);
    if (!feedRows.length) {
      return json(res, 400, { error: { message: "No rows to quote. Set a recommended quantity (> 0) on at least one spare first." } });
    }

    // Build line_items JSONB (unpriced) from the recommended rows.
    const lineItems = feedRows.map((r) => ({
      partNumber: r.part_no || null,
      description: r.description
        || [r.item_type, r.part_no].filter(Boolean).join(" ")
        || null,
      quantity: Number(r.recommended_qty) || 0,
      uom: "Nos",
      unitPrice: 0,                       // priced downstream in price_composition
      gstRate: 0,
      customerPartNumber: r.customer_part_no || null,
    }));
    const totals = computeTotals(lineItems);

    // Re-feed is IDEMPOTENT: if a DRAFT quote already exists for this matrix
    // (and no force), UPDATE it to the CURRENT selection instead of leaving a
    // stale draft — so filling more recommended qtys and feeding again adds
    // the new lines rather than returning the old set.
    let existingDraft = null;
    if (!body.force) {
      const existing = await svc.from("quotes")
        .select("*")
        .eq("tenant_id", ctx.tenantId).eq("source_matrix_id", id).eq("status", "DRAFT")
        .order("created_at", { ascending: false }).limit(1);
      // source_matrix_id may not exist on very old deployments; ignore that error.
      if (!existing.error && Array.isArray(existing.data) && existing.data.length) existingDraft = existing.data[0];
    }

    let quote, quoteNumber, reused = false;
    if (existingDraft) {
      reused = true;
      quoteNumber = existingDraft.quote_number;
      const upd = await svc.from("quotes")
        .update({ line_items: lineItems, ...totals, updated_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId).eq("id", existingDraft.id).select("*").single();
      quote = (!upd.error && upd.data) ? upd.data : existingDraft;
    } else {
      // Customer defaults for currency / validity (mirror quotes/index.js).
      let currency = "INR";
      let validityDays = 30;
      const cust = await svc.from("customers")
        .select("currency, default_quote_validity_days")
        .eq("tenant_id", ctx.tenantId).eq("id", matrix.customer_id).maybeSingle();
      if (!cust.error && cust.data) {
        if (cust.data.currency) currency = cust.data.currency;
        if (cust.data.default_quote_validity_days != null) validityDays = Number(cust.data.default_quote_validity_days);
      }
      quoteNumber = await generateQuoteNumber(svc, ctx.tenantId);
      const insertPayload = {
        tenant_id: ctx.tenantId, customer_id: matrix.customer_id, opportunity_id: null,
        source_matrix_id: id, quote_number: quoteNumber, version: 1, status: "DRAFT", currency,
        ...totals, validity_days: validityDays, expires_at: null,
        notes: "Spares for " + (matrix.name || matrix.project_name || "matrix"),
        line_items: lineItems, field_sources: { line_items: "spare_matrix.recommended" },
        created_by: ctx.user?.id || null,
      };
      // Strip unknown columns and retry once (pre-migration deployments).
      let ins = await svc.from("quotes").insert(insertPayload).select("*").single();
      if (ins.error && (ins.error.code === "42703" || /field_sources|source_matrix_id/i.test(ins.error.message))) {
        delete insertPayload.field_sources;
        delete insertPayload.source_matrix_id;
        ins = await svc.from("quotes").insert(insertPayload).select("*").single();
      }
      if (ins.error) throw new Error(ins.error.message);
      quote = ins.data;
    }

    // Replace quote_lines with the CURRENT selection (delete-then-insert) so
    // a re-feed drops de-selected parts and adds newly-filled ones.
    const delLines = await svc.from("quote_lines").delete().eq("tenant_id", ctx.tenantId).eq("quote_id", quote.id);
    if (delLines.error) throw new Error(delLines.error.message);
    const lineRows = feedRows.map((r, i) => buildQuoteLineRow(ctx.tenantId, quote.id, {
      line_index: i,
      part_no: r.part_no || null,
      description: lineItems[i].description,
      uom: "Nos",
      customer_part_number: r.customer_part_no || null,
      qty: Number(r.recommended_qty) || 0,
      listed_unit_price: 0,
    }));
    const linesUp = await svc.from("quote_lines").insert(lineRows).select("*");
    if (linesUp.error) throw new Error(linesUp.error.message);

    // Link the fed recommended rows back to the quote.
    const fedIds = feedRows.map((r) => r.id).filter(Boolean);
    if (fedIds.length) {
      const back = await svc.from("recommended_spares")
        .update({ quote_id: quote.id, quote_ref: quoteNumber, updated_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId).eq("matrix_id", id).in("id", fedIds);
      if (back.error) throw new Error(back.error.message);
    }

    await recordAudit(ctx, {
      action: "spare_matrix_to_quote",
      objectType: "quote",
      objectId: quote.id,
      detail: quoteNumber + " :: " + feedRows.length + " spare line(s) from matrix " + id + (reused ? " (re-synced draft)" : " (new draft)"),
    });

    return json(res, 200, { quote, lines: linesUp.data || [], fed: feedRows.length, reused });
  } catch (err) {
    sendError(res, err);
  }
}
