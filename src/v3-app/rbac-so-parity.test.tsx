// Every canDo(...) key the SO screens use is registered on BOTH sides, with
// the same roles: the client's ACTIONS (lib/rbac.ts) and the server's
// SERVER_ACTIONS (api/_lib/auth.js).
//
// Why: both canDo and hasAction ALLOW any action they do not know. so.write
// and so.admin were used by the SO workspace and registered nowhere, so every
// write button showed as enabled for a viewer, and the server could not check
// them either.
//
// How: behavioural, not a source scan. canDo is wrapped to record every key
// it is asked for (through both the named export and RBAC.canDo), and the SO
// screens are rendered in the states and tabs that reach their checks. Then
// every recorded key is checked against both tables, role by role.
//
// Invented fixtures only.

import React from "react";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { waitFor, cleanup } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "./test-utils";

const seen = vi.hoisted(() => new Set<string>());

vi.mock("./lib/rbac", async (importOriginal) => {
  const actual: any = await importOriginal();
  const canDo = (action: string) => { seen.add(action); return actual.canDo(action); };
  return { ...actual, canDo, RBAC: { ...actual.RBAC, canDo } };
});

const ORDER_ID = "ord-parity-1";
const order = (status: string) => ({
  id: ORDER_ID, status, po_number: "PO-PARITY-1", po_date: "2026-10-01", customer_id: "cust-1",
  customer: { customer_name: "Parity Buyer" },
  payload_hash: "hash-parity-1",
  preflight_payload: { source_document_id: "doc-1" },
  documents: [{ id: "doc-1" }],
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  result: {
    salesOrder: {
      grandTotal: 500,
      customer: { name: "Parity Buyer" },
      lineItems: [{ partNumber: "PT-1", description: "Part", qty: 5, rate: 100, uom: "NOS" }],
    },
    quoteReconciliation: { summary: { total: 1, matched: 1 }, flags: [], quoted_not_ordered: [] },
  },
});

const TERMS = {
  order_id: ORDER_ID, mode: "on", shadow: false, visible: true,
  check: { id: "chk-1", po_terms_status: "read", po_source: "terms_pass", clause_count: 1 },
  flags: [{
    id: "fl-1", clause: "payment_terms", clause_label: "Payment terms", outcome: "differs", severity: "high", state: "undecided",
    po: { text: "90 days" }, quote: { text: "30 days" }, allowed: ["accept", "request_amendment", "reject_term", "not_a_deviation"], decisions: [],
  }],
  counts: { total: 1, undecided: 1, amendment_requested: 0, decided: 0 },
};

const ATTACHED = {
  attached: [{
    document_id: "qdoc-1", filename: "quote.pdf", ingested: true,
    superseded_by: { document_id: "qdoc-2", basis: "same_number", certain: true },
    quote: { id: "q-1", quote_number: "Q-PARITY-1", line_count: 1 },
  }],
  other_quotes: [],
};

const backend = (status: string) => ({
  orders: {
    get: vi.fn(async () => ({ order: order(status) })),
    list: vi.fn(async () => ({ orders: [order(status)] })),
    update: vi.fn(async () => ({})),
    terms: vi.fn(async () => TERMS),
    attachedQuotes: vi.fn(async () => ATTACHED),
  },
  audit: { list: vi.fn(async () => []) },
  events: { list: vi.fn(async () => []) },
  cost: { breakdown: vi.fn(async () => null) },
  docai: { soProcessingMode: vi.fn(async () => ({ mode: "A" })), getRun: vi.fn(async () => null) },
});

// The workspace tabs, by their ?tab= id.
const TABS = [
  "recon", "header", "margin", "why", "evidence", "quotes", "terms", "approval",
  "tally", "threeway", "invoice_check", "schedule", "shipments", "activity", "diagnostics",
];

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  installRbac("admin");
  (window as any).URL.createObjectURL = vi.fn(() => "blob:x");
  // The workspace: every tab while pending review, and the review layout in
  // the other states its buttons depend on.
  const runs: Array<[string, string]> = [
    ...TABS.map((t) => ["PENDING_REVIEW", t] as [string, string]),
    ["DRAFT", "recon"], ["APPROVED", "recon"], ["CANCELLED", "recon"],
  ];
  const ws = (await import("./screens/so-workspace")).default;
  for (const [status, tab] of runs) {
    installBackend(backend(status));
    window.location.hash = "#/so?id=" + ORDER_ID + "&tab=" + tab;
    const view = renderScreen(ws);
    await waitFor(() => expect(view.container.querySelector(".ws-title h1")).toBeTruthy());
    await settle();
    view.unmount();
  }
  // The other SO screens.
  for (const path of ["./screens/so-intake", "./screens/so-register", "./screens/orders", "./screens/pipeline-kanban", "./screens/approvals"]) {
    installBackend(backend("PENDING_REVIEW"));
    window.location.hash = "#/so";
    const mod = await import(/* @vite-ignore */ path);
    const view = renderScreen(mod.default);
    await settle();
    await settle();
    view.unmount();
  }
  cleanup();
}, 60000);

const ROLES = ["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator", "viewer", "design_engineer", "design_manager", "customer_support"];

describe("the canDo keys the SO screens use", () => {
  it("include the SO actions (the render reached their checks)", () => {
    for (const key of ["so.write", "so.admin", "so.approve", "so.cancel", "so.push_tally", "cost.view", "order.terms_decide"]) {
      expect([...seen]).toContain(key);
    }
  });

  it("are each registered on the client and on the server, with the same roles", async () => {
    const { ACTIONS } = await vi.importActual<any>("./lib/rbac");
    const { SERVER_ACTIONS } = await import("../api/_lib/auth.js");
    for (const key of seen) {
      expect(ACTIONS[key], "client ACTIONS has " + key).toBeTruthy();
      expect(SERVER_ACTIONS[key], "server SERVER_ACTIONS has " + key).toBeInstanceOf(Set);
      expect([...SERVER_ACTIONS[key]].sort(), key).toEqual([...ACTIONS[key]].sort());
    }
  });

  it("admit the same roles on both sides, role by role", async () => {
    const { canDo } = await vi.importActual<any>("./lib/rbac");
    const { hasAction } = await import("../api/_lib/auth.js");
    for (const key of seen) {
      for (const role of ROLES) {
        installRbac(role);
        expect(canDo(key), key + " for " + role).toBe(hasAction({ role }, key));
      }
    }
    installRbac("admin");
  });
});

describe("so.write and so.admin follow the MATRIX", () => {
  it("so.write admits the roles with SO rw (design roles inherit it), plus admin", async () => {
    const { canDo, canWrite } = await vi.importActual<any>("./lib/rbac");
    for (const role of ROLES) {
      installRbac(role);
      // Admin is "r" on MATRIX.so but passes every action.
      expect(canDo("so.write"), role).toBe(role === "admin" ? true : canWrite("so"));
    }
    installRbac("admin");
  });

  it("so.admin admits admin only, the same as the admin verb", async () => {
    const { hasAction, hasPermission } = await import("../api/_lib/auth.js");
    for (const role of ROLES) {
      expect(hasAction({ role }, "so.admin"), role).toBe(hasPermission({ role }, "admin"));
    }
  });

  it("so.approve and so.push_tally admit exactly the approve verb's roles", async () => {
    const { hasAction, hasPermission } = await import("../api/_lib/auth.js");
    for (const role of ROLES) {
      expect(hasAction({ role }, "so.approve"), role).toBe(hasPermission({ role }, "approve"));
      expect(hasAction({ role }, "so.push_tally"), role).toBe(hasPermission({ role }, "approve"));
    }
  });
});
