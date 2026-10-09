// The opportunity detail card mounts the same TouchLog as the quote drawer's
// Follow-up tab, filed against the OPPORTUNITY (object_type 'opportunity').

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

let listSpy: any;
let logSpy: any;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 2, 10, 0, 0));   // Fri 2 Oct; +3 business days = Wed 7 Oct
  listSpy = vi.fn(async () => ({ communications: [] }));
  logSpy = vi.fn(async (p: any) => ({ communication: { id: "new", ...p } }));
  installBackend({
    sales: {
      listOpportunities: async () => ({ opportunities: [
        { id: "o-1", opportunity_name: "Line 4 retrofit", customer_id: "c-1", customer_name: "Fixture Axle Works", stage: "RFQ", amount_inr: 100000, owner_id: null, owner_name: null, probability: 50 },
      ] }),
    },
    customers: { listContacts: async () => ({ contacts: [{ id: "ct-9", name: "Meera Iyer" }] }) },
    communications: { list: listSpy, log: logSpy },
  });
  installRbac("admin");
  window.location.hash = "#/opps?id=o-1";
});
afterEach(() => {
  vi.useRealTimers();
  window.location.hash = "";
});

describe("Opps detail: touch log", () => {
  it("lists and logs touches against the selected opportunity", async () => {
    const { default: Opps } = await import("./opps");
    const { findByLabelText, getByRole } = renderScreen(Opps);
    const notes = await findByLabelText("Touch notes");
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ object_type: "opportunity", object_id: "o-1" }));
    // The opportunity's customer reaches TouchLog: its contacts load into an
    // enabled picker (without a customer id the picker is disabled and empty).
    const picker = (await findByLabelText("Touch contact")) as HTMLSelectElement;
    await waitFor(() => expect(picker.textContent).toContain("Meera Iyer"));
    expect(picker.disabled).toBe(false);

    fireEvent.change(notes, { target: { value: "Budget confirmed by plant head" } });
    fireEvent.click(getByRole("button", { name: "Log touch" }));
    await waitFor(() => expect(logSpy).toHaveBeenCalledTimes(1));
    expect(logSpy).toHaveBeenCalledWith({
      object_type: "opportunity", object_id: "o-1", channel: "call",
      body: "Budget confirmed by plant head", metadata: { next_followup_at: "2026-10-07" },
    });
  });
});
