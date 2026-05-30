// Tests for the Quotes panel on the opportunity detail card. Stubs
// quotes.list and asserts the panel renders rows + calls the API with
// the right opportunity_id filter.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { OpportunityQuotesPanel } from "./OpportunityQuotesPanel";

const QUOTES = [
  { id: "q1", quote_number: "Q-202605-0001", version: 1, status: "DRAFT", grand_total: 5000, expires_at: null, updated_at: new Date().toISOString() },
  { id: "q2", quote_number: "Q-202605-0002", version: 2, status: "SENT", grand_total: 7500, expires_at: new Date().toISOString(), updated_at: new Date().toISOString() },
];

describe("OpportunityQuotesPanel", () => {
  let listSpy: any;
  beforeEach(() => {
    listSpy = vi.fn(async () => ({ quotes: QUOTES }));
    installBackend({ quotes: { list: listSpy } });
  });

  it("calls quotes.list with the opportunity_id filter", async () => {
    render(<OpportunityQuotesPanel opportunityId="OPP-1" />);
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));
    expect(listSpy.mock.calls[0][0]).toMatchObject({ opportunity_id: "OPP-1" });
  });

  it("renders a row per quote with status + number", async () => {
    const { findByText, getByText } = render(<OpportunityQuotesPanel opportunityId="OPP-1" />);
    expect(await findByText("Q-202605-0001")).toBeTruthy();
    expect(getByText("Q-202605-0002")).toBeTruthy();
    expect(getByText("DRAFT")).toBeTruthy();
    expect(getByText("SENT")).toBeTruthy();
  });

  it("shows the empty-state when there are no quotes for the opp", async () => {
    installBackend({ quotes: { list: vi.fn(async () => ({ quotes: [] })) } });
    const { findByText } = render(<OpportunityQuotesPanel opportunityId="OPP-1" />);
    expect(await findByText(/No quotes yet/i)).toBeTruthy();
  });
});
