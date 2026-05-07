// Unit tests for the inbound-email attachment persistence helper.
// Audit P5.4 follow-up.
//
// We stub Supabase's chained query builder so the helper can be
// exercised end-to-end without a real database. The two tests
// cover the happy path (decode + upload + insert + scan) and
// idempotency (a re-run picks up the existing row instead of
// double-inserting).

import { describe, it, expect, vi } from "vitest";
import { persistOneAttachment, persistEmailAttachments } from "../api/inbound/email/_lib/persist-attachments.js";

// Build a mock Supabase client. We capture the inserts + uploads
// in arrays so the assertions can read what the helper did.
const buildSvc = (opts) => {
  const o = opts || {};
  const inserts = [];
  const uploads = [];
  const updates = [];
  const existing = o.existing || null;
  const svc = {
    storage: {
      from: () => ({
        upload: (path, buf, headers) => {
          uploads.push({ path, size: buf.length, contentType: headers?.contentType });
          return { error: null };
        },
      }),
    },
    from: (table) => {
      if (table !== "documents") {
        return {
          select: () => ({ eq: () => ({ contains: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }),
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "doc-" + (inserts.length + 1) }, error: null }) }) }),
          update: () => ({ eq: () => ({}) }),
        };
      }
      return {
        select: (_cols) => ({
          eq: () => ({
            eq: () => ({
              contains: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: existing }),
                }),
              }),
            }),
          }),
        }),
        insert: (row) => {
          inserts.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "doc-" + inserts.length }, error: null }) }) };
        },
        update: (patch) => {
          updates.push(patch);
          return { eq: () => ({}) };
        },
      };
    },
  };
  return { svc, inserts, uploads, updates };
};

const b64 = (s) => Buffer.from(s).toString("base64");

describe("persistOneAttachment", () => {
  it("decodes the base64, uploads the bytes, inserts a documents row", async () => {
    const { svc, inserts, uploads, updates } = buildSvc();
    const out = await persistOneAttachment(svc, {
      tenantId: "t-1",
      emailId: "e-1",
      attachment: {
        filename: "PO-12345.pdf",
        content_type: "application/pdf",
        content_b64: b64("hello world"),
      },
    });
    expect(out.error).toBeUndefined();
    expect(out.document_id).toBe("doc-1");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe("inbound/t-1/e-1/po-12345.pdf");
    expect(uploads[0].size).toBe(11); // "hello world".length
    expect(inserts).toHaveLength(1);
    expect(inserts[0].metadata.source).toBe("email_inbound");
    expect(inserts[0].metadata.inbound_email_id).toBe("e-1");
    expect(inserts[0].scan_status).toBe("pending");
    // Scan completion patches scan_status. With no CLAMAV_URL the
    // scan stays pending, but the helper still emits the update.
    expect(updates).toHaveLength(1);
  });

  it("is idempotent: a re-run with the same content reuses the existing document row", async () => {
    const existing = {
      id: "doc-existing",
      storage_bucket: "obara-documents",
      storage_path: "inbound/t-1/e-1/po-12345.pdf",
      scan_status: "clean",
    };
    const { svc, inserts, uploads } = buildSvc({ existing });
    const out = await persistOneAttachment(svc, {
      tenantId: "t-1",
      emailId: "e-1",
      attachment: {
        filename: "PO-12345.pdf",
        content_type: "application/pdf",
        content_b64: b64("hello world"),
      },
    });
    expect(out.document_id).toBe("doc-existing");
    expect(out.reused).toBe(true);
    expect(inserts).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  it("returns an error when content_b64 is missing", async () => {
    const { svc } = buildSvc();
    const out = await persistOneAttachment(svc, {
      tenantId: "t-1",
      emailId: "e-1",
      attachment: { filename: "no-bytes.pdf", content_type: "application/pdf" },
    });
    expect(out.error).toBe("no content_b64");
  });
});

describe("persistEmailAttachments", () => {
  it("strips content_b64 from the patched attachment shape after persisting", async () => {
    const { svc } = buildSvc();
    const email = {
      id: "e-2",
      tenant_id: "t-2",
      attachments: [
        {
          filename: "drawing.png",
          content_type: "image/png",
          content_b64: b64("PNGdata"),
        },
        // Already-persisted attachment passes through untouched.
        {
          filename: "old.pdf",
          content_type: "application/pdf",
          document_id: "doc-old",
          storage_path: "inbound/t-2/e-2/old.pdf",
        },
      ],
    };
    const out = await persistEmailAttachments(svc, email);
    expect(out.persisted).toBe(1);
    expect(out.failed).toBe(0);
    expect(out.attachments).toHaveLength(2);
    // Newly persisted: gets document_id, no content_b64.
    expect(out.attachments[0].content_b64).toBeUndefined();
    expect(out.attachments[0].document_id).toBe("doc-1");
    expect(out.attachments[0].storage_path).toBe("inbound/t-2/e-2/drawing.png");
    // Already-persisted: passes through.
    expect(out.attachments[1].document_id).toBe("doc-old");
  });
});
