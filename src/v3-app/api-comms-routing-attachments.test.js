// Function-based routing + attachment support.
//
// The domain fact both exist to serve: a customer is a COMPANY WITH FUNCTIONS.
// A dispatch register goes TO the stores team with purchase and accounts in
// CC; a payment reminder goes TO accounts. Same customer, different recipients
// per document type — which customer_contacts (a free-text `role` and nothing
// else) could not express, and the SendGrid payload (`to` only) could not send.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRecipients } from "../api/_lib/comms-routing.js";
import { parseAttachmentSpecs, resolveAttachments, __consts__ } from "../api/_lib/comms-attachments.js";

const FN = { stores: "f-stores", purchase: "f-purchase", accounts: "f-accounts" };

const CONTACTS = [
  { id: "c1", email: "stores@buyer.com",   function_id: FN.stores,   is_primary: false },
  { id: "c2", email: "purchase@buyer.com", function_id: FN.purchase, is_primary: true  },
  { id: "c3", email: "accounts@buyer.com", function_id: FN.accounts, is_primary: false },
];

const RULES = [
  { document_type: "dispatch_register", function_id: FN.stores,   disposition: "to" },
  { document_type: "dispatch_register", function_id: FN.purchase, disposition: "cc" },
  { document_type: "dispatch_register", function_id: FN.accounts, disposition: "cc" },
  { document_type: "payment_reminder",  function_id: FN.accounts, disposition: "to" },
];

describe("routing / the case the feature exists for", () => {
  it("dispatch register: TO stores, CC purchase + accounts", () => {
    const r = resolveRecipients("dispatch_register", CONTACTS, RULES);
    expect(r.to).toEqual(["stores@buyer.com"]);
    expect(r.cc).toEqual(["purchase@buyer.com", "accounts@buyer.com"]);
    expect(r.fallback_used).toBeNull();
  });

  it("payment reminder: TO accounts only — same customer, different recipients", () => {
    const r = resolveRecipients("payment_reminder", CONTACTS, RULES);
    expect(r.to).toEqual(["accounts@buyer.com"]);
    expect(r.cc).toEqual([]);
  });

  it("never lists the same address twice across to/cc", () => {
    const contacts = [{ id: "c1", email: "both@buyer.com", function_id: FN.stores, is_primary: true },
                      { id: "c2", email: "both@buyer.com", function_id: FN.purchase }];
    const r = resolveRecipients("dispatch_register", contacts, RULES);
    expect(r.to).toEqual(["both@buyer.com"]);
    expect(r.cc).toEqual([]);           // deduped out of cc, not duplicated
  });
});

describe("routing degrades gracefully — redundancy, not a gate", () => {
  it("no rule for the document type -> everyone with a function, marked", () => {
    const r = resolveRecipients("service_report", CONTACTS, RULES);
    expect(r.to.sort()).toEqual(["accounts@buyer.com", "purchase@buyer.com", "stores@buyer.com"]);
    expect(r.fallback_used).toBe("function");
    expect(r.unresolved).toBe(false);
  });

  it("no functions at all -> the primary contact", () => {
    const plain = [{ id: "c1", email: "a@buyer.com" }, { id: "c2", email: "boss@buyer.com", is_primary: true }];
    const r = resolveRecipients("dispatch_register", plain, []);
    expect(r.to).toEqual(["boss@buyer.com"]);
    expect(r.fallback_used).toBe("primary");
  });

  it("no contacts at all -> the operator, so failure is visible not silent", () => {
    const r = resolveRecipients("quote", [], [], { fallbackEmail: "ops@seller.com" });
    expect(r.to).toEqual(["ops@seller.com"]);
    expect(r.fallback_used).toBe("operator");
  });

  it("nothing resolvable is flagged, not sent into the void", () => {
    const r = resolveRecipients("quote", [], []);
    expect(r.to).toEqual([]);
    expect(r.unresolved).toBe(true);
  });

  it("skips inactive contacts", () => {
    const contacts = [{ id: "c1", email: "gone@buyer.com", function_id: FN.stores, is_active: false }];
    const r = resolveRecipients("dispatch_register", contacts, RULES, { fallbackEmail: "ops@seller.com" });
    expect(r.to).toEqual(["ops@seller.com"]);
  });
});

