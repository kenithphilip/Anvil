// The LlamaParse path reads the same three fields by label (plan PR 17).
//
// po-header-text.js (#563) reads a PO header from the parsed markdown,
// deterministically. It now also reads the order's delivery date, the buyer's
// contact person and the buyer's phone, under the field names the LLM
// adapters use, so the handoff reads one shape whichever adapter served.
//
// A PO is addressed TO its supplier, so the supplier block carries our own
// "Kind Attn", "Contact Person" and "Tel". None of them may ever be read as
// the buyer's. Every value below is invented.

import { describe, it, expect } from "vitest";
import { readPoHeader } from "../api/_lib/docai/po-header-text.js";
import { __test__ as llamaparse } from "../api/_lib/docai/llamaparse.js";

const OWN = { ownNames: ["Fixture Supplier Tools Pvt Ltd"], ownPhones: ["+91 22 4000 1111"] };

// The buyer's letterhead and PO details, then the supplier block (us).
const HEADER = [
  "# FIXTURE BUYER WORKS PVT LTD",
  "Plot 12, Sample Industrial Area, Example City",
  "Tel: +91 20 2712 3456",
  "# PURCHASE ORDER",
  "**PO No :** 4500098765",
  "**PO Date :** 02/10/2026",
  "**Contact Person :** Ms. P. Iyer **Mob :** 98200 12345",
  "**Delivery Date :** 15/11/2026",
  "**TO** M/s Fixture Supplier Tools Pvt Ltd",
  "Kind Attn: Mr. S. Supplier",
  "Contact Person: Mr. S. Supplier",
  "Tel: 022 4000 1111",
];

describe("the delivery date, the contact person and the phone, by label", () => {
  it("reads all three, day-first to ISO, with the phone as printed and its digits", () => {
    const h = readPoHeader(HEADER.join("\n"), OWN);
    expect(h.customer).toMatchObject({
      name: "FIXTURE BUYER WORKS PVT LTD",
      po_number: "4500098765",
      po_date: "2026-10-02",
      delivery_date: "2026-11-15",
      contact_name: "Ms. P. Iyer",
      phone: "98200 12345",
      phone_digits: "9820012345",
    });
    expect(h.fields).toEqual(expect.arrayContaining(["delivery_date", "contact_name", "phone"]));
  });

  it("prefers the number printed with the person over the letterhead's", () => {
    expect(readPoHeader(HEADER.join("\n"), OWN).customer.phone).toBe("98200 12345");
  });

  it("falls back to the buyer's printed number when the person has none", () => {
    const md = HEADER.map((l) => (l.startsWith("**Contact Person") ? "**Contact Person :** Ms. P. Iyer" : l)).join("\n");
    const h = readPoHeader(md, OWN);
    expect(h.customer).toMatchObject({ contact_name: "Ms. P. Iyer", phone: "+91 20 2712 3456", phone_digits: "912027123456" });
  });

  it("reads a contact laid out as table cells, one per line", () => {
    const md = [
      "# FIXTURE BUYER WORKS PVT LTD",
      "<table><tr><td>Contact Person</td><td>A. Rao</td><td>Mob</td><td>98200 54321</td></tr></table>",
      "**TO** M/s Fixture Supplier Tools Pvt Ltd",
    ].join("\n");
    expect(readPoHeader(md, OWN).customer).toMatchObject({ contact_name: "A. Rao", phone: "98200 54321" });
  });

  it("passes over a delivery label with no date, and reads a month name without a time-zone shift", () => {
    const md = [
      "# FIXTURE BUYER WORKS PVT LTD", "PO No: 4500098765",
      "Delivery Date : within 4 weeks of PO", "Required by : 20-Nov-2026",
      "**TO** M/s Fixture Supplier Tools Pvt Ltd",
    ].join("\n");
    expect(readPoHeader(md, OWN).customer.delivery_date).toBe("2026-11-20");
  });

  it("passes over an ERP's blank date placeholder and reads the next delivery label", () => {
    const md = [
      "# FIXTURE BUYER WORKS PVT LTD", "PO No: 4500098765",
      "Delivery Date : 00/00/0000", "Need by : 20/11/2026",
      "**TO** M/s Fixture Supplier Tools Pvt Ltd",
    ].join("\n");
    expect(readPoHeader(md, OWN).customer.delivery_date).toBe("2026-11-20");
  });

  it("returns no delivery date at all when none is printed as a date", () => {
    const md = ["# FIXTURE BUYER WORKS PVT LTD", "PO No: 4500098765", "Delivery: ASAP"].join("\n");
    expect(readPoHeader(md, OWN).customer).not.toHaveProperty("delivery_date");
  });
});

