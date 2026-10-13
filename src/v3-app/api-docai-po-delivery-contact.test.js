// The PO's delivery date and the buyer's contact person, read by BOTH LLM PO
// adapters from one shared rule and three schema slots (plan PR 17,
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md 4.6).
//
// claude.js told the model a "Delivery date :..." line in a description cell
// is boilerplate, and gemini.js, which runs FIRST for POs, had no slot for a
// date at all. That is the fifth claude/gemini drift. So these tests drive
// each adapter's real extract() with the network stubbed and assert on what it
// actually SENDS (the prompt and the schema) and what it RETURNS, as the
// requisition (#550) and continuation-row (#559) parity tests do.
//
// The change is behind the po_extractor@v4 canary. The variant hint below is
// resolved from the real registry, so the registry row and the adapters are
// tested together. Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ anthropicArgs: null, geminiBodies: [], reply: null }));

vi.mock("../api/_lib/anthropic.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callAnthropic: vi.fn(async (args) => {
      H.anthropicArgs = args;
      return {
        ok: true,
        status: 200,
        data: { stop_reason: "tool_use", content: [{ type: "tool_use", name: args.tool_choice.name, input: H.reply }] },
      };
    }),
  };
});

vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: async (_url, init) => {
    H.geminiBodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(H.reply) }] }, finishReason: "STOP" }],
      }),
    };
  },
}));

const claude = await import("../api/_lib/docai/claude.js");
const gemini = await import("../api/_lib/docai/gemini.js");
const { toGeminiSchema } = await import("../api/_lib/gemini.js");
const { getPromptVersion } = await import("../api/_lib/docai/prompt-versions.js");
const { canonicaliseLine } = await import("../api/_lib/docai/line-schema.js");
const DC = await import("../api/_lib/docai/po-delivery-contact.js");

// A PO whose header prints a delivery date and a contact person with a phone,
// and whose lines print their own dates in two formats. One line prints none.
const REPLY = {
  classification: "po",
  confidence: 0.95,
  customer: {
    name: "Fixture Buyer Works Pvt Ltd",
    po_number: "PO-8801",
    phone: "  +91 20 2712 3456 ",
    contact_name: "  Ms.  P. Iyer ",
    delivery_date: "15/11/2026",
  },
  lines: [
    { partNumber: "QX-1", description: "Guide pin", quantity: 2, unitPrice: 100, delivery_date: "02-12-2026" },
    { partNumber: "QX-2", description: "Clamp", quantity: 1, unitPrice: 50, delivery_date: "20 Nov 2026" },
    { partNumber: "QX-3", description: "Spacer", quantity: 5, unitPrice: 10 },
  ],
  stated_line_count: 3,
};

// The same PO read on the base prompt: no slot was asked for, so none came back.
const BASE_REPLY = {
  classification: "po",
  confidence: 0.95,
  customer: { name: "Fixture Buyer Works Pvt Ltd", po_number: "PO-8801", phone: "020-2712 3456 / 98200 12345" },
  lines: [{ partNumber: "QX-1", description: "Guide pin", quantity: 2, unitPrice: 100 }],
  stated_line_count: 1,
};

const settings = { tenant_id: "t-1" };

// The hint run.js builds for a tenant on the canary whose document drew v4.
const v4Hint = () => {
  const c = getPromptVersion("po_extractor", { tenantId: "t-1", forceVersion: "v4", allowVariants: true });
  return { name: c.name, version: c.version, system_append: c.system_append, features: c.features };
};
const hintsFor = (extra = {}) => ({ bodyText: "fixture purchase order text", expectedKind: "po", ...extra });

beforeEach(() => {
  H.anthropicArgs = null;
  H.geminiBodies.length = 0;
  H.reply = REPLY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-key";
});

const sentClaudeSystemText = () => (H.anthropicArgs?.system || [])
  .map((b) => (typeof b === "string" ? b : b.text || "")).join("\n");
const sentGeminiSystemText = () => (H.geminiBodies[0]?.systemInstruction?.parts || [])
  .map((p) => p.text || "").join("\n");
const sentClaudeSchema = () => H.anthropicArgs.tools[0].input_schema;
const sentGeminiSchema = () => H.geminiBodies[0].generationConfig.responseSchema;

