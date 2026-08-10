// Unit tests for the logistics-workbook parser (src/api/_lib/shipment-import.js).
// Uses synthetic 2D rows that mirror the real sheets: the Pending header sits on
// row 4 (title + section rows above it) with duplicate "ETA @ ..." columns, and
// the per-country line sheets put the part/description columns in different
// orders — so everything is resolved by header LABEL, never position.

import { describe, it, expect } from "vitest";
import {
  detectHeaderRow, buildHeaderMap, classifySheet, normalizeMode, toDateStr,
  normalizePending, normalizeLine, deriveStatus, pendingToShipment, parseSheets,
} from "../api/_lib/shipment-import.js";

const PENDING_HEADER = [
  "Sr. No.", "Supplier Name", "Shipper Invoice No.", "Items Details", "Shipper Inv Date",
  "Mode", "Gross Weight (kg)", "Vessel Name", "Port of discharge", "Forwarder", "HAWB NO / BL NO",
  "ETD @ Source Port", "ETA @ Indian Port", "ETA @ Obara Store", "ATD @ Source Port",
  "ETA @ Indian Port", "Delayed Shipment Update-ETA @ Indian Port", "ATA @ India",
  "ETA @ Obara Store", "Delayed Shipment Update-ETA @ Obara Store", "ATA @ Obara Store",
  "No. of Delays", "Remark", "Current Status", "Pending Process", "Revised ETA at store",
];
const PENDING_ROW = [
  "1", "O/KOREA", "OK-CO-26-0166", "Rhythmsoft 4Guns", "2026-06-25", "SEA", "1360",
  "XIN MEI ZHOU", "Nhava Sheva", "Neoways", "WRECNSA26070601",
  "2026-07-11", "2026-07-29", "2026-08-06", "2026-07-12", "2026-07-31", "", "2026-08-07",
  "2026-08-09", "", "", "", "weather delay", "In Transit", "", "2026-08-10",
];
const pendingSheet = { name: "Pending", rows: [["Daily Shipment Reports"], ["Date :", "2026-08-07"], ["Basic Information"], PENDING_HEADER, PENDING_ROW] };

// Korea line sheet: DESCRIPTION before Part Number.
const lineSheet = {
  name: "Korea",
  rows: [
    ["P/O", "DESCRIPTION", "Part Number", "Q'TY", "Net Weight", "Shipper Inv No.", "Mode", "POD", "Vessel or flight sailing date", "Arrival at Indian Port", "Receipt date at our warehouse", "Remark"],
    ["OIPOOK-260104-01-OK", "CYLINDER ASSY", "FOR_UC-K3227", "2", "", "OK-CO-26-0166", "SEA", "Nhava Sheva", "", "", "2026-08-08", "Received"],
  ],
};

describe("header detection + classification", () => {
  it("finds the Pending header below the title/section rows", () => {
    expect(detectHeaderRow(pendingSheet.rows).index).toBe(3);
  });
  it("classifies pending vs lines vs ignore", () => {
    expect(classifySheet(buildHeaderMap(PENDING_HEADER))).toBe("pending");
    expect(classifySheet(buildHeaderMap(lineSheet.rows[0]))).toBe("lines");
    expect(classifySheet(buildHeaderMap(["Box", "Dim", "CBM"]))).toBe("ignore");
  });
});

describe("value coercion", () => {
  it("normalizeMode maps free text to the enum, else null", () => {
    expect(normalizeMode("SEA")).toBe("SEA");
    expect(normalizeMode("By Air")).toBe("AIR");
    expect(normalizeMode("road")).toBe("ROAD");
    expect(normalizeMode("")).toBe(null);
  });
  it("toDateStr handles ISO, dd.mm.yyyy, Date, and blanks", () => {
    expect(toDateStr("2026-08-07")).toBe("2026-08-07");
    expect(toDateStr("07.08.2026")).toBe("2026-08-07");
    expect(toDateStr(new Date("2026-08-07T00:00:00Z"))).toBe("2026-08-07");
    expect(toDateStr("")).toBe("");
    expect(toDateStr(null)).toBe("");
  });
});

describe("normalizePending", () => {
  const n = normalizePending(PENDING_ROW, buildHeaderMap(PENDING_HEADER));
  it("resolves columns by label", () => {
    expect(n.shipper_invoice_no).toBe("OK-CO-26-0166");
    expect(n.supplier).toBe("O/KOREA");
    expect(n.mode).toBe("SEA");
    expect(n.vessel_or_flight).toBe("XIN MEI ZHOU");
    expect(n.port_of_discharge).toBe("Nhava Sheva");
    expect(n.carrier).toBe("Neoways");
    expect(n.bl_awb).toBe("WRECNSA26070601");
  });
  it("maps the actual-date ladder and the first-occurrence expected ETA", () => {
    expect(n.atd_source).toBe("2026-07-12");     // ATD @ Source Port
    expect(n.ata_india).toBe("2026-08-07");      // ATA @ India
    expect(n.eta_india).toBe("2026-07-29");      // first "ETA @ Indian Port"
    expect(n.eta_store).toBe("2026-08-10");      // "Revised ETA at store" preferred
  });
});

describe("deriveStatus + pendingToShipment", () => {
  it("derives a status from ladder + free-text", () => {
    expect(deriveStatus("", { ata_store: "2026-08-09" })).toBe("DELIVERED");
    expect(deriveStatus("In Transit", { ata_india: "2026-08-07" })).toBe("AT_PORT");
    expect(deriveStatus("In Transit", { atd_source: "2026-07-12" })).toBe("IN_TRANSIT");
    expect(deriveStatus("", {})).toBe("PLANNED");
  });
  it("builds the shipments upsert body with the ladder + link + lossless remarks", () => {
    const n = normalizePending(PENDING_ROW, buildHeaderMap(PENDING_HEADER));
    const body = pendingToShipment(n, { order_id: "o1", source_po_id: "sp1" });
    expect(body.shipment_number).toBe("WRECNSA26070601");
    expect(body.vessel_sailing_date).toBe("2026-07-12");
    expect(body.port_arrival_date).toBe("2026-08-07");
    expect(body.warehouse_receipt_date).toBe(null);
    expect(body.order_id).toBe("o1");
    expect(body.source_po_id).toBe("sp1");
    // Expected ETAs live in remarks until they get their own columns.
    expect(body.remarks).toContain("ETA store (promised): 2026-08-10");
    expect(body.remarks).toContain("Items: Rhythmsoft 4Guns");
  });
});

describe("normalizeLine + parseSheets", () => {
  it("reads a line row regardless of column order", () => {
    const l = normalizeLine(lineSheet.rows[1], buildHeaderMap(lineSheet.rows[0]));
    expect(l.po_ref).toBe("OIPOOK-260104-01-OK");
    expect(l.part_no).toBe("FOR_UC-K3227");
    expect(l.shipper_invoice_no).toBe("OK-CO-26-0166");
    expect(l.receipt_date).toBe("2026-08-08");
  });
  it("parses a mixed workbook into pending + line rows", () => {
    const { pending, lines } = parseSheets([pendingSheet, lineSheet]);
    expect(pending).toHaveLength(1);
    expect(lines).toHaveLength(1);
    // the invoice->PO bridge: the line row ties this invoice to a source PO ref
    expect(lines[0].shipper_invoice_no).toBe(pending[0].shipper_invoice_no);
    expect(lines[0].po_ref).toBe("OIPOOK-260104-01-OK");
  });
});