describe("never our own contact", () => {
  it("nothing at or below the supplier block is read as the buyer's person or number", () => {
    // Only the supplier block names a contact and prints a number here.
    const md = [
      "# FIXTURE BUYER WORKS PVT LTD", "# PURCHASE ORDER", "PO No: 4500098765",
      "**TO** M/s Fixture Supplier Tools Pvt Ltd", "Kind Attn: Mr. S. Supplier",
      "Contact Person: Mr. S. Supplier", "Tel: 022 4000 1999",
    ].join("\n");
    const h = readPoHeader(md); // our identity not even configured
    expect(h.customer.po_number).toBe("4500098765");
    expect(h.customer).not.toHaveProperty("contact_name");
    expect(h.customer).not.toHaveProperty("phone");
    expect(h.customer).not.toHaveProperty("phone_digits");
  });

  it("a contact label that names our own company is skipped for the buyer's person", () => {
    const md = [
      "# FIXTURE BUYER WORKS PVT LTD", "Contact Name : Fixture Supplier Tools Pvt Ltd",
      "Contact Person : A. Rao", "**TO** M/s Fixture Supplier Tools Pvt Ltd",
    ].join("\n");
    expect(readPoHeader(md, OWN).customer.contact_name).toBe("A. Rao");
  });

  it("skips our own number above the supplier block and takes the buyer's after it", () => {
    const md = [
      "# FIXTURE BUYER WORKS PVT LTD", "Tel: 022-4000 1111", "Ph: 020 2712 9999",
      "**TO** M/s Fixture Supplier Tools Pvt Ltd",
    ].join("\n");
    expect(readPoHeader(md, OWN).customer).toMatchObject({ phone: "020 2712 9999", phone_digits: "02027129999" });
  });

  it("with no supplier block found, reads a contact only inside a labelled buyer block", () => {
    const loose = ["# PURCHASE ORDER", "PO No: 4500098765", "Contact Person: Mr. S. Somebody", "Tel: 020 2712 0000"].join("\n");
    const h = readPoHeader(loose, OWN);
    expect(h.customer).not.toHaveProperty("contact_name");
    expect(h.customer).not.toHaveProperty("phone");

    const labelled = [
      "# PURCHASE ORDER", "PO No: 4500098765",
      "**Bill To:**", "Fixture Buyer Plant 2 Pvt Ltd", "Contact Person: A. Rao", "Tel: 020 2712 0000",
    ].join("\n");
    expect(readPoHeader(labelled, OWN).customer).toMatchObject({
      name: "Fixture Buyer Plant 2 Pvt Ltd", contact_name: "A. Rao", phone: "020 2712 0000",
    });
  });

  it("the llamaparse adapter passes our phone from tenant settings, so the header never offers it", () => {
    const md = ["# FIXTURE BUYER WORKS PVT LTD", "Tel: 022-4000 1111", "**TO** M/s Fixture Supplier Tools Pvt Ltd"].join("\n");
    const ours = llamaparse.readHeader(md, { einvoice_seller_phone: "+91 22 4000 1111" });
    expect(ours.customer).not.toHaveProperty("phone");
    const alias = llamaparse.readHeader(md, { docai_tenant_aliases: { phones: ["02240001111"] } });
    expect(alias.customer).not.toHaveProperty("phone");
    // Without that setting the same number is (correctly, as far as the
    // header can tell) the buyer's.
    expect(llamaparse.readHeader(md, {}).customer.phone).toBe("022-4000 1111");
  });
});
