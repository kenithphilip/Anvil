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

// The provider circuit breaker skips a model that was overloaded on every model
// it tried in the last N minutes, and records the skip on adapter_attempts.
// The card names it, so an operator knows why Gemini did not read this PO.
const skippedGemini = {
  adapter: "gemini",
  status: "skipped_circuit_open",
  reason: "provider_overloaded_recently",
  opened_at: "2026-10-07T05:10:00.000Z",
  last_overload_at: "2026-10-07T05:12:00.000Z",
  half_open_at: "2026-10-07T05:22:00.000Z",
  window_minutes: 10,
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

describe("ExtractionQualityCard and a model the breaker skipped", () => {
  it("says so on its own when another model read the PO", () => {
    const run = {
      id: "run-2",
      adapter_used: "claude",
      confidence_overall: 0.93,
      validator_issues: [],
      validator_summary: { error: 0, warn: 0, total: 0 },
      anomalies: [],
      anomalies_summary: { error: 0, warn: 0, info: 0, total: 0 },
      // Two chunks, one skip each: the card names Gemini once.
      adapter_attempts: [skippedGemini, { adapter: "claude", status: "ok", ms: 9000 }, skippedGemini],
    };
    const { getByRole, queryByRole } = render(
      <ExtractionQualityCard extractionRun={run} extractionIndex={buildExtractionIndex(run)} />,
    );
    expect(queryByRole("alert")).toBeNull();
    const banner = getByRole("status");
    expect(banner.textContent).toContain("Skipped a busy model");
    expect(banner.textContent).toContain("This run skipped gemini because it was overloaded in the last 10 minutes.");
    expect(banner.textContent).toContain("The next engine got its time.");
    expect(banner.textContent).toContain("Anvil tries gemini again from " + clock(skippedGemini.half_open_at) + ".");
  });

  it("adds it to the busy-models banner when a parser read the PO", () => {
    const run = {
      ...runReadByParser,
      adapter_attempts: [skippedGemini, { adapter: "claude", status: "failed", failure_class: "timeout", transient: true }],
    };
    const { getByRole, queryByRole } = render(
      <ExtractionQualityCard extractionRun={run} extractionIndex={buildExtractionIndex(run)} />,
    );
    const banner = getByRole("alert");
    expect(banner.textContent).toContain("Read by the fallback parser");
    expect(banner.textContent).toContain("This run skipped gemini because it was overloaded in the last 10 minutes.");
    // One banner, not two.
    expect(queryByRole("status")).toBeNull();
  });
});
