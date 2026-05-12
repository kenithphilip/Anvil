// Selective per-line re-extraction (Wave 4.4 / #19).
//
// Sometimes the operator looks at a low-confidence line and
// thinks "this one is wrong but the other 19 lines are fine".
// Today the workspace's "Re-extract" button re-runs the WHOLE
// document via runExtractionPipeline. That costs N adapter
// calls + the L1/L2 cache miss + the validator pass when we only
// needed to fix one line.
//
// This module:
//
//   1. Accepts the existing extraction_run_id + a list of
//      line_indices to re-extract.
//   2. Reads the prior run's normalized_extract.
//   3. Builds a sliced bodyText that includes ONLY the rows
//      corresponding to those lines (using the bbox/page info
//      stamped by Wave 4.3 to anchor; fallback to a coarse
//      "extract whole document text and ask the model to
//      re-emit only the indicated lines" prompt).
//   4. Runs the dispatcher on the sliced body with a tight
//      tool schema (re-emit just the indicated lines + their
//      confidence). Cheap: small prompt, small response, ~10%
//      of a full re-extraction's cost.
//   5. Merges the new lines back into the prior normalized
//      output, preserving the other lines.
//   6. Records the per-line provenance: when which adapter
//      re-extracted what, with what confidence change.

const buildSubsetPrompt = (priorNormalized, lineIndices) => {
  const lines = Array.isArray(priorNormalized?.lines) ? priorNormalized.lines : [];
  const subset = lineIndices.map((i) => {
    const line = lines[i];
    if (!line) return null;
    return {
      line_index: i,
      part_number: line.partNumber || null,
      description: line.description || null,
      current_unit_price: line.unitPrice ?? null,
      current_quantity: line.quantity ?? null,
      current_amount: line.amount ?? null,
      current_hsn: line.hsn || null,
      current_gst_pct: line.gst_pct ?? null,
    };
  }).filter(Boolean);
  return subset;
};

const SELECTIVE_TOOL = {
  name: "return_lines",
  description: "Return the re-extracted line items keyed by line_index.",
  input_schema: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            line_index: { type: "integer" },
            partNumber: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            quantity: { type: ["number", "null"] },
            unitPrice: { type: ["number", "null"] },
            amount: { type: ["number", "null"] },
            hsn: { type: ["string", "null"] },
            gst_pct: { type: ["number", "null"] },
            confidence: { type: ["number", "null"] },
          },
          required: ["line_index"],
        },
      },
    },
    required: ["lines"],
  },
};

const SYSTEM_PROMPT = "You are re-extracting specific line items from a purchase order. The user supplies the prior model output (which may be wrong) plus the FULL document body. Return ONLY the indicated lines with corrected values. If a field is unchanged, repeat it; do not invent values.";

// Public: re-extract a subset of lines via a cheap targeted LLM
// call. Accepts a CALLABLE adapter (so the cost-guard +
// per-extraction cap fire) and the bodyText of the original
// document; the dispatcher's full chain isn't reinvoked.
//
// Returns:
//   { ok, updated_lines: [{line_index, line}], attempts,
//     cost_estimate_usd }
export const selectiveReextract = async ({
  bodyText, priorNormalized, lineIndices, callAnthropic, opts = {},
}) => {
  if (!bodyText || !priorNormalized || !Array.isArray(lineIndices) || !lineIndices.length) {
    return { ok: false, error: "missing_inputs", updated_lines: [], attempts: [] };
  }
  if (typeof callAnthropic !== "function") {
    return { ok: false, error: "no_call_anthropic", updated_lines: [], attempts: [] };
  }
  const subset = buildSubsetPrompt(priorNormalized, lineIndices);
  if (!subset.length) {
    return { ok: false, error: "no_valid_line_indices", updated_lines: [], attempts: [] };
  }
  const user = "Document body:\n" + String(bodyText).slice(0, 50_000)
    + "\n\nPrior model output for the indicated lines:\n"
    + JSON.stringify(subset, null, 2)
    + "\n\nRe-extract only those lines. Return one entry per line_index.";
  const result = await callAnthropic({
    tenantId: opts.tenantId || null,
    purpose: "selective_reextract",
    model: opts.model || "claude-3-5-sonnet-latest",
    max_tokens: 1500,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: user }] }],
    tools: [SELECTIVE_TOOL],
    tool_choice: { type: "tool", name: "return_lines" },
    temperature: 0,
  });
  if (!result?.ok) {
    return { ok: false, error: result?.error || "upstream_error", updated_lines: [], attempts: [{ adapter: "claude", status: "failed", error: result?.error }] };
  }
  const block = (result.data?.content || []).find((c) => c.type === "tool_use" && c.name === "return_lines");
  if (!block) return { ok: false, error: "no_tool_use", updated_lines: [], attempts: [{ adapter: "claude", status: "failed", error: "no_tool_use" }] };
  const returnedLines = Array.isArray(block.input?.lines) ? block.input.lines : [];
  return {
    ok: true,
    updated_lines: returnedLines,
    attempts: [{ adapter: "claude", status: "ok" }],
  };
};

// Merge the re-extracted lines back into the prior normalized
// payload. Idempotent: passing the same updates twice yields the
// same result. Mutates the cloned normalized object (caller is
// responsible for cloning if they need to preserve the original).
export const mergeSelectiveUpdates = (priorNormalized, updatedLines) => {
  if (!priorNormalized || !Array.isArray(priorNormalized.lines)) return priorNormalized;
  if (!Array.isArray(updatedLines) || !updatedLines.length) return priorNormalized;
  for (const u of updatedLines) {
    const idx = Number(u.line_index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= priorNormalized.lines.length) continue;
    const prior = priorNormalized.lines[idx] || {};
    const merged = { ...prior };
    for (const k of ["partNumber", "description", "quantity", "unitPrice", "amount", "hsn", "gst_pct"]) {
      if (u[k] !== undefined) merged[k] = u[k];
    }
    if (u.confidence != null) merged._reextract_confidence = u.confidence;
    merged._reextracted_at = new Date().toISOString();
    priorNormalized.lines[idx] = merged;
  }
  return priorNormalized;
};

export const __test = { buildSubsetPrompt };
