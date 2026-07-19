// Regression: the Claude adapter must send VALID base64 for PDF bytes,
// including when the bytes arrive as a Uint8Array (chunked extraction
// passes each chunk as a Uint8Array from pdf-lib's PDFDocument.save()).
// The old code did `bytes.toString("base64")`, which for a Uint8Array
// returns comma-joined byte values ("37,80,68,...") -> the Anthropic API
// rejected it with "messages.0.content.0.document.source.base64: Invalid
// base64 data", failing every large/chunked PO extraction.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ captured: null }));
vi.mock("../api/_lib/anthropic.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callAnthropic: vi.fn(async (args) => { H.captured = args; return { ok: false, status: 599, error: "stubbed" }; }),
  };
});

const { extract } = await import("../api/_lib/docai/claude.js");

// A tiny but binary PDF: "%PDF-1.4\n" then bytes that are NOT valid UTF-8
// / ASCII (0x80, 0xFF) so a wrong (utf8 / Array#toString) encoding would
// visibly corrupt the round-trip.
const pdfBytes = () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x80, 0xff, 0x00, 0x41, 0x42, 0xfe]);

beforeEach(() => {
  H.captured = null;
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("claude adapter PDF base64 encoding", () => {
  it("encodes Uint8Array PDF bytes as valid base64 that round-trips", async () => {
    const u8 = pdfBytes();
    await extract({ bytes: u8, mime: "application/pdf", settings: { tenant_id: "t-1" }, hints: {} });

    // The document block is messages[0].content[0] — exactly the path
    // the Anthropic error names.
    const block = H.captured?.messages?.[0]?.content?.[0];
    expect(block?.type).toBe("document");
    expect(block?.source?.type).toBe("base64");
    const data = block.source.data;

    // Valid base64 (standard alphabet, no commas) that decodes back to
    // the exact input bytes.
    expect(/^[A-Za-z0-9+/]+=*$/.test(data)).toBe(true);
    expect([...Buffer.from(data, "base64")]).toEqual([...u8]);

    // Guard against regressing to the old bug: Array/Uint8Array
    // toString("base64") produces comma-joined decimals, which is what
    // broke chunked extraction.
    expect(data).not.toContain(",");
    expect(data).not.toBe(u8.toString("base64"));
  });

  it("also works when bytes arrive as a Node Buffer (small-PDF download path)", async () => {
    const buf = Buffer.from(pdfBytes());
    await extract({ bytes: buf, mime: "application/pdf", settings: { tenant_id: "t-1" }, hints: {} });
    const data = H.captured?.messages?.[0]?.content?.[0]?.source?.data;
    expect([...Buffer.from(data, "base64")]).toEqual([...buf]);
  });
});
