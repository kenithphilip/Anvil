// The customer-master "Extraction learning" panel: shows the last PO Anvil
// extracted for the customer, each line's extracted codes mapped against the
// item master, and the accumulated customer-code -> our-part map.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { CustomerExtractionLearning } from "./CustomerExtractionLearning";

const RUNS = { runs: [{ status: "ok", confidence_overall: 0.93, adapter_used: "gemini", started_at: "2026-07-19T10:00:00Z" }] };
const ORDERS = { orders: [{
  id: "o1", po_number: "3200231847", created_at: "2026-07-19T10:00:00Z",
  result: { salesOrder: { lineItems: [
    { partNumber: "TNA-16-04-10-2", customerItemCode: "A12060OBAR010003", description: "OBARA STD SHANK TNA-16-04-10-2",
      _mapped_item: { match_via: "customer_part", part_no: "TNA-16-04-10-2" } },
  ] } },
}] };
const MAP = { parts: [{ customer_part_number: "A44146OBAR010001", part_no: "TWS-092-95-2", created_via: "quote_sent" }] };

const routeFetch = () => vi.fn(async (url: any) => {
  const u = String(url);
  const body = u.includes("/api/docai/runs") ? RUNS
    : u.includes("item_customer_parts") ? MAP
    : u.includes("/api/orders") ? ORDERS
    : {};
  return { ok: true, json: async () => body } as any;
});

describe("CustomerExtractionLearning", () => {
  beforeEach(() => {
    installBackend({});
    (global as any).fetch = routeFetch();
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows the last extracted PO with extracted ↔ mapped per line", async () => {
    const { findByText, getByText, getAllByText } = render(<CustomerExtractionLearning customerId="c1" />);
    expect(await findByText(/3200231847/)).toBeTruthy();       // PO number
    expect(getAllByText(/TNA-16-04-10-2/).length).toBeGreaterThan(0); // our part (extracted + mapped)
    expect(getByText(/A12060OBAR010003/)).toBeTruthy();        // buyer SAP chip
    expect(getByText(/customer_part/)).toBeTruthy();           // mapped via
  });

  it("shows the learned customer-code -> our-part map", async () => {
    const { findByText } = render(<CustomerExtractionLearning customerId="c1" />);
    expect(await findByText(/A44146OBAR010001/)).toBeTruthy();
  });

  it("degrades gracefully when the customer has no extracted PO", async () => {
    (global as any).fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any);
    const { findByText } = render(<CustomerExtractionLearning customerId="c2" />);
    expect(await findByText(/No extracted PO on file/i)).toBeTruthy();
  });
});
