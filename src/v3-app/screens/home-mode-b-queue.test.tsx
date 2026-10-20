// Home "My queue" reads each order's stage (plan R-M1, C-10).
// 1. A Mode B order stays APPROVED after it is keyed and verified in Tally,
//    so it never left the queue. Verified and cancelled orders leave it now.
// 2. The queue took the first 8 rows and then counted them, so 30 open
//    orders showed "8". It counts first now.
// 3. The list is newest first, and "oldest" read the first row: the newest.
// Invented fixtures; stages from the server's own orderStage().

import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";
import { orderStage } from "../../api/_lib/order-stage.js";

const HASH = "hash-1";
const DAY = 86400000;
const NOW = Date.now();

const order = (id: string, status: string, over: Record<string, unknown> = {}, mode = "B") => {
  const o = {
    id, status, po_number: "PO-" + id, payload_hash: HASH, result: {},
    created_at: new Date(NOW - 40 * DAY).toISOString(), updated_at: new Date(NOW - DAY).toISOString(), ...over,
  };
  return { ...o, stage: orderStage(o, { mode }) };
};
const approved = (id: string, over: Record<string, unknown> = {}) =>
  order(id, "APPROVED", { approval: { payloadHash: HASH }, approved_at: new Date(NOW - 2 * DAY).toISOString(), ...over });

const mount = async (orders: unknown[]) => {
  installBackend({
    orders: { list: vi.fn(async () => ({ orders })) },
    audit: { list: vi.fn(async () => ({ events: [] })) },
    docai: { soProcessingMode: vi.fn(async () => ({ mode: "B" })) },
  });
  const mod = await import("./home");
  return renderScreen(mod.default);
};

const kpi = (container: HTMLElement, label: string) => {
  const box = Array.from(container.querySelectorAll(".kpi")).find((k) => k.querySelector(".lbl")?.textContent === label);
  return { v: box?.querySelector(".v")?.textContent, d: box?.querySelector(".d")?.textContent };
};

beforeEach(() => { installRbac("sales_engineer"); });

describe("Home queue in Mode B", () => {
  it("drops a verified order and a cancelled one, and keeps an approved order that waits for its handoff", async () => {
    const { container } = await mount([
      approved("WAIT"),
      approved("DONE", { tally_status: "reconciled" }),
      order("GONE", "CANCELLED"),
    ]);
    await screen.findByText("PO-WAIT");
    expect(screen.queryByText("PO-DONE")).toBeNull();
    expect(screen.queryByText("PO-GONE")).toBeNull();
    expect(kpi(container, "My queue").v).toBe("1");
    // The row names the stage the server sent.
    expect((screen.getByText("PO-WAIT").closest("tr") as HTMLElement).textContent).toContain("Approved");
  });

  it("counts 30 open orders as 30, shows 8 rows, and names the oldest as oldest", async () => {
    // Newest first, as GET /api/orders returns them: 1 to 30 days old.
    const open = Array.from({ length: 30 }, (_, i) =>
      order("N" + (i + 1), "DRAFT", { updated_at: new Date(NOW - (i + 1) * DAY).toISOString() }));
    const { container } = await mount(open);
    await waitFor(() => expect(kpi(container, "My queue").v).toBe("30"));
    expect(kpi(container, "My queue").d).toBe("oldest 30d");
    expect(container.querySelectorAll("table.tbl tbody tr")).toHaveLength(8);
    expect(screen.getByText(/30 orders in your queue · oldest 30d/)).toBeTruthy();
  });
});
