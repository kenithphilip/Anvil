// Unit tests for src/api/_lib/docai/pdf-metadata.js.

import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { readPdfBias, composeOrderWithBias, __test } from "../api/_lib/docai/pdf-metadata.js";

const makePdfWithMetadata = async (meta) => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  // pdf-lib forcibly stamps its own brand on /Producer when it
  // saves, so the test fixtures route the producer signal
  // through /Creator (which is settable and survives). Real
  // PDFs from SAP / Tally / Word usually carry the same string
  // in both fields; the production rule matcher concatenates
  // all six metadata fields so either lands a hit.
  if (meta.producer) doc.setCreator(meta.producer);
  if (meta.creator) doc.setCreator(meta.creator);
  if (meta.title) doc.setTitle(meta.title);
  if (meta.subject) doc.setSubject(meta.subject);
  if (meta.author) doc.setAuthor(meta.author);
  return doc.save();
};

describe("composeOrderWithBias", () => {
  it("prepends bias adapters to the default order", () => {
    const out = composeOrderWithBias(
      ["gemini", "docling", "marker", "claude"],
      ["claude", "marker"],
    );
    expect(out).toEqual(["claude", "marker", "gemini", "docling"]);
  });
  it("drops bias adapters that are not in the default order", () => {
    const out = composeOrderWithBias(
      ["gemini", "claude"],
      ["reducto", "azure_di"], // neither is in default
    );
    expect(out).toEqual(["gemini", "claude"]);
  });
  it("returns the default order when bias is empty or null", () => {
    expect(composeOrderWithBias(["a", "b"], null)).toEqual(["a", "b"]);
    expect(composeOrderWithBias(["a", "b"], [])).toEqual(["a", "b"]);
  });
});

describe("readPdfBias", () => {
  it("detects SAP-emitted PDFs and biases toward reducto", async () => {
    const bytes = await makePdfWithMetadata({ producer: "SAPSprint 12.0" });
    const out = await readPdfBias(bytes);
    // Producer is routed through /Creator in the test fixture
    // because pdf-lib's save() stamps its own /Producer brand.
    expect(out.creator).toBe("SAPSprint 12.0");
    expect(out.bias_label).toBe("sap");
    expect(out.bias_adapters?.[0]).toBe("reducto");
  });

  it("detects Microsoft Word and biases toward docling", async () => {
    const bytes = await makePdfWithMetadata({ producer: "Microsoft Word 2024" });
    const out = await readPdfBias(bytes);
    expect(out.bias_label).toBe("office_word");
    expect(out.bias_adapters?.[0]).toBe("docling");
  });

  it("detects Adobe Acrobat (likely scanned) and biases toward azure_di", async () => {
    const bytes = await makePdfWithMetadata({ producer: "Adobe Acrobat 23.1" });
    const out = await readPdfBias(bytes);
    expect(out.bias_label).toBe("acrobat");
    expect(out.bias_adapters?.[0]).toBe("azure_di");
  });

  it("recognises Meridian metadata via the subject field", async () => {
    const bytes = await makePdfWithMetadata({ subject: "Meridian PO 26-04" });
    const out = await readPdfBias(bytes);
    expect(out.bias_label).toBe("hyundai");
  });

  it("returns null bias for unrecognised metadata", async () => {
    const bytes = await makePdfWithMetadata({ producer: "Some Unknown PDF Tool 1.0" });
    const out = await readPdfBias(bytes);
    expect(out.bias_label).toBeNull();
    expect(out.bias_adapters).toBeNull();
  });

  it("returns nulls without throwing on an invalid PDF", async () => {
    const out = await readPdfBias(new Uint8Array([1, 2, 3]));
    expect(out.bias_label).toBeNull();
  });

  it("accepts a base64 string", async () => {
    const bytes = await makePdfWithMetadata({ producer: "iText 5.5.10" });
    const b64 = Buffer.from(bytes).toString("base64");
    const out = await readPdfBias(b64);
    expect(out.bias_label).toBe("itext");
  });
});
