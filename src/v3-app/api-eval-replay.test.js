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
// The handler's own collaborators, so the real default export can be driven.
// handlerSvc is whatever the test under way has installed.
let handlerSvc = null;
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ tenantId: "corpus", user: { id: "op-1" } })),
  requirePermission: vi.fn(),
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => handlerSvc }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

import { chunkedExtract } from "../api/_lib/docai/chunked-extract.js";
import { tenantSettings } from "../api/_lib/stripe-client.js";
import { recordAudit } from "../api/_lib/audit.js";
import { listPromptVersions, resolvePromptVersion } from "../api/_lib/docai/prompt-versions.js";
import replayHandler, { replayGoldens, modelOwnedExpected, fetchDocBytes } from "../api/eval/replay.js";

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

// A svc that also records which tables were touched and what eval_runs got,
// so a test can say that a refused replay read and wrote nothing.
const recordingSvc = (cases, doc) => {
  const log = { tables: [], evalRunInserts: [] };
  const base = makeSvc(cases, doc);
  return {
    log,
    storage: base.storage,
    from(table) {
      log.tables.push(table);
      const b = base.from(table);
      const insert = b.insert;
      b.insert = (row) => { if (table === "eval_runs") log.evalRunInserts.push(row); return insert(row); };
      return b;
    },
  };
};

const poCase = (caseId, customerId) => ({
  case_id: caseId,
  documents: [{ documentId: "doc-" + caseId, role: "purchase_order", sha256: "h-" + caseId }],
  expected: {
    poNumber: "PO-1", customer: "ACME",
    lineItems: [{ partNo: "A", qty: 1, rate: 10 }],
    _provenance: { source_tenant_id: "src", customer_id: customerId },
  },
});

// Replay passes no splitKey, so the split is keyed on (source tenant,
// customer). Pick one customer the split sends to the v3 canary and one it
// keeps on v1, so every test below covers both arms.
const customerOnArm = (version) => {
  for (let i = 0; i < 500; i++) {
    const id = "cust-" + i;
    if (resolvePromptVersion("po_extractor", { tenantId: "src", customerId: id }).version === version) return id;
  }
  return null;
};
const CANARY_CUSTOMER = customerOnArm("v3");
const CONTROL_CUSTOMER = customerOnArm("v1");
const V3_APPEND = listPromptVersions("po_extractor").find((r) => r.version === "v3").system_append;

const post = async (body) => {
  const req = { method: "POST", headers: {}, body };
  const res = {
    statusCode: 0, payload: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    send(text) { this.payload = JSON.parse(text); return this; },
    json(obj) { this.payload = obj; return this; },
  };
  await replayHandler(req, res);
  return res;
};

