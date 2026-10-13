// The normalizer for the PO delivery date and contact fields (plan PR 17),
// and the two places the fields must survive after an adapter returns them:
// the cross-adapter vote and the tenant-identity scrub.
//
// Dates are read day-first, as Indian POs print them, and stored as ISO. A
// phone is kept as printed, with a digits-only form beside it. Every value is
// invented.

import { describe, it, expect } from "vitest";
import {
  isoDayFirst, deliveryDateOf, phoneOf, phoneDigits, contactNameOf, normalizeDeliveryContact,
} from "../api/_lib/docai/po-delivery-contact.js";
import { voteAcrossAdapters } from "../api/_lib/docai/voter.js";
import { buildTenantIdentity, scrubCustomerOfTenantIdentity } from "../api/_lib/docai/tenant-scrub.js";

describe("isoDayFirst: a printed date to ISO, day first", () => {
  it.each([
    ["15/11/2026", "2026-11-15"],
    ["05/11/2026", "2026-11-05"],
    ["5-11-2026", "2026-11-05"],
    ["05.11.2026", "2026-11-05"],
    ["05/11/26", "2026-11-05"],
    ["2026-11-05", "2026-11-05"],
    ["2026-11-05T00:00:00Z", "2026-11-05"],
    ["2026/11/05", "2026-11-05"],
  ])("numeric %s -> %s", (raw, iso) => {
    expect(isoDayFirst(raw)).toBe(iso);
  });

  it("reads 03/04/2026 as 3 April, not 4 March", () => {
    expect(isoDayFirst("03/04/2026")).toBe("2026-04-03");
  });

  it("still decodes a date that cannot be day-first", () => {
    expect(isoDayFirst("10/25/2026")).toBe("2026-10-25");
  });

  it.each([
    ["5 Nov 2026", "2026-11-05"],
    ["05-Nov-2026", "2026-11-05"],
    ["05-NOV-26", "2026-11-05"],
    ["5th November, 2026", "2026-11-05"],
    ["Nov 5, 2026", "2026-11-05"],
    ["Sept 30 2026", "2026-09-30"],
    ["1 Jan 2027", "2027-01-01"],
  ])("month name %s -> %s, on any server time zone", (raw, iso) => {
    // Read by arithmetic: new Date("5 Nov 2026") is local midnight, which
    // toISOString turns into 4 November on a server east of UTC.
    expect(isoDayFirst(raw)).toBe(iso);
  });

  it.each(["31/02/2026", "2026-02-30", "32 Jan 2026", "15 Foo 2026", "4 weeks", "ASAP", "", "   ", null, undefined, {}, true])(
    "%j is not a date", (raw) => {
      expect(isoDayFirst(raw)).toBeNull();
    },
  );
});

describe("deliveryDateOf: ISO when it parses, else as printed, else null", () => {
  it("parses", () => {
    expect(deliveryDateOf(" 15/11/2026 ")).toBe("2026-11-15");
  });

  it("keeps a period or an impossible date as printed, so a person sees it", () => {
    expect(deliveryDateOf("4  weeks from PO")).toBe("4 weeks from PO");
    expect(deliveryDateOf("31/02/2026")).toBe("31/02/2026");
  });

  it.each([null, undefined, "", "  ", "NA", "N/A", "n.a.", "-", "TBD", "nil"])("%j is null", (raw) => {
    expect(deliveryDateOf(raw)).toBeNull();
  });
});

describe("phones: kept as printed, plus the digits of the first number", () => {
  it.each([
    ["+91 20 2712 3456", "+91 20 2712 3456", "912027123456"],
    ["  020-2712\n3456 ", "020-2712 3456", "02027123456"],
    ["(020) 2712 3456", "(020) 2712 3456", "02027123456"],
    ["98200 12345 / 98200 54321", "98200 12345 / 98200 54321", "9820012345"],
    ["020-27123456/57", "020-27123456/57", "02027123456"],
    ["98200 12345, 020 2712 3456", "98200 12345, 020 2712 3456", "9820012345"],
    ["020 2712 3456 Extn. 204", "020 2712 3456 Extn. 204", "02027123456"],
  ])("%j", (raw, printed, digits) => {
    expect(phoneOf(raw)).toBe(printed);
    expect(phoneDigits(raw)).toBe(digits);
  });

  it("a number too short to dial keeps its printed form and has no digits form", () => {
    expect(phoneOf("Ext 204")).toBe("Ext 204");
    expect(phoneDigits("1234")).toBeNull();
  });

  it("two numbers run together with no separator are not one number", () => {
    expect(phoneDigits("020 2712 3456 98200 12345 98200 54321")).toBeNull();
  });

  it.each([null, undefined, "", "N/A", "nil", "-", "no phone"])("%j is null in both forms", (raw) => {
    expect(phoneOf(raw)).toBeNull();
    expect(phoneDigits(raw)).toBeNull();
  });
});

describe("contact names", () => {
  it("tidies whitespace and edge punctuation, and keeps the title as printed", () => {
    expect(contactNameOf("  Ms.   P.  Iyer , ")).toBe("Ms. P. Iyer");
    expect(contactNameOf("Rao")).toBe("Rao");
  });

  it.each([null, "", "  ", "NA", "-", "12345", {}])("%j is null", (raw) => {
    expect(contactNameOf(raw)).toBeNull();
  });
});

