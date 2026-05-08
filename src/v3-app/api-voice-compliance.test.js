// Unit tests for src/api/_lib/voice-compliance.js. Covers the
// pure helpers (E.164 parsing, region detection, recording-
// disclosure template lookup) plus the DB-touching gates
// (DND lookup, consent lookup, full pre-call gate) against a
// thenable Supabase mock.
//
// Audit: DEFERRED_ROADMAP §1 (voice AI).

import { describe, it, expect } from "vitest";
import {
  __test as compTest,
  isOnDndList,
  hasVoiceConsent,
  checkOutboundCompliance,
} from "../api/_lib/voice-compliance.js";

// Minimal thenable-builder mock; per-table behaviour parameterised.
const buildSvc = (handlers) => ({
  from: (table) => {
    const filters = {};
    let opts = { order: null, limit: null };
    const builder = {
      select: () => builder,
      eq: (k, v) => { filters[k] = v; return builder; },
      is: (k, v) => { filters["is:" + k] = v; return builder; },
      gt: (k, v) => { filters["gt:" + k] = v; return builder; },
      lt: (k, v) => { filters["lt:" + k] = v; return builder; },
      gte: (k, v) => { filters["gte:" + k] = v; return builder; },
      in: (k, vs) => { filters[k] = vs; return builder; },
      order: (k, opt) => { opts.order = { k, ...(opt || {}) }; return builder; },
      limit: (n) => { opts.limit = n; return builder; },
      maybeSingle: () => Promise.resolve(handlers[table]?.({ filters, opts, single: true }) || { data: null, error: null }),
      single: () => Promise.resolve(handlers[table]?.({ filters, opts, single: true }) || { data: null, error: null }),
      then: (resolve, reject) => {
        try { resolve(handlers[table]?.({ filters, opts, single: false }) || { data: [], error: null }); }
        catch (err) { reject(err); }
      },
    };
    return builder;
  },
});

describe("voice-compliance helpers (pure)", () => {
  it("normalizes E.164 inputs and rejects ambiguous bare-digit strings", () => {
    expect(compTest.normalizeE164("+919876543210")).toBe("+919876543210");
    // Punctuation cleanup is allowed when the "+" prefix is present.
    expect(compTest.normalizeE164("+1 (415) 555-0123")).toBe("+14155550123");
    // "00" international trunk prefix is accepted.
    expect(compTest.normalizeE164("0091987654321")).toBe("+91987654321");
    // Bare 10-digit string (no country code) is now rejected: the
    // old behaviour silently produced a wrong-region number.
    expect(compTest.normalizeE164("9876543210")).toBeNull();
    expect(compTest.normalizeE164(null)).toBeNull();
    expect(compTest.normalizeE164("123")).toBeNull();
    expect(compTest.normalizeE164("")).toBeNull();
  });

  it("maps E.164 country codes to regions", () => {
    expect(compTest.regionFromE164("+919876543210")).toBe("IN");
    expect(compTest.regionFromE164("+14155550123")).toBe("US");
    // Canadian +1 NPAs no longer fall through to US.
    expect(compTest.regionFromE164("+14165550123")).toBe("CA");
    expect(compTest.regionFromE164("+16045550123")).toBe("CA");
    expect(compTest.regionFromE164("+442071234567")).toBe("UK");
    expect(compTest.regionFromE164("+971501234567")).toBe("AE");
    expect(compTest.regionFromE164("+6512345678")).toBe("SG");
    expect(compTest.regionFromE164("+33145678901")).toBe("EU");
    expect(compTest.regionFromE164("+99912345")).toBe("OTHER");
    expect(compTest.regionFromE164(null)).toBe("OTHER");
  });

  it("returns the right recording disclosure per (region, locale)", () => {
    const inHi = compTest.recordingDisclosureFor("IN", "hi-IN");
    expect(inHi).toMatch(/रिकॉर्ड/);
    const inEn = compTest.recordingDisclosureFor("IN", "en-IN");
    expect(inEn).toMatch(/recorded for quality/);
    // Falls back to first locale if requested locale absent.
    const inFr = compTest.recordingDisclosureFor("IN", "fr-FR");
    expect(inFr).toMatch(/recorded/);
    // OTHER fallback.
    const other = compTest.recordingDisclosureFor("XYZ", "en");
    expect(other).toMatch(/may be recorded/);
  });
});

