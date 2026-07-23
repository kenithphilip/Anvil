// Helper for the inbound-email attachment persistence worker.
//
// Audit P5.4 (May 2026). The inbound-email webhook (Postmark
// path) used to capture attachment metadata (filename, content
// type, size) but discarded the bytes. Postmark sends the
// `Content` field as base64 inline; we now stash that into
// `attachments[i].content_b64` and let this worker drain it
// asynchronously.
//
// For each attachment with content_b64 set, the helper:
//
//   1. Decodes the base64 bytes.
//   2. Computes a sha256 digest.
//   3. Uploads to Supabase Storage at:
//        inbound/{tenant_id}/{email_id}/{filename}
//      ...inside the tenant's documents bucket.
//   4. Inserts a `documents` row with:
//        metadata.source            = 'email_inbound'
//        metadata.inbound_email_id  = email.id
//        scan_status                = 'pending'
//   5. Runs ClamAV via scanWithClamAV() and flips scan_status to
//      'clean' / 'quarantined'.
//   6. Returns a patched attachment object: { document_id,
//      storage_path, sha256, content_b64: undefined }.
//
// A successful run leaves the attachments[].content_b64 field
// undefined so the bytes don't sit in the database after they're
// safely in storage. Failed scans leave the document row in
// quarantined state; the auto_ocr worker filters those out.
//
// Microsoft Graph + raw SMTP paths are not handled here. Graph's
// webhook does not send bytes inline; persisting Graph attachments
// requires a follow-up GET to the Graph attachments endpoint and
// is deferred until the Graph adapter writes a real
// download-attachments helper.

import { sha256 as sha256Hex, scanWithClamAV } from "../../../documents/_lib/scan-runner.js";

// Sanitize the filename for use as a storage path component.
// Storage rejects path traversal; we allow lowercase letters,
// digits, dot, dash, underscore.
const safeName = (name) => {
  const s = String(name || "attachment").toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 200);
  return s || "attachment";
};

// Build the storage path. Slash-delimited; the bucket layout for
// inbound documents is `inbound/<tenant>/<email>/<filename>`.
const storagePathFor = (tenantId, emailId, filename) =>
  "inbound/" + tenantId + "/" + emailId + "/" + safeName(filename);

// Persist one attachment that carries inline content_b64. Returns
// the patched attachment shape on success, or { error } on failure.
// Idempotent: if the document already exists for this email +
// filename, skip reupload and just return the existing row.
export const persistOneAttachment = async (svc, { tenantId, emailId, attachment }) => {
  if (!attachment || !attachment.content_b64) {
    return { error: "no content_b64" };
  }
  const filename = attachment.filename || "attachment.bin";
  const mime = attachment.content_type || "application/octet-stream";
  const path = storagePathFor(tenantId, emailId, filename);
  const buf = Buffer.from(attachment.content_b64, "base64");
  const sha = sha256Hex(buf);

  // Idempotency: if a document with the same sha256 already
  // exists for this tenant + inbound_email, skip the storage
  // upload and reuse the existing row.
  const existing = await svc.from("documents")
    .select("id, storage_bucket, storage_path, scan_status")
    .eq("tenant_id", tenantId)
    .eq("sha256", sha)
    .contains("metadata", { source: "email_inbound", inbound_email_id: emailId })
    .limit(1)
    .maybeSingle();
  if (existing.data) {
    return {
      document_id: existing.data.id,
      storage_path: existing.data.storage_path,
      sha256: sha,
      reused: true,
    };
  }

  // Upload the bytes. We default to the same `obara-documents`
  // bucket the rest of the platform uses.
  const bucket = "obara-documents";
  const up = await svc.storage.from(bucket).upload(path, buf, {
    contentType: mime,
    upsert: true,
  });
  if (up.error) {
    return { error: "storage upload: " + up.error.message };
  }

  // Insert documents row. scan_status starts at 'pending' until
  // ClamAV reports a verdict; the auto_ocr worker filters on
  // scan_status='clean' so this gates extraction safely.
  const ins = await svc.from("documents").insert({
    tenant_id: tenantId,
    storage_bucket: bucket,
    storage_path: path,
    filename,
    mime_type: mime,
    size_bytes: buf.length,
    sha256: sha,
    classification: "purchase_order",
    metadata: {
      source: "email_inbound",
      inbound_email_id: emailId,
    },
    scan_status: "pending",
  }).select("id").single();
  if (ins.error) {
    return { error: "documents insert: " + ins.error.message };
  }
  const documentId = ins.data.id;

  // Run scan. A null/missing CLAMAV_URL leaves scanWithClamAV()
  // returning { invoked: false } which our scan_status policy
  // treats as "still pending"; the operator can retry via
  // /api/documents/scan if AV comes back online.
  //
  // Bug fix May 2026: an AV outage used to silently leave
  // scan_status='pending', and the auto_ocr worker filters on
  // scan_status='clean', so all inbound documents stopped
  // extracting indefinitely. Now we write a processing_event
  // for any non-clean outcome so ops sees the AV gap and can
  // act before document throughput tanks.
  let scanStatus = "pending";
  let scanReason = null;
  try {
    const v = await scanWithClamAV(buf, filename, {});
    if (v.invoked) {
      scanStatus = v.infected ? "quarantined" : "clean";
      if (v.infected) scanReason = "infected:" + (v.virus || "unknown");
    } else {
      scanReason = "av_not_invoked:" + (v.reason || "unknown");
    }
  } catch (e) {
    scanStatus = "pending";
    scanReason = "av_threw:" + (e.message || String(e));
  }
  await svc.from("documents").update({ scan_status: scanStatus }).eq("id", documentId);
  if (scanStatus !== "clean") {
    await svc.from("processing_events").insert({
      tenant_id: tenantId,
      case_id: emailId,
      event_type: "inbound_av_scan_unresolved",
      object_type: "document",
      object_id: documentId,
      detail: {
        filename, scan_status: scanStatus, reason: scanReason,
        severity: scanStatus === "quarantined" ? "warn" : "info",
      },
    });
  }

  return {
    document_id: documentId,
    storage_path: path,
    sha256: sha,
    scan_status: scanStatus,
  };
};

// Drain one inbound_emails row: persist every attachment that
// carries content_b64. Returns the new attachments JSONB to
// store back.
export const persistEmailAttachments = async (svc, email) => {
  const attachments = Array.isArray(email.attachments) ? email.attachments : [];
  const out = [];
  let persisted = 0;
  let failed = 0;
  for (const att of attachments) {
    if (!att || !att.content_b64) {
      // Attachment already persisted (or never had bytes). Pass
      // through unchanged.
      out.push(att);
      continue;
    }
    const result = await persistOneAttachment(svc, {
      tenantId: email.tenant_id,
      emailId: email.id,
      attachment: att,
    });
    if (result.error) {
      // Keep the metadata + bytes so a subsequent tick retries.
      out.push({ ...att, last_error: String(result.error).slice(0, 240) });
      failed += 1;
      continue;
    }
    persisted += 1;
    // Strip content_b64 once the bytes are safely in storage.
    const { content_b64, ...rest } = att;
    void content_b64;
    out.push({
      ...rest,
      document_id: result.document_id,
      storage_path: result.storage_path,
      sha256: result.sha256,
      scan_status: result.scan_status,
    });
  }
  return { attachments: out, persisted, failed };
};
