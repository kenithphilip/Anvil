// GenAI copilot P0b: the Ask Anvil screen. Two ways to ask, one trust contract
// — a governed metric (deterministic, renders the number + provenance + as_of)
// or a free-text question routed to the agentic assistant. Every answer shows
// how it was derived.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const CATALOG = [
  { id: "ar_overdue", label: "Overdue AR", unit: "currency", domain: "finance", description: "overdue balance" },
  { id: "quote_acceptance_rate", label: "Quote acceptance rate", unit: "percent", domain: "sales" },
];

const AR_ANSWER = {
  metric_id: "ar_overdue", label: "Overdue AR", unit: "currency", domain: "finance", value: 1300,
  breakdown: [{ label: "1-30", outstanding: 1000, count: 1 }, { label: "31-60", outstanding: 300, count: 1 }],
  as_of: "2026-07-22T00:00:00.000Z", provenance: "outstanding on invoices where now > due_date",
};

beforeEach(() => { installRbac("admin"); });

describe("AskAnvil", () => {
  it("loads the metric catalog and renders a chip per metric", async () => {
    const list = vi.fn(async () => ({ metrics: CATALOG }));
    installBackend({ metrics: { list, query: vi.fn() }, erpChat: { send: vi.fn() } });
    const mod = await import("./ask-anvil");
    const { getByText } = renderScreen(mod.default);
    await waitFor(() => expect(getByText("Overdue AR")).toBeTruthy());
    expect(getByText("Quote acceptance rate")).toBeTruthy();
    expect(list).toHaveBeenCalled();
  });

  it("computes a governed metric on click → shows the number + provenance, never invents it", async () => {
    const list = vi.fn(async () => ({ metrics: CATALOG }));
    const query = vi.fn(async (_id: string, _opts: any) => AR_ANSWER);
    installBackend({ metrics: { list, query }, erpChat: { send: vi.fn() } });
    const mod = await import("./ask-anvil");
    const { getByText, findByText } = renderScreen(mod.default);
    await waitFor(() => expect(getByText("Overdue AR")).toBeTruthy());

    fireEvent.click(getByText("Overdue AR"));
    // governed answer card: the formatted number + the "how computed" provenance
    await waitFor(() => expect(getByText(/₹\s*1,300/)).toBeTruthy());
    expect(await findByText(/how computed:/i)).toBeTruthy();
    expect(getByText(/outstanding on invoices/i)).toBeTruthy();
    // it queried the catalog with the selected window, not free-form SQL
    expect(query).toHaveBeenCalledWith("ar_overdue", { window_days: 90 });
  });

  it("routes a free-text question to the agentic assistant", async () => {
    const send = vi.fn(async (_p: any) => ({ ok: true, session_id: "s1", content: "You have 3 open orders.", citations: [{ source: "orders" }] }));
    installBackend({ metrics: { list: vi.fn(async () => ({ metrics: CATALOG })), query: vi.fn() }, erpChat: { send } });
    const mod = await import("./ask-anvil");
    const { container, getByText } = renderScreen(mod.default);
    await waitFor(() => expect(getByText("Overdue AR")).toBeTruthy());

    const input = container.querySelector('input[aria-label="Ask Anvil a question"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "how many open orders?" } });
    fireEvent.click(getByText(/^Ask$/i) || getByText("Ask"));

    await waitFor(() => expect(getByText("You have 3 open orders.")).toBeTruthy());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: "how many open orders?" }));
    expect(getByText("orders")).toBeTruthy(); // citation chip
  });

  it("surfaces a metric error instead of a fake number", async () => {
    const query = vi.fn(async () => ({ error: "unknown metric" }));
    installBackend({ metrics: { list: vi.fn(async () => ({ metrics: CATALOG })), query }, erpChat: { send: vi.fn() } });
    const mod = await import("./ask-anvil");
    const { getByText } = renderScreen(mod.default);
    await waitFor(() => expect(getByText("Overdue AR")).toBeTruthy());
    fireEvent.click(getByText("Overdue AR"));
    await waitFor(() => expect(getByText(/Couldn't answer that/i)).toBeTruthy());
  });
});
