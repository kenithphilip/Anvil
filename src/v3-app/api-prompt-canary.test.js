// Turning the traffic split on: a prompt version that changes the request.
//
// The registry, the deterministic split and the per-run label all shipped
// already. What did not exist was the wire: run.js resolved a version purely to
// caption the extraction_runs row, and no adapter ever looked at it. So "70/30
// between v1 and v2" described two arms running the identical prompt — an
// A/B test of a thing against itself.
//
// These tests cover the three things that make it real, and the one thing that
// keeps it safe:
//   - a registry row can carry prompt text (system_append)
//   - both adapters append it, scoped to the prompt name
//   - the run records whether the variant was ACTUALLY applied, not merely
//     which label it drew
//   - none of it happens unless a tenant opted in

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPromptVersion, resolvePromptVersion, promptNameForKind, __test } from "../api/_lib/docai/prompt-versions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("a registry row can now carry prompt text", () => {
  const v3 = __test.REGISTRY.po_extractor.find((r) => r.version === "v3");

  it("po_extractor@v3 supplies a real delta", () => {
    expect(Array.isArray(v3.system_append)).toBe(true);
    expect(v3.system_append.length).toBeGreaterThan(5);
  });

  it("is a DELTA, not a restatement of the base prompt", () => {
    // The base prompt is ~175 lines of accumulated fixes. A row that restated
    // it wholesale would silently drop whichever ones the author forgot, and
    // no reviewer could tell which.
    const base = read("src/api/_lib/docai/claude.js");
    expect(v3.system_append.join("\n").length).toBeLessThan(base.length / 10);
  });

  it("carries the counting rule that is the point of the experiment", () => {
    const text = v3.system_append.join("\n");
    expect(text).toMatch(/same S\.No/i);
    expect(text).toMatch(/exactly 8 lines\[\] entries/);
    // The failure being targeted is BOTH shredding and giving up.
    expect(text).toMatch(/do NOT emit one lines\[\] entry per physical row/i);
    expect(text).toMatch(/do NOT give up and return an empty/i);
  });

  it("omits the col-2 example mapping, which would confound the experiment", () => {
    // claude.js itself calls that mapping "ONE example layout ONLY". Carrying
    // it would test two treatments at once.
    const text = v3.system_append.join("\n");
    expect(text).not.toMatch(/row 1 col 2|Ex-Price column/i);
  });

  it("is a canary — a small share, not a coin flip", () => {
    expect(v3.status).toBe("canary");
    expect(v3.traffic_weight).toBeLessThanOrEqual(0.15);
    const v1 = __test.REGISTRY.po_extractor.find((r) => r.version === "v1");
    expect(v1.traffic_weight).toBeGreaterThanOrEqual(0.85);
  });
});

describe("a variant applies only when the tenant opted in", () => {
  const opts = { tenantId: "t1", customerId: "c1", forceVersion: "v3" };

  it("does not apply by default", () => {
    const r = getPromptVersion("po_extractor", opts);
    expect(r.version).toBe("v3");
    expect(r.has_variant_text).toBe(true);   // the row HAS text
    expect(r.is_variant).toBe(false);        // this run did not use it
    expect(r.system_append).toBeNull();      // and cannot reach it
  });

  it("applies when allowVariants is passed", () => {
    const r = getPromptVersion("po_extractor", { ...opts, allowVariants: true });
    expect(r.is_variant).toBe(true);
    expect(Array.isArray(r.system_append)).toBe(true);
  });

  it("withholds the text itself, not just the flag", () => {
    // A caller must not be able to run a variant it was not authorised for by
    // reading the row off the result object.
    const off = getPromptVersion("po_extractor", { ...opts });
    expect(off.system_append).toBeNull();
  });

  it("a version with no text is never a variant, opted in or not", () => {
    const r = getPromptVersion("supplier_ack_extractor", { tenantId: "t1", allowVariants: true });
    expect(r.has_variant_text).toBe(false);
    expect(r.is_variant).toBe(false);
  });

  it("does not disturb the deterministic split", () => {
    const a = resolvePromptVersion("po_extractor", { tenantId: "t1", customerId: "c1" });
    const b = resolvePromptVersion("po_extractor", { tenantId: "t1", customerId: "c1" });
    expect(a.version).toBe(b.version);
  });
});

