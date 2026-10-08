// Recording a supplier ack from the Source POs screen always failed with 400.
//
// The screen called ack({ sourcePoId, ack }) but the client is
// ack(sourcePoId, ack), so the POST body carried no `ack` at all. And the
// fields were acked_unit_price / acked_eta_date, which /api/source_pos/ack
// never reads (it reads confirmedPrice / confirmedEta).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

// test-setup.ts ran the client IIFE before this file loaded, so this is the
// real client, captured before installBackend swaps in a stub.
const realClient = (window as any).AnvilBackend;

const SENT = {
  id: "spo-1",
  tenant_id: "t-1",
  reference: "SPO-REF-1",
  supplier: "Acme Robotics",
  country: "DE",
  currency: "EUR",
  total_foreign: 1000,
  acknowledged_eta: "2026-11-01",
  status: "SENT_TO_SUPPLIER",
};
const ACKED = { ...SENT, status: "SUPPLIER_ACK", acknowledged_price: 1000, acknowledged_eta: "2026-11-03" };

let rows: any[];
let ackSpy: any;
let listSpy: any;

const install = () => {
  installBackend({
    sourcePos: {
      list: listSpy,
      scorecard: vi.fn(async () => ({ scorecards: [] })),
      ack: ackSpy,
    },
  });
};

beforeEach(() => {
  rows = [SENT];
  listSpy = vi.fn(async () => ({ sourcePos: rows }));
  ackSpy = vi.fn(async () => {
    rows = [ACKED];
    return { status: "SUPPLIER_ACK" };
  });
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
  install();
  installRbac("procurement");
  window.location.hash = "#/spo";
});

afterEach(() => {
  vi.unstubAllGlobals();
  try { realClient.setConfig(null); } catch { /* not configured */ }
});

const openAckForm = async () => {
  const mod = await import("./source-pos");
  renderScreen(mod.default);
  const row = await screen.findByRole("row", { name: "Open ack for SPO-REF-1" });
  await act(async () => { fireEvent.click(row); });
  await screen.findByText("Record ack · SPO-REF-1");
};

const submit = async () => {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit ack" })); });
};

describe("Source POs: record a supplier ack", () => {
  it("prefills the form from the PO's own columns", async () => {
    await openAckForm();
    expect((screen.getByLabelText("Acked PO total (EUR)") as HTMLInputElement).value).toBe("1000");
    expect((screen.getByLabelText("Acked ETA") as HTMLInputElement).value).toBe("2026-11-01");
  });

  it("calls the client as ack(sourcePoId, ack) in the API's field names, and refreshes the row", async () => {
    await openAckForm();
    fireEvent.change(screen.getByLabelText("Acked ETA"), { target: { value: "2026-11-03" } });
    fireEvent.change(screen.getByLabelText("Supplier ref"), { target: { value: "ACK-77" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "confirmed by mail" } });
    await submit();

    expect(ackSpy).toHaveBeenCalledTimes(1);
    expect(ackSpy).toHaveBeenCalledWith("spo-1", {
      confirmedPrice: 1000,
      confirmedEta: "2026-11-03",
      supplierRef: "ACK-77",
      remarks: "confirmed by mail",
    });

    // The list reloads. An acked PO leaves "Open" for "In transit", and
    // its row there shows what the ack wrote.
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Record ack · SPO-REF-1")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("row", { name: "Open ack for SPO-REF-1" })).toBeNull());
    const transitTab = screen.getAllByRole("tab").find((t) => (t.textContent || "").includes("In transit")) as HTMLElement;
    await act(async () => { fireEvent.click(transitTab); });
    const row = await screen.findByRole("row", { name: "Open ack for SPO-REF-1" });
    expect(row.textContent).toContain("acked");
    expect(row.textContent).toContain("03 Nov");
  });

  it("puts the request the API expects on the wire", async () => {
    // The real client, so the body is what /api/source_pos/ack reads.
    realClient.setConfig({ url: "https://api.test", tenantId: "t-1" });
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: "SUPPLIER_ACK" }) }));
    vi.stubGlobal("fetch", fetchSpy);
    ackSpy = vi.fn((id: string, ack: unknown) => realClient.sourcePos.ack(id, ack));
    install();

    await openAckForm();
    await submit();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe("https://api.test/api/source_pos/ack");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      sourcePoId: "spo-1",
      ack: { confirmedPrice: 1000, confirmedEta: "2026-11-01", supplierRef: null, remarks: null },
    });
  });

  it("shows the API's own error message when the ack fails", async () => {
    realClient.setConfig({ url: "https://api.test", tenantId: "t-1" });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { message: "Source PO not found" } }),
    })));
    ackSpy = vi.fn((id: string, ack: unknown) => realClient.sourcePos.ack(id, ack));
    install();

    await openAckForm();
    await submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Source PO not found");
    // The form stays open so the operator can correct and resend.
    expect(screen.getByText("Record ack · SPO-REF-1")).toBeTruthy();
    expect((window as any).notifyError).toHaveBeenCalledWith("Ack failed", "Source PO not found");
  });
});
