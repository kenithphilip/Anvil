// The PO-line identity chain: split the part code, keep the buyer's code
// distinct, carry the canonical identity into the Tally voucher, and make a
// scanned PO approvable at all.
//
// All four defects were found on Mahindra PO 0066026562, whose line reads
// "OBARA STD SHANK TWS-092-90-2" with the buyer's own SAP code
// "A12060OBAR010003" in a separate "Item Number" column.

import { describe, it, expect } from "vitest";
import { splitPartFromDescription, repairLinePartCode, repairPartCodes, looksLikePartCode, brandTokensFromTenantName, __test__ } from "../api/_lib/docai/part-split.js";
import { classifyColumns } from "../api/_lib/docai/table-columns.js";
import { computeOrderPayloadHash, canonicalOrderPayload } from "../api/_lib/payload-hash.js";
import { unmappedVoucherLines, computeLineTax, buildSalesVoucherXml } from "../api/_lib/tally-build-voucher.js";

// ── Item 3: deterministic part/description split ───────────────────────────
describe("part-split (real lines from PO 0066026562)", () => {
  // Brand + noise vocabulary is per-tenant config, exactly as run.js supplies
  // it — nothing entity-specific is baked into the module.
  const opts = { brandTokens: ["OBARA"], stopWords: ["STD"] };

  it.each([
    ["OBARA STD SHANK TWS-092-90-2",      "TWS-092-90-2",   "SHANK"],
    ["OBARA FIXED HOLDER X-TB0029-3",     "X-TB0029-3",     "FIXED HOLDER"],
    ["OBARA STD O-RING P-009",            "P-009",          "O-RING"],
    ["OBARA MOV. ADAPTER TNA-16-04-10-1", "TNA-16-04-10-1", "MOV. ADAPTER"],
    ["OBARA SHUNT ASSY 403S0K2652",       "403S0K2652",     "SHUNT ASSY"],
  ])("%s -> %s / %s", (text, part, desc) => {
    expect(splitPartFromDescription(text, opts)).toEqual({ partNumber: part, description: desc });
  });

  it("keeps ASSY / FIXED / MOV. — this master distinguishes SHUNT from SHUNT ASSY", () => {
    // Stripping them as boilerplate would collapse genuinely different items,
    // which is why the module ships with an EMPTY default vocabulary.
    expect(splitPartFromDescription("OBARA SHUNT ASSY 403S0K2652", opts).description).toBe("SHUNT ASSY");
    expect(splitPartFromDescription("OBARA FIXED HOLDER X-TB0029-3", opts).description).toBe("FIXED HOLDER");
  });

  it("leaves an already-correct line completely untouched (same object)", () => {
    const good = { partNumber: "TWS-092-90-2", description: "SHANK" };
    expect(repairLinePartCode(good, opts)).toBe(good);
  });

  it("repairs a line where the model returned the uncut cell", () => {
    const out = repairLinePartCode({
      partNumber: "OBARA STD SHANK TWS-092-90-2",
      raw_description: "OBARA STD SHANK TWS-092-90-2",
      description: "OBARA STD SHANK",
    }, opts);
    expect(out.partNumber).toBe("TWS-092-90-2");
    expect(out.description).toBe("SHANK");
    expect(out._part_split.before).toBe("OBARA STD SHANK TWS-092-90-2");
  });

  it("recognises a phrase as NOT a part code", () => {
    expect(looksLikePartCode("TWS-092-90-2")).toBe(true);
    expect(looksLikePartCode("OBARA STD SHANK TWS-092-90-2")).toBe(false);
  });

  it("counts repairs across a normalized extraction", () => {
    const { normalized, repaired } = repairPartCodes({
      lines: [
        { partNumber: "TWS-092-90-2", description: "SHANK" },
        { partNumber: "OBARA STD O-RING P-009", raw_description: "OBARA STD O-RING P-009" },
      ],
    }, opts);
    expect(repaired).toBe(1);
    expect(normalized.lines[1].partNumber).toBe("P-009");
  });
});

