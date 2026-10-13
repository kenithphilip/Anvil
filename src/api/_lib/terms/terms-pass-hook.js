// Where the terms check meets the terms pass (plan PR 11).
//
// PR 11 is built separately. It adds src/api/_lib/terms/terms-pass.js, which
// reads the PO's whole cached text and returns its verified clauses
// (docs/SO_TERMS_AND_HANDOFF_SCOPE.md sections 4 and 9.2). The check calls
// its export `runTermsPass` with:
//
//   { svc, ctx, orderId, documentId, kind: "po", mode, previous }
//
// where `previous` is the order's current order_term_checks row (or null), so
// the pass can reuse po_clauses cached for the same text hash and prompt
// version. It returns:
//
//   { po_terms_status: "read" | "partial" | "not_read",
//     po_text_source: "text_layer" | "ocr_layer" | "office" | "email_body" | "none",
//     po_clauses: TermClause[], segmenter, dropped_unverified,
//     prompt_version, model, reason }
//
// Until that file exists the loader returns null and the check reads the PO
// side from what extraction already gives, labelled with its true
// provenance (sides.js).
//
// The specifier is a variable so the cold import of the API does not fail
// while the file is absent. When PR 11 lands, replace this dynamic import
// with a static `import { runTermsPass } from "./terms-pass.js"`, so the
// deploy bundle traces the file.

const TERMS_PASS_MODULE = "./terms-pass.js";

let loaded;

export const loadTermsPass = async () => {
  if (loaded !== undefined) return loaded;
  try {
    const mod = await import(/* @vite-ignore */ TERMS_PASS_MODULE);
    loaded = typeof mod.runTermsPass === "function" ? mod.runTermsPass : null;
  } catch (err) {
    const missing = err && (err.code === "ERR_MODULE_NOT_FOUND" || /Cannot find|Failed to load|not found/i.test(String(err.message || "")));
    if (!missing) console.warn("[terms] the terms pass failed to load; the check reads extraction instead: " + (err?.message || err));
    loaded = null;
  }
  return loaded;
};
