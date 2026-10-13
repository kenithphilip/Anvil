// The po_extractor@v4 canary gate, through the real pipeline.
//
// v4 is the PO delivery date and contact treatment (plan PR 17). It carries
// no appended text: it names a feature that both adapters build from
// po-delivery-contact.js. run.js used to hand an adapter a variant only when it
// carried appended text, so a features-only row would have been recorded as
// "v4, variant" while the adapter ran the base prompt.
//
// runExtractionPipeline is driven for real with the dispatcher stubbed, and
// the test reads the hints the dispatcher was handed: what the adapters will
// actually be asked. Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ dispatchArgs: [] }));

vi.mock("../api/_lib/docai/text_layer.js", () => ({
  extractTextLayer: vi.fn(async () => ({
    ok: true, status: "has_text", page_count: 1, char_count: 40, body_text: "PURCHASE ORDER\nFixture Buyer\nPO No 8801\n",
    page_breakdown: [], extractor: "unpdf", extractor_version: "test", latency_ms: 1, error: null,
  })),
  extractTextBlocks: vi.fn(async () => null),
  contentHash: vi.fn(async () => "fixture_hash_delivery_contact"),
}));

vi.mock("../api/_lib/docai/ocr_layer.js", () => ({
  extractOcrLayer: vi.fn(async () => ({ ok: false, status: "failed", page_count: 0, char_count: 0, body_text: null, raw_pages: [], error: "stubbed" })),
}));

vi.mock("../api/_lib/docai/index.js", () => ({
  dispatchExtract: vi.fn(async (args) => {
    H.dispatchArgs.push(args);
    return {
      ok: true, adapter_used: "gemini", confidence_overall: 0.9, confidences: { overall: 0.9, "lines[0]": 0.9 },
      normalized: {
        classification: "po",
        customer: { name: "Fixture Buyer", po_number: "8801" },
        lines: [{ partNumber: "QX-1", quantity: 1, unitPrice: 10 }],
        stated_line_count: 1,
      },
      attempts: [{ adapter: "gemini", status: "ok" }], mode: "pre_extracted_text",
    };
  }),
  buildPromptOverrides: () => null,
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordEvent: vi.fn(async () => undefined),
  recordAudit: vi.fn(async () => undefined),
}));

const { runExtractionPipeline } = await import("../api/_lib/docai/run.js");
const { PO_DELIVERY_CONTACT_FEATURE } = await import("../api/_lib/docai/po-delivery-contact.js");
const { getPromptVersion, listPromptVersions, __test } = await import("../api/_lib/docai/prompt-versions.js");

// Minimal Supabase double: remembers every write, reads nothing back.
const makeSvc = () => {
  const writes = [];
  return {
    writes,
    from(table) {
      const api = {
        select() { return api; },
        eq() { return api; }, in() { return api; }, is() { return api; },
        gte() { return api; }, lte() { return api; }, order() { return api; }, limit() { return api; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        update(values) { writes.push({ table, op: "update", values }); return api; },
        upsert(values) { writes.push({ table, op: "upsert", values }); return Promise.resolve({ data: null, error: null }); },
        insert(values) {
          writes.push({ table, op: "insert", values });
          const row = { id: table === "extraction_runs" ? "run-1" : "id-x", ...values };
          return {
            select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
            then: (resolve) => { resolve({ data: [row], error: null }); return { catch: () => ({}) }; },
          };
        },
        then(resolve) { resolve({ data: [], error: null }); return { catch: () => ({}) }; },
      };
      return api;
    },
  };
};

const run = (svc, { settings = {}, hints = {}, kind = "po" } = {}) => runExtractionPipeline({
  ctx: { tenantId: "t1", user: { id: "u1" } },
  svc,
  settings,
  hints,
  bytes: Buffer.from("%PDF-1.4 fake"),
  filename: "po.pdf",
  mime: "application/pdf",
  sourceType: "pdf",
  kind,
});

const sentHints = () => H.dispatchArgs.at(-1)?.hints || {};
const recordedVersion = (svc) => svc.writes
  .find((w) => w.table === "extraction_runs" && w.op === "insert")?.values?.prompt_version;

beforeEach(() => {
  vi.clearAllMocks();
  H.dispatchArgs.length = 0;
});

describe("the v4 row", () => {
  it("is a canary that names the delivery-contact feature and appends no text", () => {
    const v4 = listPromptVersions("po_extractor").find((r) => r.version === "v4");
    expect(v4.status).toBe("canary");
    expect(v4.features).toEqual([PO_DELIVERY_CONTACT_FEATURE]);
    expect(v4.system_append).toBeUndefined();
    expect(v4.traffic_weight).toBeGreaterThan(0);
    expect(v4.traffic_weight).toBeLessThanOrEqual(0.1);
  });

  it("left v3's documents where they were: only documents on v1 move to v4", () => {
    // The split walks the live rows in array order. These are the arms v1 and
    // v3 had before v4 existed (0.90 and 0.10), on the same hash.
    const before = (key) => (__test.splitFraction("t1", key) <= 0.9 ? "v1" : "v3");
    let moved = 0;
    for (let i = 0; i < 4000; i++) {
      const key = "doc-" + i;
      const now = getPromptVersion("po_extractor", { tenantId: "t1", splitKey: key }).version;
      const was = before(key);
      if (was === "v3") expect(now).toBe("v3");
      if (now === "v3") expect(was).toBe("v3");
      if (now === "v4") { expect(was).toBe("v1"); moved++; }
    }
    expect(moved).toBeGreaterThan(0);
  });
});

describe("run.js hands the v4 treatment to the adapters only for a tenant that opted in", () => {
  it("off (the default): no variant reaches the adapters, and the run says it was not one", async () => {
    const svc = makeSvc();
    const result = await run(svc, { hints: { forcePromptVersion: "v4" } });
    expect(result.status).toBe("ok");
    expect(sentHints().promptVariant).toBeUndefined();
    expect(recordedVersion(svc)).toMatchObject({ name: "po_extractor", version: "v4", is_variant: false });
  });

  it("on: the adapters are handed the feature, and the run records a real variant", async () => {
    const svc = makeSvc();
    const result = await run(svc, { settings: { docai_prompt_variants: true }, hints: { forcePromptVersion: "v4" } });
    expect(result.status).toBe("ok");
    expect(sentHints().promptVariant).toEqual({
      name: "po_extractor", version: "v4", system_append: null, features: [PO_DELIVERY_CONTACT_FEATURE],
    });
    expect(recordedVersion(svc)).toMatchObject({ version: "v4", is_variant: true, label: "po_extractor@v4" });
  });

  it("on, but the document drew v1: nothing is handed down", async () => {
    const svc = makeSvc();
    await run(svc, { settings: { docai_prompt_variants: true }, hints: { forcePromptVersion: "v1" } });
    expect(sentHints().promptVariant).toBeUndefined();
  });

  it("on, with a tenant pin to v4: the pin is honoured the same way", async () => {
    const svc = makeSvc();
    await run(svc, { settings: { docai_prompt_variants: true, docai_prompt_pins: { po_extractor: "v4" } } });
    expect(sentHints().promptVariant?.features).toEqual([PO_DELIVERY_CONTACT_FEATURE]);
  });

  it("v3 still reaches the adapters as appended text, with no features key", async () => {
    const svc = makeSvc();
    await run(svc, { settings: { docai_prompt_variants: true }, hints: { forcePromptVersion: "v3" } });
    const v = sentHints().promptVariant;
    expect(v.version).toBe("v3");
    expect(v.system_append.length).toBeGreaterThan(0);
    expect(v).not.toHaveProperty("features");
  });
});
