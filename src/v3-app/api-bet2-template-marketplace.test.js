// Bet 2 regression tests: format-template marketplace.
//
// Comprehensive coverage of every safeguard, because publishing
// regex patterns into a shared library is a high-blast-radius
// operation:
//
//   1. Regex-safety: ReDoS shapes, length cap, capture cap, wide
//      captures, large quantifiers, named groups, lookarounds.
//   2. PII redaction: every PII pattern detected; sample_value
//      always stripped; unknown fields flagged.
//   3. Triple-gate opt-in:
//        - tenant_settings.template_marketplace_publisher_optin = false
//          -> blocked
//        - customers.do_not_publish_templates = true (default)
//          -> blocked
//        - k_anonymity < 5 -> blocked
//   4. Stage-1 deterministic checks: regex-safety, anchor count,
//      miss-rate.
//   5. Scoring math: combinedScore + scoreCandidate.
//   6. applyGlobalTemplate fires in hint mode by default; promotion
//      to skip_llm requires N operator confirms.
//   7. revokeTemplate marks the row revoked + auto-suspends after
//      3 confirmed reports.
//   8. Source-contract regression: migration columns + RLS + router
//      wiring + client surface + nav + rbac + routes.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  validateRegexSafety, validateAnchorSafety, safeMatch,
  __test as rsTest,
} from "../api/_lib/docai/regex-safety.js";
import {
  redactTemplateForPublication, isBlockingReport,
  __test as redTest,
} from "../api/_lib/docai/redact.js";
import {
  combinedScore, scoreCandidate, __consts, __test as mktTest,
} from "../api/_lib/docai/marketplace.js";

const SRC = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

// -------------------- regex-safety ------------------------------

describe("Bet 2 - regex-safety primitives", () => {
  it("accepts a well-formed PO-number anchor regex", () => {
    const r = validateRegexSafety("PO[-\\s]+([A-Z0-9-]{4,20})");
    expect(r.ok).toBe(true);
  });

  it("rejects empty pattern", () => {
    expect(validateRegexSafety("").ok).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(validateRegexSafety(null).ok).toBe(false);
    expect(validateRegexSafety(123).ok).toBe(false);
  });

  it("rejects pattern longer than the max (200 chars by default)", () => {
    const r = validateRegexSafety("a".repeat(250));
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("pattern_too_long_"))).toBe(true);
  });

  it("rejects ReDoS nested-quantifier shapes", () => {
    expect(validateRegexSafety("(.*)*").ok).toBe(false);
    expect(validateRegexSafety("(.+)+").ok).toBe(false);
    expect(validateRegexSafety("(a+)+").ok).toBe(false);
  });

  it("rejects duplicate-anchor dotstar", () => {
    expect(validateRegexSafety(".*.*x").ok).toBe(false);
  });

  it("rejects wide capture (.*) or (.+)", () => {
    expect(validateRegexSafety("(.*)Z").ok).toBe(false);
    expect(validateRegexSafety("foo(.+)bar").ok).toBe(false);
  });

  it("rejects more than one capture group", () => {
    expect(validateRegexSafety("([A-Z]+)([0-9]+)").ok).toBe(false);
  });

  it("accepts a single bounded capture group", () => {
    expect(validateRegexSafety("PO[-\\s]+([A-Z0-9-]{4,20})").ok).toBe(true);
  });

  it("rejects huge quantifiers ({501,})", () => {
    expect(validateRegexSafety("[A-Z]{501,}").ok).toBe(false);
  });

  it("rejects named groups + PCRE callouts", () => {
    expect(validateRegexSafety("(?<foo>[a-z]+)").ok).toBe(false);
    expect(validateRegexSafety("(?{print})").ok).toBe(false);
  });

  it("rejects lookarounds (negative + positive lookbehind)", () => {
    expect(validateRegexSafety("(?!foo)bar").ok).toBe(false);
    expect(validateRegexSafety("(?<=foo)bar").ok).toBe(false);
  });

  it("countCaptureGroups handles escapes + character classes", () => {
    expect(rsTest.countCaptureGroups("foo\\(bar\\)")).toBe(0);
    expect(rsTest.countCaptureGroups("[()]")).toBe(0);
    expect(rsTest.countCaptureGroups("(?:a)(b)")).toBe(1);
    expect(rsTest.countCaptureGroups("(a)(b)(c)")).toBe(3);
  });

  it("safeMatch caps the capture span at maxCapturedSpan", () => {
    const longText = "PO " + "X".repeat(500);
    const r = safeMatch("PO ([A-Z]{1,500})", longText);
    expect(r.ok).toBe(true);
    expect(r.match.captured.length).toBeLessThanOrEqual(200);
    expect(r.match.truncated).toBe(true);
  });

  it("safeMatch rejects unsafe patterns up front", () => {
    const r = safeMatch("(.*)*", "anything");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unsafe_pattern");
  });

  it("safeMatch caps the input length at 200 KB by default", () => {
    const huge = "x".repeat(250_000) + "FIND-ME";
    const r = safeMatch("(FIND-ME)", huge);
    expect(r.ok).toBe(true);
    // The match site at 250K + 7 should be PAST the input cap, so
    // we get no match. Confirms the cap is enforced.
    expect(r.match).toBe(null);
  });

  it("validateAnchorSafety requires all canonical fields", () => {
    const r = validateAnchorSafety({});
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("missing_field");
    expect(r.reasons).toContain("missing_pattern");
    expect(r.reasons).toContain("missing_label");
  });

  it("validateAnchorSafety rejects labels longer than 100 chars", () => {
    const r = validateAnchorSafety({
      field: "customer.name",
      pattern: "ACME",
      label: "x".repeat(120),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.some((x) => x.startsWith("label_too_long_"))).toBe(true);
  });
});