describe("isOnDndList", () => {
  // Bug fix May 2026: lookup is now two scoped queries (tenant
  // first, global second). The mock dispatches by inspecting
  // which filter was set, so each test can return the right row
  // for the right query.
  const dndHandler = (rows) => ({ filters }) => {
    const isGlobal = filters["is:tenant_id"] === null;
    const isTenant = filters.tenant_id !== undefined;
    const want = isGlobal
      ? rows.find((r) => r.tenant_id === null)
      : isTenant
        ? rows.find((r) => r.tenant_id === filters.tenant_id)
        : null;
    return { data: want || null, error: null };
  };

  it("returns listed=false when no rows match", async () => {
    const svc = buildSvc({ voice_dnd_list: dndHandler([]) });
    const out = await isOnDndList(svc, { tenantId: "t-1", phoneNumber: "+919876543210" });
    expect(out.listed).toBe(false);
  });

  it("prefers a tenant-specific row over a global one", async () => {
    const svc = buildSvc({
      voice_dnd_list: dndHandler([
        { source: "trai_ndnc",     tenant_id: null,  region: "IN" },
        { source: "tenant_manual", tenant_id: "t-1", region: "IN" },
      ]),
    });
    const out = await isOnDndList(svc, { tenantId: "t-1", phoneNumber: "+919876543210" });
    expect(out.listed).toBe(true);
    expect(out.source).toBe("tenant_manual");
  });

  it("falls back to the global TRAI / FCC row when no tenant row matches", async () => {
    const svc = buildSvc({
      voice_dnd_list: dndHandler([{ source: "trai_ndnc", tenant_id: null, region: "IN" }]),
    });
    const out = await isOnDndList(svc, { tenantId: "t-2", phoneNumber: "+919876543210" });
    expect(out.listed).toBe(true);
    expect(out.source).toBe("trai_ndnc");
  });
});

describe("hasVoiceConsent", () => {
  it("returns no_record when there is no consent row", async () => {
    const svc = buildSvc({
      voice_consent: () => ({ data: [], error: null }),
    });
    const out = await hasVoiceConsent(svc, { tenantId: "t-1", phoneNumber: "+919876543210" });
    expect(out.consented).toBe(false);
    expect(out.reason).toBe("no_record");
  });

  it("returns withdrawn when the latest row has withdrawn_at set", async () => {
    const svc = buildSvc({
      voice_consent: () => ({
        data: [{ id: "c1", scope: "voice", consented_at: "2026-04-01T00:00:00Z", withdrawn_at: "2026-04-15T00:00:00Z", expires_at: null, source: "opt_in_form" }],
        error: null,
      }),
    });
    const out = await hasVoiceConsent(svc, { tenantId: "t-1", phoneNumber: "+919876543210" });
    expect(out.consented).toBe(false);
    expect(out.reason).toBe("withdrawn");
  });

  it("returns expired when expires_at is past", async () => {
    const svc = buildSvc({
      voice_consent: () => ({
        data: [{ id: "c1", scope: "voice", consented_at: "2025-01-01T00:00:00Z", withdrawn_at: null, expires_at: "2025-12-31T00:00:00Z", source: "signed_agreement" }],
        error: null,
      }),
    });
    const out = await hasVoiceConsent(svc, { tenantId: "t-1", phoneNumber: "+919876543210" });
    expect(out.consented).toBe(false);
    expect(out.reason).toBe("expired");
  });

  it("returns consented true on a fresh active row", async () => {
    const svc = buildSvc({
      voice_consent: () => ({
        data: [{ id: "c1", scope: "voice", consented_at: "2026-05-01T00:00:00Z", withdrawn_at: null, expires_at: null, source: "inbound_call" }],
        error: null,
      }),
    });
    const out = await hasVoiceConsent(svc, { tenantId: "t-1", phoneNumber: "+919876543210" });
    expect(out.consented).toBe(true);
    expect(out.consent.id).toBe("c1");
    expect(out.consent.source).toBe("inbound_call");
  });

  it("ignores SMS-only consent (scope mismatch)", async () => {
    const svc = buildSvc({
      voice_consent: () => ({
        data: [{ id: "c1", scope: "sms", consented_at: "2026-05-01T00:00:00Z", withdrawn_at: null, expires_at: null, source: "opt_in_form" }],
        error: null,
      }),
    });
    const out = await hasVoiceConsent(svc, { tenantId: "t-1", phoneNumber: "+919876543210" });
    expect(out.consented).toBe(false);
    expect(out.reason).toBe("no_record");
  });
});

