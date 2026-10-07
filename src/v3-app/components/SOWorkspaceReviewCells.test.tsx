// The SO workspace's extraction-quality card tells the operator when the AI
// models were busy and a fallback parser read the PO.
//
// On 2026-10-07 a 6-page PO was read by LlamaParse because Gemini was
// overloaded and Claude timed out. The card showed the adapter and the counts
// and nothing else, so it looked like an ordinary weak read. The run now
// carries the llm_unavailable_fallback_parse anomaly, and the card turns it
// into a plain banner: what happened, what to check, and that running
// extraction again later may give a better result. Every value is invented.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ExtractionQualityCard } from "./SOWorkspaceReviewCells";
import { buildExtractionIndex } from "../lib/field-sources";

const runReadByParser = {
  id: "run-1",
  adapter_used: "llamaparse",
  confidence_overall: 0.6,
  validator_issues: [],
  validator_summary: { error: 0, warn: 0, total: 0 },
  anomalies: [{
    code: "llm_unavailable_fallback_parse",
    severity: "warn",
    path: "document",
    actual: "llamaparse",
    detail: "The AI models were busy (gemini overloaded, claude timed out), so the fallback parser (llamaparse) read this document.",
  }],
  anomalies_summary: { error: 0, warn: 1, info: 0, total: 1 },
};

describe("ExtractionQualityCard", () => {
  it("shows the busy-models banner when a fallback parser read the PO", () => {
    const { getByRole, container } = render(
      <ExtractionQualityCard extractionRun={runReadByParser} extractionIndex={buildExtractionIndex(runReadByParser)} />,
    );
    const banner = getByRole("alert");
    expect(banner.textContent).toContain("Read by the fallback parser");
    expect(banner.textContent).toContain("The AI models were busy, so the fallback parser (llamaparse) read this PO.");
    expect(banner.textContent).toContain("Run extraction again later for a better result.");
    // The card's own numbers still render under it.
    expect(container.textContent).toContain("Extraction quality");
  });

  it("shows no banner on an ordinary run", () => {
    const run = { ...runReadByParser, adapter_used: "gemini", anomalies: [], anomalies_summary: { error: 0, warn: 0, info: 0, total: 0 } };
    const { queryByRole } = render(
      <ExtractionQualityCard extractionRun={run} extractionIndex={buildExtractionIndex(run)} />,
    );
    expect(queryByRole("alert")).toBeNull();
  });
});
