// Read-only audit-timeline rendering. Stubs AnvilBackend.audit.list and
// asserts the right human labels + detail formatting for representative
// event types (create, auto-fill, status change, send).

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { QuoteHistoryTab } from "./QuoteHistoryTab";

const EVENTS = [
  { id: "e1", action: "quote_create", created_at: new Date().toISOString(), detail: "Q-1 :: 0 INR" },
  { id: "e2", action: "quote_auto_populate", created_at: new Date().toISOString(),
    after: { auto_filled: { currency: "customer.currency", validity_days: "customer.default_quote_validity_days" } } },
  { id: "e3", action: "quote_update", created_at: new Date().toISOString(),
    before: { status: "DRAFT" }, after: { status: "SENT" } },
  { id: "e4", action: "quote_send", created_at: new Date().toISOString(), detail: "ops@customer.example :: v1" },
];

describe("QuoteHistoryTab", () => {
  beforeEach(() => {
    installBackend({
      audit: { list: vi.fn(async () => ({ events: EVENTS })) },
    });
  });

  it("renders a row per event with the right action label", async () => {
    const { findByText, getByText } = render(<QuoteHistoryTab quoteId="q-1" />);
    expect(await findByText("Created")).toBeTruthy();
    expect(getByText("Auto-filled")).toBeTruthy();
    expect(getByText("Updated header")).toBeTruthy();
    expect(getByText("Sent to customer")).toBeTruthy();
  });

  it("formats auto_filled detail as 'field < source' pairs", async () => {
    const { findByText } = render(<QuoteHistoryTab quoteId="q-1" />);
    // The auto_populate row joins entries with ", ".
    const text = (await findByText(/currency < customer\.currency/)).textContent || "";
    expect(text).toContain("currency < customer.currency");
    expect(text).toContain("validity_days < customer.default_quote_validity_days");
  });

  it("formats status updates as 'before > after'", async () => {
    const { findByText } = render(<QuoteHistoryTab quoteId="q-1" />);
    expect(await findByText(/DRAFT > SENT/)).toBeTruthy();
  });

  it("shows an empty-state when there are no events", async () => {
    installBackend({ audit: { list: vi.fn(async () => ({ events: [] })) } });
    const { findByText } = render(<QuoteHistoryTab quoteId="q-1" />);
    expect(await findByText(/No history yet/i)).toBeTruthy();
  });
});