// -------------------- redact primitives -------------------------

describe("Bet 2 - PII redaction", () => {
  it("strips sample_value regardless of PII state", () => {
    const out = redactTemplateForPublication({
      anchors: [{ field: "customer.po_number", pattern: "PO-([0-9]+)", label: "PO Number", capture_group: 1, sample_value: "PO-12345" }],
    });
    expect(out.redacted.anchors[0].sample_value).toBe("<redacted>");
    expect(out.report.stripped_sample_values).toBe(1);
  });

  it("detects GSTIN in a label", () => {
    const out = redactTemplateForPublication({
      anchors: [{ field: "customer.gstin", pattern: "\\d+", label: "GSTIN 27ABCDE1234F1Z5", sample_value: "x" }],
    });
    expect(out.report.pii_detections.some((d) => d.kind === "gstin")).toBe(true);
    expect(isBlockingReport(out.report)).toBe(true);
  });

  it("detects email + phone + Aadhaar + bank account", () => {
    const out = redactTemplateForPublication({
      anchors: [
        { field: "customer.email", pattern: ".+", label: "Send to ops@acme.com", sample_value: "ops@acme.com" },
        { field: "customer.phone", pattern: ".+", label: "Call +91 9876543210", sample_value: "9876543210" },
      ],
    });
    expect(out.report.pii_detections.some((d) => d.kind === "email")).toBe(true);
    expect(out.report.pii_detections.some((d) => d.kind === "phone_in" || d.kind === "phone_intl")).toBe(true);
  });

  it("detects honorific + capitalised name (Mr Smith / M/s. Acme)", () => {
    const out = redactTemplateForPublication({
      anchors: [{ field: "customer.name", pattern: ".+", label: "M/s. Acme Pvt Ltd PO", sample_value: "x" }],
    });
    expect(out.report.pii_detections.some((d) => d.kind === "honorific")).toBe(true);
  });

  it("flags unknown field names", () => {
    const out = redactTemplateForPublication({
      anchors: [{ field: "exfil.body", pattern: "(.+)", label: "BODY", sample_value: "x" }],
    });
    expect(out.report.unknown_fields).toContain("exfil.body");
    expect(isBlockingReport(out.report)).toBe(true);
  });

  it("isBlockingReport is true on PII OR unknown_fields", () => {
    expect(isBlockingReport(null)).toBe(true);
    expect(isBlockingReport({ ok: false, unknown_fields: [] })).toBe(true);
    expect(isBlockingReport({ ok: true, unknown_fields: ["x"] })).toBe(true);
    expect(isBlockingReport({ ok: true, unknown_fields: [] })).toBe(false);
  });

  it("clean template (no PII, all known fields) is non-blocking", () => {
    const out = redactTemplateForPublication({
      anchors: [
        { field: "customer.po_number", pattern: "PO-([0-9]+)", label: "PO Number", capture_group: 1, sample_value: "PO-12345" },
        { field: "customer.po_date",   pattern: "Date:\\s*([0-9/]+)", label: "Date", capture_group: 1, sample_value: "01/01/2026" },
      ],
    });
    expect(out.report.pii_detections).toEqual([]);
    expect(out.report.unknown_fields).toEqual([]);
    expect(isBlockingReport(out.report)).toBe(false);
  });
});