describe("prompt_version through the handler", () => {
  it("both arms of the split are represented, or nothing below means anything", () => {
    expect(CANARY_CUSTOMER).toMatch(/^cust-/);
    expect(CONTROL_CUSTOMER).toMatch(/^cust-/);
    expect(V3_APPEND.length).toBeGreaterThan(0);
  });

  it("refuses an unknown version with 400 and the allowed versions, and replays nothing", async () => {
    chunkedExtract.mockResolvedValue(goodExtract([{ partNumber: "A", quantity: 1, unitPrice: 10 }]));
    handlerSvc = recordingSvc([poCase("A", CANARY_CUSTOMER), poCase("B", CONTROL_CUSTOMER)], docRow);
    const res = await post({ prompt_version: "v9" });

    expect(res.statusCode).toBe(400);
    expect(res.payload.error.allowed_versions).toEqual(listPromptVersions("po_extractor").map((r) => r.version));
    expect(res.payload.error.allowed_versions).toContain("v1");
    expect(res.payload.error.allowed_versions).toContain("v3");
    expect(res.payload.error.message).toContain("v9");
    expect(chunkedExtract).not.toHaveBeenCalled();
    expect(handlerSvc.log.tables).toEqual([]);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses any version for a suite whose kind runs no versioned prompt", async () => {
    // The quote prompt is not in the registry, so "v3" would replay the base
    // quote prompt under a v3 label.
    handlerSvc = recordingSvc([poCase("A", CANARY_CUSTOMER)], docRow);
    const res = await post({ suite: "quote-extraction", prompt_version: "v3" });

    expect(res.statusCode).toBe(400);
    expect(res.payload.error.allowed_versions).toEqual([]);
    expect(chunkedExtract).not.toHaveBeenCalled();
    expect(handlerSvc.log.tables).toEqual([]);
  });

  it("forcing v3 runs v3 on every case, including the customer the split keeps on v1", async () => {
    chunkedExtract.mockResolvedValue(goodExtract([{ partNumber: "A", quantity: 1, unitPrice: 10 }]));
    handlerSvc = recordingSvc([poCase("A", CANARY_CUSTOMER), poCase("B", CONTROL_CUSTOMER)], docRow);
    const res = await post({ prompt_version: "v3" });

    expect(res.statusCode).toBe(200);
    expect(res.payload.scored).toBe(2);
    expect(chunkedExtract).toHaveBeenCalledTimes(2);
    const calls = chunkedExtract.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.customerId).sort()).toEqual([CANARY_CUSTOMER, CONTROL_CUSTOMER].sort());
    for (const call of calls) {
      expect(call.hints.expectedKind).toBe("po");
      expect(call.hints.promptVariant).toEqual({ name: "po_extractor", version: "v3", system_append: V3_APPEND });
    }
    expect(handlerSvc.log.evalRunInserts).toHaveLength(1);
    expect(handlerSvc.log.evalRunInserts[0].prompt_version).toBe("live-replay:prompt:v3");
  });

  it("forcing v1 runs the base prompt on every case, including the customer the split sends to the canary", async () => {
    chunkedExtract.mockResolvedValue(goodExtract([{ partNumber: "A", quantity: 1, unitPrice: 10 }]));
    handlerSvc = recordingSvc([poCase("A", CANARY_CUSTOMER), poCase("B", CONTROL_CUSTOMER)], docRow);
    const res = await post({ prompt_version: "v1" });

    expect(res.statusCode).toBe(200);
    expect(res.payload.scored).toBe(2);
    expect(chunkedExtract).toHaveBeenCalledTimes(2);
    const calls = chunkedExtract.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.customerId).sort()).toEqual([CANARY_CUSTOMER, CONTROL_CUSTOMER].sort());
    for (const call of calls) {
      expect(call.hints).toEqual({ expectedKind: "po" });
    }
    expect(handlerSvc.log.evalRunInserts).toHaveLength(1);
    expect(handlerSvc.log.evalRunInserts[0].prompt_version).toBe("live-replay:prompt:v1");
  });
});

describe("replayGoldens never lets the split stand in for a forced version", () => {
  it("refuses every case when the version is not in the registry, rather than letting the split pick", async () => {
    // The pure core is exported and callable without the handler, so it keeps
    // its own guard. Before it, the canary customer's case ran v3 here.
    chunkedExtract.mockResolvedValue(goodExtract([{ partNumber: "A", quantity: 1, unitPrice: 10 }]));
    const svc = recordingSvc([poCase("A", CANARY_CUSTOMER), poCase("B", CONTROL_CUSTOMER)], docRow);
    const report = await replayGoldens(svc, { tenantId: "corpus", promptVersion: "v9" });

    expect(chunkedExtract).not.toHaveBeenCalled();
    expect(report.scored).toBe(0);
    expect(report.skipped).toEqual([
      { case_id: "A", reason: "prompt_version_not_applicable: v9 for kind po" },
      { case_id: "B", reason: "prompt_version_not_applicable: v9 for kind po" },
    ]);
    expect(svc.log.evalRunInserts).toEqual([]);
  });

  it("refuses a case whose kind has no registry prompt instead of running it unversioned under the variant's name", async () => {
    chunkedExtract.mockResolvedValue(goodExtract([{ partNumber: "A", quantity: 1, unitPrice: 10 }]));
    const quoteCase = {
      case_id: "Q",
      documents: [{ documentId: "doc-Q", role: "quote", sha256: "h-Q" }],
      expected: {
        quoteNumber: "Q-1",
        lineItems: [{ partNo: "A", qty: 1, rate: 10 }],
        _provenance: { source_tenant_id: "src", customer_id: CONTROL_CUSTOMER, extraction_kind: "quote" },
      },
    };
    const svc = recordingSvc([poCase("A", CONTROL_CUSTOMER), quoteCase], docRow);
    const report = await replayGoldens(svc, { tenantId: "corpus", promptVersion: "v3" });

    expect(chunkedExtract).toHaveBeenCalledTimes(1);
    expect(chunkedExtract.mock.calls[0][0].hints.promptVariant.version).toBe("v3");
    expect(report.scored).toBe(1);
    expect(report.cases.map((c) => c.case_id)).toEqual(["A"]);
    expect(report.skipped).toEqual([{ case_id: "Q", reason: "prompt_version_not_applicable: v3 for kind quote" }]);
    expect(svc.log.evalRunInserts[0].prompt_version).toBe("live-replay:prompt:v3");
  });
});