describe("on the v4 canary, both adapters send the one shared rule", () => {
  it("claude sends it", async () => {
    const out = await claude.extract({ settings, hints: hintsFor({ promptVariant: v4Hint() }) });
    expect(out.ok).toBe(true);
    expect(sentClaudeSystemText()).toContain(DC.PO_DELIVERY_CONTACT_RULE);
  });

  it("gemini, which runs first for POs, sends the identical string", async () => {
    const out = await gemini.extract({ settings, hints: hintsFor({ promptVariant: v4Hint() }) });
    expect(out.ok).toBe(true);
    expect(sentGeminiSystemText()).toContain(DC.PO_DELIVERY_CONTACT_RULE);
  });

  it("the rule names the three slots, stops the delivery line being boilerplate, and keeps our own contact out", () => {
    const rule = DC.PO_DELIVERY_CONTACT_RULE;
    expect(rule).toMatch(/customer\.delivery_date/);
    expect(rule).toMatch(/lines\[\]\.delivery_date/);
    expect(rule).toMatch(/customer\.contact_name/);
    expect(rule).toMatch(/NOT boilerplate for this slot/);
    expect(rule).toMatch(/never copy\s+customer\.delivery_date onto a line/);
    expect(rule).toMatch(/NEVER a\s+person printed in the supplier/);
  });
});

describe("on the v4 canary, both adapters declare the three slots", () => {
  it("claude's tool schema, as sent, has them, on the PO tool, with lines still closed", async () => {
    await claude.extract({ settings, hints: hintsFor({ promptVariant: v4Hint() }) });
    expect(H.anthropicArgs.tools[0].name).toBe("extract_purchase_order");
    const s = sentClaudeSchema();
    expect(s.properties.customer.properties.contact_name).toEqual(DC.PO_DELIVERY_CONTACT_SLOTS.customer.contact_name);
    expect(s.properties.customer.properties.delivery_date).toEqual(DC.PO_DELIVERY_CONTACT_SLOTS.customer.delivery_date);
    expect(s.properties.lines.items.properties.delivery_date).toEqual(DC.PO_DELIVERY_CONTACT_SLOTS.line.delivery_date);
    // A line is additionalProperties:false, which is why a slot that is not
    // declared can never be filled.
    expect(s.properties.lines.items.additionalProperties).toBe(false);
    // The existing slots are all still there.
    expect(s.properties.lines.items.properties.requisition_no).toBeDefined();
    expect(s.properties.customer.properties.phone).toBeDefined();
  });

  it("gemini's responseSchema, as sent, has the same three slots after conversion", async () => {
    await gemini.extract({ settings, hints: hintsFor({ promptVariant: v4Hint() }) });
    const s = sentGeminiSchema();
    expect(s.properties.customer.properties.contact_name).toEqual(toGeminiSchema(DC.PO_DELIVERY_CONTACT_SLOTS.customer.contact_name));
    expect(s.properties.customer.properties.delivery_date).toEqual(toGeminiSchema(DC.PO_DELIVERY_CONTACT_SLOTS.customer.delivery_date));
    expect(s.properties.lines.items.properties.delivery_date).toEqual(toGeminiSchema(DC.PO_DELIVERY_CONTACT_SLOTS.line.delivery_date));
    expect(s.properties.lines.items.properties.delivery_date).toMatchObject({ type: "string", nullable: true });
  });

  it("the two sends declare identical slots", async () => {
    await claude.extract({ settings, hints: hintsFor({ promptVariant: v4Hint() }) });
    await gemini.extract({ settings, hints: hintsFor({ promptVariant: v4Hint() }) });
    const c = sentClaudeSchema();
    const g = sentGeminiSchema();
    for (const k of ["contact_name", "delivery_date"]) {
      expect(g.properties.customer.properties[k]).toEqual(toGeminiSchema(c.properties.customer.properties[k]));
    }
    expect(g.properties.lines.items.properties.delivery_date)
      .toEqual(toGeminiSchema(c.properties.lines.items.properties.delivery_date));
  });

  it("an RFQ is read by the PO prompt, so it gets them too", async () => {
    await claude.extract({ settings, hints: hintsFor({ expectedKind: "rfq", promptVariant: v4Hint() }) });
    await gemini.extract({ settings, hints: hintsFor({ expectedKind: "rfq", promptVariant: v4Hint() }) });
    expect(sentClaudeSchema().properties.customer.properties.contact_name).toBeDefined();
    expect(sentGeminiSchema().properties.customer.properties.contact_name).toBeDefined();
    expect(sentClaudeSystemText()).toContain(DC.PO_DELIVERY_CONTACT_RULE);
    expect(sentGeminiSystemText()).toContain(DC.PO_DELIVERY_CONTACT_RULE);
  });
});

