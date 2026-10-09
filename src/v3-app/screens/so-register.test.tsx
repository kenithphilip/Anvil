// The sales-order register screen: renders the server's rows and sends every
// filter, and the page, to GET /api/orders/register. Invented fixtures.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const C1 = "c1111111-1111-4111-8111-111111111111";

const ROWS = [
  {
    id: "o1", received_at: "2026-10-01T05:00:00.000Z", channel: "email", customer_id: C1,
    customer_name: "Acme Test Works", po_number: "PO-T-001", po_date: "2026-09-30",
    value: 1000, currency: "INR", line_count: 2,
    extraction: { status: "ok", confidence: 0.92, run_id: "r1" },
    reconciliation: { analysed: true, matched: 1, total: 2, line_flags: 1, terms_flags: 2 },
    status: "APPROVED", erp_so: { attached: true, voucher_no: "SO-77" }, handoff: { status: "not_sent" },
  },
  {
    id: "o2", received_at: "2026-10-03T05:00:00.000Z", channel: "whatsapp", customer_id: null,
    customer_name: null, po_number: "PO-T-002", po_date: null, value: null, currency: null, line_count: 0,
    extraction: { status: "not_extracted", confidence: null, run_id: null },
    reconciliation: { analysed: false },
    status: "DRAFT", erp_so: { attached: false, voucher_no: null }, handoff: { status: "not_sent" },
  },
];

let register: any;

const mount = async () => {
  register = vi.fn(async (params: any) => ({
    rows: ROWS, page: params.page, page_size: 50, total: 120, has_more: params.page < 3,
    channels: ["upload", "email", "whatsapp", "chat", "voice", "quote", "portal"],
  }));
  installBackend({
    orders: { register },
    customers: { list: vi.fn(async () => ({ customers: [{ id: C1, customer_name: "Acme Test Works" }] })) },
  });
  installRbac("sales_engineer");
  const mod = await import("./so-register");
  const utils = renderScreen(mod.default);
  await waitFor(() => expect(utils.container.textContent).toContain("PO-T-001"));
  return utils;
};

const lastParams = () => register.mock.calls[register.mock.calls.length - 1][0];

beforeEach(() => { vi.stubGlobal("confirm", () => true); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("SO register: rows", () => {
  it("renders one row per order with every register column", async () => {
    const { container } = await mount();
    const rows = Array.from(container.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(2);
    const first = rows[0].textContent || "";
    for (const text of ["Email", "Acme Test Works", "PO-T-001", "read", "92%", "1/2 matched", "1 line flag", "2 terms flags", "approval", "SO-77", "not sent"]) {
      expect(first).toContain(text);
    }
    const second = rows[1].textContent || "";
    for (const text of ["WhatsApp", "PO-T-002", "not extracted", "not analysed", "intake", "none", "not sent"]) {
      expect(second).toContain(text);
    }
    expect(container.textContent).toContain("120 orders");
    expect(container.textContent).toContain("Page 1 of 3");
  });

  it("asks the server for page 1 with no filters", async () => {
    await mount();
    expect(register).toHaveBeenCalledTimes(1);
    expect(lastParams()).toEqual({
      page: 1, page_size: 50, from: "", to: "", customer: "", channel: "", status: "", has_flags: "",
    });
  });
});

describe("SO register: filters and paging", () => {
  it("sends the channel, customer and status filters", async () => {
    const { getByLabelText } = await mount();
    await waitFor(() => expect((getByLabelText("Filter by customer") as HTMLSelectElement).options.length).toBe(2));
    fireEvent.change(getByLabelText("Filter by channel"), { target: { value: "whatsapp" } });
    await waitFor(() => expect(lastParams().channel).toBe("whatsapp"));
    fireEvent.change(getByLabelText("Filter by customer"), { target: { value: C1 } });
    await waitFor(() => expect(lastParams().customer).toBe(C1));
    fireEvent.change(getByLabelText("Filter by status"), { target: { value: "APPROVED" } });
    await waitFor(() => expect(lastParams()).toMatchObject({ channel: "whatsapp", customer: C1, status: "APPROVED", page: 1 }));
  });

  it("sends has_flags and the received-date range as local-day bounds", async () => {
    const { getByLabelText } = await mount();
    fireEvent.click(getByLabelText("Only orders with reconciliation flags"));
    await waitFor(() => expect(lastParams().has_flags).toBe("1"));
    fireEvent.change(getByLabelText("Received from"), { target: { value: "2026-10-01" } });
    fireEvent.change(getByLabelText("Received to"), { target: { value: "2026-10-05" } });
    await waitFor(() => expect(lastParams().to).not.toBe(""));
    expect(lastParams().from).toBe(new Date(2026, 9, 1).toISOString());
    // `to` is exclusive on the server: the day after, at local midnight.
    expect(lastParams().to).toBe(new Date(2026, 9, 6).toISOString());
  });

  it("pages forward, and a filter change starts again at page 1", async () => {
    const { getByText, getByLabelText } = await mount();
    fireEvent.click(getByText("Next"));
    await waitFor(() => expect(lastParams().page).toBe(2));
    fireEvent.change(getByLabelText("Filter by status"), { target: { value: "DRAFT" } });
    await waitFor(() => expect(lastParams()).toMatchObject({ status: "DRAFT", page: 1 }));
  });

  it("shows the server's error instead of an empty register", async () => {
    installBackend({ orders: { register: vi.fn(async () => { throw new Error("status must be one of DRAFT"); }) } });
    const mod = await import("./so-register");
    const { container } = renderScreen(mod.default);
    await waitFor(() => expect(container.textContent).toContain("Could not load the register"));
    expect(container.textContent).toContain("status must be one of DRAFT");
  });
});

describe("SO register: reachable", () => {
  it("is the #/so?view=register route, distinct from the list and the pending view", async () => {
    const { RESOLVERS } = await import("../routes");
    const so = (q: string) => (RESOLVERS as any).so({ params: new URLSearchParams(q) });
    const register = so("view=register");
    expect(register).toBeTruthy();
    expect(register).not.toBe(so(""));
    expect(register).not.toBe(so("view=pending"));
  });
});
