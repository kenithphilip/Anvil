// Unit tests for src/api/_lib/docai/office.js (Wave 2.2).

import { describe, it, expect } from "vitest";
import {
  isDocx, isLegacyDoc, isRtf,
  docxXmlToText, stripRtf,
  extractRtfText, extractOfficeText,
} from "../api/_lib/docai/office.js";

describe("isDocx", () => {
  it("matches by extension", () => {
    expect(isDocx({ filename: "po.docx" })).toBe(true);
    expect(isDocx({ filename: "po.DOTX" })).toBe(true);
    expect(isDocx({ filename: "po.pdf" })).toBe(false);
  });
  it("matches by zip magic when mime claims docx", () => {
    const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(isDocx({
      filename: "noext",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: zipMagic,
    })).toBe(true);
  });
});

describe("isLegacyDoc", () => {
  it("matches .doc extension", () => {
    expect(isLegacyDoc({ filename: "old.doc" })).toBe(true);
  });
  it("matches compound file binary signature", () => {
    const compound = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(isLegacyDoc({ filename: "noext", bytes: compound })).toBe(true);
  });
});

describe("isRtf", () => {
  it("matches .rtf extension", () => {
    expect(isRtf({ filename: "po.rtf" })).toBe(true);
  });
  it("matches rtf magic", () => {
    const magic = Buffer.from("{\\rtf1", "utf8");
    expect(isRtf({ filename: "noext", bytes: magic })).toBe(true);
  });
  it("matches rtf mime", () => {
    expect(isRtf({ filename: "noext", mime: "application/rtf" })).toBe(true);
    expect(isRtf({ filename: "noext", mime: "text/rtf" })).toBe(true);
  });
});

describe("docxXmlToText", () => {
  it("strips tags and decodes entities", () => {
    const xml = '<w:p><w:r><w:t>Hello &amp; world</w:t></w:r></w:p><w:p><w:r><w:t>Line 2</w:t></w:r></w:p>';
    const out = docxXmlToText(xml);
    expect(out).toContain("Hello & world");
    expect(out).toContain("Line 2");
  });
  it("emits paragraph breaks", () => {
    const xml = '<w:p><w:r><w:t>A</w:t></w:r></w:p><w:p><w:r><w:t>B</w:t></w:r></w:p>';
    const lines = docxXmlToText(xml).split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines).toEqual(["A", "B"]);
  });
});

describe("stripRtf", () => {
  it("strips control words and decodes \\par to newline", () => {
    const rtf = "{\\rtf1\\ansi {\\fonttbl{\\f0 Arial;}}\\par Hello World\\par Second Line}";
    const out = stripRtf(rtf);
    expect(out).toContain("Hello World");
    expect(out).toContain("Second Line");
    expect(out).not.toContain("\\par");
  });
  it("decodes \\u escapes", () => {
    const rtf = "{\\rtf1\\u8364?\\u8482?}"; // euro + trademark
    const out = stripRtf(rtf);
    expect(out).toContain("€");
    expect(out).toContain("™");
  });
  it("returns '' on empty input", () => {
    expect(stripRtf("")).toBe("");
  });
});

describe("extractRtfText", () => {
  it("returns ok=true with body_text on valid RTF", async () => {
    const rtf = "{\\rtf1\\ansi Hello\\par World}";
    const out = await extractRtfText(Buffer.from(rtf, "utf8"));
    expect(out.ok).toBe(true);
    expect(out.body_text).toContain("Hello");
    expect(out.body_text).toContain("World");
  });
  it("returns ok=false on no bytes", async () => {
    const out = await extractRtfText(null);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("no_bytes");
  });
  it("returns empty_text on rtf that has no payload", async () => {
    const out = await extractRtfText(Buffer.from("{\\rtf1\\ansi}", "utf8"));
    expect(out.ok).toBe(false);
    expect(out.error).toBe("empty_text");
  });
});

describe("extractOfficeText (router)", () => {
  it("routes RTF to the stripper", async () => {
    const rtf = "{\\rtf1\\ansi Hello\\par World}";
    const out = await extractOfficeText({
      bytes: Buffer.from(rtf, "utf8"),
      filename: "po.rtf",
      mime: "application/rtf",
    });
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("rtf");
    expect(out.body_text).toContain("Hello");
  });
  it("flags legacy .doc as unsupported", async () => {
    const compound = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00]);
    const out = await extractOfficeText({ bytes: compound, filename: "old.doc" });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("unsupported_legacy_doc");
    expect(out.kind).toBe("legacy_doc");
  });
  it("returns not_office for non-office bytes", async () => {
    const out = await extractOfficeText({
      bytes: Buffer.from("%PDF-1.4 fake"),
      filename: "po.pdf",
      mime: "application/pdf",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("not_office");
    expect(out.kind).toBeNull();
  });
});
