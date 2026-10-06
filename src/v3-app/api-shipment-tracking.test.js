// Guards src/api/sales/shipment_tracking.js — the account-owner tracking
// read-model. Two risks: (1) the order_mode -> item-type classification, and
// (2) column drift, since the enrichment SELECTs specific columns across five
// tables and a single renamed/absent column would silently blank a whole join
// (the classic Anvil screen<->API drift failure). We assert every column the
// handler reads is actually declared in a migration.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { shipmentItemType } from "../api/sales/shipment_tracking.js";

describe("shipmentItemType", () => {
  it("classifies project material vs spares from order_mode", () => {
    expect(shipmentItemType("PROJECT_FOR")).toBe("project");
    expect(shipmentItemType("PROJECT_HSS")).toBe("project");
    expect(shipmentItemType("SPARES")).toBe("spares");
    expect(shipmentItemType("SPARES_ASSEMBLY")).toBe("spares");
    expect(shipmentItemType("INTERNAL")).toBe("internal");
    expect(shipmentItemType(null)).toBe("unknown");
    expect(shipmentItemType("SOMETHING_ELSE")).toBe("unknown");
  });
});

// ---- column-drift guard ----------------------------------------------------
const migDir = join(process.cwd(), "supabase", "migrations");
const allSql = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(migDir, f), "utf8"))
  .join("\n");

// The enrichment reads these columns. A missing one blanks its join silently.
const READS = {
  shipments: ["tenant_id", "order_id", "source_po_id", "status", "created_at", "shipper_invoice_no", "ready_date", "vessel_sailing_date", "port_arrival_date", "warehouse_receipt_date", "customer_delivery_date"],
  orders: ["customer_id", "opportunity_id", "order_mode", "committed_delivery_date", "po_number"],
  opportunities: ["opportunity_name", "owner_id", "customer_id", "order_mode"],
  customers: ["customer_name"],
  source_po_lines: ["source_po_id", "qty", "received_qty"],
};

// A column is "declared" if its identifier appears anywhere in the migrations
// (covers both the create-table body and later `add column` statements, which
// is how orders.committed_delivery_date / opportunity_id were added).
const declared = (col) => new RegExp("\\b" + col + "\\b").test(allSql);

describe("shipment_tracking column-drift guard", () => {
  for (const [table, cols] of Object.entries(READS)) {
    for (const col of cols) {
      it(`${table}.${col} exists in a migration`, () => {
        expect(declared(col), `${table}.${col} is read by the handler but not declared`).toBe(true);
      });
    }
  }
});
