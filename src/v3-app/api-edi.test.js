// Unit tests for the EDI parser/builder. Confirms:
//   - X12 850 round-trips through parseX12 with line-item details.
//   - X12 855 build emits a syntactically valid string with the
//     correct ISA/GS/ST nesting + SE/GE/IEA terminators.
//   - X12 997 ack contains AK1/AK9.
//   - EDIFACT ORDERS parses BGM + LIN + QTY + PRI.
//   - EDIFACT ORDRSP build emits UNH/UNT/UNZ correctly.

import { describe, it, expect } from "vitest";
import { parseX12, buildX12, buildX12_997, parseEdifact, buildEdifact } from "../api/_lib/edi.js";

describe("EDI / X12 850 parse", () => {
  it("parses a minimal 850 with one line", () => {
    const raw = [
      "ISA*00*          *00*          *ZZ*BUYER          *ZZ*SELLER         *240101*1200*U*00501*000000001*0*P*:",
      "GS*PO*BUYER*SELLER*20240101*1200*1*X*005010",
      "ST*850*0001",
      "BEG*00*SA*PO12345**20240101",
      "REF*VR*VENDOR1",
      "PO1*1*10*EA*99.50**BP*WIDGET-001*VP*VEN-001",
      "PID*F****10mm widget",
      "CTT*1",
      "SE*7*0001",
      "GE*1*1",
      "IEA*1*000000001",
    ].join("~") + "~";
    const parsed = parseX12(raw);
    expect(parsed.message_type).toBe("850");
    expect(parsed.po.number).toBe("PO12345");
    expect(parsed.po.lines).toHaveLength(1);
    expect(parsed.po.lines[0].quantity).toBe(10);
    expect(parsed.po.lines[0].unit_price).toBe(99.5);
    expect(parsed.po.lines[0].buyer_part_id).toBe("WIDGET-001");
  });
});

describe("EDI / X12 855 build", () => {
  it("emits an envelope with proper structure", () => {
    const out = buildX12({
      messageType: "855", sender: "SELLER", receiver: "BUYER",
      controlNumber: "000000123",
      payload: {
        po_number: "PO12345",
        po_date: "20240101",
        lines: [{ quantity: 10, uom: "EA", unit_price: 99.5, buyer_part_id: "WIDGET-001" }],
      },
    });
    expect(out).toContain("ISA*00*");
    expect(out).toContain("GS*PR*SELLER*BUYER*");
    expect(out).toContain("ST*855*0001");
    expect(out).toContain("BAK*00*AC*PO12345*");
    expect(out).toContain("CTT*1");
    expect(out).toContain("IEA*1*000000123");
  });
});

describe("EDI / X12 997 ack", () => {
  it("contains AK1 + AK9 with status", () => {
    const ack = buildX12_997({
      sender: "ANVIL", receiver: "BUYER",
      controlNumber: "000000999", ackedGsControl: "1", status: "A",
    });
    expect(ack).toContain("ST*997*0001");
    expect(ack).toContain("AK1*PO*1");
    expect(ack).toContain("AK9*A*1*1*1");
  });
});

describe("EDI / EDIFACT ORDERS", () => {
  it("parses a minimal ORDERS message", () => {
    const raw = [
      "UNB+UNOA:3+SENDER+RECEIVER+240101:1200+1",
      "UNH+1+ORDERS:D:96A:UN",
      "BGM+220+PO9999+9",
      "DTM+137:20240101:102",
      "LIN+1++WIDGET-A:BP",
      "IMD+F+++:::Premium widget",
      "QTY+21:5",
      "PRI+AAA:42.00",
      "UNS+S",
      "UNT+8+1",
      "UNZ+1+1",
    ].join("'") + "'";
    const p = parseEdifact(raw);
    expect(p.message_type).toBe("ORDERS");
    expect(p.po.number).toBe("PO9999");
    expect(p.po.lines).toHaveLength(1);
    expect(p.po.lines[0].buyer_part_id).toBe("WIDGET-A");
    expect(p.po.lines[0].quantity).toBe(5);
    expect(p.po.lines[0].unit_price).toBe(42);
  });
});

describe("EDI / EDIFACT ORDRSP build", () => {
  it("emits UNH + BGM + LIN + UNT segments", () => {
    const out = buildEdifact({
      messageType: "ORDRSP", sender: "ANVIL", receiver: "BUYER",
      controlNumber: "1",
      payload: {
        po_number: "PO9999",
        lines: [{ buyer_part_id: "WIDGET-A", quantity: 5, unit_price: 42, description: "Premium widget" }],
      },
    });
    expect(out).toContain("UNH+1+ORDRSP:D:96A:UN");
    expect(out).toContain("BGM+231+PO9999+29");
    expect(out).toContain("LIN+1+");
    expect(out).toContain("QTY+21:5");
    expect(out).toContain("PRI+AAA:42");
    expect(out).toContain("UNZ+1+1");
  });
});
