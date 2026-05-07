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
import { dispatchExtract } from "../_lib/docai/index.js";

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

const runOne = async (svc, doc) => {
  if (await alreadyExtracted(svc, doc)) return { skipped: "already_extracted" };
  // Sign a short-lived URL; the dispatcher's adapters (Reducto,
  // Azure DI, Unstructured, Claude fallback) all accept a URL.
  const signed = await svc.storage
    .from(doc.storage_bucket)
    .createSignedUrl(doc.storage_path, SIGNED_TTL_SECONDS);
  if (signed.error) return { error: "signed url: " + signed.error.message };
  const sourceUrl = signed.data?.signedUrl || null;

  // Pull customer_id from the linked order (best-effort) so the
  // dispatcher can fold in per-customer prompt overrides.
  const orderId = (doc.order_documents || [])[0]?.order_id || null;
  let customerId = null;
  if (orderId) {
    const ord = await svc.from("orders").select("customer_id").eq("id", orderId).maybeSingle();
    customerId = ord.data?.customer_id || null;
  }

  const settings = await tenantSettings(svc, doc.tenant_id);

  // Open the run row first so we have a stable id to attach.
  const sourceType = inferSourceType(doc.mime_type, doc.filename);
  const ins = await svc.from("extraction_runs").insert({
    tenant_id: doc.tenant_id,
    customer_id: customerId,
    source_type: sourceType,
    source_id: doc.id,
    source_url: sourceUrl,
    source_filename: doc.filename || null,
    source_size_bytes: null,
    status: "running",
    triggered_by: null,
  }).select("id").single();
  if (ins.error) return { error: "extraction_runs insert: " + ins.error.message };
  const runId = ins.data.id;

  let out;
  try {
    out = await dispatchExtract({
      source: {
        url: sourceUrl,
        bytes: null,
        filename: doc.filename || null,
        mime: doc.mime_type || null,
        sourceType,
      },
      settings: { ...settings, tenant_id: doc.tenant_id },
      customerId,
      hints: { auto_ocr: true, document_id: doc.id, order_id: orderId },
    });
  } catch (err) {
    await svc.from("extraction_runs").update({
      status: "failed",
      error: (err.message || String(err)).slice(0, 500),
      finished_at: new Date().toISOString(),
    }).eq("id", runId);
    return { error: err.message || String(err), run_id: runId };
  }

  const status = !out.ok
    ? "failed"
    : (out.confidence_overall != null && out.confidence_overall < 0.7 ? "low_confidence" : "ok");

  await svc.from("extraction_runs").update({
    adapter_used: out.adapter_used || null,
    adapter_attempts: out.attempts || [],
    raw_extract: out.raw || null,
    normalized_extract: out.normalized || null,
    field_confidences: out.confidences || {},
    confidence_overall: out.confidence_overall ?? null,
    status,
    error: out.error || null,
    finished_at: new Date().toISOString(),
  }).eq("id", runId);

  await svc.from("audit_events").insert({
    tenant_id: doc.tenant_id,
    action: status === "ok" ? "auto_ocr_ok"
      : status === "low_confidence" ? "auto_ocr_low_confidence"
      : "auto_ocr_failed",
    object_type: "extraction_run",
    object_id: runId,
    detail: (out.adapter_used || "none") + "::" + (out.confidence_overall ?? "n/a") + "::doc=" + doc.id,
  });

  return {
    run_id: runId,
    document_id: doc.id,
    order_id: orderId,
    adapter_used: out.adapter_used || null,
    status,
    confidence_overall: out.confidence_overall ?? null,
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
