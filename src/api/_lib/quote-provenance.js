// Recognising Anvil's OWN quotation PDFs, so we never re-read what we wrote.
//
// WHY THIS EXISTS. A quotation attached to a customer PO is very often not a
// third party's document — it is ours. The operator downloads the quote Anvil
// generated, mails it, and later attaches that same PDF to the PO it produced.
// For that file there is nothing to extract: every line, price, HSN and tax
// rate is already a row in quotes/quote_lines, authored in the app by a human.
// Running it back through a language model can only lose fidelity.
//
// And until now it did exactly that, destructively. ingestQuote keys on
// (tenant, quote_number, version) and REPLACES the quote's lines wholesale, so
// re-uploading our own quote deleted the authoritative quote_lines and put
// model output in their place — silently, reported as a successful ingest.
//
// SHAPE OF THE EVIDENCE. generateQuoteNumber (quotes/_lib/quote-build.js)
// emits Q-YYYYMM-NNNN, unique per tenant on (quote_number, version). The
// rendered PDF prints it in the fixed page header, and both download paths
// name the file quote-<number>.pdf (quotes/pdf.js, so-workspace.tsx).
//
// A FILENAME IS A HINT, NEVER A DECISION. Anyone can name a file
// quote-Q-202608-0001.pdf, and a customer's own PO may legitimately cite our
// quote number in its text. So a match here only ever nominates a CANDIDATE.
// The decision rests entirely on a quotes row that exists, belongs to this
// tenant, and was AUTHORED in Anvil rather than ingested — migration 188 is
// explicit that ingest_source null means authored in Anvil. A wrong hint finds
// no such row and costs one indexed lookup.
//
// This is deliberately source-agnostic: it reads a string. Today the caller
// passes a filename; passing the L1 text layer instead is the same call, which
// is what makes the eventual "never extract our own quote at all" cheap.

// Q-YYYYMM-NNNN, optionally followed by a version marker. The emailed PDF
// stamps "Q-202608-0001 v2" while the download stamps the bare number, so the
// version is optional and absent means "whatever the current version is".
const QUOTE_REF_RE = /\bQ-(\d{6})-(\d{4})\b(?:[\s_-]*v(\d+))?/i;

// Parse the FIRST self-issued quote reference out of arbitrary text.
// Returns null rather than throwing: this runs on operator-supplied filenames.
export const parseQuoteRef = (text) => {
  if (!text) return null;
  const m = QUOTE_REF_RE.exec(String(text));
  if (!m) return null;
  const version = m[3] ? Number(m[3]) : null;
  return {
    quote_number: `Q-${m[1]}-${m[2]}`.toUpperCase(),
    version: Number.isFinite(version) && version > 0 ? version : null,
  };
};

// Migration 188: ingest_source null = authored in Anvil, 'document' =
// extracted from an upload, 'bulk' = back-catalogue import. Only the first is
// authoritative; re-ingesting over the other two is legitimate and expected.
export const isAuthoredInAnvil = (row) =>
  !!row && (row.ingest_source == null || row.ingest_source === "");

// Resolve a candidate reference to a quote this tenant actually authored.
//
// Returns { matched, quote, reason }. `matched` is true ONLY for a row that
// exists, is this tenant's, and was authored in Anvil — every other outcome
// falls through to normal extraction, which is the safe direction: treating a
// third party's quote as ours would drop its contents on the floor.
export const findSelfIssuedQuote = async (svc, tenantId, ref) => {
  if (!ref?.quote_number) return { matched: false, quote: null, reason: "no_reference" };
  if (!tenantId) return { matched: false, quote: null, reason: "no_tenant" };
  let q = svc.from("quotes")
    .select("id, quote_number, version, status, ingest_source, currency, grand_total, customer_id")
    .eq("tenant_id", tenantId)
    .eq("quote_number", ref.quote_number);
  // No version in the reference means take the newest: an operator attaching
  // "the quote" means the one they last sent, not v1 of a revised chain.
  if (ref.version != null) q = q.eq("version", ref.version);
  const r = await q.order("version", { ascending: false }).limit(1);
  if (r.error) return { matched: false, quote: null, reason: "lookup_failed" };
  const row = (r.data || [])[0] || null;
  if (!row) return { matched: false, quote: null, reason: "not_ours" };
  if (!isAuthoredInAnvil(row)) {
    // The number is ours but this row was itself ingested from a document, so
    // there is no hand-authored content to protect. Extract as normal.
    return { matched: false, quote: row, reason: "previously_ingested" };
  }
  return { matched: true, quote: row, reason: "authored_in_anvil" };
};
