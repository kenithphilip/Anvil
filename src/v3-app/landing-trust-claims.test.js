// The landing page may not assert a certification, a capability or a data
// guarantee this repository cannot evidence.
//
// This exists because the page did exactly that, under a source comment
// asserting the statuses were honest. Five of six security badges failed a
// check against the code: SOC 2 and ISO 27001 claimed "in progress" (an
// engaged auditor and a running observation window) with only an internal
// audit behind them; "GDPR / DPDP — compliant" was self-asserted with no DPA,
// subject-access path, erasure endpoint, retention policy or sub-processor
// list; "Data residency — IN · EU · US" described region routing that exists
// nowhere; "BYO LLM key — supported" described per-tenant provider keys when
// both adapters read one process-level env var.
//
// Copy drifts from capability silently and in the direction that flatters,
// because nothing fails when it does. So the forbidden claims are pinned
// here, and each claim the page still makes is tied to the file that
// evidences it — delete the passkey module and this test goes red rather
// than the badge quietly becoming a lie.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const LANDING = readFileSync(join(HERE, "screens", "landing.tsx"), "utf8");

// Only whole-line `//` comments are removed. Block-comment stripping is
// deliberately NOT used: the file contains `docai/*` and `lib/*` inside
// prose, each of which opens a false block comment and silently deletes
// everything to the next `*/`.
const code = LANDING.split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

const slice = (name) => {
  const start = code.indexOf(`const ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = code.indexOf("\n];", start);
  expect(end, `${name} unterminated`).toBeGreaterThan(start);
  return code.slice(start, end);
};

describe("landing page: certification claims", () => {
  const badges = slice("SECURITY");

  it("does not claim a certification is under way", () => {
    // "In progress" states to a buyer that an auditor is engaged. What
    // exists is SECURITY.md and an internal review. "Planned" is honest and
    // is forgiven; "in progress" discovered to mean "intended" is not.
    expect(badges).not.toMatch(/in progress/i);
    expect(badges).toMatch(/SOC 2 Type II[^}]*planned/);
    expect(badges).toMatch(/ISO 27001[^}]*planned/);
  });

  it("does not self-assert regulatory compliance", () => {
    expect(badges).not.toMatch(/compliant/i);
    expect(badges).not.toMatch(/GDPR|DPDP/);
  });

  it("has no certification evidence to offer, so does not sell it", () => {
    // A plan feature is a contractual promise. This one promised an audit
    // report and a signed DPA, neither of which can be produced.
    expect(code).not.toMatch(/SOC 2 \+ ISO 27001 evidence/);
  });
});

describe("landing page: data-handling claims", () => {
  it("does not offer data residency that has no implementation", () => {
    // No region key in vercel.json, none in the Supabase config, no routing
    // code. Selling it per plan tier is the version that reaches a contract.
    expect(code).not.toMatch(/EU (and|·) US residency/i);
    expect(code).not.toMatch(/residency available/i);
    expect(code).not.toMatch(/IN · EU · US/);

    const vercel = join(ROOT, "vercel.json");
    if (existsSync(vercel)) {
      const cfg = JSON.parse(readFileSync(vercel, "utf8"));
      expect(
        cfg.regions,
        "vercel.json now declares regions — the residency claim may be re-qualified",
      ).toBeUndefined();
    }
  });

  it("does not claim per-tenant or in-VPC model keys", () => {
    // Both adapters read one process-level env var. The page previously told
    // an enterprise buyer their document content "never crosses our
    // boundary" — the single most consequential sentence on it.
    expect(code).not.toMatch(/never crosses our boundary/i);
    expect(code).not.toMatch(/we never see the document content/i);
    expect(code).not.toMatch(/BYO LLM key/);
    expect(code).not.toMatch(/pointed at your own VPC/i);

    // A tenant CAN supply its own key for the extraction providers
    // (docai_*_api_key_enc, seven of them), which is why the FAQ says so.
    // What does not exist is a Bedrock / Vertex / Azure adapter, and the
    // Anthropic path has no per-tenant key at all — it reads the env var.
    const anthropic = readFileSync(join(ROOT, "src", "api", "_lib", "anthropic.js"), "utf8");
    expect(
      /process\.env\.ANTHROPIC_API_KEY/.test(anthropic),
      "anthropic.js no longer reads a process-level key — the FAQ may be re-qualified",
    ).toBe(true);
    for (const vendor of ["bedrock", "vertex"]) {
      expect(
        existsSync(join(ROOT, "src", "api", "_lib", `${vendor}.js`)),
        `${vendor} adapter now exists — the FAQ may be re-qualified`,
      ).toBe(false);
    }
  });

  it("does not claim the audit log is chained", () => {
    // audit_events carries a per-row payload_hash and is genuinely
    // append-only, but there is no prev_hash, so rows are not chained to
    // each other. Append-only + signed export is the true, weaker claim.
    expect(code).not.toMatch(/cryptographically chained/i);
  });

  it("does not claim SCIM", () => {
    expect(code).not.toMatch(/SCIM/);
  });
});

describe("landing page: the claims it still makes are evidenced", () => {
  // Each badge left standing is tied to the artefact that supports it, so
  // removing the capability fails the test instead of stranding the badge.
  const badges = slice("SECURITY");

  it("passkeys and TOTP exist", () => {
    expect(badges).toMatch(/Passkeys · TOTP/);
    expect(existsSync(join(ROOT, "src", "api", "auth", "passkey", "register_begin.js"))).toBe(true);
    expect(existsSync(join(ROOT, "src", "api", "_lib", "totp.js"))).toBe(true);
  });

  it("PII redaction is reachable from both model adapters", () => {
    expect(badges).toMatch(/PII redaction/);
    for (const f of ["anthropic.js", "gemini.js"]) {
      expect(readFileSync(join(ROOT, "src", "api", "_lib", f), "utf8")).toMatch(/redact/);
    }
  });

  it("the audit log is append-only at the database layer", () => {
    expect(badges).toMatch(/Append-only audit/);
    const mig = join(ROOT, "supabase", "migrations", "058_audit_events_append_only.sql");
    expect(existsSync(mig)).toBe(true);
    const sql = readFileSync(mig, "utf8");
    expect(sql).toMatch(/drop policy if exists tenant_update on audit_events/);
    expect(sql).toMatch(/drop policy if exists tenant_delete on audit_events/);
  });
});
