// GET or POST /api/inbound/email/persist_attachments
//
// Cron-only via Bearer CRON_SECRET (drained every 5 min from
// /api/cron/tick), plus a manual admin trigger. Persists inline
// `attachments[i].content_b64` blobs from inbound_emails into
// the documents bucket, runs the ClamAV scan, and patches the
// row's attachments JSONB with the new document_id + storage_path.
//
// Audit P5.4 (May 2026). Before this worker, the inbound-email
// webhook stored attachment metadata only (filename, content_type,
// size_bytes); the bytes were dropped on the floor. The auto_ocr
// worker filters on `scan_status='clean'` and `metadata.source =
// 'email_inbound'`, so without persisted bytes there were no
// clean rows for it to OCR. The headline gap was that an inbound
// PO PDF arrived, the email row got matched + classified +
// drafted into an order, but the actual PDF never made it into
// the platform's storage.
//
// Idempotency: persist_attachments is safe to re-run. The helper
// looks up `(tenant_id, sha256, source=email_inbound)` first and
// reuses an existing document row when one exists, so a tick
// that completes the storage upload but crashes before patching
// the inbound_emails row will not duplicate documents on the
// next tick.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { persistEmailAttachments } from "./_lib/persist-attachments.js";

const CRON_SECRET = process.env.CRON_SECRET;
const BATCH_SIZE = 10;

const hasInlineBytes = (atts) =>
  Array.isArray(atts) && atts.some((a) => a && a.content_b64);

const drainOnce = async (svc) => {
  // Fetch a wider window than BATCH_SIZE so we have material to
  // round-robin across tenants. We can't filter by JSON content
  // in Supabase's PostgREST without a function, so we pull and
  // filter in JS.
  //
  // Bug fix May 2026: previously we sliced the first BATCH_SIZE
  // candidates straight off the head of a global received_at
  // ordering. A single noisy tenant with 40+ inline-bytes emails
  // would starve every other tenant on every tick. Now we group
  // by tenant_id and round-robin: each tenant gets up to
  // ceil(BATCH_SIZE / n_active_tenants) slots, with the
  // remainder going to the tenant with the most pending rows.
  const rows = await svc.from("inbound_emails")
    .select("id, tenant_id, attachments")
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE * 8);
  if (rows.error) throw new Error(rows.error.message);

  const allCandidates = (rows.data || []).filter((r) => hasInlineBytes(r.attachments));
  // Group by tenant_id, preserving received_at order within each
  // group.
  const byTenant = new Map();
  for (const r of allCandidates) {
    if (!byTenant.has(r.tenant_id)) byTenant.set(r.tenant_id, []);
    byTenant.get(r.tenant_id).push(r);
  }
  const tenantQueues = [...byTenant.values()];
  const candidates = [];
  let cursor = 0;
  // Round-robin: pop one row from each tenant queue, cycle. Stop
  // when we hit BATCH_SIZE or every queue empties.
  while (candidates.length < BATCH_SIZE && tenantQueues.some((q) => q.length > 0)) {
    const queue = tenantQueues[cursor % tenantQueues.length];
    if (queue.length > 0) candidates.push(queue.shift());
    cursor += 1;
    // If we've cycled through all queues without taking, break.
    if (cursor > tenantQueues.length * BATCH_SIZE) break;
  }
  let persisted = 0;
  let failed = 0;
  const results = [];
  for (const email of candidates) {
    try {
      const out = await persistEmailAttachments(svc, email);
      const upd = await svc.from("inbound_emails")
        .update({ attachments: out.attachments })
        .eq("id", email.id);
      if (upd.error) {
        failed += 1;
        results.push({ email_id: email.id, error: "row patch: " + upd.error.message });
        continue;
      }
      persisted += out.persisted;
      failed += out.failed;
      results.push({
        email_id: email.id,
        persisted: out.persisted,
        failed: out.failed,
      });
    } catch (err) {
      failed += 1;
      results.push({ email_id: email.id, error: err.message || String(err) });
    }
  }
  return {
    considered: candidates.length,
    persisted,
    failed,
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
      action: "inbound_email_persist_attachments_drain",
      objectType: "tenant",
      objectId: ctx.tenantId,
      detail: "considered=" + out.considered + " persisted=" + out.persisted + " failed=" + out.failed,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...out });
  } catch (err) { sendError(res, err); }
}
