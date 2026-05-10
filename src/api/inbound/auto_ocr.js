// GET or POST /api/inbound/auto_ocr
//
// Cron-only via Bearer CRON_SECRET (drained every 5 min from
// /api/cron/tick), plus a manual admin trigger. Picks up
// `documents` rows that:
//
//   1. Have scan_status='clean' (already passed ClamAV / ZIP guards).
//   2. Originated from an inbound channel (metadata->>source matches
//      one of: 'whatsapp_inbound', 'email_inbound').
//   3. Are linked to an order via order_documents.
//   4. Have NO existing extraction_runs row for the same source_id.
//
// Runs each through dispatchExtract and writes an extraction_runs
// row with normalized output + confidences. The order's result is
// NOT updated here; the operator opens the SO Workspace to accept
// the extraction. (Auto-merge of high-confidence extractions onto
// orders.result lands in a later phase.)
//
// Audit P2.5. Three inbound channels persist documents but no
// worker auto-OCR'd them: WhatsApp inbound, the legacy email
// inbound, and the newer inbound/email path. Operators had to
// open each order and click Extract manually. Per the audit's
// Part 5.3.10 finding.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { runExtractionPipeline } from "../_lib/docai/run.js";
import { safeFetch } from "../_lib/safe-fetch.js";

const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_SIZE = 10;
const SIGNED_TTL_SECONDS = 60 * 5;
const ELIGIBLE_SOURCES = ["whatsapp_inbound", "email_inbound"];

// Look up the candidate set in one query. We join via
// order_documents so we know which order a document belongs to,
// but we don't try to filter on extraction_runs here (the join
// shape gets unwieldy in Supabase JS); instead we filter
// post-fetch.
const fetchCandidates = async (svc, limit) => {
  const docs = await svc
    .from("documents")
    .select(`
      id, tenant_id, storage_bucket, storage_path, filename, mime_type,
      sha256, classification, metadata, scan_status, created_at,
      order_documents!inner(order_id, role)
    `)
    .eq("scan_status", "clean")
    .order("created_at", { ascending: true })
    .limit(limit * 2);
  if (docs.error) throw new Error("documents read: " + docs.error.message);
  return (docs.data || []).filter((d) => {
    const src = d.metadata && d.metadata.source;
    return ELIGIBLE_SOURCES.includes(src);
  }).slice(0, limit);
};

// Has any prior extraction_run for this document already
// completed (regardless of confidence)? If so, skip; the operator
// will re-trigger manually if they want a re-run.
const alreadyExtracted = async (svc, doc) => {
  const r = await svc.from("extraction_runs")
    .select("id, status")
    .eq("tenant_id", doc.tenant_id)
    .eq("source_id", doc.id)
    .in("status", ["running", "ok", "low_confidence", "failed"])
    .limit(1);
  return !r.error && (r.data || []).length > 0;
};

const inferSourceType = (mime, filename) => {
  if (mime?.startsWith("image/")) return "image";
  const f = (filename || "").toLowerCase();
  if (f.endsWith(".xlsx") || f.endsWith(".xlsm") || f.endsWith(".xls")) return "xlsx";
  if (mime === "application/pdf" || f.endsWith(".pdf")) return "pdf";
  return "pdf";
};

// Download document bytes via a signed URL. The unified pipeline
// needs bytes to run L1 (deterministic text) + L2 (OCR). We pull
// once and keep the signed URL too so adapters that work
// URL-only (Reducto / Azure DI) still have it.
const downloadBytes = async (svc, doc) => {
  const signed = await svc.storage
    .from(doc.storage_bucket)
    .createSignedUrl(doc.storage_path, SIGNED_TTL_SECONDS);
  if (signed.error) return { error: "signed url: " + signed.error.message };
  const url = signed.data?.signedUrl || null;
  if (!url) return { error: "signed url: no URL returned" };
  const resp = await safeFetch(url, { timeoutMs: 30_000 });
  if (!resp.ok) return { url, error: "download: " + resp.status };
  const bytes = Buffer.from(await resp.arrayBuffer());
  return { url, bytes };
};

