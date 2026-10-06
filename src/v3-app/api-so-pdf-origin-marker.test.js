// so_pdf.js used to append a hardcoded "(O/K)" to EVERY vendor part on the SO
// PDF, mislabelling local -I parts and China/Japan imports as Korea. partOriginMarker
// now derives the marker per part from the item-master source_country, else the
// pending-so origin classifier.

import { describe, it, expect } from "vitest";
import { partOriginMarker } from "../api/orders/so_pdf.js";

describe("partOriginMarker", () => {
  it("uses the item-master resolved source_country when present", () => {
    expect(partOriginMarker({ _mapped_item: { source_country: "O-KOREA" } }, "403A7K188-100", "Point Holder")).toBe("(O/K)");
    expect(partOriginMarker({ _mapped_item: { source_country: "O-CHINA" } }, "DB6-90-510", "Transformer")).toBe("(O/C)");
    expect(partOriginMarker({ _mapped_item: { source_country: "O-JAPAN" } }, "X168", "Assy")).toBe("(O/J)");
  });

  it("appends NO marker for a locally-sourced (India) part", () => {
    expect(partOriginMarker({ _mapped_item: { source_country: "O-INDIA" } }, "X168-STD", "Gear Case")).toBe("");
  });

  it("classifies from the strings when there is no item-master origin", () => {
    // description carries the import marker
    expect(partOriginMarker({}, "DB6-90-510", "Transformer (O/C)")).toBe("(O/C)");
    // a bare code with no origin signal gets NO marker (was wrongly "(O/K)")
    expect(partOriginMarker({}, "403A7K188-100", "Point Holder")).toBe("");
  });

  it("does not double-mark a part that already carries a marker", () => {
    expect(partOriginMarker({ _mapped_item: { source_country: "O-KOREA" } }, "OID1292-I", "Electrode")).toBe(""); // -I local, already marked
    expect(partOriginMarker({ _mapped_item: { source_country: "O-KOREA" } }, "DB6-90-510(O/C)", "Transformer")).toBe(""); // already has (O/C)
  });

  it("prefers the item-master origin over a conflicting string signal", () => {
    // resolved to China even though the part text has no marker
    expect(partOriginMarker({ _mapped_item: { source_country: "O-CHINA" } }, "SRTX-2C3741", "Coupling")).toBe("(O/C)");
  });
});
