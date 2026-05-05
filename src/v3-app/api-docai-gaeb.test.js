// Unit tests for the GAEB DA XML parser (Phase 5.3).

import { describe, it, expect } from "vitest";
import { extract, looksLikeGaeb } from "../api/_lib/docai/gaeb.js";

const X83_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<GAEB>
  <GAEBInfo><Version>3.2</Version><Date>2025-03-12</Date></GAEBInfo>
  <Award>
    <DP DPType="83">
      <PrjName>Hochbau Phase 2</PrjName>
      <DPNo>BVG-2025-A11</DPNo>
      <BoQ Currency="EUR">
        <BoQBody>
          <BoQCtgy RNoPart="01">
            <Itemlist>
              <Item ID="01.01.0010" RNoPart="0010">
                <Description>
                  <CompleteText>
                    <DetailTxt><Text>Beton C30/37 fuer Bodenplatte</Text></DetailTxt>
                  </CompleteText>
                </Description>
                <Qty>120,5</Qty>
                <QU>m3</QU>
                <UP Currency="EUR">85,50</UP>
                <IT>10302,75</IT>
              </Item>
              <Item ID="01.01.0020" RNoPart="0020">
                <Description><CompleteText><DetailTxt><Text>Bewehrungsstahl B500B</Text></DetailTxt></CompleteText></Description>
                <Qty>3500</Qty>
                <QU>kg</QU>
                <UP Currency="EUR">1,20</UP>
                <IT>4200,00</IT>
              </Item>
            </Itemlist>
          </BoQCtgy>
        </BoQBody>
      </BoQ>
    </DP>
  </Award>
</GAEB>`;

const X83_INVITATION_NO_PRICES = `<?xml version="1.0"?>
<GAEB>
  <Award>
    <DP DPType="83">
      <PrjName>Tender 41</PrjName>
      <BoQ>
        <BoQBody>
          <Itemlist>
            <Item ID="A.1"><Description><Text>Position 1</Text></Description><Qty>10</Qty><QU>St</QU></Item>
            <Item ID="A.2"><Description><Text>Position 2</Text></Description><Qty>5</Qty><QU>m</QU></Item>
          </Itemlist>
        </BoQBody>
      </BoQ>
    </DP>
  </Award>
</GAEB>`;

describe("GAEB / detection", () => {
  it("recognises .x83 extension", () => {
    expect(looksLikeGaeb({ filename: "tender.x83", bytes: null })).toBe(true);
  });
  it("recognises .x84, .x86, .x81 extensions", () => {
    expect(looksLikeGaeb({ filename: "bid.x84", bytes: null })).toBe(true);
    expect(looksLikeGaeb({ filename: "award.x86", bytes: null })).toBe(true);
    expect(looksLikeGaeb({ filename: "rates.x81", bytes: null })).toBe(true);
  });
  it("sniffs <GAEB> in file bytes when extension is unknown", () => {
    expect(looksLikeGaeb({ filename: "tender.xml", bytes: X83_SAMPLE })).toBe(true);
  });
  it("rejects files that do not look like GAEB", () => {
    expect(looksLikeGaeb({ filename: "po.pdf", bytes: "%PDF-1.4..." })).toBe(false);
    expect(looksLikeGaeb({ filename: "x.xml", bytes: "<other-root/>" })).toBe(false);
  });
});

describe("GAEB / extract", () => {
  it("parses an X83 with two priced items", async () => {
    const out = await extract({ bytes: X83_SAMPLE, filename: "tender.x83" });
    expect(out.ok).toBe(true);
    const so = out.normalized.salesOrder;
    expect(so.lineItems).toHaveLength(2);
    expect(so.lineItems[0].itemCode).toBe("01.01.0010");
    expect(so.lineItems[0].qty).toBe(120.5);
    expect(so.lineItems[0].uom).toBe("m3");
    expect(so.lineItems[0].rate).toBe(85.5);
    expect(so.lineItems[0].lineTotal).toBe(10302.75);
    expect(so.lineItems[0].description).toContain("Beton");
    expect(so.currency).toBe("EUR");
    expect(so.gaeb.variant).toBe("x83");
    expect(so.gaeb.project_name).toBe("Hochbau Phase 2");
    expect(so.gaeb.item_count).toBe(2);
    expect(so.grandTotal).toBeCloseTo(14502.75, 2);
  });

  it("handles a bid invitation with no UP/IT (X83 buyer-published)", async () => {
    const out = await extract({ bytes: X83_INVITATION_NO_PRICES, filename: "tender.x83" });
    expect(out.ok).toBe(true);
    const so = out.normalized.salesOrder;
    expect(so.lineItems).toHaveLength(2);
    expect(so.lineItems[0].rate).toBeNull();
    expect(so.lineItems[0].lineTotal).toBeNull();
    expect(so.lineItems[0].qty).toBe(10);
    expect(so.grandTotal).toBeNull();
  });

  it("rejects non-GAEB input", async () => {
    const out = await extract({ bytes: "<other-root/>", filename: "x.xml" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/GAEB/i);
  });

  it("handles namespaced root tag", async () => {
    const ns = X83_SAMPLE.replace("<GAEB>", "<gaeb:GAEB xmlns:gaeb=\"urn:gaeb-da-xml\">").replace("</GAEB>", "</gaeb:GAEB>");
    const out = await extract({ bytes: ns, filename: "tender.x83" });
    expect(out.ok).toBe(true);
    expect(out.normalized.salesOrder.lineItems).toHaveLength(2);
  });

  it("falls back gracefully on parse failure", async () => {
    const out = await extract({ bytes: "<GAEB><Award><DP><BoQ><Itemlist><Item ID='broken'><Qty>not-a-number", filename: "broken.x83" });
    // Tokenizer is lenient, so parse may still succeed but with no items.
    // Either way the call should not throw.
    expect(typeof out.ok).toBe("boolean");
  });
});
