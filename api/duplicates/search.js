import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const lineFingerprint = (li) => [
  norm(li.tallyItemName || li.itemName),
  norm(li.sellerPartNo || li.partNumber),
  Number(li.qty) || 0,
  Math.round((Number(li.rate) || 0) * 100),
].join("|");

const similarityScore = (a, b) => {
  let score = 0;
  if (a.poNumber && b.po_number && norm(a.poNumber) === norm(b.po_number)) score += 35;
  if (a.customerKey && b.customer_id && a.customerId === b.customer_id) score += 15;
  if (a.totalValue && b.result && b.result.salesOrder && Math.abs((b.result.salesOrder.grandTotal || 0) - a.totalValue) <= Math.max(1, a.totalValue * 0.005)) score += 15;
  if (a.docFingerprint && b.doc_fingerprint && a.docFingerprint === b.doc_fingerprint) score += 25;
  const lineSet = new Set(a.lineFingerprints || []);
  const otherLines = (b.result && b.result.salesOrder && b.result.salesOrder.lineItems || []).map(lineFingerprint);
  const overlap = otherLines.filter((f) => lineSet.has(f)).length;
  if (otherLines.length && lineSet.size) {
    score += Math.min(20, Math.round((overlap / Math.max(otherLines.length, lineSet.size)) * 20));
  }
  return Math.min(100, score);
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    const candidate = body.candidate || {};
    const minScore = Number(body.minScore || 60);
    const svc = serviceClient();
    const { data, error } = await svc.from("orders").select("id, po_number, doc_fingerprint, customer_id, status, result, created_at").eq("tenant_id", ctx.tenantId).neq("status", "BLOCKED").order("created_at", { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    const candLines = (candidate.lineItems || []).map(lineFingerprint);
    const enriched = data.map((row) => {
      const score = similarityScore({
        poNumber: candidate.poNumber,
        customerId: candidate.customerId,
        totalValue: candidate.totalValue,
        docFingerprint: candidate.docFingerprint,
        lineFingerprints: candLines,
      }, row);
      return { ...row, similarity: score };
    }).filter((row) => row.similarity >= minScore).sort((a, b) => b.similarity - a.similarity).slice(0, 10);
    return json(res, 200, { matches: enriched });
  } catch (err) {
    sendError(res, err);
  }
}