describe("marketing consent is separate from transactional", () => {
  const contacts = [
    { id: "c1", email: "yes@buyer.com", function_id: FN.stores, marketing_consent: true },
    { id: "c2", email: "no@buyer.com",  function_id: FN.stores, marketing_consent: false },
  ];

  it("marketing reaches only consented contacts", () => {
    const r = resolveRecipients("marketing", contacts, [], { requireConsent: true });
    expect(r.to).toEqual(["yes@buyer.com"]);
  });

  it("a transactional send IGNORES consent — a payment reminder is not marketing", () => {
    // The legal separation cuts both ways: no consent must never suppress this.
    const r = resolveRecipients("payment_reminder", contacts, []);
    expect(r.to.sort()).toEqual(["no@buyer.com", "yes@buyer.com"]);
  });
});

describe("attachments", () => {
  it("accepts a document reference and an inline payload", () => {
    const specs = parseAttachmentSpecs([
      { document_id: "d1" },
      { filename: "x.pdf", content_base64: "AAA=" },
      { nonsense: true },
    ]);
    expect(specs).toHaveLength(2);
    expect(specs[0].kind).toBe("document");
    expect(specs[1].kind).toBe("inline");
  });

  const makeSvc = (doc, bytes = Buffer.from("%PDF-1.4 hello")) => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: doc, error: null }) }) }) }) }),
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => bytes }, error: null }) }) },
  });

  it("resolves a stored document into a base64 payload", async () => {
    const svc = makeSvc({ id: "d1", filename: "quote.pdf", mime_type: "application/pdf", storage_bucket: "b", storage_path: "p", scan_status: "clean" });
    const out = await resolveAttachments(svc, "t1", [{ document_id: "d1" }]);
    expect(out.errors).toEqual([]);
    expect(out.attachments[0].filename).toBe("quote.pdf");
    expect(out.attachments[0].type).toBe("application/pdf");
    expect(Buffer.from(out.attachments[0].content_base64, "base64").toString()).toMatch(/%PDF/);
  });

  it("REFUSES a quarantined document — never mail flagged malware to a customer", async () => {
    const svc = makeSvc({ id: "d1", filename: "bad.pdf", storage_bucket: "b", storage_path: "p", scan_status: "quarantined" });
    const out = await resolveAttachments(svc, "t1", [{ document_id: "d1" }]);
    expect(out.attachments).toEqual([]);
    expect(out.errors[0].reason).toBe("quarantined");
  });

  it("reports a missing document rather than throwing", async () => {
    const svc = makeSvc(null);
    const out = await resolveAttachments(svc, "t1", [{ document_id: "gone" }]);
    expect(out.errors[0].reason).toBe("not_found");
  });

  it("drops the whole set when over the size cap, rather than sending a partial one", async () => {
    const big = Buffer.alloc(__consts__.MAX_TOTAL_BYTES + 1024);
    const svc = makeSvc({ id: "d1", filename: "big.pdf", storage_bucket: "b", storage_path: "p", scan_status: "clean" }, big);
    const out = await resolveAttachments(svc, "t1", [{ document_id: "d1" }]);
    expect(out.attachments).toEqual([]);
    expect(out.errors.some((e) => e.reason === "too_large")).toBe(true);
  });

  it("no attachments is not an error", async () => {
    const out = await resolveAttachments(makeSvc(null), "t1", []);
    expect(out).toEqual({ attachments: [], errors: [], total_bytes: 0 });
  });
});

describe("the SendGrid payload actually carries cc/bcc + attachments", () => {
  it("was `to` only before — routing had nowhere to land", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "api", "_lib", "comms-send.js"), "utf8");
    expect(src).toMatch(/personalization\.cc = addrs\(cc\)/);
    expect(src).toMatch(/personalization\.bcc = addrs\(bcc\)/);
    expect(src).toMatch(/payload\.attachments = attachments\.map/);
    expect(src).toMatch(/disposition: "attachment"/);
  });
});
