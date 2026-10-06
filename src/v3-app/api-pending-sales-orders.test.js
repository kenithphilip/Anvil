// Guards src/api/sales/pending_sales_orders.js — the per-customer Pending Sales
// Order read-model. It joins six tables by specific columns; a renamed/absent
// column silently blanks a whole join (the classic Anvil screen<->API drift).
// We assert every column the handler reads is declared in a migration.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const migDir = join(process.cwd(), "supabase", "migrations");
const allSql = readdirSync(migDir).filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(migDir, f), "utf8")).join("\n");
const declared = (col) => new RegExp("\\b" + col + "\\b").test(allSql);

// column -> reads by the handler
const READS = {
  orders: ["po_number", "po_date", "status", "order_mode", "committed_delivery_date", "opportunity_id", "result", "customer_id"],
  dispatch_lines: ["order_id", "shipment_id", "line_index", "part_no", "dispatched_qty", "dispatch_date", "invoice_number"],
  order_schedule_lines: ["order_id", "line_index", "part_no", "scheduled_date"],
  source_pos: ["order_id", "reference", "supplier", "country", "acknowledged_eta"],
  source_po_lines: ["source_po_id", "part_no", "acknowledged_eta", "received_qty", "received_at"],
  shipment_lines: ["shipment_id", "source_po_id", "source_po_line_id", "part_no", "received_qty", "receipt_date"],
  shipments: ["shipper_invoice_no", "mode", "carrier", "vessel_or_flight", "port_of_discharge", "ready_date", "vessel_sailing_date", "port_arrival_date", "warehouse_receipt_date"],
};

describe("pending_sales_orders column-drift guard", () => {
  for (const [table, cols] of Object.entries(READS)) {
    for (const col of cols) {
      it(`${table}.${col} exists in a migration`, () => {
        expect(declared(col), `${table}.${col} read by the handler but not declared`).toBe(true);
      });
    }
  }
});

// The OPEN_STATUSES the handler filters on must be real order_status enum values.
describe("pending_sales_orders open-status filter", () => {
  const enumBody = allSql.match(/create type order_status as enum\s*\(([\s\S]*?)\)/i)?.[1] || "";
  for (const s of ["PENDING_REVIEW", "APPROVED", "BLOCKED", "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT"]) {
    it(`${s} is a valid order_status`, () => {
      expect(enumBody.includes("'" + s + "'")).toBe(true);
    });
  }
});