describe("the normalised output is the same from both adapters", () => {
  const run = async () => {
    const c = await claude.extract({ settings, hints: hintsFor({ promptVariant: v4Hint() }) });
    const g = await gemini.extract({ settings, hints: hintsFor({ promptVariant: v4Hint() }) });
    expect(c.ok).toBe(true);
    expect(g.ok).toBe(true);
    return { c: c.normalized, g: g.normalized };
  };

  it("dates go to ISO day-first, the phone keeps its printed form and gains its digits, the name is tidied", async () => {
    const { c, g } = await run();
    const expected = {
      contact_name: "Ms. P. Iyer",
      delivery_date: "2026-11-15",
      phone: "+91 20 2712 3456",
      phone_digits: "912027123456",
    };
    expect(c.customer).toMatchObject(expected);
    expect(g.customer).toMatchObject(expected);
    expect(c.lines.map((l) => l.delivery_date)).toEqual(["2026-12-02", "2026-11-20", null]);
    expect(g.lines.map((l) => l.delivery_date)).toEqual(["2026-12-02", "2026-11-20", null]);
  });

  it("both adapters return the same customer and lines, field for field", async () => {
    const { c, g } = await run();
    expect(c.customer).toEqual(g.customer);
    expect(c.lines).toEqual(g.lines);
  });

  it("each slot is present on the canary, null when the PO printed none", async () => {
    H.reply = { ...REPLY, customer: { name: "Fixture Buyer Works Pvt Ltd" }, lines: [{ partNumber: "QX-9", quantity: 1, unitPrice: 5 }] };
    const { c, g } = await run();
    for (const n of [c, g]) {
      expect(n.customer).toMatchObject({ contact_name: null, delivery_date: null });
      expect(n.lines[0]).toHaveProperty("delivery_date", null);
    }
  });

  it("the line field crosses the dispatcher's conformance step as a known field", async () => {
    const { c, g } = await run();
    for (const n of [c, g]) {
      const { line, unknown } = canonicaliseLine(n.lines[0]);
      expect(line.delivery_date).toBe("2026-12-02");
      expect(unknown).toEqual([]);
    }
  });
});

describe("canary off: both adapters send today's prompt and schema", () => {
  it("claude sends the base tool, unchanged, and no rule", async () => {
    H.reply = BASE_REPLY;
    const out = await claude.extract({ settings, hints: hintsFor() });
    expect(out.ok).toBe(true);
    expect(H.anthropicArgs.tools[0]).toEqual(claude.TOOL_DEFINITION);
    expect(sentClaudeSchema().properties.customer.properties.contact_name).toBeUndefined();
    expect(sentClaudeSchema().properties.lines.items.properties.delivery_date).toBeUndefined();
    expect(sentClaudeSystemText()).not.toContain(DC.PO_DELIVERY_CONTACT_RULE);
  });

  it("gemini sends the base schema, unchanged, and no rule", async () => {
    H.reply = BASE_REPLY;
    const out = await gemini.extract({ settings, hints: hintsFor() });
    expect(out.ok).toBe(true);
    expect(sentGeminiSchema()).toEqual(toGeminiSchema(gemini.PO_SCHEMA));
    expect(sentGeminiSchema().properties.customer.properties.contact_name).toBeUndefined();
    expect(sentGeminiSystemText()).not.toContain(DC.PO_DELIVERY_CONTACT_RULE);
  });

  it("building the canary schemas left the exported base schemas as they were", () => {
    expect(claude.TOOL_DEFINITION.input_schema.properties.customer.properties.contact_name).toBeUndefined();
    expect(claude.TOOL_DEFINITION.input_schema.properties.lines.items.properties.delivery_date).toBeUndefined();
    expect(gemini.PO_SCHEMA.properties.customer.properties.delivery_date).toBeUndefined();
    expect(gemini.PO_SCHEMA.properties.lines.items.properties.delivery_date).toBeUndefined();
  });

  it("a slot that was not asked for stays absent, and the phone still gains its digits, from both", async () => {
    H.reply = BASE_REPLY;
    const c = (await claude.extract({ settings, hints: hintsFor() })).normalized;
    const g = (await gemini.extract({ settings, hints: hintsFor() })).normalized;
    for (const n of [c, g]) {
      expect(n.customer).not.toHaveProperty("contact_name");
      expect(n.customer).not.toHaveProperty("delivery_date");
      expect(n.lines[0]).not.toHaveProperty("delivery_date");
      // Two numbers printed: the first one, never the two run together.
      expect(n.customer.phone).toBe("020-2712 3456 / 98200 12345");
      expect(n.customer.phone_digits).toBe("02027123456");
    }
    expect(c.customer).toEqual(g.customer);
  });

  it("the registry withholds the feature from a tenant that did not opt in", () => {
    const off = getPromptVersion("po_extractor", { tenantId: "t-1", forceVersion: "v4" });
    expect(off.version).toBe("v4");
    expect(off.is_variant).toBe(false);
    expect(off.features).toBeNull();
    const on = getPromptVersion("po_extractor", { tenantId: "t-1", forceVersion: "v4", allowVariants: true });
    expect(on.is_variant).toBe(true);
    expect(on.features).toEqual([DC.PO_DELIVERY_CONTACT_FEATURE]);
    expect(on.system_append).toBeNull();
  });
});