describe("normalizeDeliveryContact", () => {
  const PO = {
    classification: "po",
    customer: { name: "Fixture Buyer", phone: " 020 2712 3456 ", contact_name: " A.  Rao ", delivery_date: "15/11/2026" },
    lines: [
      { partNumber: "QX-1", delivery_date: "1 Dec 2026" },
      { partNumber: "QX-2" },
    ],
    stated_line_count: 2,
  };

  it("normalizes every field it finds, and leaves the rest of the result alone", () => {
    const out = normalizeDeliveryContact(PO);
    expect(out.customer).toEqual({
      name: "Fixture Buyer",
      phone: "020 2712 3456",
      phone_digits: "02027123456",
      contact_name: "A. Rao",
      delivery_date: "2026-11-15",
    });
    expect(out.lines[0]).toEqual({ partNumber: "QX-1", delivery_date: "2026-12-01" });
    expect(out.classification).toBe("po");
    expect(out.stated_line_count).toBe(2);
  });

  it("with the slots asked for, each is present, null when missing", () => {
    const out = normalizeDeliveryContact({ customer: { name: "Fixture Buyer" }, lines: [{ partNumber: "QX-2" }] }, { slots: true });
    expect(out.customer).toEqual({ name: "Fixture Buyer", contact_name: null, delivery_date: null });
    expect(out.lines[0]).toEqual({ partNumber: "QX-2", delivery_date: null });
  });

  it("without them, a missing field stays absent: not asked is not the same as none printed", () => {
    const out = normalizeDeliveryContact({ customer: { name: "Fixture Buyer" }, lines: [{ partNumber: "QX-2" }] });
    expect(out.customer).toEqual({ name: "Fixture Buyer" });
    expect(out.lines[0]).toEqual({ partNumber: "QX-2" });
  });

  it("a null phone is null in both forms; no phone key adds no digits key", () => {
    expect(normalizeDeliveryContact({ customer: { phone: null }, lines: [] }).customer).toEqual({ phone: null, phone_digits: null });
    expect(normalizeDeliveryContact({ customer: { name: "B" }, lines: [] }).customer).not.toHaveProperty("phone_digits");
  });

  it("does not change its input", () => {
    const before = JSON.stringify(PO);
    normalizeDeliveryContact(PO, { slots: true });
    expect(JSON.stringify(PO)).toBe(before);
  });

  it("passes odd input through without throwing", () => {
    expect(normalizeDeliveryContact(null)).toBeNull();
    expect(normalizeDeliveryContact({ customer: null, lines: [null, "x"] }, { slots: true }))
      .toEqual({ customer: null, lines: [null, "x"] });
  });
});

describe("a voted run keeps the fields", () => {
  const result = (adapter, rank, customer, lines) => ({
    ok: true, adapter_used: adapter, confidence_overall: 0.9, _rank: rank,
    normalized: { classification: "po", customer, lines },
  });

  it("the header contact and date, and each line's date, survive the vote", () => {
    const customer = { name: "Fixture Buyer", contact_name: "A. Rao", delivery_date: "2026-11-15", phone: "020 2712 3456" };
    const lines = [{ partNumber: "QX-1", quantity: 1, unitPrice: 10, delivery_date: "2026-12-01" }];
    const voted = voteAcrossAdapters([result("gemini", 0, customer, lines), result("claude", 1, customer, lines)]);
    expect(voted.normalized.customer).toMatchObject({ contact_name: "A. Rao", delivery_date: "2026-11-15" });
    expect(voted.normalized.lines[0].delivery_date).toBe("2026-12-01");
  });

  it("the digits come from the voted phone, never from a different adapter's", () => {
    // Two adapters agree on one phone; a third reads another and carries its
    // own digits. The voted pair must stay consistent.
    const a = { name: "Fixture Buyer", phone: "020 2712 3456", phone_digits: "02027123456" };
    const b = { name: "Fixture Buyer", phone: "98200 12345", phone_digits: "9820012345" };
    const voted = voteAcrossAdapters([
      result("gemini", 0, b, []), result("claude", 1, a, []), result("llamaparse", 2, a, []),
    ]);
    expect(voted.normalized.customer.phone).toBe("020 2712 3456");
    expect(voted.normalized.customer.phone_digits).toBe("02027123456");
  });
});

describe("the tenant scrub never leaves our own number behind in phone_digits", () => {
  const identity = buildTenantIdentity(null, {
    einvoice_seller_legal_name: "Fixture Supplier Tools Pvt Ltd",
    einvoice_seller_phone: "+91 22 4000 1111",
  });

  it("our phone is nulled in both forms", () => {
    const customer = normalizeDeliveryContact({ customer: { name: "Fixture Buyer", phone: "022-4000 1111" }, lines: [] }).customer;
    const { customer: out, scrubbed } = scrubCustomerOfTenantIdentity(customer, identity);
    expect(out.phone).toBeNull();
    expect(out.phone_digits).toBeNull();
    expect(scrubbed).toEqual(expect.arrayContaining(["phone", "phone_digits"]));
  });

  it("our number printed first beside the buyer's: the digits form is ours, so it goes", () => {
    const customer = normalizeDeliveryContact({ customer: { phone: "022 4000 1111 / 020 2712 3456" }, lines: [] }).customer;
    expect(customer.phone_digits).toBe("02240001111");
    const { customer: out, scrubbed } = scrubCustomerOfTenantIdentity(customer, identity);
    expect(out.phone_digits).toBeNull();
    expect(scrubbed).toContain("phone_digits");
  });

  it("the buyer's own number is kept in both forms", () => {
    const customer = normalizeDeliveryContact({ customer: { phone: "020 2712 3456" }, lines: [] }).customer;
    const { customer: out, scrubbed } = scrubCustomerOfTenantIdentity(customer, identity);
    expect(out).toMatchObject({ phone: "020 2712 3456", phone_digits: "02027123456" });
    expect(scrubbed).toEqual([]);
  });
});
