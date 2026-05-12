// Cross-page table continuation (Wave 5.3 / #3).
//
// The PDF chunker (pdf-chunker.js) cuts a long doc into N-page
// chunks for parallel LLM extraction. That's fast but it splits
// continuation tables: a 14-line PO with line items on pages 2
// and 3 becomes two extractor calls, each emitting partial
// tables. The merge step concatenates the line arrays but every
// line's confidence drops because the model on page 3 saw the
// SECOND HALF of the table without the column header on page 2.
//
// Fix: before chunking, detect line-item tables that span page
// boundaries and either:
//   1. Keep the spanning pages in the same chunk (preferred when
//      the chunk doesn't exceed maxPagesPerChunk), or
//   2. Replicate the column header from the start of the table
//      onto every subsequent chunk so the LLM has full context.
//
// Detection heuristic. We look for:
//   - Page N ending with a row that looks like a line item
//     (begins with a numeric quantity or "Item N").
//   - Page N+1 starting with a row that ALSO looks like a line
//     item (without re-emitting a header).
// When both fire, the table spans the boundary.
//
// This module produces decisions for the chunker; it doesn't
// rewrite the PDF itself. The chunker consumes the decisions
// and adjusts its page-keep map accordingly.

const LINE_ITEM_LEADING = /^(\s*\d+[.)]\s|\s*Item\s+\d+|\s*\d+\s+(?:[A-Z]{2,}|\w{2,}[-\w]+))/i;
const HEADER_TOKENS = /(qty|quantity|description|item|hsn|sac|rate|amount|unit\s+price)/i;

const lastNonEmptyLine = (text) => {
  if (!text) return "";
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] && lines[i].trim()) return lines[i].trim();
  }
  return "";
};

const firstNonEmptyLine = (text) => {
  if (!text) return "";
  const lines = String(text).split(/\r?\n/);
  for (const l of lines) {
    if (l && l.trim()) return l.trim();
  }
  return "";
};

const looksLikeHeaderRow = (line) => HEADER_TOKENS.test(line) && (line.match(HEADER_TOKENS) || []).length >= 2;

const looksLikeLineItemRow = (line) => LINE_ITEM_LEADING.test(line);

// Detect spanning boundaries given an ordered array of per-page
// text snippets [{ page, text }]. Returns an array of
// { from_page, to_page, header_page? } entries.
export const detectSpanningTables = (pages) => {
  if (!Array.isArray(pages) || pages.length < 2) return [];
  const spans = [];
  // Find the most recent header page; once a header row exists,
  // every subsequent line-item-only page is part of the same
  // table until either a new header or a non-line block (totals,
  // T&C) breaks the run.
  let headerPage = null;
  let runStart = null;
  for (let i = 0; i < pages.length; i++) {
    const text = pages[i]?.text || "";
    const first = firstNonEmptyLine(text);
    const last = lastNonEmptyLine(text);
    const hasHeader = first && looksLikeHeaderRow(first);
    if (hasHeader) {
      headerPage = pages[i].page;
      runStart = pages[i].page;
    }
    if (runStart != null) {
      const endsWithLine = last && looksLikeLineItemRow(last);
      const nextText = pages[i + 1]?.text || "";
      const nextFirst = firstNonEmptyLine(nextText);
      const nextIsContinuation = nextFirst && looksLikeLineItemRow(nextFirst) && !looksLikeHeaderRow(nextFirst);
      if (endsWithLine && nextIsContinuation) {
        spans.push({
          from_page: pages[i].page,
          to_page: pages[i + 1].page,
          header_page: headerPage,
        });
      } else if (!endsWithLine || !looksLikeLineItemRow(first)) {
        // Run broke; clear state.
        if (!hasHeader) {
          headerPage = null;
          runStart = null;
        }
      }
    }
  }
  return spans;
};

// Given detected spans + the chunker's keep-pages decision,
// produce a list of (chunk_index, header_page_to_replicate)
// entries so the chunker can carry the header forward.
//
// Strategy:
//   - For each spanning pair (from -> to) that ends up in
//     different chunks, mark the destination chunk as needing
//     the header.
//   - The chunker reads this mapping and either:
//     a. Adds the header page to the destination chunk's
//        page-keep set (cheap; one extra page in the prompt),
//     b. Or pads the prompt with a synthesised "[continuation
//        of table on page X]" hint.
export const planHeaderReplication = (spans, chunks) => {
  if (!Array.isArray(spans) || !Array.isArray(chunks)) return [];
  const out = [];
  for (const span of spans) {
    const fromChunk = chunks.findIndex((c) => c.pageStart <= span.from_page && span.from_page <= c.pageEnd);
    const toChunk = chunks.findIndex((c) => c.pageStart <= span.to_page && span.to_page <= c.pageEnd);
    if (fromChunk === toChunk) continue;        // already same chunk
    if (toChunk < 0 || span.header_page == null) continue;
    out.push({
      chunk_index: toChunk,
      header_page: span.header_page,
      from_chunk: fromChunk,
      span_from: span.from_page,
      span_to: span.to_page,
    });
  }
  return out;
};

export const __test = { firstNonEmptyLine, lastNonEmptyLine, looksLikeHeaderRow, looksLikeLineItemRow };
