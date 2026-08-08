// Auto-generated smoke test for screens/shipments.jsx.
// Hand-edit if a screen needs a more specific assertion; the generator
// only overwrites files that match the auto-generated header below.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  // jsdom's confirm/alert/prompt are no-ops by default; stub them so
  // accidental click handlers can't pop dialogs during a smoke render.
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("Shipments", () => {
  it("renders without throwing", async () => {
    const mod = await import("./shipments");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});

// Regression guard for the field-drift data-loss bug: the form used to POST
// vessel_name / eta / notes and a lower-case mode, none of which are real
// `shipments` columns (or matched the upper-case enum), so every save silently
// dropped them. shipmentToForm must map legacy rows onto the real column names
// so an edit-then-save round-trips instead of erasing data.
describe("shipmentToForm (drift fix)", () => {
  it("maps legacy field names + lower-case mode onto real columns", async () => {
    const { shipmentToForm } = await import("./shipments");
    const legacy = {
      id: "s1",
      mode: "sea",
      vessel_name: "XIN MEI ZHOU",
      eta: "2026-08-01T00:00:00.000Z",
      notes: "port congestion",
    };
    const f = shipmentToForm(legacy);
    expect(f.mode).toBe("SEA"); // upper-cased for the enum
    expect(f.vessel_or_flight).toBe("XIN MEI ZHOU");
    expect(f.port_arrival_date).toBe("2026-08-01"); // legacy eta -> arrival hop, date-only
    expect(f.remarks).toBe("port congestion");
  });

  it("round-trips an already-correct row and truncates dates to YYYY-MM-DD", async () => {
    const { shipmentToForm } = await import("./shipments");
    const row = {
      id: "s2",
      mode: "AIR",
      vessel_or_flight: "AI-317",
      shipper_invoice_no: "OK-CO-26-0166",
      warehouse_receipt_date: "2026-08-07T10:00:00.000Z",
      remarks: "ok",
    };
    const f = shipmentToForm(row);
    expect(f.mode).toBe("AIR");
    expect(f.shipper_invoice_no).toBe("OK-CO-26-0166");
    expect(f.warehouse_receipt_date).toBe("2026-08-07");
    expect(f.remarks).toBe("ok");
  });
});

describe("shipmentLatestDate", () => {
  it("reports the furthest-along hop, else legacy eta, else dash", async () => {
    const { shipmentLatestDate } = await import("./shipments");
    expect(shipmentLatestDate({ ready_date: "2026-07-01", warehouse_receipt_date: "2026-08-07" }))
      .toBe("Store: 2026-08-07");
    expect(shipmentLatestDate({ ready_date: "2026-07-01" })).toBe("Ready: 2026-07-01");
    expect(shipmentLatestDate({ eta: "2026-07-30T00:00:00Z" })).toBe("ETA: 2026-07-30");
    expect(shipmentLatestDate({})).toBe("—");
  });
});
