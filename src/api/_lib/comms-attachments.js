// Resolve `communications.attachments` into provider-ready payloads.
//
// The column has existed since 005 with zero writers and zero readers — the
// storage was there, the plumbing was never built. Five of the six
// customer-facing document types (quote, invoice, PoD, dispatch register,
// service report) ARE attachments, so nothing in the comms design ships
// without this.
//
// STORED SHAPE. `attachments` is a jsonb array. Two forms are accepted:
//
//   { document_id: "<uuid>", filename?: "override.pdf" }   <- preferred
//   { filename: "x.pdf", content_base64: "...", type?: "application/pdf" }
//
// The document_id form is preferred by a distance: it stores a REFERENCE, so
// the row stays small, the file is fetched at send time (always current), and
// access stays governed by the documents table + storage RLS. Inlining base64
// into a jsonb column bloats every subsequent read of that row.
//
// SAFETY. Two limits, both deliberate:
//   * a per-message total size cap — providers reject oversized payloads with
//     an opaque error, and a 30 MB row is a database problem as well as a mail
//     problem;
//   * quarantined documents are REFUSED. documents.scan_status is set by the
//     AV pipeline; attaching a quarantined file would mail malware to a
//     customer under our own domain.
//
// Failures are REPORTED, never thrown: one unreadable attachment must not
// silently drop a payment reminder. The caller decides whether to send
// without it or to fail — see sendCommunication.

// SendGrid's hard limit is 30 MB total; stay well under so base64 inflation
// (~33%) plus the body cannot breach it.
const MAX_TOTAL_BYTES = Number(process.env.COMMS_MAX_ATTACHMENT_BYTES || 15 * 1024 * 1024);

const guessType = (filename) => {
  const f = String(filename || "").toLowerCase();
  if (f.endsWith(".pdf")) return "application/pdf";
  if (f.endsWith(".csv")) return "text/csv";
  if (f.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (f.endsWith(".xls")) return "application/vnd.ms-excel";
  if (f.endsWith(".png")) return "image/png";
  if (f.endsWith(".jpg") || f.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
};

// Public: normalise whatever is on the row into a list of intents. Pure.
export const parseAttachmentSpecs = (attachments) => {
  const list = Array.isArray(attachments) ? attachments : [];
  return list
    .map((a) => {
      if (!a || typeof a !== "object") return null;
      if (a.document_id) return { kind: "document", document_id: String(a.document_id), filename: a.filename || null };
      if (a.content_base64 && a.filename) {
        return { kind: "inline", filename: String(a.filename), content_base64: String(a.content_base64), type: a.type || guessType(a.filename) };
      }
      return null;
    })
    .filter(Boolean);
};

// Public: resolve specs into { attachments, errors, total_bytes }.
// `attachments` are provider-neutral: { filename, type, content_base64 }.
export const resolveAttachments = async (svc, tenantId, attachments) => {
  const specs = parseAttachmentSpecs(attachments);
  const out = { attachments: [], errors: [], total_bytes: 0 };
  if (!specs.length) return out;

  for (const spec of specs) {
    try {
      if (spec.kind === "inline") {
        const bytes = Math.ceil((spec.content_base64.length * 3) / 4);
        out.attachments.push({ filename: spec.filename, type: spec.type, content_base64: spec.content_base64 });
        out.total_bytes += bytes;
        continue;
      }

      const doc = await svc.from("documents")
        .select("id, filename, mime_type, storage_bucket, storage_path, scan_status")
        .eq("tenant_id", tenantId).eq("id", spec.document_id).maybeSingle();
      if (doc.error || !doc.data) {
        out.errors.push({ document_id: spec.document_id, reason: "not_found" });
        continue;
      }
      // Never mail a file the AV pipeline flagged.
      if (doc.data.scan_status === "quarantined" || doc.data.scan_status === "infected") {
        out.errors.push({ document_id: spec.document_id, reason: "quarantined" });
        continue;
      }
      const dl = await svc.storage.from(doc.data.storage_bucket).download(doc.data.storage_path);
      if (dl.error || !dl.data) {
        out.errors.push({ document_id: spec.document_id, reason: "download_failed" });
        continue;
      }
      const buf = Buffer.from(await dl.data.arrayBuffer());
      out.attachments.push({
        filename: spec.filename || doc.data.filename || "attachment",
        type: doc.data.mime_type || guessType(doc.data.filename),
        content_base64: buf.toString("base64"),
      });
      out.total_bytes += buf.length;
    } catch (err) {
      out.errors.push({ document_id: spec.document_id || null, reason: String(err?.message || err).slice(0, 200) });
    }
  }

  // Over the cap, drop them ALL rather than send a partial set: silently
  // omitting one attachment from a dispatch register is worse than an explicit
  // failure the operator can act on.
  if (out.total_bytes > MAX_TOTAL_BYTES) {
    out.errors.push({ reason: "too_large", total_bytes: out.total_bytes, limit: MAX_TOTAL_BYTES });
    out.attachments = [];
  }
  return out;
};

export const __consts__ = { MAX_TOTAL_BYTES, guessType };