const runOne = async (svc, doc) => {
  if (await alreadyExtracted(svc, doc)) return { skipped: "already_extracted" };

  const orderId = (doc.order_documents || [])[0]?.order_id || null;
  let customerId = null;
  if (orderId) {
    const ord = await svc.from("orders").select("customer_id").eq("id", orderId).maybeSingle();
    customerId = ord.data?.customer_id || null;
  }

  const settings = await tenantSettings(svc, doc.tenant_id);
  const sourceType = inferSourceType(doc.mime_type, doc.filename);
  const dl = await downloadBytes(svc, doc);
  if (dl.error && !dl.url) return { error: dl.error };
  // If we got a URL but bytes-fetch failed, log it so the L1/L2
  // skip is visible. Adapters that accept URL-only (Reducto / Azure
  // DI) still work; everything else falls back to whatever the
  // dispatcher's default order finds first.
  if (dl.error && dl.url) {
    /* eslint-disable no-console */
    console.warn("[auto_ocr] bytes fetch failed for doc " + doc.id + " (" + dl.error + "); proceeding URL-only, L1/L2 skipped");
  }

  // The cron path uses a synthesised ctx because the unified
  // pipeline records audit + processing events. recordEvent reads
  // ctx.tenantId; we pass triggeredBy=null so the audit row marks
  // the cron actor.
  const cronCtx = { tenantId: doc.tenant_id, userId: null };
  let result;
  try {
    result = await runExtractionPipeline({
      ctx: cronCtx, svc, settings,
      bytes: dl.bytes || null,
      url: dl.url || null,
      filename: doc.filename || null,
      mime: doc.mime_type || null,
      sourceType,
      customerId,
      documentId: doc.id,
      sourceId: doc.id,
      caseId: orderId || doc.id,
      kind: "po",
      triggeredBy: null,
      hints: { auto_ocr: true, order_id: orderId },
    });
  } catch (err) {
    return { error: err.message || String(err) };
  }

  await svc.from("audit_events").insert({
    tenant_id: doc.tenant_id,
    action: result.status === "ok" ? "auto_ocr_ok"
      : result.status === "low_confidence" ? "auto_ocr_low_confidence"
      : "auto_ocr_failed",
    object_type: "extraction_run",
    object_id: result.runId,
    detail: (result.adapterUsed || "none")
      + "::" + (result.confidenceOverall ?? "n/a")
      + "::doc=" + doc.id
      + "::reason=" + result.statusReason,
  });

  return {
    run_id: result.runId,
    document_id: doc.id,
    order_id: orderId,
    adapter_used: result.adapterUsed || null,
    status: result.status,
    status_reason: result.statusReason,
    confidence_overall: result.confidenceOverall,
    text_layer_used: result.textLayerUsed,
    ocr_layer_used: result.ocrLayerUsed,
    template_used: !!result.templateUsed,
    voter_used: result.voterUsed,
    validator_summary: result.validatorSummary,
  };
};

const drainOnce = async (svc) => {
  const docs = await fetchCandidates(svc, BATCH_SIZE);
  const results = [];
  for (const doc of docs) {
    try {
      const r = await runOne(svc, doc);
      results.push({ document_id: doc.id, ...r });
    } catch (err) {
      results.push({ document_id: doc.id, error: err.message || String(err) });
    }
  }
  return {
    considered: docs.length,
    succeeded: results.filter((r) => r.status === "ok" || r.status === "low_confidence").length,
    failed: results.filter((r) => r.error).length,
    skipped: results.filter((r) => r.skipped).length,
    text_layer_hits: results.filter((r) => r.text_layer_used).length,
    ocr_layer_hits: results.filter((r) => r.ocr_layer_used).length,
    template_hits: results.filter((r) => r.template_used).length,
    results,
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (isCron) {
      const out = await drainOnce(svc);
      return json(res, 200, { ran_at: new Date().toISOString(), ...out });
    }
    if (req.method !== "POST" && req.method !== "GET") {
      res.setHeader("Allow", "POST, GET");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const out = await drainOnce(svc);
    await recordAudit(ctx, {
      action: "auto_ocr_drain",
      objectType: "tenant",
      objectId: ctx.tenantId,
      detail: "considered=" + out.considered + " succeeded=" + out.succeeded + " failed=" + out.failed,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...out });
  } catch (err) { sendError(res, err); }
}
