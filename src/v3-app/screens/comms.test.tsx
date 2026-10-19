// Communications screen: a smoke render, plus the list's rows and statuses.
// Started as the generated smoke test for screens/comms.tsx and extended by
// hand.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  // jsdom's confirm/alert/prompt are no-ops by default; stub them so
  // accidental click handlers can't pop dialogs during a smoke render.
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

// The list reads GET /api/communications through the API client and shows
// the status each row has on the server. It used to read the audit log with a
// bare fetch (no session, so refused) and action names nothing writes, so it
// was always empty. Invented fixtures.
const ROWS = [
  { id: "c-sent-0001", channel: "email", to_addr: "buyer@acme.test", subject: "Quotation Q-1", status: "sent", order_id: null, created_at: "2026-10-16T10:00:00Z" },
  { id: "c-fail-0002", channel: "email", to_addr: "ap@bolt.test", subject: "Invoice INV-9", status: "failed", order_id: null, created_at: "2026-10-16T09:00:00Z" },
  { id: "c-queu-0003", channel: "email", to_addr: "ops@core.test", subject: "Dispatch register", status: "queued", order_id: "ord-1", created_at: "2026-10-16T08:00:00Z" },
  { id: "c-drft-0004", channel: "email", to_addr: "qa@delta.test", subject: "Missing doc", status: "draft", order_id: null, created_at: "2026-10-16T07:00:00Z" },
];
const bodyRows = (c: HTMLElement) => Array.from(c.querySelectorAll("tbody tr")).map((tr) => {
  const td = tr.querySelectorAll("td");
  return { recipient: td[3]?.textContent, status: td[5]?.textContent };
});

describe("Comms list: real rows and real status", () => {
  it("reads the communications through the API client and shows each row's stored status", async () => {
    const list = vi.fn(async () => ({ communications: ROWS }));
    installBackend({ communications: { list } });
    const mod = await import("./comms");
    const { container } = renderScreen(mod.default);
    await waitFor(() => expect(bodyRows(container)).toHaveLength(4));
    expect(list).toHaveBeenCalledWith({ limit: 200 });
    expect(bodyRows(container)).toEqual([
      { recipient: "buyer@acme.test", status: "sent" },
      { recipient: "ap@bolt.test", status: "failed" },
      { recipient: "ops@core.test", status: "queued" },
      { recipient: "qa@delta.test", status: "draft" },
    ]);
  });

  it("the Sent tab shows only what a provider accepted, never a failed or queued row", async () => {
    installBackend({ communications: { list: vi.fn(async () => ({ communications: ROWS })) } });
    const mod = await import("./comms");
    const { container, getByRole } = renderScreen(mod.default);
    await waitFor(() => expect(bodyRows(container)).toHaveLength(4));
    fireEvent.click(getByRole("tab", { name: /^Sent/ }));
    await waitFor(() => expect(bodyRows(container)).toEqual([{ recipient: "buyer@acme.test", status: "sent" }]));
    fireEvent.click(getByRole("tab", { name: /^Drafts/ }));
    await waitFor(() => expect(bodyRows(container)).toEqual([{ recipient: "qa@delta.test", status: "draft" }]));
  });

  it("a refused read shows the error, not an empty list", async () => {
    installBackend({ communications: { list: vi.fn(async () => { throw new Error("401 Unauthorized"); }) } });
    const mod = await import("./comms");
    const { findByText } = renderScreen(mod.default);
    expect(await findByText("Failed to load communications")).toBeTruthy();
    expect(await findByText("401 Unauthorized")).toBeTruthy();
  });
});

describe("Comms", () => {
  it("renders without throwing", async () => {
    const mod = await import("./comms");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});