// ── Multi-entity: the same code must serve any tenant on the platform ──────
describe("part-split is entity-agnostic", () => {
  it("ships with NO built-in vocabulary — an unconfigured tenant strips nothing", () => {
    // Guards against anyone re-seeding the stop-list with words that are noise
    // for one entity and meaningful SKU qualifiers for another.
    expect(__test__.DEFAULT_STOP_WORDS.size).toBe(0);
    expect(splitPartFromDescription("ACME STD WIDGET AB-100-1", {}))
      .toEqual({ partNumber: "AB-100-1", description: "ACME STD WIDGET" });
  });

  it("derives the brand token from ANY tenant's registered name", () => {
    expect(brandTokensFromTenantName("OBARA INDIA PRIVATE LIMITED")).toEqual(["OBARA"]);
    expect(brandTokensFromTenantName("Faith Automation Systems & Tooling Private Limited")).toEqual(["FAITH"]);
    expect(brandTokensFromTenantName("Zeta Werke GmbH")).toEqual(["ZETA"]);
    expect(brandTokensFromTenantName("Pvt Ltd")).toEqual([]);   // nothing but legal form
    expect(brandTokensFromTenantName("")).toEqual([]);
  });

  it("splits a DIFFERENT entity's part formats with only its own config", () => {
    const acme = { brandTokens: brandTokensFromTenantName("Acme Tooling Pvt Ltd"), stopWords: ["GRADE"] };
    expect(splitPartFromDescription("ACME GRADE BUSHING BSH/44/9", acme))
      .toEqual({ partNumber: "BSH/44/9", description: "BUSHING" });
    expect(splitPartFromDescription("ACME COUPLING CPL9931X", acme))
      .toEqual({ partNumber: "CPL9931X", description: "COUPLING" });
  });

  it("recognises codes by SHAPE, not by any entity's known prefixes", () => {
    for (const code of ["AB-100-1", "X-HD0420-3", "TNA-16-04-10-1", "CPL9931X", "BSH/44/9"]) {
      expect(looksLikePartCode(code)).toBe(true);
    }
    // Unit tokens must never be mistaken for a code.
    for (const notCode of ["NOS", "PCS", "EACH", "WIDGET"]) {
      expect(looksLikePartCode(notCode)).toBe(false);
    }
  });
});

// ── Item 4: table-column classification ────────────────────────────────────
describe("table-columns (the Mahindra header that used to invert)", () => {
  const header = ["Line", "Item Number", "Service Parent Name", "Item Description", "Quantity", "UOM", "Unit Price"];

  it("never puts the buyer's 'Item Number' into partNumber", () => {
    const c = classifyColumns(header);
    expect(c.part).toBe(-1);              // no OUR-part column on this PO
    expect(c.buyerCode).toBe(1);          // "Item Number" is the buyer's code
  });

  it("prefers 'Item Description' over 'Service Parent Name'", () => {
    expect(classifyColumns(header).desc).toBe(3);
  });

  it("still finds a real part column when one exists", () => {
    const c = classifyColumns(["S.No", "Part No", "Description", "Qty", "Rate"]);
    expect(c.part).toBe(1);
    expect(c.desc).toBe(2);
  });

  it("a single generic code column stays the part column, not the buyer code", () => {
    const c = classifyColumns(["SKU", "Description", "Qty"]);
    expect(c.part).toBe(0);
    expect(c.buyerCode).toBe(-1);
  });
});

