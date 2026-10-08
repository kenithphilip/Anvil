// The pipeline kanban moves ORDERS between statuses by drag and drop.
//
// Three things it used to get wrong:
// 1. "Closed" was a drop target whose status was CANCELLED, so a card
//    dropped there to mark it done was cancelled.
// 2. The Approve drop sent { status } with no payload hash, and
//    src/api/orders/[id].js refuses that with 400 every time.
// 3. EXPORTED_TO_TALLY, BLOCKED, DUPLICATE, CANCELLED (and more) matched
//    no column and piled up in Inbox.
//
// The approve tests run the REAL orders/[id].js handler behind the
// screen's orders.update, over a small in-memory orders table, so "the
// server accepts it" is the server's own answer.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const db = vi.hoisted(() => ({ orders: [] as Array<Record<string, any>> }));
const ctx = vi.hoisted(() => ({ value: { user: { id: "u-mgr" }, tenantId: "t-1", role: "sales_manager" } as Record<string, any> }));

vi.mock("../../api/_lib/supabase.js", () => {
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;
    const rows = () => ((db as any)[table] || []).filter((r: any) => filters.every(([c, v]) => r[c] === v));
    const q: any = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
      update: (p: Record<string, unknown>) => { patch = p; return q; },
      single: async () => {
        const hit = rows();
        if (patch) hit.forEach((r: any) => Object.assign(r, JSON.parse(JSON.stringify(patch))));
        return hit[0] ? { data: JSON.parse(JSON.stringify(hit[0])), error: null } : { data: null, error: { message: "no rows" } };
      },
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
    };
    return q;
  };
  return { serviceClient: () => ({ from }), userClient: () => ({ from }) };
});
vi.mock("../../api/_lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveContext: vi.fn(async () => ctx.value),
}));
vi.mock("../../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}), recordEvent: vi.fn(async () => {}) }));
vi.mock("../../api/_lib/approval-evaluator.js", () => ({ evaluateApprovalsForOrder: vi.fn(async () => ({ created: [] })) }));
vi.mock("../../api/eval/promote.js", () => ({ promoteApprovedOrder: vi.fn(async () => ({ promoted: false })) }));

const orderHandler = (await import("../../api/orders/[id].js")).default;

// The screen's orders.update, answered by the real handler.
const serverUpdate = vi.fn(async (id: string, body: Record<string, unknown>) => {
  let status = 200;
  let sent = "";
  const res: any = {
    setHeader: () => {},
    status(c: number) { status = c; return res; },
    send(p: string) { sent = p; return res; },
    end() { return res; },
  };
  await orderHandler({ method: "PATCH", headers: {}, query: { id }, url: "/api/orders/" + id, body }, res);
  const parsed = sent ? JSON.parse(sent) : {};
  if (status >= 400) throw new Error(parsed?.error?.message || "HTTP " + status);
  return parsed;
});

const order = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "o-" + status.toLowerCase(),
  tenant_id: "t-1",
  po_number: "PO-" + status,
  status,
  created_at: new Date().toISOString(),
  ...extra,
});

const seed = (rows: Array<Record<string, any>>) => {
  db.orders.length = 0;
  rows.forEach((r) => db.orders.push(JSON.parse(JSON.stringify(r))));
};

