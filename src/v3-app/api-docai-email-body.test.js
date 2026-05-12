// Unit tests for src/api/_lib/docai/email-body.js (Wave 2.3).

import { describe, it, expect } from "vitest";
import {
  htmlToText, stripSignaturesAndQuotes, poLikenessScore,
  prepareEmailBody,
} from "../api/_lib/docai/email-body.js";

describe("htmlToText", () => {
  it("converts common HTML to plain text", () => {
    const html = "<p>Line 1</p><p>Line 2</p>";
    expect(htmlToText(html)).toContain("Line 1");
    expect(htmlToText(html)).toContain("Line 2");
  });
  it("removes scripts and styles", () => {
    const html = "<style>.a{}</style><script>alert(1)</script><p>Hello</p>";
    const out = htmlToText(html);
    expect(out).toContain("Hello");
    expect(out).not.toContain("alert");
  });
  it("decodes entities", () => {
    expect(htmlToText("<p>A &amp; B</p>")).toContain("A & B");
    expect(htmlToText("<p>&nbsp;X&nbsp;</p>")).toContain("X");
  });
});

describe("stripSignaturesAndQuotes", () => {
  it("cuts at the standard -- signature delimiter", () => {
    const body = "Real body line 1\nReal body line 2\n--\nJohn Doe\nCEO";
    const out = stripSignaturesAndQuotes(body);
    expect(out).toContain("Real body line 1");
    expect(out).toContain("Real body line 2");
    expect(out).not.toContain("John Doe");
  });
  it("cuts at the Best regards signature", () => {
    const body = "PO content here.\n\nBest regards,\nJohn";
    const out = stripSignaturesAndQuotes(body);
    expect(out).toContain("PO content here.");
    expect(out).not.toContain("John");
  });
  it("cuts at a run of 3+ quoted reply lines", () => {
    const body = "Real body\n\n> previous line 1\n> previous line 2\n> previous line 3";
    const out = stripSignaturesAndQuotes(body);
    expect(out).toContain("Real body");
    expect(out).not.toContain("previous line");
  });
  it("leaves an isolated quote in the middle alone", () => {
    const body = "Para A\n> single quote\nPara B";
    const out = stripSignaturesAndQuotes(body);
    expect(out).toContain("Para A");
    expect(out).toContain("Para B");
  });
});

describe("poLikenessScore", () => {
  it("returns 0 on short text", () => {
    expect(poLikenessScore("hi")).toBe(0);
    expect(poLikenessScore(null)).toBe(0);
  });
  it("scores a PO-shaped body high", () => {
    const text = `
      Purchase Order PO-12345
      Item     Qty   Rate    HSN     GST
      Widget   10    100.00  8482    18%
      Total: 1180.00
    `;
    expect(poLikenessScore(text)).toBeGreaterThan(0.4);
  });
  it("scores a thank-you reply low", () => {
    const text = "Thanks for the quote. Let me check internally and revert.";
    expect(poLikenessScore(text)).toBeLessThan(0.2);
  });
});

describe("prepareEmailBody", () => {
  it("uses body_text when present", () => {
    const out = prepareEmailBody({
      body_text: "Purchase Order PO-1\nItem qty rate hsn gst\nWidget 10 100 8482 18%\nTotal 1180",
      body_html: null,
    });
    expect(out.ok).toBe(true);
    expect(out.source).toBe("body_text");
    expect(out.body_text).toContain("Purchase Order");
  });

  it("falls back to body_html when body_text is empty", () => {
    const out = prepareEmailBody({
      body_text: null,
      body_html: "<p>Purchase Order PO-1</p><table><tr><td>Widget</td><td>10</td><td>100</td><td>8482</td><td>18%</td></tr></table><p>Total 1180</p>",
    });
    expect(out.ok).toBe(true);
    expect(out.source).toBe("body_html");
    expect(out.body_text).toContain("Purchase Order");
  });

  it("rejects bodies below the PO-likeness threshold", () => {
    const out = prepareEmailBody({
      body_text: "Hello, thanks for reaching out. We'll get back to you next week with our quote.",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("not_po_shaped");
  });

  it("rejects too-short bodies", () => {
    const out = prepareEmailBody({ body_text: "Hi PO 1." });
    expect(out.ok).toBe(false);
    // either too_short (body very short) or not_po_shaped
    expect(["too_short", "not_po_shaped"]).toContain(out.reason);
  });

  it("returns null when there's nothing to work with", () => {
    const out = prepareEmailBody({ body_text: null, body_html: null });
    expect(out.ok).toBe(false);
    expect(out.body_text).toBeNull();
  });
});
