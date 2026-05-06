// Storage-bucket name resolver. Pre-rebrand the canonical bucket was
// `obara-documents`; post-rebrand new deployments default to
// `anvil-documents`. The env var lets an operator pin the legacy
// name on an existing deployment without a code change, so the
// rename is purely a Supabase Storage admin operation.
//
// Resolution order:
//   1. process.env.ANVIL_DOCUMENTS_BUCKET (explicit override)
//   2. anvil-documents (new deployments)
//   3. obara-documents (legacy fallback used by `tryDocumentsBucket`
//      when a fetch returns 404 against the primary bucket)

export const documentsBucket = () =>
  process.env.ANVIL_DOCUMENTS_BUCKET || "anvil-documents";

export const legacyDocumentsBucket = () => "obara-documents";

// Helper that takes a Supabase service client + a function that takes
// a bucket name and runs an operation, and tries the canonical bucket
// first, falling back to the legacy bucket on PGRST204 / not-found.
// Useful for read paths (signed URL, download) that have to keep
// working on existing tenants whose data is still in the legacy bucket.
export const withBucketFallback = async (run) => {
  try {
    return await run(documentsBucket());
  } catch (err) {
    if (legacyDocumentsBucket() === documentsBucket()) throw err;
    return await run(legacyDocumentsBucket());
  }
};

// Idempotent ensure-bucket. Probes listBuckets, creates the canonical
// bucket if missing, falls back to the legacy name. Throws an
// actionable error only when both attempts fail. Closes the
// "signed URL: related resource does not exist" failure on first-run
// uploads. Cached per process so repeat callers don't re-probe.
let _ensuredBucket = null;

// Test-only: clear the cached bucket name so repeat unit tests can
// exercise the probe + create paths cleanly. Production code never
// needs this.
export const _resetEnsuredBucket = () => { _ensuredBucket = null; };

export const ensureDocumentsBucket = async (svc) => {
  if (_ensuredBucket) return _ensuredBucket;
  const canonical = documentsBucket();
  const legacy = legacyDocumentsBucket();
  const tried = [];
  try {
    const { data: buckets, error } = await svc.storage.listBuckets();
    if (!error && Array.isArray(buckets)) {
      const have = new Set(buckets.map((b) => b.name));
      if (have.has(canonical)) { _ensuredBucket = canonical; return canonical; }
      if (have.has(legacy))    { _ensuredBucket = legacy;    return legacy; }
    }
  } catch (_) { /* fall through */ }
  try {
    const { error: createErr } = await svc.storage.createBucket(canonical, { public: false });
    if (!createErr) { _ensuredBucket = canonical; return canonical; }
    tried.push(canonical + ": " + createErr.message);
  } catch (e) { tried.push(canonical + ": " + (e.message || String(e))); }
  try {
    const { error: createErr } = await svc.storage.createBucket(legacy, { public: false });
    if (!createErr) { _ensuredBucket = legacy; return legacy; }
    tried.push(legacy + ": " + createErr.message);
  } catch (e) { tried.push(legacy + ": " + (e.message || String(e))); }
  throw new Error(
    "Documents storage bucket missing. Could not auto-create on Supabase. " +
    "Create a private bucket named `" + canonical + "` in the Supabase " +
    "dashboard (Storage > New bucket) or set ANVIL_DOCUMENTS_BUCKET to " +
    "an existing bucket. Attempted: " + tried.join("; "),
  );
};

// Wraps a Supabase storage error message that says "not found" / "404"
// / "does not exist" into something the operator can act on. Use this
// after every createSignedUrl / createSignedUploadUrl that goes through
// withBucketFallback or against a hardcoded bucket name.
export const friendlyStorageError = (rawMessage, bucket) => {
  const msg = String(rawMessage || "");
  if (/not.*exist|not.*found|404/i.test(msg)) {
    return "Documents storage bucket `" + bucket + "` not found. " +
      "Create a private bucket with that name in Supabase Storage, or " +
      "set ANVIL_DOCUMENTS_BUCKET to point at an existing bucket.";
  }
  return msg;
};