describe("run.js hands the variant to the adapter", () => {
  const src = strip(read("src/api/_lib/docai/run.js"));

  it("gates on an opt-IN setting, the opposite polarity to every other docai gate", () => {
    // The others read `docai_x !== false` — on unless disabled — because they
    // guard proven behaviour. This one decides whether a tenant's live
    // documents are read by an experiment.
    expect(src).toMatch(/docai_prompt_variants === true/);
    expect(src).not.toMatch(/docai_prompt_variants !== false/);
  });

  it("passes the resolved variant down, which is the wire that was missing", () => {
    expect(src).toMatch(/dispatchHints\.promptVariant = \{/);
    expect(src).toMatch(/system_append: promptChoice\.system_append/);
  });

  it("passes it only when the variant actually applies", () => {
    expect(src).toMatch(/promptChoice\?\.is_variant &&/);
  });

  it("still records what happened, so the label cannot outrun the truth", () => {
    expect(src).toMatch(/is_variant: !!promptChoice\.is_variant/);
  });
});

describe.each([
  ["claude.js", "src/api/_lib/docai/claude.js"],
  ["gemini.js", "src/api/_lib/docai/gemini.js"],
])("%s appends the variant", (_name, path) => {
  const src = strip(read(path));

  it("appends rather than replaces, so the base prompt survives", () => {
    expect(src).toMatch(/systemBlocks\.push\(\{/);
    expect(src).toMatch(/\.\.\.variant\.system_append,/);
  });

  it("scopes it by prompt NAME, so a po variant cannot reach a quote run", () => {
    // The kinds share adapters but not prompts: a packing-list run's
    // activePrompt is a different string entirely.
    expect(src).toMatch(/variant\.name === promptNameForKind\(expectedKind\)/);
  });

  it("requires a non-empty delta", () => {
    expect(src).toMatch(/Array\.isArray\(variant\.system_append\) && variant\.system_append\.length/);
  });
});

describe("the scoping actually holds for every kind", () => {
  it("only po / rfq / generic resolve to po_extractor", () => {
    // This is what makes the adapter guard sufficient. If a new kind were
    // mapped to po_extractor without its prompt being the PO prompt, the
    // variant would leak onto it.
    for (const k of ["po", "rfq", "generic"]) expect(promptNameForKind(k)).toBe("po_extractor");
    for (const k of ["quote", "packing_list", "invoice", "eway_bill", "assembly_bom", "part_drawing"]) {
      expect(promptNameForKind(k)).not.toBe("po_extractor");
    }
  });
});

describe("a variant can be judged before any live traffic sees it", () => {
  const src = strip(read("src/api/eval/replay.js"));

  it("replay can force a version, and it is the only path that re-asks the model", () => {
    // golden-gate and rescore both re-score a FROZEN normalized_extract, so
    // neither can say anything about a prompt. Replay fetches the original PDF
    // and runs the model again.
    expect(src).toMatch(/promptVersion = null/);
    expect(src).toMatch(/forceVersion: promptVersion, allowVariants: true/);
    expect(src).toMatch(/promptVariant: \{/);
  });

  it("names the variant in the attestation so two replays are comparable", () => {
    expect(src).toMatch(/"live-replay:prompt:" \+ promptVersion/);
  });

  it("is reachable from the API", () => {
    expect(src).toMatch(/promptVersion: body\.prompt_version \|\| null/);
  });

  it("still writes nothing to production", () => {
    // The whole safety case for allowVariants:true here rests on this.
    expect(src).toMatch(/chunkedExtract\(/);
    expect(src).not.toMatch(/runExtractionPipeline\(/);
  });
});

describe("the switch has a handle", () => {
  const mig = read("supabase/migrations/218_docai_prompt_variants.sql");
  const admin = strip(read("src/api/admin/docai_settings.js"));

  it("the flag is a real column, or it could never be true", () => {
    // tenant_settings is a TABLE read with select("*"), so a setting with no
    // column is permanently undefined. `docai_prompt_variants === true` would
    // then never fire and the canary would be a lever with no handle — which
    // is exactly what happened to docai_prompt_pins, read by run.js since the
    // version-recording work with no column behind it.
    expect(mig).toMatch(/add column if not exists docai_prompt_variants boolean default false/);
    expect(mig).toMatch(/add column if not exists docai_prompt_pins jsonb/);
  });

  it("defaults to off", () => {
    expect(mig).toMatch(/docai_prompt_variants boolean default false/);
    expect(mig).not.toMatch(/docai_prompt_variants boolean default true/);
  });

  it("is settable without a deploy — the claim the registry makes", () => {
    expect(admin).toMatch(/"docai_prompt_variants"/);
    expect(admin).toMatch(/"docai_prompt_pins"/);
  });

  it("coerces the flag rather than storing a truthy string", () => {
    // "false" is truthy. Storing it would switch an experiment ON for a tenant
    // that asked for it off.
    expect(admin).toMatch(/updates\.docai_prompt_variants = body\.docai_prompt_variants === true/);
  });

  it("says which migration to apply instead of leaking a PostgREST error", () => {
    expect(admin).toMatch(/MIGRATION_NOT_APPLIED/);
    expect(admin).toMatch(/218_docai_prompt_variants\.sql/);
  });

  it("validates a pin against the registry", () => {
    // A pin is the per-tenant rollback out of a canary. A typo that silently
    // resolves to "no pin" leaves a tenant in an experiment they asked to
    // leave — the one failure this validator exists to prevent.
    expect(admin).toMatch(/validatePromptPins/);
    expect(admin).toMatch(/has no version/);
  });
});

describe("absent column behaves as off, so the code ships before the migration", () => {
  it("undefined settings mean no variant", () => {
    // `undefined === true` is false. This is what makes it safe to merge the
    // code before anyone runs the migration.
    const settings = {};
    expect(settings?.docai_prompt_variants === true).toBe(false);
    const r = getPromptVersion("po_extractor", {
      tenantId: "t1", forceVersion: "v3",
      allowVariants: settings?.docai_prompt_variants === true,
    });
    expect(r.version).toBe("v3");
    expect(r.is_variant).toBe(false);
    expect(r.system_append).toBeNull();
  });
});

describe("the canary samples DOCUMENTS, not tenants", () => {
  const { splitFraction, REGISTRY } = __test;

  it("a customer-keyed split collapses to one arm per tenant on the intake path", () => {
    // so-intake.tsx calls documents.extract with only { source_id } — the
    // customer is what the extraction is trying to determine — and
    // docai/extract.js resolves `body?.customer_id || null`. So a
    // (tenant, customer) hash is a single fixed number per tenant, and a 10%
    // weight means ~10% of TENANTS at 100% exposure, not 10% of documents.
    const tenants = Array.from({ length: 40 }, (_, i) => "t-" + i);
    const perTenant = new Set(tenants.map((t) => splitFraction(t, null)));
    expect(perTenant.size).toBe(40);        // one value each...
    for (const t of tenants) {
      // ...and it never varies across that tenant's documents.
      expect(splitFraction(t, null)).toBe(splitFraction(t, null));
    }
  });

  it("keying on the document actually samples", () => {
    const v3 = REGISTRY.po_extractor.find((r) => r.version === "v3");
    let hits = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      if (getPromptVersion("po_extractor", { tenantId: "t1", splitKey: "sha-" + i }).version === "v3") hits++;
    }
    const share = hits / N;
    expect(share).toBeGreaterThan(v3.traffic_weight * 0.7);
    expect(share).toBeLessThan(v3.traffic_weight * 1.3);
  });

  it("is still deterministic — a retry cannot flip the treatment", () => {
    const a = getPromptVersion("po_extractor", { tenantId: "t1", splitKey: "sha-abc" });
    const b = getPromptVersion("po_extractor", { tenantId: "t1", splitKey: "sha-abc" });
    expect(a.version).toBe(b.version);
  });

  it("falls back to the customer key when there is no document hash", () => {
    // url-only sources have no bytes to hash. Old behaviour, best available.
    const a = getPromptVersion("po_extractor", { tenantId: "t1", customerId: "c9" });
    const b = getPromptVersion("po_extractor", { tenantId: "t1", customerId: "c9", splitKey: null });
    expect(a.version).toBe(b.version);
  });

  it("run.js keys on the content hash it already computed", () => {
    expect(strip(read("src/api/_lib/docai/run.js"))).toMatch(/splitKey: preHash \|\| null/);
  });
});

describe("the experiment gets an uncontaminated version string", () => {
  const rows = __test.REGISTRY.po_extractor;

  it("v2 is retired, not reused", () => {
    // Since #487 began recording prompt_version, ~30% of PO runs have carried
    // po_extractor@v2 while executing the identical base prompt. The metrics
    // bucket on that label (extraction-kpis promptVersionKey), so hanging the
    // variant on v2 would drop every future variant run into a bucket already
    // full of runs that were never variants.
    const v2 = rows.find((r) => r.version === "v2");
    expect(v2.status).toBe("retired");
    expect(v2.traffic_weight).toBe(0);
    expect(v2.system_append).toBeUndefined();
  });

  it("a retired version is never drawn by the split", () => {
    const drawn = new Set(
      Array.from({ length: 800 }, (_, i) =>
        getPromptVersion("po_extractor", { tenantId: "t" + (i % 7), splitKey: "d" + i }).version),
    );
    expect(drawn.has("v2")).toBe(false);
    expect(drawn.has("v1")).toBe(true);
    expect(drawn.has("v3")).toBe(true);
  });

  it("still resolves a historical v2 row so old runs stay readable", () => {
    // Retired removes it from the split; it must not remove it from the
    // registry, or a run recorded months ago becomes unattributable.
    expect(rows.find((r) => r.version === "v2")).toBeTruthy();
  });
});
