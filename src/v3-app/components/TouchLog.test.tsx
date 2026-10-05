// TouchLog: the Follow-up timeline + "Log a touch" form shared by the quote
// drawer and the opportunity detail. Renders the real component against a
// stubbed AnvilBackend and asserts what it sends.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { TouchLog, defaultNextFollowup } from "./TouchLog";

let listSpy: any;
let logSpy: any;
let listContactsSpy: any;
let rows: any[];

beforeEach(() => {
  // Only Date is faked: Friday 2 Oct 2026, 10:00 local. Plus 3 business days
  // skips the weekend and lands on Wednesday 7 Oct.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 2, 10, 0, 0));
  rows = [];
  listSpy = vi.fn(async () => ({ communications: rows }));
  logSpy = vi.fn(async (p: any) => ({ communication: { id: "new", ...p } }));
  listContactsSpy = vi.fn(async () => ({ contacts: [
    { id: "ct-1", name: "Asha Rao", role: "procurement" },
    { id: "ct-2", name: "Vikram Shah", role: "maintenance" },
  ] }));
  (window as any).AnvilBackend = {
    communications: { list: listSpy, log: logSpy },
    customers: { listContacts: listContactsSpy },
  };
});
afterEach(() => { vi.useRealTimers(); });

const typeNotes = (getByLabelText: any, text: string) =>
  fireEvent.change(getByLabelText("Touch notes"), { target: { value: text } });

describe("defaultNextFollowup", () => {
  it("is today plus 3 business days, skipping the weekend", () => {
    expect(defaultNextFollowup(new Date(2026, 9, 2, 10))).toBe("2026-10-07");   // Fri -> Wed
    expect(defaultNextFollowup(new Date(2026, 9, 5, 10))).toBe("2026-10-08");   // Mon -> Thu
  });
});

describe("TouchLog", () => {
  it("logs a call on a quote with the default next date of today plus 3 business days", async () => {
    const { getByLabelText, getByRole } = render(<TouchLog objectType="quote" objectId="q-1" />);
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ object_type: "quote", object_id: "q-1" }));
    expect((getByLabelText("Touch channel") as HTMLSelectElement).value).toBe("call");
    expect((getByLabelText("Next follow-up") as HTMLInputElement).value).toBe("2026-10-07");

    typeNotes(getByLabelText, "Spoke to maintenance");
    fireEvent.click(getByRole("button", { name: "Log touch" }));

    await waitFor(() => expect(logSpy).toHaveBeenCalledTimes(1));
    expect(logSpy).toHaveBeenCalledWith({
      object_type: "quote",
      object_id: "q-1",
      channel: "call",
      body: "Spoke to maintenance",
      metadata: { next_followup_at: "2026-10-07" },
    });
    // The timeline reloads so the new touch shows.
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
  });

  it("prefills the last channel used and the quote's own contact", async () => {
    rows = [
      { id: "t-old", document_type: "rep_touch", channel: "visit", customer_contact_id: "ct-2", body: "Site visit", created_at: "2026-09-20T10:00:00Z" },
      { id: "t-new", document_type: "rep_touch", channel: "whatsapp", customer_contact_id: "ct-2", body: "Sent drawings", created_at: "2026-09-28T10:00:00Z" },
      // Newer than both touches, but an email is not a touch channel.
      { id: "e-1", document_type: "quote_email", channel: "email", subject: "Quotation Q-1", created_at: "2026-09-30T10:00:00Z", status: "sent" },
    ];
    const { getByLabelText, getByRole } = render(
      <TouchLog objectType="quote" objectId="q-1" customerId="c-1" contactId="ct-1" />
    );
    await waitFor(() => expect((getByLabelText("Touch channel") as HTMLSelectElement).value).toBe("whatsapp"));
    await waitFor(() => expect(listContactsSpy).toHaveBeenCalledWith({ customer_id: "c-1" }));
    expect((getByLabelText("Touch contact") as HTMLSelectElement).value).toBe("ct-1");

    typeNotes(getByLabelText, "Chased the PO");
    fireEvent.click(getByRole("button", { name: "Log touch" }));
    await waitFor(() => expect(logSpy).toHaveBeenCalledTimes(1));
    expect(logSpy.mock.calls[0][0]).toEqual({
      object_type: "quote", object_id: "q-1", channel: "whatsapp", body: "Chased the PO",
      customer_contact_id: "ct-1", metadata: { next_followup_at: "2026-10-07" },
    });
  });

  it("falls back to the last touch's contact when the object has none (an opportunity)", async () => {
    rows = [{ id: "t-1", document_type: "rep_touch", channel: "meeting", customer_contact_id: "ct-2", body: "Review", created_at: "2026-09-28T10:00:00Z" }];
    const { getByLabelText, getByRole } = render(<TouchLog objectType="opportunity" objectId="o-1" customerId="c-1" />);
    await waitFor(() => expect((getByLabelText("Touch contact") as HTMLSelectElement).value).toBe("ct-2"));
    fireEvent.change(getByLabelText("Next follow-up"), { target: { value: "2026-10-12" } });
    typeNotes(getByLabelText, "Budget confirmed");
    fireEvent.click(getByRole("button", { name: "Log touch" }));
    await waitFor(() => expect(logSpy).toHaveBeenCalledTimes(1));
    expect(logSpy.mock.calls[0][0]).toEqual({
      object_type: "opportunity", object_id: "o-1", channel: "meeting", body: "Budget confirmed",
      customer_contact_id: "ct-2", metadata: { next_followup_at: "2026-10-12" },
    });
  });

  it("lists touches and emails newest first, with the next follow-up date", async () => {
    rows = [
      { id: "t-old", document_type: "rep_touch", channel: "visit", body: "Site visit notes", created_at: "2026-09-20T10:00:00Z" },
      { id: "e-1", document_type: "quote_email", channel: "email", subject: "Quotation Q-1", status: "queued", created_at: "2026-09-30T10:00:00Z" },
      { id: "t-new", document_type: "rep_touch", channel: "call", body: "Called stores", next_followup_at: "2026-10-07", created_at: "2026-09-28T10:00:00Z" },
    ];
    const { findByRole } = render(<TouchLog objectType="quote" objectId="q-1" />);
    const list = await findByRole("list", { name: "Follow-up timeline" });
    const items = Array.from(list.querySelectorAll("li")).map((li) => li.textContent || "");
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("Quotation Q-1");
    expect(items[0]).toContain("queued");
    expect(items[1]).toContain("Called stores");
    expect(items[1]).toContain("next follow-up");
    expect(items[2]).toContain("Site visit notes");
  });

  it("does not post an empty note", async () => {
    const { getByRole } = render(<TouchLog objectType="quote" objectId="q-1" />);
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect((getByRole("button", { name: "Log touch" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's refusal", async () => {
    logSpy.mockRejectedValueOnce(new Error("quote not found"));
    const { getByLabelText, getByRole, findByText } = render(<TouchLog objectType="quote" objectId="q-1" />);
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    typeNotes(getByLabelText, "Spoke to maintenance");
    fireEvent.click(getByRole("button", { name: "Log touch" }));
    expect(await findByText("quote not found")).toBeTruthy();
  });
});
