// Where the terms check meets the terms pass (plan PR 11).
//
// src/api/_lib/terms/terms-pass.js reads the PO's whole cached text and
// returns its verified clauses (docs/SO_TERMS_AND_HANDOFF_SCOPE.md sections 4
// and 9.2). The check calls its export `runTermsPass` with:
//
//   { svc, ctx, orderId, documentId, kind: "po", mode, previous, deadlineAt }
//
// where `previous` is the order's current order_term_checks row (or null), so
// the pass can reuse po_clauses read from the same text with the same prompt
// version, and `deadlineAt` is when the read must end. It returns:
//
//   { po_terms_status: "read" | "partial" | "not_read",
//     po_text_source: "text_layer" | "ocr_layer" | "office" | "email_body" | "none",
//     po_clauses: TermClause[], segmenter, dropped_unverified,
//     prompt_version, model, reason }
//
// The import is STATIC, so the deploy bundle traces terms-pass.js from
// api/dispatch.js. loadTermsPass stays the seam the check calls, and the one
// a test replaces with a fixture.

import { runTermsPass } from "./terms-pass.js";

export const loadTermsPass = async () => runTermsPass;
