// The recon grid's hover tooltip pairs what was EXTRACTED from the PO against
// what it was MAPPED to in the item master, so an operator can hover a line
// and see the dual codes (our part + the buyer's SAP code, parsed out of a
// prefixed description) alongside the resolved canonical part.

import { describe, it, expect } from "vitest";
import { mappingTitle } from "./screens/so-workspace.tsx";

describe("recon mapping tooltip (hover extracted ↔ mapped)", () => {
  it("shows both extracted codes and the mapped canonical part", () => {
    const t = mappingTitle({
      partNumber: "TWS-092-90-2",
      customerItemCode: "A12060OBAR010003",
      description: "OBARA STD SHANK TWS-092-90-2",
      _mapped_item: { match_via: "customer_part", part_no: "TWS-092-90-2", print_name: "STD SHANK", hsn_sac: "82075000" },
    });
    expect(t).toContain("EXTRACTED FROM PO");
    expect(t).toContain("part (ours): TWS-092-90-2");
    expect(t).toContain("buyer SAP / item code: A12060OBAR010003");
    expect(t).toContain("MAPPED TO ITEM MASTER");
    expect(t).toContain("via: customer_part");
    expect(t).toContain("canonical part_no: TWS-092-90-2");
    expect(t).toContain("HSN/SAC: 82075000");
  });

  it("flags an unmapped line clearly", () => {
    const t = mappingTitle({ partNumber: "X-1" });
    expect(t).toContain("part (ours): X-1");
    expect(t).toMatch(/not yet mapped/i);
  });

  it("tolerates snake_case line shapes + empty lines", () => {
    expect(mappingTitle({ part_no: "P", customer_item_code: "C" })).toContain("buyer SAP / item code: C");
    expect(mappingTitle({})).toContain("(no codes on this line)");
  });
});
