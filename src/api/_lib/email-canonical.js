// Email canonicalisation + hashing (Wave CM 1.3).
//
// Mirrors the SQL `_canonicalise_email` + `_email_hash` functions
// in migration 128 so the JS side (inbound matcher, dedupe
// sweep, customer dedupe heuristic) computes the same hash the
// DB stores in customer_contacts.canonical_email_hash. The hash
// is the join key: a lookup against the canonical_email_hash
// index resolves "is this inbound email from a known contact?"
// in one indexed probe.
//
// Canonicalisation rules:
//   1. Lowercase + trim.
//   2. Strip +tag suffix on EVERY provider (most honour it; only
//      a tiny minority don't, and treating it as canonical is
//      strictly safer for dedupe).
//   3. Fold the dots in the local part for gmail.com /
//      googlemail.com (canonical Gmail rule). Other providers
//      keep dots verbatim.
//
// We do NOT strip the domain. Two contacts at the same display
// name but different domains are different people.

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export const canonicaliseEmail = (raw) => {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const at = s.indexOf("@");
  if (at < 0) return s;
  let local = s.slice(0, at);
  const domain = s.slice(at + 1);
  // Strip +tag.
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  // Gmail dot-fold.
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
  }
  if (!local) return null;
  return local + "@" + domain;
};

// SHA-256 hex of the canonicalised email. Returns null when the
// email is not parseable. Uses node:crypto for the serverless
// path; SubtleCrypto when available (edge runtime).
export const emailHash = async (raw) => {
  const canon = canonicaliseEmail(raw);
  if (!canon) return null;
  try {
    const sub = globalThis.crypto?.subtle;
    if (sub && typeof sub.digest === "function") {
      const enc = new TextEncoder().encode(canon);
      const digest = await sub.digest("SHA-256", enc);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch (_e) { /* fall through */ }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(canon).digest("hex");
};

// Look up a customer_contact by canonicalised email hash.
// Returns the contact + customer reference or null.
export const findContactByEmail = async (svc, tenantId, email) => {
  if (!svc || !tenantId) return null;
  const hash = await emailHash(email);
  if (!hash) return null;
  try {
    const r = await svc.from("customer_contacts")
      .select("id, customer_id, name, role, is_primary, is_active, preferred_locale, confidence")
      .eq("tenant_id", tenantId)
      .eq("canonical_email_hash", hash)
      .eq("is_active", true)
      .maybeSingle();
    return r?.data || null;
  } catch (_e) { return null; }
};

export const __test = { GMAIL_DOMAINS };
