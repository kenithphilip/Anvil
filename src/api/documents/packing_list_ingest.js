// POST /api/documents/packing_list_ingest
//   { document_id, extracted }
//
// Turn a packing list into per-part shipping weights.
//
// WHY THIS DOCUMENT. item_master.weight_kg has been empty on every item since
// migration 145 created it — 1,000 sampled from live data, zero with a weight
// — so the freight allocator apportions an awarded bid by line VALUE instead
// of by weight, and consolidatePlans returns recommended_mode 'none' for every
// real plan. A packing list is the only import document that can fix that: a
// bill of lading gives one gross weight for a container, an invoice gives
// money, and only the packing list is per line with the part number beside the
// weight. An importer has years of them already on disk.
//
// IT WRITES ONE THING. Weights onto parts that have none. It does not create
// shipments, does not touch orders, does not price anything. A packing list
// describes what physically shipped; wiring it to the shipment ladder is a
// separate question with its own matching problem (which shipment? by invoice
// number? by container?) and guessing that here would be worse than not doing
// it.
//
// The refusals all live in _lib/item-weight-capture.js and are shared with the
// quotation path from PR #482: unambiguous per_unit/line_total basis, a
// recognised unit, a plausible magnitude, and fill-a-blank-only enforced in
// the UPDATE rather than by a read beforehand.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { weightCandidates } from "../_lib/item-weight-capture.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = (await readBody(req)) || {};
    const documentId = body.document_id;
    const extracted = body.extracted || null;
    if (!documentId) return json(res, 400, { error: { message: "document_id required" } });

    const svc = serviceClient();
    const docQ = await svc.from("documents").select("id, filename")
      .eq("tenant_id", ctx.tenantId).eq("id", documentId).maybeSingle();
    if (docQ.error) throw new Error("documents read: " + docQ.error.message);
    if (!docQ.data) return json(res, 404, { error: { message: "Document not found" } });

    const lines = Array.isArray(extracted?.lines) ? extracted.lines : [];
    if (!extracted || extracted.classification === "non_packing_list" || !lines.length) {
      return json(res, 200, {
        ok: true, learned: 0, considered: 0, skipped: [],
        reason: extracted?.classification === "non_packing_list"
          ? "That document did not read as a packing list."
          : "No packing lines could be read from that document.",
      });
    }

    // The header unit applies to any row that does not print its own — packing
    // lists routinely state "KGS" once at the top. Defaulting to kg instead
    // would silently mis-scale a document printed in pounds.
    const { candidates, skipped } = weightCandidates(lines, { weight_uom: extracted.weight_uom || null });

    let learned = 0;
    const unknownParts = [];
    if (candidates.length) {
      // Exact, case-folded match only — the same rule quote ingestion uses. A
      // near-miss on a part code is a different SKU, and a weight written to
      // the wrong part is invisible and permanent.
      const wanted = candidates.map((c) => c.part_no);
      const imQ = await svc.from("item_master")
        .select("id, part_no").eq("tenant_id", ctx.tenantId).limit(5000);
      const byPart = new Map();
      for (const r of (!imQ.error && imQ.data) || []) {
        const k = String(r.part_no || "").trim().toUpperCase();
        if (k && wanted.includes(k)) byPart.set(k, r.id);
      }

      for (const c of candidates) {
        const itemId = byPart.get(c.part_no);
        if (!itemId) { unknownParts.push(c.part_no); continue; }
        const patch = {
          weight_kg: c.weight_kg,
          weight_source: "document",
          weight_captured_at: new Date().toISOString(),
          weight_document_id: documentId,
        };
        let upd = await svc.from("item_master").update(patch)
          .eq("tenant_id", ctx.tenantId).eq("id", itemId)
          .is("weight_kg", null);
        // Migration 216 is applied BY HAND; PostgREST rejects the whole update
        // over one unknown column. Losing provenance is acceptable, losing the
        // weight is not.
        if (upd.error && (upd.error.code === "42703" || /weight_(source|captured_at|document_id)/.test(upd.error.message || ""))) {
          upd = await svc.from("item_master").update({ weight_kg: c.weight_kg })
            .eq("tenant_id", ctx.tenantId).eq("id", itemId)
            .is("weight_kg", null);
        }
        if (!upd.error) learned += 1;
      }
    }

    await recordAudit(ctx, {
      action: "packing_list_ingested", objectType: "document", objectId: documentId,
      detail: {
        filename: docQ.data.filename,
        lines: lines.length, considered: candidates.length,
        learned, refused: skipped.length, unmatched_parts: unknownParts.length,
      },
    });

    return json(res, 200, {
      ok: true,
      document: { id: documentId, filename: docQ.data.filename },
      lines_read: lines.length,
      considered: candidates.length,
      learned,
      // Every reason a weight did NOT land, kept apart. "Already had one" is
      // the healthy steady state and must not read like a failure, while a
      // refused basis or an unmatched part is something to act on.
      already_had_weight: candidates.length - learned - unknownParts.length,
      unmatched_parts: unknownParts,
      skipped,
    });
  } catch (err) {
    sendError(res, err);
  }
}
