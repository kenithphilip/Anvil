// Voice AI compliance helpers.
//
// Three responsibilities:
//
//   1. Recording-disclosure copy: per region (IN, US, EU, UK, AE,
//      SG, OTHER), in the correct locale. Returned at config time
//      so the assistant's system_prompt opens with it; also
//      returned by the outbound endpoint so the caller can render
//      it into the call request.
//
//   2. TRAI-NDNC + FCC-DNC + tenant-manual DND lookup. Refuses
//      the call when the destination is on any of the lists.
//
//   3. TCPA / GDPR / DPDP prior-consent gate. Refuses the call
//      when no active voice_consent row exists for the
//      destination.
//
// The helpers are designed to be testable: they take a Supabase
// service client and a small bag of inputs, return a verdict
// object, and never throw on routine "blocked" outcomes (only on
// genuine database errors).
//
// Audit: DEFERRED_ROADMAP §1 (voice AI). Migration 080 lays down
// the underlying tables (voice_consent, voice_dnd_list) and the
// recording-disclosure columns on voice_configs.

// E.164 normalization. Strict: input must either already carry a
// "+" prefix with 8-15 digits, OR carry a recognisable country
// code in the digits. Bare 8-digit local numbers are rejected,
// because prefixing them with "+" produces a "probably wrong"
// E.164 that silently misses the DND + consent lookups (the
// caller would think the number was clean when it was actually
// never queried correctly).
//
// P2 from the May 2026 critic: previous behaviour accepted any
// 8-15 digit string and prefixed "+". A 10-digit Indian local
// number (without the 91 country code) became "+9876543210" and
// looked like an Egyptian / Russian number to regionFromE164.
// Now we require a country code in front (either explicit "+"
// or a leading "00" trunk prefix).
export const normalizeE164 = (raw) => {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  // Already E.164-shaped: "+91987654321"
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed;
  // International dialling prefix "00": treat as E.164 root.
  // "0091987654321" -> "+91987654321".
  if (/^00\d{8,15}$/.test(trimmed)) return "+" + trimmed.slice(2);
  // Strip whitespace + parens + dashes; recheck.
  const cleaned = trimmed.replace(/[\s()\-.]/g, "");
  if (/^\+\d{8,15}$/.test(cleaned)) return cleaned;
  if (/^00\d{8,15}$/.test(cleaned)) return "+" + cleaned.slice(2);
  // Reject anything else. The caller (DND lookup, consent lookup,
  // outbound endpoint) explicitly handles a null return as
  // "invalid_number" and refuses to dial; this is fail-closed.
  return null;
};

// Region detection from an E.164 number. Cheap heuristic: just
// looks at the country code prefix. Falls back to OTHER. The
// outbound dialer uses this to know which compliance regime
// applies.
//
// P1 from May 2026 critic: distinguish Canada from the rest of
// the NANP. Canada's CRTC + CASL regime differs from the FCC's
// TCPA, and treating a Canadian number as US runs the wrong
// disclosure. We pull the area-code list from the public
// allocation; the major bands suffice for pilot. Bermuda /
// Caribbean NANP numbers fall through to US, which is wrong but
// closer than treating them as a separate uncovered region; the
// disclosure templates are functionally identical for them.
export const regionFromE164 = (e164) => {
  if (!e164 || typeof e164 !== "string" || !e164.startsWith("+")) return "OTHER";
  if (e164.startsWith("+91")) return "IN";
  if (e164.startsWith("+1")) {
    // Canadian area codes (NPAs allocated to Canada). List
    // sourced from CNAC. Truncated to the actively-used ones.
    const npa = e164.slice(2, 5);
    const CA_NPAS = new Set([
      "204", "226", "236", "249", "250", "263", "289",
      "306", "343", "354", "365", "367", "368", "382", "403", "416", "418", "428", "431", "437", "438", "450", "468", "474",
      "506", "514", "519", "548", "579", "581", "584", "587",
      "604", "613", "639", "647", "672", "683", "705", "709", "742",
      "778", "780", "782", "807", "819", "825", "867", "873", "879",
      "902", "905",
    ]);
    if (CA_NPAS.has(npa)) return "CA";
    return "US";
  }
  if (e164.startsWith("+44")) return "UK";
  if (e164.startsWith("+971")) return "AE";
  if (e164.startsWith("+65")) return "SG";
  // EU codes: 31, 32, 33, 34, 39, 49, 351, 353, 358, 359, 36, 370,
  // 371, 372, 30, 421, 420, 386. The list is illustrative; the
  // helper returns EU for the most common ones we'll see in
  // pilot.
  if (/^\+(31|32|33|34|39|49|351|353|358|36|370|371|372|30|421|420|386|45|46|47|48|350)/.test(e164)) return "EU";
  return "OTHER";
};