beforeEach(() => {
  serverUpdate.mockClear();
  ctx.value = { user: { id: "u-mgr" }, tenantId: "t-1", role: "sales_manager" };
  seed([]);
  installBackend({
    orders: {
      list: vi.fn(async () => ({ orders: db.orders.map((r) => ({ ...r })) })),
      update: serverUpdate,
    },
  });
  installRbac("sales_manager");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

const renderBoard = async () => {
  const mod = await import("./pipeline-kanban");
  return renderScreen(mod.default);
};

const column = (label: string) => screen.getByRole("region", { name: label });

// One DataTransfer shared by dragstart and drop, as in a browser.
const makeDataTransfer = () => {
  const data: Record<string, string> = {};
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: (k: string, v: string) => { data[k] = v; },
    getData: (k: string) => data[k] || "",
  };
};

const dragTo = async (poNumber: string, label: string) => {
  const dt = makeDataTransfer();
  const card = screen.getByText(poNumber).closest("a") as HTMLElement;
  fireEvent.dragStart(card, { dataTransfer: dt });
  const over = fireEvent.dragOver(column(label), { dataTransfer: dt });
  await act(async () => { fireEvent.drop(column(label), { dataTransfer: dt }); });
  // fireEvent returns false when the handler called preventDefault, which
  // is what tells the browser the column accepts the drop.
  return { accepted: over === false };
};

describe("PipelineKanban", () => {
  it("renders the 6 kanban columns", async () => {
    await renderBoard();
    for (const label of ["Inbox", "OCR", "Validate", "Approve", "Push", "Closed"]) {
      expect(column(label)).toBeTruthy();
    }
  });

  it("shows every order status in exactly one column", async () => {
    const where: Record<string, string> = {
      DRAFT: "Inbox",
      PENDING_REVIEW: "Validate",
      BLOCKED: "Validate",
      DUPLICATE: "Validate",
      REUSED: "Validate",
      APPROVED: "Approve",
      FAILED_TALLY_IMPORT: "Push",
      EXPORTED_TO_TALLY: "Closed",
      RECONCILED: "Closed",
      CANCELLED: "Closed",
    };
    seed(Object.keys(where).map((s) => order(s)));
    await renderBoard();
    await screen.findByText("PO-DRAFT");
    for (const [status, label] of Object.entries(where)) {
      expect(screen.getAllByText("PO-" + status)).toHaveLength(1);
      expect(within(column(label)).getByText("PO-" + status)).toBeTruthy();
    }
    // Nothing but the DRAFT lands in Inbox, and OCR holds no status.
    expect(within(column("Inbox")).queryAllByRole("link")).toHaveLength(1);
    expect(within(column("OCR")).queryAllByRole("link")).toHaveLength(0);
  });

  it("names the status on a card that shares its column with others", async () => {
    seed([order("BLOCKED"), order("CANCELLED")]);
    await renderBoard();
    await screen.findByText("PO-BLOCKED");
    expect(within(column("Validate")).getByText("blocked")).toBeTruthy();
    expect(within(column("Closed")).getByText("cancelled")).toBeTruthy();
  });

  it("does not accept a drop on Closed, and changes nothing", async () => {
    seed([order("DRAFT"), order("PENDING_REVIEW", { payload_hash: "h-1" })]);
    await renderBoard();
    await screen.findByText("PO-DRAFT");

    const drop1 = await dragTo("PO-DRAFT", "Closed");
    const drop2 = await dragTo("PO-PENDING_REVIEW", "Closed");

    expect(drop1.accepted).toBe(false);
    expect(drop2.accepted).toBe(false);
    expect(serverUpdate).not.toHaveBeenCalled();
    expect(within(column("Inbox")).getByText("PO-DRAFT")).toBeTruthy();
    expect(within(column("Validate")).getByText("PO-PENDING_REVIEW")).toBeTruthy();
    expect(within(column("Closed")).queryAllByRole("link")).toHaveLength(0);
    expect(db.orders.map((o) => o.status)).toEqual(["DRAFT", "PENDING_REVIEW"]);
  });

  it("does not offer a closed order for dragging", async () => {
    seed([order("EXPORTED_TO_TALLY")]);
    await renderBoard();
    const card = (await screen.findByText("PO-EXPORTED_TO_TALLY")).closest("a") as HTMLElement;
    expect(card.getAttribute("draggable")).toBe("false");
  });

  it("approves on an Approve drop with the order's payload hash, and the server accepts it", async () => {
    seed([order("PENDING_REVIEW", { payload_hash: "hash-abc" })]);
    await renderBoard();
    await screen.findByText("PO-PENDING_REVIEW");

    const { accepted } = await dragTo("PO-PENDING_REVIEW", "Approve");

    expect(accepted).toBe(true);
    expect(serverUpdate).toHaveBeenCalledTimes(1);
    expect(serverUpdate).toHaveBeenCalledWith("o-pending_review", {
      status: "APPROVED",
      approval: { payloadHash: "hash-abc" },
    });
    // The server's answer, written to the table.
    await waitFor(() => expect(db.orders[0].status).toBe("APPROVED"));
    expect(db.orders[0].approval.payloadHash).toBe("hash-abc");
    expect(db.orders[0].approved_by).toBe("u-mgr");
    expect(within(column("Approve")).getByText("PO-PENDING_REVIEW")).toBeTruthy();
    expect(screen.queryByText(/Move rejected/)).toBeNull();
  });

  it("refuses an Approve drop on an order with no payload hash, without calling the server", async () => {
    seed([order("PENDING_REVIEW")]);
    await renderBoard();
    await screen.findByText("PO-PENDING_REVIEW");

    await dragTo("PO-PENDING_REVIEW", "Approve");

    expect(serverUpdate).not.toHaveBeenCalled();
    expect(screen.getByText(/Order has no payload hash/)).toBeTruthy();
    expect(within(column("Validate")).getByText("PO-PENDING_REVIEW")).toBeTruthy();
  });

  it("keeps Approve view-only for a role without so.approve", async () => {
    installRbac("sales_engineer");
    ctx.value = { user: { id: "u-se" }, tenantId: "t-1", role: "sales_engineer" };
    seed([order("PENDING_REVIEW", { payload_hash: "hash-abc" })]);
    await renderBoard();
    await screen.findByText("PO-PENDING_REVIEW");

    const { accepted } = await dragTo("PO-PENDING_REVIEW", "Approve");

    expect(accepted).toBe(false);
    expect(serverUpdate).not.toHaveBeenCalled();
    expect(db.orders[0].status).toBe("PENDING_REVIEW");
  });

  it("does not re-approve an approved order dropped on Approve again", async () => {
    seed([order("APPROVED", { payload_hash: "hash-abc", approved_at: "2026-10-01T00:00:00.000Z" })]);
    await renderBoard();
    await screen.findByText("PO-APPROVED");

    await dragTo("PO-APPROVED", "Approve");

    expect(serverUpdate).not.toHaveBeenCalled();
    expect(db.orders[0].approved_at).toBe("2026-10-01T00:00:00.000Z");
  });

  it("sends a blocked order back to review from its place in Validate", async () => {
    seed([order("BLOCKED", { result: { salesOrder: { lineItems: [] } } })]);
    await renderBoard();
    await screen.findByText("PO-BLOCKED");

    await dragTo("PO-BLOCKED", "Validate");

    expect(serverUpdate).toHaveBeenCalledWith("o-blocked", { status: "PENDING_REVIEW" });
    await waitFor(() => expect(db.orders[0].status).toBe("PENDING_REVIEW"));
  });

  it("still moves a DRAFT to Validate (send for review)", async () => {
    seed([order("DRAFT", { result: { salesOrder: { lineItems: [] } } })]);
    await renderBoard();
    await screen.findByText("PO-DRAFT");

    const { accepted } = await dragTo("PO-DRAFT", "Validate");

    expect(accepted).toBe(true);
    expect(serverUpdate).toHaveBeenCalledWith("o-draft", { status: "PENDING_REVIEW" });
    await waitFor(() => expect(db.orders[0].status).toBe("PENDING_REVIEW"));
  });
});
