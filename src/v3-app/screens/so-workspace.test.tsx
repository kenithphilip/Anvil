// Auto-generated smoke test for screens/so-workspace.jsx.
// Hand-edit if a screen needs a more specific assertion; the generator
// only overwrites files that match the auto-generated header below.

import { describe, it, expect, beforeEach, vi } from "vitest";
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

describe("SoWorkspace", () => {
  it("renders without throwing", async () => {
    const mod = await import("./so-workspace");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("renders run-extraction + send-for-review buttons for DRAFT orders", async () => {
    // Regression May 2026: orders that arrived in DRAFT had no
    // operator-facing trigger when post-create OCR silently failed.
    // The workspace's action bar now exposes both actions so a stuck
    // order can be unstuck without a backend round-trip.
    const original = window.location.hash;
    const orderId = "ord-fixture-1";
    const sourceId = "doc-fixture-1";
    const orderDraft = {
      id: orderId,
      status: "DRAFT",
      po_number: "PO-9001",
      customer_id: "cust-1",
      customer_name: "Fixture Customer",
      result: { salesOrder: { lineItems: [] } },
      preflight_payload: { source_document_id: sourceId },
      documents: [{ id: sourceId }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try {
      window.location.hash = "#/so?id=" + orderId;
      installBackend({
        orders: {
          get: vi.fn(async () => ({ order: orderDraft })),
          update: vi.fn(async () => ({})),
        },
        audit: { list: vi.fn(async () => []) },
        events: { list: vi.fn(async () => []) },
        cost: { breakdown: vi.fn(async () => null) },
      });
      const mod = await import("./so-workspace");
      const Screen = mod.default;
      const { container } = renderScreen(Screen);
      // Wait two ticks so the effects fetch + render with the order.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const html = container.innerHTML;
      expect(html).toContain("run extraction");
      expect(html).toContain("send for review");
    } finally {
      window.location.hash = original;
    }
  });

  it("renders run-validation button when DRAFT has lines + customer", async () => {
    // Regression May 2026: the Validate stepper step had no UI
    // trigger. The workspace now surfaces "run validation" once the
    // order has both a customer (rule library needs the peer set)
    // and at least one extracted line item.
    const original = window.location.hash;
    const orderId = "ord-fixture-validate";
    const order = {
      id: orderId,
      status: "DRAFT",
      po_number: "PO-V-1",
      customer_id: "cust-1",
      customer_name: "Fixture Customer",
      result: {
        salesOrder: {
          lineItems: [
            { partNumber: "BR-6204-ZZ", qty: 10, rate: 145, lineTotal: 1450 },
          ],
        },
      },
      preflight_payload: { source_document_id: "doc-1", extraction_run_id: "run-1" },
      documents: [{ id: "doc-1" }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try {
      window.location.hash = "#/so?id=" + orderId;
      installBackend({
        orders: {
          get: vi.fn(async () => ({ order })),
          update: vi.fn(async () => ({})),
        },
        audit: { list: vi.fn(async () => []) },
        events: { list: vi.fn(async () => []) },
        cost: { breakdown: vi.fn(async () => null) },
      });
      const mod = await import("./so-workspace");
      const Screen = mod.default;
      const { container } = renderScreen(Screen);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const html = container.innerHTML;
      expect(html).toContain("run validation");
      const validate = Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent && b.textContent.toLowerCase().includes("run validation"));
      expect(validate).toBeTruthy();
      expect(validate?.hasAttribute("disabled")).toBe(false);
    } finally {
      window.location.hash = original;
    }
  });

  it("derives stepper from preflight_payload + lineItems, not status alone", async () => {
    // Regression May 2026: the previous stepper drove all 6 steps
    // off o.status, so Preflight + Extract were never highlighted.
    // The new derivation reads source-doc + extraction signals so an
    // order with extraction done but still in DRAFT lights step 3
    // (Validate) as in-progress, with the prior steps as done.
    const original = window.location.hash;
    const orderId = "ord-fixture-stepper";
    const order = {
      id: orderId,
      status: "DRAFT",
      po_number: "PO-S-1",
      customer_id: "cust-1",
      customer_name: "Fixture Customer",
      result: {
        salesOrder: {
          lineItems: [
            { partNumber: "X", qty: 1, rate: 10, lineTotal: 10 },
          ],
        },
      },
      preflight_payload: { source_document_id: "doc-1", extraction_run_id: "run-1" },
      documents: [{ id: "doc-1" }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try {
      window.location.hash = "#/so?id=" + orderId;
      installBackend({
        orders: {
          get: vi.fn(async () => ({ order })),
          update: vi.fn(async () => ({})),
        },
        audit: { list: vi.fn(async () => []) },
        events: { list: vi.fn(async () => []) },
        cost: { breakdown: vi.fn(async () => null) },
      });
      const mod = await import("./so-workspace");
      const Screen = mod.default;
      const { container } = renderScreen(Screen);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      // Stepper renders Capture, Preflight, Extract as done (with
      // the check mark) and Validate as the current step. Look for
      // the "cur" class on the 4th step (index 3 = Validate).
      const steps = container.querySelectorAll(".step");
      expect(steps.length).toBe(6);
      // Capture, Preflight, Extract should all be "done".
      expect(steps[0].className).toContain("done");
      expect(steps[1].className).toContain("done");
      expect(steps[2].className).toContain("done");
      // Validate is the current in-progress step.
      expect(steps[3].className).toContain("cur");
    } finally {
      window.location.hash = original;
    }
  });

  it("disables send-for-review on RECONCILED orders", async () => {
    // The send-for-review action only makes sense for DRAFT. Once an
    // order has been pushed and reconciled, the button must be
    // disabled so a stale operator click cannot re-enter the review
    // queue.
    const original = window.location.hash;
    const orderId = "ord-fixture-2";
    const orderPushed = {
      id: orderId,
      status: "RECONCILED",
      po_number: "PO-9002",
      customer_id: "cust-2",
      customer_name: "Fixture Customer 2",
      result: { salesOrder: { lineItems: [] } },
      preflight_payload: { source_document_id: "doc-fixture-2" },
      documents: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try {
      window.location.hash = "#/so?id=" + orderId;
      installBackend({
        orders: {
          get: vi.fn(async () => ({ order: orderPushed })),
          update: vi.fn(async () => ({})),
        },
        audit: { list: vi.fn(async () => []) },
        events: { list: vi.fn(async () => []) },
        cost: { breakdown: vi.fn(async () => null) },
      });
      const mod = await import("./so-workspace");
      const Screen = mod.default;
      const { container } = renderScreen(Screen);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const sendForReview = Array.from(container.querySelectorAll("button"))
        .find((b) => b.textContent && b.textContent.toLowerCase().includes("send for review"));
      expect(sendForReview).toBeTruthy();
      expect(sendForReview?.hasAttribute("disabled")).toBe(true);
    } finally {
      window.location.hash = original;
    }
  });

  it("stepper does NOT mark Extract done when run_id stamped but 0 lines", async () => {
    // Bug fix May 2026 (stepper-lies report): the previous logic
    // marked Extract green if extraction_run_id was stamped, even
    // when extraction returned 0 lines. Truthful stepper now
    // requires lines.length > 0 for Extract to be done; a banner
    // explains the empty extraction.
    const original = window.location.hash;
    const orderId = "ord-fixture-stepper-truth";
    const orderEmptyExtract = {
      id: orderId,
      status: "DRAFT",
      po_number: "PO-EMPTY-1",
      customer_id: "cust-1",
      customer_name: "Fixture Customer",
      result: { salesOrder: { lineItems: [] } },
      preflight_payload: {
        source_document_id: "doc-1",
        extraction_run_id: "run-empty-1",
        adapter_used: "claude",
        confidence_overall: 0.42,
      },
      documents: [{ id: "doc-1" }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try {
      window.location.hash = "#/so?id=" + orderId;
      installBackend({
        orders: { get: vi.fn(async () => ({ order: orderEmptyExtract })), update: vi.fn(async () => ({})) },
        audit: { list: vi.fn(async () => []) },
        events: { list: vi.fn(async () => []) },
        cost: { breakdown: vi.fn(async () => null) },
      });
      const mod = await import("./so-workspace");
      const Screen = mod.default;
      const { container } = renderScreen(Screen);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const steps = container.querySelectorAll(".step");
      expect(steps.length).toBe(6);
      // Capture done, Preflight done, Extract = current (not done).
      expect(steps[0].className).toContain("done");
      expect(steps[1].className).toContain("done");
      expect(steps[2].className).toContain("cur");
      expect(steps[2].className).not.toContain("done");
      // Empty-extraction banner shows.
      expect(container.innerHTML).toContain("Extraction returned no line items");
    } finally {
      window.location.hash = original;
    }
  });

  it("stepper marks Extract done once lines populate (truthful)", async () => {
    const original = window.location.hash;
    const orderId = "ord-fixture-stepper-lines";
    const orderWithLines = {
      id: orderId,
      status: "DRAFT",
      po_number: "PO-WITH-LINES",
      customer_id: "cust-1",
      result: {
        salesOrder: {
          lineItems: [
            { partNumber: "X", qty: 1, rate: 10, lineTotal: 10 },
            { partNumber: "Y", qty: 2, rate: 5, lineTotal: 10 },
          ],
        },
      },
      preflight_payload: { source_document_id: "doc-1", extraction_run_id: "run-good" },
      documents: [{ id: "doc-1" }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try {
      window.location.hash = "#/so?id=" + orderId;
      installBackend({
        orders: { get: vi.fn(async () => ({ order: orderWithLines })), update: vi.fn(async () => ({})) },
        audit: { list: vi.fn(async () => []) },
        events: { list: vi.fn(async () => []) },
        cost: { breakdown: vi.fn(async () => null) },
      });
      const mod = await import("./so-workspace");
      const Screen = mod.default;
      const { container } = renderScreen(Screen);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const steps = container.querySelectorAll(".step");
      expect(steps[2].className).toContain("done");
      expect(steps[3].className).toContain("cur");
      expect(container.innerHTML).not.toContain("Extraction returned no line items");
    } finally {
      window.location.hash = original;
    }
  });

  it("renders the From-PO customer panel when result.salesOrder.customer is set", async () => {
    // Bug fix May 2026 (customer-prefill report): workspace surfaces
    // the extracted customer block so the operator sees the PO
    // header values without bouncing to the intake screen.
    const original = window.location.hash;
    const orderId = "ord-fixture-cust-panel";
    const order = {
      id: orderId,
      status: "DRAFT",
      po_number: "PO-PANEL-1",
      customer_id: "cust-1",
      customer_name: "Existing Customer",
      result: {
        salesOrder: {
          lineItems: [],
          customer: {
            name: "Brand New Customer Pvt Ltd",
            gstin: "29ABCDE1234F1Z5",
            state_code: "29",
            currency: "INR",
            payment_terms: "Net 45",
            email: "po@customer.example",
            phone: "+91 99999 88888",
            bill_to_address: "Plot 12, MIDC, Pune 411018",
          },
        },
      },
      preflight_payload: { source_document_id: "doc-1" },
      documents: [{ id: "doc-1" }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try {
      window.location.hash = "#/so?id=" + orderId;
      installBackend({
        orders: { get: vi.fn(async () => ({ order })), update: vi.fn(async () => ({})) },
        audit: { list: vi.fn(async () => []) },
        events: { list: vi.fn(async () => []) },
        cost: { breakdown: vi.fn(async () => null) },
      });
      const mod = await import("./so-workspace");
      const Screen = mod.default;
      const { container } = renderScreen(Screen);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const html = container.innerHTML;
      expect(html).toContain("Customer · from PO header");
      expect(html).toContain("29ABCDE1234F1Z5");
      expect(html).toContain("Brand New Customer Pvt Ltd");
      expect(html).toContain("po@customer.example");
    } finally {
      window.location.hash = original;
    }
  });

  it("renders OCR provenance pills on reconciliation rows whose lines carry _field_sources", async () => {
    // Regression May 2026: after the recon table became editable
    // the operator wanted visibility into which fields came from
    // the docai extractor vs which they had already overridden.
    // Lines stamped with _field_sources from so-intake render a
    // ghost-tone "OCR" pill next to each populated cell.
    const original = window.location.hash;
    const orderId = "ord-fixture-recon-pills";
    const order = {
      id: orderId,
      status: "DRAFT",
      po_number: "PO-RECON-1",
      customer_id: "cust-1",
      customer_name: "Fixture Customer",
      result: {
        salesOrder: {
          lineItems: [
            {
              partNumber: "BR-6204-ZZ",
              description: "Deep groove ball bearing",
              quantity: 5,
              unitPrice: 145,
              uom: "Nos",
              _field_sources: {
                itemCode: "ocr",
                description: "ocr",
                qty: "ocr",
                rate: "ocr",
                uom: "ocr",
              },
            },
          ],
        },
      },
      preflight_payload: { source_document_id: "doc-1" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try {
      window.location.hash = "#/so?id=" + orderId;
      installBackend({
        orders: { get: vi.fn(async () => ({ order })), update: vi.fn(async () => ({})) },
        audit: { list: vi.fn(async () => []) },
        events: { list: vi.fn(async () => []) },
        cost: { breakdown: vi.fn(async () => null) },
      });
      const mod = await import("./so-workspace");
      const Screen = mod.default;
      const { container } = renderScreen(Screen);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const html = container.innerHTML;
      // The legend at the top of the table explains the pills.
      expect(html).toContain("= from PO");
      expect(html).toContain("= operator override");
      // Reconciliation row text remains visible inside the
      // editable input.
      expect(html).toContain("Deep groove ball bearing");
      expect(html).toContain("BR-6204-ZZ");
    } finally {
      window.location.hash = original;
    }
  });
});
