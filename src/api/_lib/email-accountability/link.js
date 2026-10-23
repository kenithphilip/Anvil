// Link an inbound message to a customer, a contact and a sales order, only
// when the match is reliable. docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.3.
//
// Reliable (a fact): the exact contact address, the exact customer address,
// or a business domain that only one customer uses. A free-mail domain or a
// domain that several customers share gives a reason and no link. The shared
// matchInboundToCustomer is not used: its domain step links gmail.com.

import { findContactByEmail } from "../email-canonical.js";

export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "ymail.com", "rediffmail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "aol.com",
  "protonmail.com", "proton.me", "zoho.com", "zohomail.in", "gmx.com", "mail.com",
]);

// An ilike pattern that matches the text literally.
export const likeLiteral = (s) => String(s).replace(/[\\%_]/g, (c) => "\\" + c);

const fact = (code, text) => ({ kind: "fact", code, text });
const inferred = (code, text) => ({ kind: "inferred", code, text });

export const linkSender = async (svc, tenantId, address) => {
  const addr = String(address || "").trim().toLowerCase();
  if (!addr.includes("@")) return { reliable: false, reasons: [] };

  const contact = await findContactByEmail(svc, tenantId, addr);
  if (contact?.customer_id) {
    return {
      reliable: true, customer_id: contact.customer_id, contact_id: contact.id,
      reasons: [fact("known_contact", "The sender is a contact of the customer.")],
    };
  }
  const exact = await svc.from("customers").select("id")
    .eq("tenant_id", tenantId).ilike("contact_email", likeLiteral(addr)).limit(2);
  if (exact.error) throw new Error("customer lookup: " + exact.error.message);
  if ((exact.data || []).length === 1) {
    return {
      reliable: true, customer_id: exact.data[0].id, contact_id: null,
      reasons: [fact("customer_address", "The sender address is the customer's address.")],
    };
  }

  const domain = addr.split("@")[1];
  if (FREE_MAIL_DOMAINS.has(domain)) {
    return { reliable: false, reasons: [inferred("free_mail", "The sender uses a free mail domain, so the domain names no customer.")] };
  }
  const pattern = "%@" + likeLiteral(domain);
  const [contacts, customers] = await Promise.all([
    svc.from("customer_contacts").select("customer_id").eq("tenant_id", tenantId).ilike("email", pattern).limit(50),
    svc.from("customers").select("id").eq("tenant_id", tenantId).ilike("contact_email", pattern).limit(50),
  ]);
  if (contacts.error || customers.error) throw new Error("domain lookup: " + (contacts.error || customers.error).message);
  const ids = new Set([...(contacts.data || []).map((r) => r.customer_id), ...(customers.data || []).map((r) => r.id)]);
  if (ids.size === 1) {
    return {
      reliable: true, customer_id: [...ids][0], contact_id: null,
      reasons: [fact("customer_domain", "The sender domain belongs to one customer only.")],
    };
  }
  if (ids.size > 1) {
    return { reliable: false, reasons: [inferred("shared_domain", "The sender domain belongs to more than one customer, so no customer is linked.")] };
  }
  return { reliable: false, reasons: [] };
};

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The customer's sales order whose PO number the text names as a whole token.
// One match links it; two or more link nothing.
export const linkOrder = async (svc, tenantId, customerId, text) => {
  if (!customerId) return null;
  const r = await svc.from("orders").select("id, po_number, opportunity_id")
    .eq("tenant_id", tenantId).eq("customer_id", customerId).neq("status", "CANCELLED")
    .order("created_at", { ascending: false }).limit(200);
  if (r.error) throw new Error("order lookup: " + r.error.message);
  const hay = String(text || "").toLowerCase();
  const hits = (r.data || []).filter((o) => {
    const po = String(o.po_number || "").trim().toLowerCase();
    return po.length >= 4 && new RegExp("(^|[^a-z0-9])" + escRe(po) + "([^a-z0-9]|$)").test(hay);
  });
  if (hits.length === 1) {
    return {
      order_id: hits[0].id, opportunity_id: hits[0].opportunity_id || null,
      reasons: [fact("po_reference", "The text names PO " + hits[0].po_number + ", which matches one sales order.")],
    };
  }
  if (hits.length > 1) {
    return { order_id: null, opportunity_id: null, reasons: [inferred("po_ambiguous", "The text names a PO number that matches more than one sales order.")] };
  }
  return null;
};
