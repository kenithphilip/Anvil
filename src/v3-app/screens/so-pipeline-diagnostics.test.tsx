// Pipeline Diagnostics tab + intake docai-not-configured banner.
//
// Phase 3.6 observability tests. Covers the two operator-visible
// surfaces that landed with the audit-close: the workspace's
// Pipeline Diagnostics tab (reads /api/orders/<id>/pipeline-state)
// and the intake's pre-flight warning when no docai adapter is
// configured.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  if (!("arrayBuffer" in Blob.prototype)) {
    Object.defineProperty(Blob.prototype, "arrayBuffer", {
      value: function () { return Promise.resolve(new ArrayBuffer(0)); },
      writable: true, configurable: true,
    });
  }
});

describe("Pipeline Diagnostics tab (S4 of audit-close)", () => {
  it("renders the latest-run banner + adapter chain + extraction runs + events", async () => {
    const orderId = "ord-fixture-diag-1";
    const order = {
      id: orderId,
      status: "DRAFT",
      po_number: "PO-DIAG-1",
      customer_id: "cust-1",
      result: { salesOrder: { lineItems: [] } },
      preflight_payload: { source_document_id: "doc-1" },
      documents: [{ id: "doc-1" }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const pipelineState = {
      order: {
        id: orderId, status: "DRAFT", customer_id: "cust-1",
        lines_count: 0,
        preflight_payload: { source_document_id: "doc-1" },
      },
      document: {
        id: "doc-1",
        filename: "po-broken.pdf",
        mime_type: "application/pdf",
        size_bytes: 84321,
        scan_status: "unverified",
        scan_threats: [],
      },
      extraction_runs: [
        {
          id: "run-1",
          source_id: "doc-1",
          source_type: "pdf",
          status: "failed",
          status_reason: "image_pdf_no_text",
          adapter_used: "claude",
          adapter_attempts: [{ adapter: "claude", status: "ok" }],
          confidence_overall: 0.42,
          finished_at: new Date().toISOString(),
          normalized_extract: { classification: "non_po", customer: null, lines: [] },
          raw_extract: { stop_reason: "end_turn" },
          // Phase B-F: full per-run signal set the diagnostics tab now
          // renders. Mirrors what /api/orders/<id>/pipeline-state returns.
          validator_issues: [],
          validator_summary: { error: 0, warn: 0, info: 0, total: 0 },
          text_layer_used: false,
          ocr_layer_used: true,
          template_used: null,
          overrides_applied: [],
          field_provenance: [],
          voter_lines: [],
          voter_used: false,
          extraction_kind: "po",
          // Phase Cost-Opt: deterministic model selector picked
          // Sonnet because the L2 OCR layer fed the prompt.
          selected_model: "claude-sonnet-4-20250514",
          model_selection_reason: "ocr_derived_text",
        },
      ],
      processing_events: [
        { id: "e1", event_type: "docai_extract_started", object_type: "extraction_run", object_id: "run-1", case_id: orderId, detail: { source_type: "pdf" }, created_at: new Date().toISOString() },
        { id: "e2", event_type: "docai_extract_failed",  object_type: "extraction_run", object_id: "run-1", case_id: orderId, detail: { status_reason: "image_pdf_no_text" }, created_at: new Date().toISOString() },
      ],
      ocr_runs: [],
      adapter_chain: [
        { name: "reducto",  configured_hint: false },
        { name: "azure_di", configured_hint: false },
        { name: "claude",   configured_hint: true },
      ],
      latest_run_summary: {
        run_id: "run-1",
        status: "failed",
        status_reason: "image_pdf_no_text",
        adapter_used: "claude",
        confidence_overall: 0.42,
        finished_at: new Date().toISOString(),
        validator_summary: { error: 0, warn: 0, info: 0, total: 0 },
        text_layer_used: false,
        ocr_layer_used: true,
        template_used: null,
        voter_used: false,
        overrides_applied_count: 0,
        extraction_kind: "po",
        selected_model: "claude-sonnet-4-20250514",
        model_selection_reason: "ocr_derived_text",
      },
      text_layer: {
        text_status: "image_only",
        page_count: 3,
        char_count: 12,
        page_breakdown: [],
        extractor: "unpdf",
        latency_ms: 14,
        created_at: new Date().toISOString(),
      },
      ocr_layer: {
        ocr_status: "ok",
        page_count: 3,
        char_count: 4231,
        page_breakdown: [],
        bbox_count: 87,
        provider: "mistral",
        provider_model: "mistral-ocr-latest",
        latency_ms: 1200,
        created_at: new Date().toISOString(),
      },
    };
    const original = window.location.hash;
    try {
      window.location.hash = "#/so?id=" + orderId + "&tab=diagnostics";
      installBackend({
        orders: {
          get: vi.fn(async () => ({ order })),
          update: vi.fn(async () => ({})),
          pipelineState: vi.fn(async () => pipelineState),
        },
        audit: { list: vi.fn(async () => []) },
        events: { list: vi.fn(async () => []) },
        cost: { breakdown: vi.fn(async () => null) },
      });
      const mod = await import("./so-workspace");
      const { container } = renderScreen(mod.default);
      // First click the Diagnostics tab; it lazy-loads the
      // pipeline-state on first open.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      // Wait for the diagnostics fetch + render.
      await waitFor(() => {
        expect(container.innerHTML).toContain("Latest extraction:");
      }, { timeout: 2000 });
      const html = container.innerHTML;
      // Latest-run banner says "Image-only PDF · no text layer".
      expect(html).toContain("Image-only PDF");
      // Adapter chain lists Claude as configured.
      expect(html).toContain("claude");
      // Filename + scan_status visible.
      expect(html).toContain("po-broken.pdf");
      expect(html).toContain("unverified");
      // Extraction runs row shows the structured reason.
      expect(html).toContain("image_pdf_no_text");
      // Events table shows the started + failed events.
      expect(html).toContain("docai_extract_started");
      expect(html).toContain("docai_extract_failed");
      // Phase B-F: the diagnostics tab renders the new "Pipeline
      // layers" card with L1 / L2 / L3 / L6 / E status, plus per-run
      // Layers + Validator columns. The fixture above sets
      // ocr_layer_used=true on the run so the layers cell shows L2.
      expect(html).toContain("Pipeline layers");
      expect(html).toContain("L2 OCR layer");
      expect(html).toContain("Layers");
      expect(html).toContain("Validator");
      // Phase Cost-Opt: the diagnostics tab surfaces which LLM
      // model the deterministic selector picked + why.
      expect(html).toContain("LLM model used");
      expect(html).toContain("ocr_derived_text");
    } finally { window.location.hash = original; }
  });
});

describe("Intake pre-flight: no docai adapter warning", () => {
  it("shows the warning Banner when no adapter is configured", async () => {
    installBackend({
      health: async () => ({
        integrations: [
          { id: "clamav", configured: false },
          { id: "claude", configured: false },
          { id: "reducto", configured: false },
          { id: "azure_di", configured: false },
        ],
      }),
      customers: { list: async () => ({ customers: [] }) },
      documents: { upload: async () => ({ documentId: "doc-x" }), extract: async () => ({}) },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    await waitFor(() => {
      expect(container.innerHTML).toContain("No docai adapter configured");
    }, { timeout: 2000 });
  });

  it("does NOT show the warning when at least one adapter is configured", async () => {
    installBackend({
      health: async () => ({
        integrations: [
          { id: "clamav", configured: false },
          { id: "claude", configured: true },
        ],
      }),
      customers: { list: async () => ({ customers: [] }) },
      documents: { upload: async () => ({ documentId: "doc-x" }), extract: async () => ({}) },
    });
    const mod = await import("./so-intake");
    const { container } = renderScreen(mod.default);
    // Wait a tick so the health probe lands.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).not.toContain("No docai adapter configured");
  });
});