// Per-region recording-disclosure templates. The locale variants
// are short, regulator-acceptable copy. Real launch will need
// counsel review (the user has been told this); shipping defaults
// makes the launch-day diff minimal.
export const RECORDING_DISCLOSURE_TEMPLATES = {
  IN: {
    "en-IN": "This call may be recorded for quality and training purposes. By staying on the line you consent to the recording. You can ask us to stop the recording at any time.",
    "hi-IN": "गुणवत्ता और प्रशिक्षण उद्देश्यों के लिए यह कॉल रिकॉर्ड की जा सकती है। लाइन पर बने रहकर आप रिकॉर्डिंग के लिए सहमति देते हैं।",
  },
  US: {
    "en-US": "This call is being recorded for quality and training purposes.",
  },
  CA: {
    "en-CA": "This call may be recorded for quality and training purposes. By staying on the line you consent to the recording per CRTC and CASL guidance; if you do not consent, please say so now.",
    "fr-CA": "Cet appel peut être enregistré aux fins de qualité et de formation. En restant en ligne, vous consentez à l'enregistrement; si vous n'y consentez pas, veuillez nous en informer maintenant.",
  },
  EU: {
    "en-GB": "This call will be recorded for quality and training purposes. Your consent is required; if you do not consent, please say so now and we will end the recording. Recordings are retained per our privacy policy.",
  },
  UK: {
    "en-GB": "This call will be recorded for quality and training purposes. Your consent is required; if you do not consent, please say so now and we will end the recording.",
  },
  AE: {
    "en-AE": "This call may be recorded for quality and training purposes.",
  },
  SG: {
    "en-SG": "This call may be recorded for quality and training purposes.",
  },
  OTHER: {
    "en": "This call may be recorded for quality and training purposes.",
  },
};

// Pick the recording disclosure for a (region, locale) tuple,
// falling back through the region's available locales, then OTHER,
// then a string that should never ship in production but at least
// signals a configuration gap.
export const recordingDisclosureFor = (region, locale) => {
  const r = (region || "OTHER").toUpperCase();
  const reg = RECORDING_DISCLOSURE_TEMPLATES[r] || RECORDING_DISCLOSURE_TEMPLATES.OTHER;
  if (locale && reg[locale]) return reg[locale];
  // First locale in the region map.
  const firstLocaleKey = Object.keys(reg)[0];
  if (firstLocaleKey) return reg[firstLocaleKey];
  return "This call may be recorded.";
};

