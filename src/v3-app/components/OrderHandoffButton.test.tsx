// The SO workspace's "Send to order processing" button: hidden unless the
// tenant has the handoff on and the user may send it; the status chip; the
// blockers the server returns; and "Send again" needs a confirm. Invented
// fixtures; every address is example.com.

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac } from "../test-utils";
import { OrderHandoffButton, handoffChip } from "./OrderHandoffButton";

const ORDER = "a0000000-0000-4000-8000-000000000001";

const preview = (handoff: any = { status: "not_sent" }, blockers: any[] = []) => ({
  enabled: true,
  order_id: ORDER,
  handoff,
  prefill: { required_by: { value: "2026-10-30", source: "po_header" }, committed: null, contact: { name: "Buyer Desk", phone: "", source: "po_buyer" } },
  fields: { required_by: "2026-10-30", required_by_source: "po_header", contact_name: "Buyer Desk", contact_phone: "", contact_source: "po_buyer", modes: { import: "ocean" } },
  groups: [{ group: "import", country: "KR", line_nos: [1], allowed_modes: ["ocean", "air"], default_mode: "ocean" }],
  modes: { ocean: "By Ocean", air: "By Air" },
  recipients: { to: [{ email: "orders-desk@example.com", reason: "listed address" }], cc: [{ email: "eng@example.com", reason: "sending engineer" }], reply_to: "eng@example.com", dropped: [] },
  subject: "SO entry: PO PO-T-100 / Test Buyer Ltd / 1 line",
  body: "Order processing team,",
  attachments: [{ label: "SO PDF" }],
  blockers,
});

const mount = (handoff: any, extra: any = {}, role = "sales_engineer") => {
  const handoffSend = vi.fn(async (..._args: any[]) => ({ ok: true, status: "sent", message: "Sent to the order processing team." }));
  const get = vi.fn(async () => preview(handoff));
  installBackend({ orders: { handoff: get, handoffSend, ...extra } });
  installRbac(role);
  const utils = render(<OrderHandoffButton orderId={ORDER} />);
  return { ...utils, handoffSend, get };
};

describe("OrderHandoffButton", () => {
  it("renders nothing when the tenant has the handoff off", async () => {
    installBackend({ orders: { handoff: vi.fn(async () => ({ enabled: false, reason: "off" })) } });
    installRbac("sales_engineer");
    const { container } = render(<OrderHandoffButton orderId={ORDER} />);
    await waitFor(() => expect((window as any).AnvilBackend.orders.handoff).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("renders nothing, and asks nothing, for a role without order.handoff", async () => {
    const { container, get } = mount({ status: "not_sent" }, {}, "finance");
    await new Promise((r) => setTimeout(r, 0));
    expect(get).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("sends the edited fields from the modal", async () => {
    const { getByText, getByLabelText, handoffSend } = mount({ status: "not_sent" });
    await waitFor(() => getByText("Send to order processing"));
    fireEvent.click(getByText("Send to order processing"));
    await waitFor(() => getByLabelText("Contact phone"));
    fireEvent.change(getByLabelText("Contact phone"), { target: { value: "+91 00000 33333" } });
    fireEvent.click(getByText("Send"));
    await waitFor(() => expect(handoffSend).toHaveBeenCalledTimes(1));
    expect(handoffSend.mock.calls[0]).toEqual([ORDER, expect.objectContaining({ contact_phone: "+91 00000 33333", modes: { import: "ocean" } }), false]);
  });

  it("changed since handoff: the chip says so, and re-send needs a confirm", async () => {
    const { getByText, getByTestId, handoffSend } = mount({ status: "sent", sent_at: "2026-10-10T05:00:00.000Z", changed_since: true });
    await waitFor(() => getByText("Re-send handoff"));
    expect(getByTestId("handoff-chip").textContent).toContain("Changed since handoff");
    fireEvent.click(getByText("Re-send handoff"));
    await waitFor(() => getByText("Send again"));
    fireEvent.click(getByText("Send again"));
    expect(handoffSend).not.toHaveBeenCalled();
    fireEvent.click(getByText("Confirm: send again"));
    await waitFor(() => expect(handoffSend).toHaveBeenCalledTimes(1));
    expect(handoffSend.mock.calls[0][2]).toBe(true);
  });

  it("shows the blockers the server returns on send", async () => {
    const err: any = new Error("blocked");
    err.body = { error: { code: "TERMS_UNDECIDED", message: "x", blockers: [{ code: "terms_undecided", message: "1 critical terms flag needs a decision first: Payment terms." }] } };
    const { getByText, findByText } = mount({ status: "not_sent" }, { handoffSend: vi.fn(async () => { throw err; }) });
    await waitFor(() => getByText("Send to order processing"));
    fireEvent.click(getByText("Send to order processing"));
    await waitFor(() => getByText("Send"));
    fireEvent.click(getByText("Send"));
    expect(await findByText("1 critical terms flag needs a decision first: Payment terms.")).toBeTruthy();
  });

  it("the chip words, for the register too", () => {
    expect(handoffChip({ status: "not_sent" }).label).toBe("not sent");
    expect(handoffChip({ status: "not_configured" }).label).toBe("Not sent: no mail provider");
    expect(handoffChip({ status: "failed" }).label).toBe("Handoff failed");
    expect(handoffChip({ status: "sent", sent_at: null, sent_by_name: "Test Engineer" }).label).toBe("Sent by Test Engineer");
  });
});
