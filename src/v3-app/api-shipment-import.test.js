// Unit tests for the logistics-workbook parser (src/api/_lib/shipment-import.js).
// Uses synthetic 2D rows that mirror the real sheets: the Pending header sits on
// row 4 (title + section rows above it) with duplicate "ETA @ ..." columns, and
// the per-country line sheets put the part/description columns in different
// orders — so everything is resolved by header LABEL, never position.

import { describe, it, expect } from "vitest";
import { detectHeaderRow, buildHeaderMap, classifySheet, normalizeMode, toDateStr, normalizePending, normalizeLine, deriveStatus, pendingToShipment, parseSheets, normHeader, sheetCountry, currentEta, originalEta } from "../api/_lib/shipment-import.js";

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

// Column-drift guard for the inbound shipment_lines table (mig 209) that the
// apply path upserts into. A renamed/absent column would silently drop the
// per-part persistence — the exact Anvil screen<->API drift failure.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("shipment_lines column-drift guard", () => {
  const migDir = join(process.cwd(), "supabase", "migrations");
  const allSql = readdirSync(migDir).filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(migDir, f), "utf8")).join("\n");
  const tableBody = (t) => {
    const m = allSql.match(new RegExp("create table(?:\\s+if not exists)?\\s+" + t + "\\s*\\(([\\s\\S]*?)\\n\\);", "i"));
    return m ? m[1] : null;
  };
  const WRITES = ["tenant_id", "shipment_id", "source_po_id", "source_po_line_id", "part_no", "description", "qty", "received_qty", "receipt_date", "remark"];
  it("shipment_lines table exists", () => {
    expect(tableBody("shipment_lines")).toBeTruthy();
  });
  for (const col of WRITES) {
    it(`shipment_lines.${col} is declared`, () => {
      expect(new RegExp("\\b" + col + "\\b").test(tableBody("shipment_lines")), `missing ${col}`).toBe(true);
    });
  }
  it("has the (shipment_id, part_no) upsert conflict target", () => {
    expect(/unique\s*\(\s*shipment_id\s*,\s*part_no\s*\)/i.test(tableBody("shipment_lines"))).toBe(true);
  });
});

// ── the real workbooks, 2026-08-15 ─────────────────────────────────────────
//
// A live upload of the logistics team's two workbooks failed, and the failure
// had nothing to do with the data:
//
//   1. PAYLOAD. The frontend posted every sheet, every cell, across Excel's
//      over-reported used range with defval "". A 646 KB file became a 47 MB
//      POST against a 1 MB server limit and 413'd before the importer ran. The
//      SMALLER workbook produced the LARGER body — it was shipping padding.
//   2. A ONE-CHARACTER HEADER TYPO. The workbook spells the same column
//      "Shipper Invoice No." on one sheet and "Shipper Invoice N0." — digit
//      zero — on two others. classifySheet matches loosely on "shipper inv" so
//      both sheets were accepted as shipment sheets; normalizePending then
//      looked for the exact alias, missed it, and dropped EVERY row.
//      1,145 of 1,718 rows went silently to zero.

describe("header confusables", () => {
  it("folds a digit zero back to o between letters", () => {
    expect(normHeader("Shipper Invoice N0.")).toBe(normHeader("Shipper Invoice No."));
  });

  it("does not touch a zero that is not standing in for a letter", () => {
    // Narrowness is the point: a WRONG fold silently maps the wrong column,
    // and nothing downstream would catch that.
    expect(normHeader("Zone 0")).toBe("zone 0");
    expect(normHeader("Bin 10")).toBe("bin 10");
    expect(normHeader("Gate 40")).toBe("gate 40");
  });

  it("leaves other confusables alone — S5 must not become SS", () => {
    expect(normHeader("S5 Code")).toBe("s5 code");
    expect(normHeader("Q1 2026")).toBe("q1 2026");
  });

  it("makes both spellings resolve to the same column", () => {
    const a = buildHeaderMap(["Sr. No.", "Supplier Name", "Shipper Invoice No."]);
    const b = buildHeaderMap(["Sr. No.", "Supplier Name", "Shipper Invoice N0."]);
    expect([...a.keys()]).toEqual([...b.keys()]);
  });
});

