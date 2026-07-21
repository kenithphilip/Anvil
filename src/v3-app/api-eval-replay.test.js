// CM P4: live-model replay — re-runs the model on a golden's source bytes and
// scores model-owned fields. chunkedExtract / tenantSettings / safeFetch are
// mocked so the orchestration (fetch → extract → score → attest) is driven
// without storage, credentials, or LLM calls.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_lib/docai/chunked-extract.js", () => ({ chunkedExtract: vi.fn() }));
vi.mock("../api/_lib/stripe-client.js", () => ({
  tenantSettings: vi.fn(async () => ({ tenant_id: "src", docai_provider_order: ["gemini"] })),
}));
vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer })),
}));

import { chunkedExtract } from "../api/_lib/docai/chunked-extract.js";
import { tenantSettings } from "../api/_lib/stripe-client.js";
import { replayGoldens, modelOwnedExpected, fetchDocBytes } from "../api/eval/replay.js";

const goodExtract = (lines, extra = {}) => ({
  ok: true,
  selected_model: "gemini-3-flash",
  model_selection_reason: "default",
  normalized: { classification: "po", customer: { po_number: "PO-1", name: "ACME" }, lines },
  ...extra,
});

const makeSvc = (cases, docRow) => ({
  from(table) {
    const b = {
      select() { return b; }, eq() { return b; }, limit() { return b; },
      insert() { return b; }, single() { return b; }, maybeSingle() { return b; },
      then(resolve) {
        if (table === "eval_cases") return Promise.resolve({ data: cases, error: null }).then(resolve);
        if (table === "documents") return Promise.resolve({ data: docRow, error: null }).then(resolve);
        if (table === "eval_runs") return Promise.resolve({ data: { id: "run-1" }, error: null }).then(resolve);
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  },
  storage: { from() { return { createSignedUrl: async () => ({ data: { signedUrl: "https://x/y" }, error: null }) }; } },
});

const caseWithDoc = () => ({
  case_id: "A",
  documents: [{ documentId: "doc-1", role: "purchase_order", sha256: "abc" }],
  expected: {
    poNumber: "PO-1", customer: "ACME",
    lineItems: [{ partNo: "A", qty: 1, rate: 10 }],
    _provenance: { source_tenant_id: "src", customer_id: "c1" },
  },
});
const docRow = { storage_bucket: "anvil-documents", storage_path: "p/1.pdf", mime_type: "application/pdf", filename: "1.pdf", sha256: "abc" };

beforeEach(() => { vi.clearAllMocks(); tenantSettings.mockResolvedValue({ tenant_id: "src", docai_provider_order: ["gemini"] }); });

describe("modelOwnedExpected", () => {
  it("drops grandTotal, _provenance, and per-line hsn (deterministic enrichment)", () => {
    const out = modelOwnedExpected({
      poNumber: "PO-1", grandTotal: 5000, _provenance: { order_id: "o1" },
      lineItems: [{ partNo: "A", qty: 1, rate: 10, hsn: "8482" }],
    });
    expect(out.grandTotal).toBeUndefined();
    expect(out._provenance).toBeUndefined();
    expect(out.lineItems[0].hsn).toBeUndefined();
    expect(out.lineItems[0]).toEqual({ partNo: "A", qty: 1, rate: 10 });   // model-owned fields kept
    expect(out.poNumber).toBe("PO-1");
  });
});

describe("fetchDocBytes", () => {
  it("resolves a document's bytes via signed URL", async () => {
    const src = await fetchDocBytes(makeSvc([], docRow), "src", "doc-1");
    expect(src).toBeTruthy();
    expect(src.mime).toBe("application/pdf");
    expect(src.bytes.length).toBe(4);
  });
});

describe("replayGoldens", () => {
  it("re-extracts, scores model-owned fields, and reports line-recall (no regression on a clean replay)", async () => {
    chunkedExtract.mockResolvedValue(goodExtract([{ partNumber: "A", quantity: 1, unitPrice: 10 }]));
    const report = await replayGoldens(makeSvc([caseWithDoc()], docRow), { tenantId: "corpus" });
    expect(report.scored).toBe(1);
    expect(report.line_recall_avg).toBe(1);
    expect(report.regression).toBe(false);
    expect(report.models).toEqual({ "gemini-3-flash": 1 });
    expect(report.cases[0].model).toBe("gemini-3-flash");
    // tenant_id is stripped from the settings handed to the model (zero-write).
    expect(chunkedExtract.mock.calls[0][0].settings.tenant_id).toBeUndefined();
  });

  it("flags a regression when the live model drops lines below the recall floor", async () => {
    chunkedExtract.mockResolvedValue(goodExtract([]));   // model returned 0 of 1 lines
    const report = await replayGoldens(makeSvc([caseWithDoc()], docRow), { tenantId: "corpus", lineRecallFloor: 0.95 });
    expect(report.line_recall_avg).toBe(0);
    expect(report.regression).toBe(true);
  });

  it("skips a golden with no resolvable source document", async () => {
    const noDoc = { case_id: "B", documents: [], expected: { poNumber: "PO-2", lineItems: [{ partNo: "Z" }], _provenance: {} } };
    const report = await replayGoldens(makeSvc([noDoc], null), { tenantId: "corpus" });
    expect(report.scored).toBe(0);
    expect(report.skipped[0].reason).toBe("no_source_document");
    expect(chunkedExtract).not.toHaveBeenCalled();
  });

  it("skips (does not score) when the live extraction fails", async () => {
    chunkedExtract.mockResolvedValue({ ok: false, reason: "upstream_error", selected_model: "gemini-3-flash" });
    const report = await replayGoldens(makeSvc([caseWithDoc()], docRow), { tenantId: "corpus" });
    expect(report.scored).toBe(0);
    expect(report.skipped[0].reason).toBe("upstream_error");
  });
});