// ── Item 1: payload hash makes a scanned PO approvable ─────────────────────
describe("order payload hash", () => {
  const order = {
    id: "o1",
    result: { salesOrder: {
      customer: { name: "MAHINDRA & MAHINDRA LTD", gstin: "27AAACM3025E1ZZ", po_number: "0066026562", currency: "INR" },
      lineItems: [{ partNumber: "TWS-092-90-2", quantity: 1, unitPrice: 1000.8 }],
    } },
  };

  it("produces a stable hash for the same payload", () => {
    expect(computeOrderPayloadHash(order)).toBe(computeOrderPayloadHash({ ...order }));
    expect(computeOrderPayloadHash(order)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when a price changes", () => {
    const edited = JSON.parse(JSON.stringify(order));
    edited.result.salesOrder.lineItems[0].unitPrice = 1200;
    expect(computeOrderPayloadHash(edited)).not.toBe(computeOrderPayloadHash(order));
  });

  it("is NOT disturbed by mapping metadata (mapping is not a commercial change)", () => {
    const mapped = JSON.parse(JSON.stringify(order));
    mapped.result.salesOrder.lineItems[0]._mapped_item = { id: "i1", part_no: "TWS-092-90-2" };
    expect(computeOrderPayloadHash(mapped)).toBe(computeOrderPayloadHash(order));
  });

  it("returns null for an empty shell rather than a shared constant", () => {
    expect(computeOrderPayloadHash({ result: { salesOrder: { lineItems: [] } } })).toBeNull();
  });

  it("canonical payload excludes volatile fields", () => {
    expect(Object.keys(canonicalOrderPayload(order))).toEqual(["po_number", "customer", "lines", "totals"]);
  });
});

// ── Item 2: the Tally voucher carries canonical identity ───────────────────
describe("Tally voucher identity", () => {
  const company = { name: "OBARA INDIA", gstin: "27AAACO8335K1Z5", state_code: "27" };
  const customer = { customer_name: "MAHINDRA & MAHINDRA LTD", gstin: "27AAACM3025E1ZZ", state_code: "27" };
  const orderWith = (lines) => ({ id: "o1", po_number: "0066026562", result: { salesOrder: { lineItems: lines } } });

  it("uses the master part_no, never the buyer's prose", () => {
    const xml = buildSalesVoucherXml({
      order: orderWith([{
        partNumber: "TWS-092-90-2",
        description: "OBARA STD SHANK TWS-092-90-2",
        quantity: 1, unitPrice: 1000.8,
        _mapped_item: { part_no: "TWS-092-90-2", print_name: "SHANK", rate_of_duty_pct: 18 },
      }]),
      company, customer, voucherNo: "SO:0066026562",
    });
    expect(xml.xml).toContain("TWS-092-90-2");
    // The whole point: buyer prose must not become a Tally stock item.
    expect(xml.xml).not.toContain("OBARA STD SHANK TWS-092-90-2");
  });

  it("takes the canonical GST rate from the master when the PO omitted it", () => {
    const t = computeLineTax(
      { quantity: 1, unitPrice: 100, _mapped_item: { rate_of_duty_pct: 18 } },
      "interstate",
    );
    expect(t.gst_pct).toBe(18);
    expect(t.igst).toBe(18);
  });

  it("refuses to build a voucher when a line is unmapped", () => {
    expect(() => buildSalesVoucherXml({
      order: orderWith([{ partNumber: "X-TB0029-3", description: "OBARA FIXED HOLDER X-TB0029-3", quantity: 1, unitPrice: 10 }]),
      company, customer, voucherNo: "SO:1",
    })).toThrow(/not mapped to the item master/i);
  });

  it("lists the offending lines so the operator knows what to fix", () => {
    const u = unmappedVoucherLines([
      { partNumber: "A", _mapped_item: { part_no: "A" } },
      { partNumber: "X-TB0029-3", description: "OBARA FIXED HOLDER X-TB0029-3" },
    ]);
    expect(u).toEqual([{ line_no: 2, partNumber: "X-TB0029-3", description: "OBARA FIXED HOLDER X-TB0029-3" }]);
  });

  it("an explicit tallyItemName override still wins", () => {
    expect(unmappedVoucherLines([{ tallyItemName: "CUSTOM", description: "x" }])).toEqual([]);
  });
});