// Look up a phone number against the DND list. Returns:
//   { listed: true,  source: 'trai_ndnc' | 'fcc_dnc' | 'tenant_manual' | 'customer_request' }
//   { listed: false }
// Throws on a database error (caller decides whether to fail
// open or closed; the outbound endpoint fails closed).
export const isOnDndList = async (svc, { tenantId, phoneNumber }) => {
  if (!phoneNumber) return { listed: false };
  // The voice_dnd_list table indexes on phone_number; we can't
  // filter by tenant_id inline because the global rows have
  // tenant_id = null. Bug fix May 2026: previously this used
  // .limit(5) and then picked-first in JS, which could miss a
  // tenant-specific row when more than 5 entries existed for the
  // same number. We now pull tenant + null rows in two scoped
  // queries and prefer the tenant hit, which is also faster
  // because each query hits its own index condition.
  const tenantQ = await svc.from("voice_dnd_list")
    .select("source, region")
    .eq("phone_number", phoneNumber)
    .eq("tenant_id", tenantId)
    .order("added_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (tenantQ.error) throw new Error("voice_dnd_list tenant lookup: " + tenantQ.error.message);
  if (tenantQ.data) return { listed: true, source: tenantQ.data.source };
  const globalQ = await svc.from("voice_dnd_list")
    .select("source, region")
    .eq("phone_number", phoneNumber)
    .is("tenant_id", null)
    .order("added_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (globalQ.error) throw new Error("voice_dnd_list global lookup: " + globalQ.error.message);
  if (globalQ.data) return { listed: true, source: globalQ.data.source };
  return { listed: false };
};

// Look up an active voice consent for (tenant, phone). Returns:
//   { consented: true,  consent: { id, source, consented_at, expires_at } }
//   { consented: false, reason: 'no_record' | 'withdrawn' | 'expired' }
// "Active" means: not withdrawn, not past expires_at, scope
// includes voice. The most recent matching row wins.
export const hasVoiceConsent = async (svc, { tenantId, phoneNumber }) => {
  if (!phoneNumber) return { consented: false, reason: "no_record" };
  const r = await svc.from("voice_consent")
    .select("id, source, consented_at, withdrawn_at, expires_at, scope")
    .eq("tenant_id", tenantId)
    .eq("phone_number", phoneNumber)
    .order("consented_at", { ascending: false })
    .limit(5);
  if (r.error) throw new Error("voice_consent lookup: " + r.error.message);
  const rows = (r.data || []).filter((row) =>
    row.scope === "voice" || row.scope === "voice+sms");
  if (rows.length === 0) return { consented: false, reason: "no_record" };
  const latest = rows[0];
  if (latest.withdrawn_at) return { consented: false, reason: "withdrawn" };
  if (latest.expires_at && new Date(latest.expires_at).getTime() < Date.now()) {
    return { consented: false, reason: "expired" };
  }
  return {
    consented: true,
    consent: {
      id: latest.id,
      source: latest.source,
      consented_at: latest.consented_at,
      expires_at: latest.expires_at,
    },
  };
};

// Top-level pre-call gate: combines region detection + DND lookup
// + consent check into a single verdict the outbound endpoint
// can act on. Returns:
//
//   { allowed: true,  region, disclosure }
//   { allowed: false, region, reason: 'dnd_listed' | 'no_consent' |
//                                      'config_outbound_disabled' |
//                                      'invalid_number',
//                     detail: string,
//                     consent_reason?: 'no_record' | 'withdrawn' | 'expired',
//                     dnd_source?: string }
//
// `config` is the voice_configs row used for the call. The
// dialler reads `outbound_enabled` here so a tenant whose
// compliance review hasn't completed cannot dial out even with
// per-number consent.
export const checkOutboundCompliance = async (svc, { tenantId, config, toNumber }) => {
  const e164 = normalizeE164(toNumber);
  if (!e164) {
    return { allowed: false, region: "OTHER", reason: "invalid_number", detail: "Phone number could not be parsed to E.164" };
  }
  const region = regionFromE164(e164);
  if (!config?.outbound_enabled) {
    return { allowed: false, region, reason: "config_outbound_disabled", detail: "Voice config outbound_enabled flag is false; tenant has not completed compliance review" };
  }
  const dnd = await isOnDndList(svc, { tenantId, phoneNumber: e164 });
  if (dnd.listed) {
    return {
      allowed: false,
      region,
      reason: "dnd_listed",
      detail: "Number is on a Do-Not-Call list (" + dnd.source + ")",
      dnd_source: dnd.source,
    };
  }
  // Consent gate runs in all regions. India + EU + US all expect
  // it; we do not soft-fail by region. If the operator wants to
  // call a brand-new number, they capture consent first via the
  // /api/voice/consent endpoint.
  const consent = await hasVoiceConsent(svc, { tenantId, phoneNumber: e164 });
  if (!consent.consented) {
    return {
      allowed: false,
      region,
      reason: "no_consent",
      detail: "No active voice consent on file for " + e164 + " (" + consent.reason + ")",
      consent_reason: consent.reason,
    };
  }
  // Pick the disclosure the assistant should open with. Prefer
  // the per-config override; fall back to the region template.
  const disclosure = config.recording_disclosure
    || recordingDisclosureFor(region, config.recording_disclosure_locale);
  return {
    allowed: true,
    region,
    disclosure,
    consent_id: consent.consent.id,
  };
};

// Ergonomic wrapper for tests + the consent endpoint: record a
// new consent row.
export const recordVoiceConsent = async (svc, { tenantId, phoneNumber, source, customerId, customerContactId, expiresAt, sourceArtifactUrl, notes, createdBy }) => {
  const e164 = normalizeE164(phoneNumber);
  if (!e164) throw new Error("Could not parse phone number to E.164: " + phoneNumber);
  const ins = await svc.from("voice_consent").insert({
    tenant_id: tenantId,
    phone_number: e164,
    customer_id: customerId || null,
    customer_contact_id: customerContactId || null,
    scope: "voice",
    source,
    source_artifact_url: sourceArtifactUrl || null,
    expires_at: expiresAt || null,
    notes: notes || null,
    created_by: createdBy || null,
  }).select("id").single();
  if (ins.error) throw new Error("voice_consent insert: " + ins.error.message);
  return { id: ins.data.id, phone_number: e164 };
};

export const __test = {
  normalizeE164,
  regionFromE164,
  recordingDisclosureFor,
  RECORDING_DISCLOSURE_TEMPLATES,
};