describe("the treatment is scoped to the feature and to the PO prompt", () => {
  it("another variant (v3, appended text only) does not bring the slots or the rule", async () => {
    const v3 = getPromptVersion("po_extractor", { tenantId: "t-1", forceVersion: "v3", allowVariants: true });
    const hint = { name: v3.name, version: v3.version, system_append: v3.system_append };
    await claude.extract({ settings, hints: hintsFor({ promptVariant: hint }) });
    await gemini.extract({ settings, hints: hintsFor({ promptVariant: hint }) });
    expect(H.anthropicArgs.tools[0]).toEqual(claude.TOOL_DEFINITION);
    expect(sentGeminiSchema()).toEqual(toGeminiSchema(gemini.PO_SCHEMA));
    expect(sentClaudeSystemText()).not.toContain(DC.PO_DELIVERY_CONTACT_RULE);
    expect(sentGeminiSystemText()).not.toContain(DC.PO_DELIVERY_CONTACT_RULE);
  });

  it("claude: a quote run handed the v4 hint sends the quote tool unchanged and no rule", async () => {
    await claude.extract({ settings, hints: hintsFor({ expectedKind: "quote", promptVariant: v4Hint() }) });
    expect(H.anthropicArgs.tools[0].name).toBe("extract_quote");
    expect(H.anthropicArgs.tools[0].input_schema.properties.customer?.properties?.contact_name).toBeUndefined();
    expect(sentClaudeSystemText()).not.toContain(DC.PO_DELIVERY_CONTACT_RULE);
  });

  it("gemini: a supplier-ack run handed the v4 hint sends the ack schema and no rule", async () => {
    await gemini.extract({ settings, hints: hintsFor({ expectedKind: "supplier_ack", promptVariant: v4Hint() }) });
    expect(sentGeminiSchema().properties.line_acks).toBeDefined();
    expect(sentGeminiSchema().properties.customer).toBeUndefined();
    expect(sentGeminiSystemText()).not.toContain(DC.PO_DELIVERY_CONTACT_RULE);
  });
});

describe("the shared rule is entity-agnostic", () => {
  // The same names api-docai-prompt-tenant-neutrality.test.js keeps out of
  // the base prompts and the registry. This rule is a prompt too.
  it.each(["OBARA", "MAHINDRA", "MMIL", "HYUNDAI", "KIA"])("contains no reference to %s", (needle) => {
    const sent = [
      DC.PO_DELIVERY_CONTACT_RULE, DC.CONTACT_NAME_DESCRIPTION,
      DC.HEADER_DELIVERY_DATE_DESCRIPTION, DC.LINE_DELIVERY_DATE_DESCRIPTION,
    ].join("\n").toUpperCase();
    expect(sent).not.toMatch(new RegExp("\\b" + needle + "\\b"));
  });
});