describe("per-sheet accounting", () => {
  const pendingSheet = (invoiceHeader) => ({
    name: "S",
    rows: [
      ["Obara India Pvt Ltd"], ["Date :", 46241], ["Basic Information"],
      ["Sr. No.", "Supplier Name", invoiceHeader, "Items Details", "Mode", "Port of discharge", "Forwarder"],
      [1, "O/KOREA", "OK-CO-26-0166", "4 guns", "SEA", "Nhava Sheva", "Neoways"],
      [2, "O/CHINA", "GF-2561Y", "7 timers", "SEA", "Nhava Sheva", "EMU"],
    ],
  });

  it("reports what each sheet contributed", () => {
    const out = parseSheets([pendingSheet("Shipper Invoice No.")]);
    expect(out.pending).toHaveLength(2);
    const d = out.diag.find((x) => x.sheet === "S");
    expect(d).toMatchObject({ kind: "pending", kept: 2, unrecognised: 0 });
  });

  it("parses the misspelled header too — the whole point of the fold", () => {
    expect(parseSheets([pendingSheet("Shipper Invoice N0.")]).pending).toHaveLength(2);
  });

  // The failure mode that hid 1,145 rows: looked right, produced nothing.
  it("WARNS when a sheet classifies but yields nothing", () => {
    const broken = pendingSheet("Shipper Invoice No.");
    broken.rows[4] = [1, "O/KOREA", "", "4 guns", "SEA", "Nhava Sheva", "Neoways"];
    broken.rows[5] = [2, "O/CHINA", "", "7 timers", "SEA", "Nhava Sheva", "EMU"];
    const d = parseSheets([broken]).diag.find((x) => x.sheet === "S");
    expect(d.kept).toBe(0);
    expect(d.unrecognised).toBe(2);
    expect(d.warning).toMatch(/every non-blank row was unrecognised/);
  });

  it("counts placeholder rows as blank, not unrecognised", () => {
    // The Pending sheet carries ~518 pre-numbered rows holding a serial, some
    // Excel checkbox `false` values and a stray space. Calling those
    // "unrecognised" made a healthy sheet look broken.
    const s = pendingSheet("Shipper Invoice No.");
    s.rows.push([21, "", "", "", false, "", " "]);
    s.rows.push([22, "", "", "", false, "", " "]);
    const d = parseSheets([s]).diag.find((x) => x.sheet === "S");
    expect(d.blank).toBe(2);
    expect(d.unrecognised).toBe(0);
    expect(d.warning).toBeUndefined();
  });
});

// ── the country sheets, audited 2026-08-15 ────────────────────────────────
//
// The In Transit workbook is one sheet per source country and the sheets do not
// agree with each other:
//
//   Japan     P/O | PART NO.     | DESCRIPTION | Q'TY | Net Weight
//   China     P/O | DESCRIPTION  | Part Number | Net Weight | Q'TY
//   Korea     P/O | DESCRIPTION  | Part Number | Q'TY | Net Weight
//   Thailand  P/O | DESCRIPTION  | Part Number | Q'TY        (no Net Weight)
//
// Requiring part_no AND po_ref dropped 763 real rows: Thailand leaves Part
// Number blank and puts the code in DESCRIPTION, Japan/Korea leave P/O blank,
// China's P/O column carries free text ("Replacement items").

describe("country sheets with different layouts", () => {
  const sheet = (name, headers, rows) => ({ name, rows: [headers, ...rows] });
  const JAPAN = ["P/O", "PART NO.", "DESCRIPTION", "Q'TY", "Net Weight", "Shipper Inv No."];
  const THAI = ["P/O", "DESCRIPTION", "Part Number", "Q'TY", "Shipper Inv No."];

  it("reads Japan's PART NO. and Thailand's Part Number alike", () => {
    const out = parseSheets([
      sheet("Japan", JAPAN, [["OIPOOJ-1", "NI110H-610", "TRANSFORMER", 1, "", "1600082-ID"]]),
      sheet("Thailand", THAI, [["OIPOOT-1", "OIL SEAL", "SB36466", 50, "EX21-0002"]]),
    ]);
    expect(out.lines.map((l) => l.part_no)).toEqual(["NI110H-610", "SB36466"]);
  });

  it("keeps a row whose part number is blank and code sits in the description", () => {
    // Thailand's 672. Real goods in transit — dropping them meant a customer
    // asking about a Thai part got "no match" while the row sat in the sheet.
    const out = parseSheets([sheet("Thailand", THAI, [["OIPOOT-1", "SB36466 OIL SEAL", "", 50, "EX21-0002"]])]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].description).toBe("SB36466 OIL SEAL");
  });

  it("does NOT mine a part number out of the description", () => {
    // The trap #424 closed on the PO side: the splitter turned "TWS-092-90-2"
    // into "90-2". A missing part number stays missing.
    const out = parseSheets([sheet("Thailand", THAI, [["OIPOOT-1", "SB36466 OIL SEAL", "", 50, "EX21-0002"]])]);
    expect(out.lines[0].part_no).toBeFalsy();
  });

  it("keeps a row whose P/O is blank but part is present", () => {
    // Japan and Korea both do this.
    const out = parseSheets([sheet("Korea", THAI, [["", "COUPLER", "KZ-1386", 20, "OK-CO-16-0075"]])]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].part_no).toBe("KZ-1386");
  });

  it("drops a row that identifies nothing", () => {
    // Anchored to something, or it is not a line.
    const out = parseSheets([sheet("Korea", THAI, [["", "", "", 20, ""]])]);
    expect(out.lines).toHaveLength(0);
  });

  it("counts part-less rows so they are visible, not silent", () => {
    const out = parseSheets([sheet("Thailand", THAI, [
      ["OIPOOT-1", "SB36466 OIL SEAL", "", 50, "EX21-0002"],
      ["OIPOOT-2", "GASKET", "GK-9", 2, "EX21-0002"],
    ])]);
    expect(out.diag[0].without_part_no).toBe(1);
    expect(out.diag[0].kept).toBe(2);
  });
});

