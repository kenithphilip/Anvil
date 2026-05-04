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