// -------------------- marketplace scoring -----------------------

describe("Bet 2 - marketplace scoring math", () => {
  it("combinedScore is 0.4 * fp + 0.6 * anchor", () => {
    expect(combinedScore({ fingerprint_score: 0.5, anchor_hit_rate: 0.5 })).toBe(0.5);
    expect(combinedScore({ fingerprint_score: 1.0, anchor_hit_rate: 0 })).toBe(0.4);
    expect(combinedScore({ fingerprint_score: 0,   anchor_hit_rate: 1.0 })).toBe(0.6);
  });

  it("combinedScore clamps to [0, 1]", () => {
    expect(combinedScore({ fingerprint_score: 2, anchor_hit_rate: 2 })).toBe(1);
    expect(combinedScore({ fingerprint_score: -1, anchor_hit_rate: -1 })).toBe(0);
  });

  it("jaccard primitive computes intersection / union", () => {
    expect(mktTest.jaccard(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(2 / 4, 4);
    expect(mktTest.jaccard([], [])).toBe(0);
    expect(mktTest.jaccard(["a"], ["a"])).toBe(1);
  });

  it("scoreCandidate hits all anchors when they ALL match the body", () => {
    const candidate = {
      id: "g1",
      fingerprint: { tokens: ["po", "number"], vec: { po: 1, number: 1 } },
      anchors: [
        { field: "customer.po_number", pattern: "PO-([0-9]+)" },
        { field: "customer.po_date",   pattern: "Date:\\s*([0-9/]+)" },
      ],
    };
    const r = scoreCandidate({
      candidate,
      localFingerprint: { tokens: ["po", "number"], vec: { po: 1, number: 1 } },
      bodyText: "PO-12345 Date: 01/01/2026",
    });
    expect(r.anchor_hit_rate).toBe(1);
    expect(r.fingerprint_score).toBe(1);
    expect(r.score).toBeCloseTo(1, 3);
  });

  it("scoreCandidate returns 0 anchors hit on irrelevant body", () => {
    const candidate = {
      id: "g1",
      fingerprint: { tokens: ["po"], vec: { po: 1 } },
      anchors: [{ field: "customer.po_number", pattern: "PO-([0-9]+)" }],
    };
    const r = scoreCandidate({
      candidate,
      localFingerprint: { tokens: ["invoice"], vec: { invoice: 1 } },
      bodyText: "Some unrelated quote text",
    });
    expect(r.anchor_hit_rate).toBe(0);
    expect(r.fingerprint_score).toBe(0);
    expect(r.score).toBe(0);
  });

  it("constants surface the right thresholds", () => {
    expect(__consts.K_ANONYMITY_THRESHOLD).toBe(5);
    expect(__consts.MIN_ANCHORS).toBe(3);
    expect(__consts.MAX_MISS_RATE).toBe(0.1);
    expect(__consts.HINT_THRESHOLD).toBe(0.7);
    expect(__consts.HINT_SILENT_THRESHOLD).toBe(0.5);
  });
});

// -------------------- Stage-1 check logic -----------------------

describe("Bet 2 - Stage-1 publish blockers", () => {
  const baseTpl = {
    anchors: [
      { field: "customer.po_number", pattern: "PO-([0-9]+)", label: "PO" },
      { field: "customer.po_date",   pattern: "Date:\\s*([0-9/]+)", label: "Date" },
      { field: "customer.name",      pattern: "Buyer:\\s*([A-Z][a-z]+)", label: "Buyer" },
    ],
    sample_doc_hashes: ["h1", "h2", "h3", "h4", "h5"],
    hit_count: 10, miss_count: 0,
  };
  const okSettings = { template_marketplace_publisher_optin: true };
  const okCustomer = { do_not_publish_templates: false };
  const okAnchorReports = baseTpl.anchors.map((a) => ({ ok: true, reasons: [] }));

  it("blocks when tenant has not opted in", () => {
    const { failures } = mktTest.runStage1Checks({
      template: baseTpl,
      tenantSettings: { template_marketplace_publisher_optin: false },
      customer: okCustomer,
      anchorReports: okAnchorReports,
    });
    expect(failures.some((f) => f.check === "tenant_not_opted_in")).toBe(true);
  });

  it("blocks when customer flag is the default TRUE (do not publish)", () => {
    const { failures } = mktTest.runStage1Checks({
      template: baseTpl,
      tenantSettings: okSettings,
      customer: { do_not_publish_templates: true },
      anchorReports: okAnchorReports,
    });
    expect(failures.some((f) => f.check === "customer_do_not_publish")).toBe(true);
  });

  it("blocks when k_anonymity < 5", () => {
    const { failures } = mktTest.runStage1Checks({
      template: { ...baseTpl, sample_doc_hashes: ["h1", "h2", "h3"] },
      tenantSettings: okSettings, customer: okCustomer, anchorReports: okAnchorReports,
    });
    expect(failures.some((f) => f.check === "k_anonymity_below_threshold")).toBe(true);
  });

  it("blocks when anchor count < 3", () => {
    const { failures } = mktTest.runStage1Checks({
      template: { ...baseTpl, anchors: baseTpl.anchors.slice(0, 2) },
      tenantSettings: okSettings, customer: okCustomer,
      anchorReports: okAnchorReports.slice(0, 2),
    });
    expect(failures.some((f) => f.check === "anchor_count_below_min")).toBe(true);
  });

  it("blocks when miss rate > 10% (with >= 5 total observations)", () => {
    const { failures } = mktTest.runStage1Checks({
      template: { ...baseTpl, hit_count: 1, miss_count: 9 },
      tenantSettings: okSettings, customer: okCustomer, anchorReports: okAnchorReports,
    });
    expect(failures.some((f) => f.check === "miss_rate_too_high")).toBe(true);
  });

  it("blocks when any anchor regex is unsafe", () => {
    const { failures } = mktTest.runStage1Checks({
      template: baseTpl,
      tenantSettings: okSettings,
      customer: okCustomer,
      anchorReports: [
        { ok: true,  reasons: [] },
        { ok: false, reasons: ["redos_nested_quantifier_dotstar"] },
        { ok: true,  reasons: [] },
      ],
    });
    expect(failures.some((f) => f.check === "anchor_regex_unsafe")).toBe(true);
  });

  it("blocks suspended publishers", () => {
    const { failures } = mktTest.runStage1Checks({
      template: baseTpl,
      tenantSettings: {
        ...okSettings,
        template_marketplace_publisher_suspended_at: new Date().toISOString(),
      },
      customer: okCustomer,
      anchorReports: okAnchorReports,
    });
    expect(failures.some((f) => f.check === "publisher_suspended")).toBe(true);
  });

  it("passes Stage-1 when all gates are open + sample is clean", () => {
    const { failures } = mktTest.runStage1Checks({
      template: baseTpl,
      tenantSettings: okSettings,
      customer: okCustomer,
      anchorReports: okAnchorReports,
    });
    expect(failures).toEqual([]);
  });
});

// -------------------- source-contract regression ---------------

describe("Bet 2 - source contract", () => {
  const migration = SRC("supabase/migrations/103_template_marketplace.sql");
  const routerSrc = SRC("src/api/router.js");
  const clientSrc = SRC("src/client/anvil-client.js");
  const navSrc    = SRC("src/v3-app/lib/nav.ts");
  const rbacSrc   = SRC("src/v3-app/lib/rbac.ts");
  const routesSrc = SRC("src/v3-app/routes.ts");
  const runSrc    = SRC("src/api/_lib/docai/run.js");
  const publishSrc = SRC("src/api/marketplace/publish.js");
  const reviewSrc = SRC("src/api/marketplace/review.js");

  it("migration creates 4 RLS-scoped marketplace tables", () => {
    expect(migration).toMatch(/create table if not exists customer_format_templates_global/);
    expect(migration).toMatch(/create table if not exists template_publications/);
    expect(migration).toMatch(/create table if not exists template_imports/);
    expect(migration).toMatch(/create table if not exists template_reports/);
    expect(migration).toMatch(/enable row level security/);
  });

  it("customers.do_not_publish_templates defaults to TRUE (opt-in)", () => {
    expect(migration).toMatch(/do_not_publish_templates boolean not null default true/);
  });

  it("tenant publisher opt-in defaults to FALSE", () => {
    expect(migration).toMatch(/template_marketplace_publisher_optin boolean not null default false/);
  });

  it("global library RLS only exposes status='approved' rows + own publications", () => {
    expect(migration).toMatch(/cftg_select_approved/);
    expect(migration).toMatch(/status = 'approved'/);
    expect(migration).toMatch(/cftg_select_own_publications/);
  });

  it("status enum includes the full lifecycle", () => {
    for (const v of [
      "pending_review", "approved", "rejected", "revoked",
      "superseded", "auto_suspended",
    ]) {
      expect(migration).toMatch(new RegExp("'" + v + "'"));
    }
  });

  it("extraction_runs gets global_template_used + global_template_use_mode", () => {
    expect(migration).toMatch(/global_template_used uuid references customer_format_templates_global/);
    expect(migration).toMatch(/global_template_use_mode text/);
  });

  it("dispatcher run.js wires L3.5 between L3 and L4 in hint mode default", () => {
    expect(runSrc).toMatch(/findGlobalCandidates/);
    expect(runSrc).toMatch(/applyGlobalTemplate/);
    expect(runSrc).toMatch(/use_mode/);
    expect(runSrc).toMatch(/template_marketplace_consumer_optin/);
    expect(runSrc).toMatch(/shouldPromoteToSkipLlm/);
  });

  it("router exposes all marketplace endpoints", () => {
    for (const p of [
      "/marketplace/publish", "/marketplace/revoke", "/marketplace/imports",
      "/marketplace/imports/confirm", "/marketplace/imports/revert",
      "/marketplace/report", "/marketplace/list",
      "/marketplace/review", "/marketplace/review/revoke",
    ]) {
      expect(routerSrc).toContain(p);
    }
  });

  it("anvil-client exposes a marketplace module with 10 methods", () => {
    expect(clientSrc).toMatch(/const marketplace = \{/);
    for (const m of [
      "list:", "publish:", "revoke:", "imports:", "confirmImport:",
      "revertImport:", "report:", "reviewQueue:", "reviewDecide:",
      "superAdminRevoke:",
    ]) {
      expect(clientSrc).toContain(m);
    }
  });

  it("nav + rbac + routes register the marketplace entry", () => {
    expect(navSrc).toMatch(/id: "marketplace"/);
    expect(rbacSrc).toMatch(/marketplace:/);
    expect(routesSrc).toMatch(/marketplace:\s+lazy/);
  });

  it("publish endpoint requires admin + audits both blocked and submitted", () => {
    expect(publishSrc).toMatch(/requirePermission\(ctx, "admin"\)/);
    expect(publishSrc).toMatch(/marketplace\.publish\.blocked/);
    expect(publishSrc).toMatch(/marketplace\.publish\.submitted/);
  });

  it("review endpoint gates on the super-admin env list", () => {
    expect(reviewSrc).toMatch(/SUPER_ADMIN_USER_IDS/);
    expect(reviewSrc).toMatch(/super_admin_only/);
    expect(reviewSrc).toMatch(/marketplace\.super_admin\.revoked/);
  });
});

// -------------------- internal helpers --------------------------

describe("Bet 2 - PII pattern detection helpers", () => {
  it("PAN, GSTIN, email, phone all detect on a single string", () => {
    expect(redTest.detectPiiIn("ABCDE1234F", "x").some((d) => d.kind === "pan")).toBe(true);
    expect(redTest.detectPiiIn("27ABCDE1234F1Z5", "x").some((d) => d.kind === "gstin")).toBe(true);
    expect(redTest.detectPiiIn("hello@acme.com", "x").some((d) => d.kind === "email")).toBe(true);
    expect(redTest.detectPiiIn("9876543210", "x").some((d) => d.kind === "phone_in")).toBe(true);
  });

  it("KNOWN_FIELDS covers customer + lines canonical paths", () => {
    expect(redTest.KNOWN_FIELDS.has("customer.name")).toBe(true);
    expect(redTest.KNOWN_FIELDS.has("lines.partNumber")).toBe(true);
    expect(redTest.KNOWN_FIELDS.has("exfil.body")).toBe(false);
  });
});
