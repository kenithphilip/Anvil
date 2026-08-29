-- Migration 223: density-aware chunking dark flag.
--
-- Adds tenant_settings.docai_density_chunk_enabled (default false), the opt-in
-- switch for row-window ("density-aware") extraction chunking
-- (src/api/_lib/docai/density-chunk.js, planned in
-- docs/DENSITY_AWARE_CHUNKING_DESIGN.md).
--
-- WHY. The PDF chunker splits by PAGE, so a document that is line-dense but
-- page-few -- a 200-line annual rate contract on 4 pages -- can never be split
-- and overruns a single extractor call even at the generation tier. When the
-- flag is on AND the generation-tier retry (migration-free, shipped in #525)
-- still returns output_truncated or zero lines AND the text layer really is
-- dense, run.js splits the TEXT into row windows (each carrying the document
-- preamble + the column header) and extracts them one at a time, merging the
-- line arrays.
--
-- Off by default because each window is an additional LLM call: it is the LAST
-- resort for documents that would otherwise extract nothing at all, and it
-- should be piloted per tenant. The shared per-extraction cost cap and the run
-- deadline both still bound it, and a density result is adopted only when it
-- recovers MORE lines than the attempt before it.
--
-- Additive + idempotent. Default false -> byte-identical for every tenant until
-- one opts in.

alter table tenant_settings
  add column if not exists docai_density_chunk_enabled boolean not null default false;

comment on column tenant_settings.docai_density_chunk_enabled is
  'Opt-in: row-window (density-aware) extraction chunking for line-dense, page-few documents, after the generation-tier retry still truncates or returns no lines (docai/density-chunk.js). Default false. See docs/DENSITY_AWARE_CHUNKING_DESIGN.md.';
