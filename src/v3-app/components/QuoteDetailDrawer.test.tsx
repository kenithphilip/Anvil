// Tests for the line-editor enrichment: the source-country column is
// editable, and the item-master picker appends a line prefilled from
// the catalogue (part_no, HSN, source country, tax rates).

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor, fireEvent, within } from "@testing-library/react";
import { QuoteDetailDrawer } from "./QuoteDetailDrawer";

const ITEMS = [
  {
    id: "it-1",
    part_no: "BR-6204-ZZ",
    description: "Deep groove ball bearing",
    uom: "NO",
    hsn_sac: "8482",
    source_country: "O-JAPAN",
    purchase_price: 145,
    cgst_rate: 0.09,
    sgst_rate: 0.09,
    igst_rate: 0,
  },
];

let transitionSpy: any;

beforeEach(() => {
  // The drawer loads quote_lines + document_templates via its local
  // fetchJson helper (global fetch). The item picker uses the
  // ObaraBackend.admin.listItemMaster facade.
  transitionSpy = vi.fn(async (id: string, status: string) => ({ quote: { id, status } }));
  (window as any).ObaraBackend = (window as any).AnvilBackend = {
    getConfig: () => ({ url: "https://api.test", tenantId: "t-1" }),
    getSession: () => ({ access_token: "x" }),
    admin: { listItemMaster: vi.fn(async () => ({ items: ITEMS })) },
    customers: {
      listContacts: vi.fn(async () => ({ contacts: [
        { id: "ct-1", name: "Asha Rao", email: "asha@x.example", is_primary: true, role: "procurement" },
        { id: "ct-2", name: "Vikram Shah", email: "vikram@x.example", is_primary: false, role: "accounts" },
      ] })),
    },
    quotes: {
      transition: transitionSpy,
      sendQuote: vi.fn(async (id: string) => ({ ok: true, quote: { id, status: "SENT" } })),
      revise: vi.fn(async (id: string) => ({ quote: { id, status: "DRAFT", version: 2 } })),
      convertToOrder: vi.fn(async () => ({ ok: true })),
      cancel: vi.fn(async (id: string) => ({ quote: { id, status: "CANCELLED" } })),
    },
  };
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    let body: any = {};
    if (u.includes("/api/admin/quote_lines")) body = { lines: [] };
    else if (u.includes("/api/admin/document_templates")) body = { templates: [] };
    return { ok: true, json: async () => body, text: async () => "" } as any;
  }) as any;
});

const QUOTE = { id: "q-1", quote_number: "Q-202605-0001", version: 1, status: "DRAFT", currency: "INR" };

describe("QuoteDetailDrawer — line enrichment", () => {
  it("renders an editable source-country column once a line exists", async () => {
    const { getByText, getByRole, getAllByText } = render(
      <QuoteDetailDrawer quote={QUOTE} onClose={() => undefined} />
    );
    fireEvent.click(getByText("Lines"));
    // The lines table (and its column headers) only render once there
    // is at least one line; add a blank line first. Target the button
    // by role since the empty-state copy also mentions "Add line".
    fireEvent.click(getByRole("button", { name: "Add line" }));
    await waitFor(() => expect(getAllByText("Src").length).toBeGreaterThan(0));
  });

  it("appends a line prefilled from an item-master pick", async () => {
    const { getByText, getByPlaceholderText, container } = render(
      <QuoteDetailDrawer quote={QUOTE} onClose={() => undefined} />
    );
    fireEvent.click(getByText("Lines"));
    fireEvent.click(getByText("From item master"));
    // The picker loads items via the facade and lists the catalogue row.
    await waitFor(() => expect(getByPlaceholderText("search part number or description...")).toBeTruthy());
    await waitFor(() => expect(getByText("Deep groove ball bearing")).toBeTruthy());
    // Click the row's Add button (inside the picker card).
    const addButtons = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent === "Add");
    expect(addButtons.length).toBeGreaterThan(0);
    fireEvent.click(addButtons[0]);
    // A line row now carries the catalogue part number and source country.
    await waitFor(() => {
      const partInput = container.querySelector('input[value="BR-6204-ZZ"]') as HTMLInputElement;
      expect(partInput).toBeTruthy();
    });
    const srcInput = container.querySelector('input[value="O-JAPAN"]') as HTMLInputElement;
    expect(srcInput).toBeTruthy();
  });

  it("exposes a Composition tab with the cost-preview surface", async () => {
    const { getByText } = render(<QuoteDetailDrawer quote={QUOTE} onClose={() => undefined} />);
    fireEvent.click(getByText("Composition"));
    // With no lines loaded, the preview shows its empty state.
    await waitFor(() => expect(getByText(/No lines to price yet/i)).toBeTruthy());
  });

  it("shows DRAFT lifecycle actions", async () => {
    const { getByText } = render(<QuoteDetailDrawer quote={QUOTE} onClose={() => undefined} />);
    expect(getByText("Send to customer")).toBeTruthy();
    expect(getByText("Request approval")).toBeTruthy();
    expect(getByText("Cancel quote")).toBeTruthy();
  });

  it("transitions a SENT quote to ACCEPTED via the lifecycle bar", async () => {
    const sent = { ...QUOTE, status: "SENT" };
    const { getByText } = render(<QuoteDetailDrawer quote={sent} onClose={() => undefined} />);
    fireEvent.click(getByText("Mark accepted"));
    await waitFor(() => expect(transitionSpy).toHaveBeenCalledWith("q-1", "ACCEPTED"));
  });

  it("offers Revise on a SENT quote and Convert on an ACCEPTED quote", () => {
    const sent = render(<QuoteDetailDrawer quote={{ ...QUOTE, status: "SENT" }} onClose={() => undefined} />);
    expect(sent.getByText("Revise")).toBeTruthy();
    sent.unmount();
    const accepted = render(<QuoteDetailDrawer quote={{ ...QUOTE, status: "ACCEPTED" }} onClose={() => undefined} />);
    expect(accepted.getByText("Convert to order")).toBeTruthy();
  });

  it("renders the contact picker in the Header tab seeded from the quote", async () => {
    const q = { ...QUOTE, customer_id: "cust-1", customer_contact_id: "ct-2" };
    const { getByLabelText } = render(<QuoteDetailDrawer quote={q} onClose={() => undefined} />);
    await waitFor(() => expect((getByLabelText("Contact") as HTMLSelectElement).value).toBe("ct-2"));
  });

  it("includes customer_contact_id in the Save header PATCH payload", async () => {
    const q = { ...QUOTE, customer_id: "cust-1", customer_contact_id: "ct-1" };
    const { getByLabelText, getByText } = render(<QuoteDetailDrawer quote={q} onClose={() => undefined} />);
    await waitFor(() => expect((getByLabelText("Contact") as HTMLSelectElement).value).toBe("ct-1"));
    fireEvent.change(getByLabelText("Contact"), { target: { value: "ct-2" } });
    fireEvent.click(getByText("Save header"));
    // Find the PATCH call to /api/quotes/q-1 and assert the body.
    await waitFor(() => {
      const patchCall = (global.fetch as any).mock.calls.find(
        ([url, init]: any[]) => String(url).includes("/api/quotes/q-1") && init?.method === "PATCH"
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall[1].body);
      expect(body.customer_contact_id).toBe("ct-2");
    });
  });
});