describe("checkOutboundCompliance (full gate)", () => {
  const config = {
    outbound_enabled: true,
    recording_disclosure_locale: "en-IN",
  };

  it("rejects when the number cannot be parsed", async () => {
    const svc = buildSvc({});
    const out = await checkOutboundCompliance(svc, { tenantId: "t-1", config, toNumber: "abc" });
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("invalid_number");
  });

  it("rejects when the config has outbound_enabled = false", async () => {
    const svc = buildSvc({});
    const out = await checkOutboundCompliance(svc, {
      tenantId: "t-1",
      config: { ...config, outbound_enabled: false },
      toNumber: "+919876543210",
    });
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("config_outbound_disabled");
  });

  it("rejects when DND-listed", async () => {
    const svc = buildSvc({
      // Tenant query returns null (no tenant row); global query
      // returns the trai_ndnc row.
      voice_dnd_list: ({ filters }) => filters["is:tenant_id"] === null
        ? { data: { source: "trai_ndnc" }, error: null }
        : { data: null, error: null },
    });
    const out = await checkOutboundCompliance(svc, { tenantId: "t-1", config, toNumber: "+919876543210" });
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("dnd_listed");
    expect(out.dnd_source).toBe("trai_ndnc");
  });

  it("rejects when consent is missing (DND clean but no record)", async () => {
    const svc = buildSvc({
      voice_dnd_list: () => ({ data: null, error: null }),
      voice_consent: () => ({ data: [], error: null }),
    });
    const out = await checkOutboundCompliance(svc, { tenantId: "t-1", config, toNumber: "+919876543210" });
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe("no_consent");
    expect(out.consent_reason).toBe("no_record");
  });

  it("returns allowed=true with the disclosure attached when both gates pass", async () => {
    const svc = buildSvc({
      voice_dnd_list: () => ({ data: null, error: null }),
      voice_consent: () => ({
        data: [{ id: "c1", scope: "voice", consented_at: "2026-05-01T00:00:00Z", withdrawn_at: null, expires_at: null, source: "inbound_call" }],
        error: null,
      }),
    });
    const out = await checkOutboundCompliance(svc, { tenantId: "t-1", config, toNumber: "+919876543210" });
    expect(out.allowed).toBe(true);
    expect(out.region).toBe("IN");
    expect(out.disclosure).toMatch(/recorded for quality/);
    expect(out.consent_id).toBe("c1");
  });

  it("uses the config-level disclosure override when present", async () => {
    const svc = buildSvc({
      voice_dnd_list: () => ({ data: null, error: null }),
      voice_consent: () => ({
        data: [{ id: "c1", scope: "voice", consented_at: "2026-05-01T00:00:00Z", withdrawn_at: null, expires_at: null, source: "inbound_call" }],
        error: null,
      }),
    });
    const customDisclosure = "Custom disclosure approved by counsel on 2026-05-08.";
    const out = await checkOutboundCompliance(svc, {
      tenantId: "t-1",
      config: { ...config, recording_disclosure: customDisclosure },
      toNumber: "+14155550123",
    });
    expect(out.allowed).toBe(true);
    expect(out.region).toBe("US");
    expect(out.disclosure).toBe(customDisclosure);
  });
});
