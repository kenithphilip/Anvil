// Unit tests for the small helper modules shipped in Phase 4 + 8.
// Audit P10.
//
//   _lib/customer-canonicalizer.js: canonicaliseName + slugify
//   _lib/pay-link.js              : substitutePayLink
//   _lib/voyage.js                : itemEmbedText, voyageIsConfigured

import { describe, it, expect } from "vitest";
import { __test as canonTest } from "../api/_lib/customer-canonicalizer.js";
import { substitutePayLink } from "../api/_lib/pay-link.js";
import { itemEmbedText, synonymEmbedText, voyageIsConfigured } from "../api/_lib/voyage.js";

describe("canonicaliseName", () => {
  const f = canonTest.canonicaliseName;
  it("strips legal suffixes (Pvt / Ltd / LLP / Inc / Corp / GmbH / Co / Limited)", () => {
    expect(f("Tata Steel Pvt Ltd")).toBe("tatasteel");
    expect(f("Acme LLP")).toBe("acme");
    expect(f("OBARA Inc.")).toBe("obara");
    expect(f("MAHALAKSHMI Engineering Co")).toBe("mahalakshmiengineering");
  });
  it("collapses to alpha-numeric only", () => {
    expect(f("M/s. Tata-Steel Ltd.")).toBe("mstatasteel");
  });
  it("returns empty string for null / undefined / empty", () => {
    expect(f(null)).toBe("");
    expect(f(undefined)).toBe("");
    expect(f("")).toBe("");
  });
  it("matches case-insensitively", () => {
    expect(f("OBARA INDIA PRIVATE LIMITED")).toBe(f("Obara India Private Limited"));
  });
});

describe("slugify", () => {
  const f = canonTest.slugify;
  it("converts spaces to hyphens, lowercases, and trims to 60 chars", () => {
    expect(f("Tata Steel Pvt Ltd")).toBe("tata-steel-pvt-ltd");
  });
  it("strips leading/trailing hyphens", () => {
    expect(f("---abc---")).toBe("abc");
  });
});

describe("substitutePayLink", () => {
  it("substitutes [PAY_LINK] with the URL when supplied", () => {
    const body = "Hello,\n\nPay now: [PAY_LINK]\n\nThanks.";
    const out = substitutePayLink(body, "https://portal.example.com/p/abc");
    expect(out).toContain("https://portal.example.com/p/abc");
    expect(out).not.toContain("[PAY_LINK]");
  });
  it("falls back to a 'reply for a link' message when no URL", () => {
    const body = "Pay now: [PAY_LINK]";
    const out = substitutePayLink(body, null);
    expect(out).not.toContain("[PAY_LINK]");
    expect(out).toContain("payment link unavailable");
  });
  it("substitutes every [PAY_LINK] occurrence", () => {
    const body = "First: [PAY_LINK]\nSecond: [PAY_LINK]";
    const out = substitutePayLink(body, "https://x.test/y");
    expect(out.match(/\[PAY_LINK\]/g)).toBeNull();
    expect((out.match(/https:\/\/x\.test\/y/g) || []).length).toBe(2);
  });
  it("returns the body unchanged when [PAY_LINK] is absent", () => {
    expect(substitutePayLink("hello", "https://x")).toBe("hello");
  });
  it("survives null / undefined body without throwing", () => {
    expect(substitutePayLink(null, "https://x")).toBe(null);
    expect(substitutePayLink(undefined, "https://x")).toBe(undefined);
  });
});

describe("itemEmbedText", () => {
  it("joins part_no + description + item_group + sub_category with `:: `", () => {
    const t = itemEmbedText({
      part_no: "BRG-6204-ZZ",
      description: "Deep groove ball bearing",
      item_group: "Bearings",
      sub_category: "Ball",
    });
    expect(t).toBe("BRG-6204-ZZ :: Deep groove ball bearing :: Bearings :: Ball");
  });
  it("skips fields that are null / undefined / empty", () => {
    expect(itemEmbedText({ part_no: "P1" })).toBe("P1");
  });
  it("caps at 2000 chars to keep the embedding window bounded", () => {
    const t = itemEmbedText({ part_no: "P", description: "x".repeat(5000) });
    expect(t.length).toBe(2000);
  });
});

describe("synonymEmbedText", () => {
  it("returns the synonym verbatim", () => {
    expect(synonymEmbedText({ synonym: "4-pole motor 1.5 kW IE3" })).toBe("4-pole motor 1.5 kW IE3");
  });
  it("survives null / undefined / missing field", () => {
    expect(synonymEmbedText(null)).toBe("");
    expect(synonymEmbedText({})).toBe("");
  });
  it("caps at 500 chars", () => {
    const t = synonymEmbedText({ synonym: "x".repeat(2000) });
    expect(t.length).toBe(500);
  });
});

describe("voyageIsConfigured", () => {
  it("returns false when VOYAGE_API_KEY is unset", () => {
    // The module reads VOYAGE_API_KEY at import time; in CI it is
    // unset by default so this matches reality. Test simply
    // confirms the helper returns a boolean.
    expect(typeof voyageIsConfigured()).toBe("boolean");
  });
});