describe("source country from the sheet name", () => {
  it("maps the country sheets to ISO codes", () => {
    expect(sheetCountry("Japan")).toBe("JP");
    expect(sheetCountry("China")).toBe("CN");
    expect(sheetCountry("Korea")).toBe("KR");
    expect(sheetCountry("Thailand")).toBe("TH");
    expect(sheetCountry("France")).toBe("FR");
  });

  it("stamps it on every line from that sheet", () => {
    const out = parseSheets([{
      name: "Korea",
      rows: [["P/O", "DESCRIPTION", "Part Number", "Q'TY", "Shipper Inv No."],
             ["OIPOOK-1", "TERMINAL", "4-ET6755", 10, "OK-CO-16-0075"]],
    }]);
    expect(out.lines[0].source_country).toBe("KR");
  });

  // An explicit list, not a guess: inferring a country from an arbitrary tab
  // name would invent data.
  it.each(["Sheet1", "Sheet2", "HSS Transit Shipment", "", null])("yields null for %p", (n) => {
    expect(sheetCountry(n)).toBeNull();
  });
});

describe("the High Seas Sale sheet", () => {
  const HSS = {
    name: "HSS Transit Shipment ",
    rows: [
      ["Customer Name", "Customer P/O", "DESCRIPTION", "Shipper Inv No.", "Mode", "POD", "BOE Status"],
      ["ACME LTD", "PO-991", "4 guns", "OK-CO-26-0166", "SEA", "Nhava Sheva", "filed"],
    ],
  };

  it("is recognised as its own kind rather than ignored", () => {
    // 70 real rows used to vanish without comment.
    expect(parseSheets([HSS]).diag[0].kind).toBe("hss");
  });

  it("warns that it is recognised but not imported", () => {
    const d = parseSheets([HSS]).diag[0];
    expect(d.warning).toMatch(/High Seas Sale/);
    expect(d.unsupported).toBe(1);
  });

  it("contributes no lines — it has no part-level columns", () => {
    expect(parseSheets([HSS]).lines).toHaveLength(0);
  });
});

// The Pending sheet states each hop's ETA up to four ways: an original column, a
// SECOND column with the identical header, a "Delayed Shipment Update-…", and
// for the store a "Revised ETA at store". normalizePending read occurrence 0 —
// the original — so a shipment that had slipped three weeks still reported the
// date it was first promised, and the revisions went into a free-text blob.
describe("current vs originally-promised ETA", () => {
  const map = buildHeaderMap(PENDING_HEADER);

  it("prefers the delayed-shipment-update column over both plain ones", () => {
    const row = [...PENDING_ROW];
    row[map.get(normHeader("delayed shipment update-eta @ indian port"))[0]] = "2026-08-22";
    expect(currentEta(row, map, "port")).toBe("2026-08-22");
    // ...and the original is still recoverable, which is what slip measures from.
    expect(originalEta(row, map, "port")).toBe("2026-07-29");
  });

  it("falls back to the second occurrence of a duplicated header", () => {
    // "ETA @ Indian Port" appears twice: expected, then revised.
    const row = [...PENDING_ROW];
    const idxs = map.get(normHeader("eta @ indian port"));
    expect(idxs.length).toBeGreaterThan(1);
    row[idxs[1]] = "2026-08-18";
    expect(currentEta(row, map, "port")).toBe("2026-08-18");
    expect(originalEta(row, map, "port")).toBe("2026-07-29");
  });

  it("falls back to the original when nothing has been revised", () => {
    expect(currentEta(PENDING_ROW, map, "port")).toBe("2026-07-31");
  });

  it("prefers 'Revised ETA at store' for the store hop", () => {
    const row = [...PENDING_ROW];
    row[map.get(normHeader("revised eta at store"))[0]] = "2026-08-25";
    expect(currentEta(row, map, "store")).toBe("2026-08-25");
  });

  it("exposes both on the normalized row without changing the old fields", () => {
    // eta_india / eta_store keep their meaning: the remarks block labels them
    // "(expected)" and "(promised)" and must keep saying what it always did.
    const n = normalizePending(PENDING_ROW, map);
    expect(n.eta_india).toBe("2026-07-29");
    expect(n.eta_port_current).toBe("2026-07-31");
    expect(n).toHaveProperty("eta_store_current");
  });

  it("returns empty for an unknown hop rather than guessing", () => {
    expect(currentEta(PENDING_ROW, map, "moon")).toBe("");
    expect(originalEta(PENDING_ROW, map, "moon")).toBe("");
  });
});
