// Pipeline Diagnostics — extracted verbatim from screens/so-workspace.tsx.
// Self-contained: lazy-loads the order's pipeline-state on first open and
// renders the adapter chain + extraction runs + processing events.

import React, { useEffect } from "react";
import { Banner, Card, Chip, KV } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// Pipeline Diagnostics tab. Self-contained component that lazy-
// loads the order's pipeline-state on first open and renders the
// adapter chain + extraction runs + processing events.
// ============================================================
export const PipelineDiagnostics: React.FC<{
  orderId: string;
  state: { data: any; loading: boolean; error: any };
  setState: (s: { data: any; loading: boolean; error: any }) => void;
}> = ({ orderId, state, setState }) => {
  React.useEffect(() => {
    if (state.data || state.loading) return;
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    Promise.resolve((AnvilBackend as any)?.orders?.pipelineState?.(orderId))
      .then((data: any) => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((err: any) => { if (!cancelled) setState({ data: null, loading: false, error: err }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  if (state.loading) {
    return <Card><div className="body">Loading pipeline state…</div></Card>;
  }
  if (state.error) {
    return (
      <Banner kind="bad" icon={Icon.alert} title="Could not load pipeline state">
        <span className="mono-sm">{String(state.error?.message || state.error || "")}</span>
      </Banner>
    );
  }
  const data = state.data;
  if (!data) return <Card><div className="body">No pipeline data.</div></Card>;

  const REASON_LABELS: Record<string, string> = {
    ok: "OK · lines extracted",
    low_confidence: "Low confidence · review",
    empty_lines: "Empty lines · model returned no rows",
    non_po: "Non-PO · classifier rejected",
    non_ack: "Non-ack · classifier rejected the supplier-ack PDF",
    no_adapter_configured: "No adapter configured · check tenant settings",
    all_adapters_skipped: "All adapters skipped · keys missing",
    image_pdf_no_text: "Image-only PDF · no text layer · needs OCR",
    parse_failed: "Parse failed · model didn't call the tool",
    model_refused: "Model refused · safety stop",
    upstream_error: "Upstream error · provider 5xx",
    no_source_bytes: "No document reached the extractor · re-upload the PO or re-run from intake",
    no_api_key: "LLM API key not configured · ask an admin to set it",
    no_tenant: "Tenant context missing on the run · internal error, retry",
    adapter_threw: "Extractor crashed · see attempts for the error",
    fail_unknown: "Unknown failure",
  };
  // An attempt now carries the adapter's own reason/error (dispatchExtract used
  // to drop both, so a failed adapter showed "claude:failed" and nothing else —
  // and the run-level error belonged to whichever adapter ran last). Show the
  // reason inline; keep the full message in the tooltip.
  const attemptLabel = (a: any) =>
    a.adapter + ":" + a.status + (a.reason ? "(" + a.reason + ")" : "");
  const attemptDetail = (a: any) =>
    attemptLabel(a) + (a.error ? " — " + a.error : "");

  const reasonTone = (r: string): "good" | "info" | "warn" | "bad" =>
    r === "ok" ? "good"
    : r === "low_confidence" ? "warn"
    : r === "empty_lines" || r === "non_po" || r === "image_pdf_no_text" ? "warn"
    : r === "no_adapter_configured" || r === "all_adapters_skipped" ? "bad"
    : "bad";

  const latest = data.latest_run_summary;
  const runs = data.extraction_runs || [];
  const events = data.processing_events || [];
  const ocrRuns = data.ocr_runs || [];
  const adapterChain = data.adapter_chain || [];

  return (
    <div className="diag">
      {/* Top-line summary banner */}
      {latest ? (
        <Banner
          kind={reasonTone(latest.status_reason)}
          icon={Icon.info}
          title={"Latest extraction: " + (REASON_LABELS[latest.status_reason] || latest.status_reason || "unknown")}
        >
          <span className="mono-sm">
            adapter <b>{latest.adapter_used || "none"}</b>
            {latest.confidence_overall != null
              ? " · confidence " + Number(latest.confidence_overall).toFixed(2)
              : ""}
            {latest.finished_at
              ? " · " + new Date(latest.finished_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
              : ""}
          </span>
          {/* The smoking gun for an empty-lines failure: the PO's own declared
              line count vs what we extracted. Shown whenever they disagree. */}
          {latest.extracted_line_count === 0 && (
            <div className="body" style={{ marginTop: 6 }}>
              {latest.stated_line_count
                ? <>This PO declares <b>{latest.stated_line_count}</b> line item{latest.stated_line_count === 1 ? "" : "s"} but extraction returned <b>0</b>. </>
                : <>Extraction returned <b>0</b> line items. </>}
              The pipeline already auto-retries once on a stronger model when a PO
              comes back with a header but no lines; a run still showing 0 means
              even that retry read no table — the document likely needs OCR or a
              manual line entry. See the escalation events below.
            </div>
          )}
        </Banner>
      ) : (
        <Banner kind="info" icon={Icon.info} title="No extraction runs yet">
          <span className="mono-sm">Run extraction from the action bar to populate this view.</span>
        </Banner>
      )}

      {/* Adapter chain health */}
      <Card title="Adapter chain" eyebrow="docai_provider_order">
        <table className="tbl">
          <thead><tr><th>#</th><th>Adapter</th><th>Configured</th></tr></thead>
          <tbody>
            {adapterChain.map((a: any, i: number) => (
              <tr key={a.name}>
                <td className="mono-sm">{i + 1}</td>
                <td className="mono">{a.name}</td>
                <td>
                  <Chip k={a.configured_hint ? "good" : "bad"}>
                    {a.configured_hint ? "yes" : "no"}
                  </Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Source document */}
      {data.document && (
        <Card title="Source document">
          <KV rows={[
            ["Filename",    data.document.filename || "—"],
            ["Mime",        data.document.mime_type || "—"],
            ["Size",        data.document.size_bytes != null ? data.document.size_bytes + " bytes" : "—"],
            ["Scan status", data.document.scan_status || "—"],
            ["Threats",     Array.isArray(data.document.scan_threats) && data.document.scan_threats.length
                              ? data.document.scan_threats.join(", ") : "(none)"],
          ]} />
        </Card>
      )}

      {/* Phase A-E pipeline layers. Surface L1 text-layer cache,
          L2 OCR cache, and the latest run's layer/voter/template
          flags so the operator can see at a glance whether the
          deterministic stages ran. */}
      {(data.text_layer || data.ocr_layer || latest) && (
        <Card title="Pipeline layers" eyebrow="L1 · L2 · L3 · L6 · E">
          <KV rows={[
            ["L1 text layer", data.text_layer
              ? (data.text_layer.text_status + " · "
                  + (data.text_layer.char_count ?? 0) + " chars · "
                  + (data.text_layer.page_count ?? 0) + " pages "
                  + (data.text_layer.extractor ? "(" + data.text_layer.extractor + ")" : ""))
              : "(no cache)"],
            ["L2 OCR layer", data.ocr_layer
              ? (data.ocr_layer.ocr_status + " · "
                  + (data.ocr_layer.char_count ?? 0) + " chars · "
                  + (data.ocr_layer.page_count ?? 0) + " pages · "
                  + (data.ocr_layer.bbox_count ?? 0) + " bboxes "
                  + (data.ocr_layer.provider ? "(" + data.ocr_layer.provider + ")" : ""))
              : "(no cache)"],
            ["Latest run used", latest ? [
                latest.text_layer_used ? "L1 text" : null,
                latest.ocr_layer_used ? "L2 OCR" : null,
                latest.template_used ? "L3 template" : null,
                latest.voter_used ? "L6 voter" : null,
                latest.overrides_applied_count > 0
                  ? "E overrides (" + latest.overrides_applied_count + ")"
                  : null,
              ].filter(Boolean).join(" · ") || "L4 LLM only"
              : "—"],
            ["Validator summary", latest?.validator_summary
              ? (latest.validator_summary.error
                  ? latest.validator_summary.error + " errors · "
                  : "")
                + (latest.validator_summary.warn
                  ? latest.validator_summary.warn + " warnings · "
                  : "")
                + (latest.validator_summary.total
                  ? latest.validator_summary.total + " total"
                  : "no issues")
              : "(no validator run yet)"],
            ["Extraction kind", latest?.extraction_kind || "po"],
            ["Lines declared / extracted", latest
              ? (latest.stated_line_count ?? "—") + " declared · " + (latest.extracted_line_count ?? "—") + " extracted"
              : "—"],
            ["LLM model used", latest?.selected_model
              ? latest.selected_model + (latest.model_selection_reason
                  ? " (reason: " + latest.model_selection_reason + ")"
                  : "")
              : "—"],
          ]} />
        </Card>
      )}

      {/* Extraction runs */}
      <Card flush>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)" }}>
          <span className="h2">Extraction runs</span>
          <span className="mono-sm" style={{ marginLeft: 8, color: "var(--ink-3)" }}>
            {runs.length} run{runs.length === 1 ? "" : "s"}
          </span>
        </div>
        {runs.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No extraction_runs row found for this order's source document.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead><tr>
              <th>Started</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Adapter</th>
              <th>Model</th>
              <th className="r">Conf</th>
              <th className="r">Lines</th>
              <th>Layers</th>
              <th>Validator</th>
              <th>Attempts</th>
            </tr></thead>
            <tbody>
              {runs.map((r: any) => {
                const layerBadges = [
                  r.text_layer_used ? "L1" : null,
                  r.ocr_layer_used ? "L2" : null,
                  r.template_used ? "L3" : null,
                  r.voter_used ? "L6" : null,
                  Array.isArray(r.overrides_applied) && r.overrides_applied.length ? "E" : null,
                ].filter(Boolean).join("·");
                const vSum = r.validator_summary || {};
                const vText = (vSum.error || vSum.warn)
                  ? (vSum.error ? vSum.error + "e " : "") + (vSum.warn ? vSum.warn + "w" : "")
                  : (vSum.total === 0 ? "ok" : "—");
                return (
                  <tr key={r.id}>
                    <td className="mono-sm">
                      {r.finished_at
                        ? new Date(r.finished_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
                        : "(running)"}
                    </td>
                    <td className="mono-sm">{r.extraction_kind || "po"}</td>
                    <td><Chip k={r.status === "ok" ? "good" : r.status === "low_confidence" ? "warn" : "bad"}>{r.status}</Chip></td>
                    <td title={r.status_reason || ""}>
                      <Chip k={reasonTone(r.status_reason || "")}>
                        {REASON_LABELS[r.status_reason] || r.status_reason || "—"}
                      </Chip>
                    </td>
                    <td className="mono-sm">{r.adapter_used || "—"}</td>
                    <td className="mono-sm" title={r.model_selection_reason || ""}>
                      {r.selected_model || "—"}
                    </td>
                    <td className="r mono">{r.confidence_overall != null ? Number(r.confidence_overall).toFixed(2) : "—"}</td>
                    <td className="r mono" title="declared → extracted">
                      {(r.stated_line_count ?? "?") + " → " + (r.extracted_line_count ?? "?")}
                    </td>
                    <td className="mono-sm">{layerBadges || "L4"}</td>
                    <td className="mono-sm">{vText}</td>
                    <td className="mono-sm" title={Array.isArray(r.adapter_attempts) ? r.adapter_attempts.map(attemptDetail).join("\n") : ""}>
                      {Array.isArray(r.adapter_attempts)
                        ? r.adapter_attempts.map(attemptLabel).join(" · ")
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </Card>

      {/* OCR runs */}
      {ocrRuns.length > 0 && (
        <Card flush>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)" }}>
            <span className="h2">OCR runs</span>
          </div>
          <table className="tbl">
            <thead><tr><th>Started</th><th>Provider</th><th>Status</th><th className="r">Pages</th><th className="r">Evidence</th><th>Error</th></tr></thead>
            <tbody>
              {ocrRuns.map((r: any) => (
                <tr key={r.id}>
                  <td className="mono-sm">{r.started_at ? new Date(r.started_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                  <td className="mono-sm">{r.provider}</td>
                  <td><Chip k={r.status === "completed" ? "good" : r.status === "running" ? "info" : "bad"}>{r.status}</Chip></td>
                  <td className="r mono">{r.page_count ?? "—"}</td>
                  <td className="r mono">{r.evidence_count ?? "—"}</td>
                  <td className="mono-sm" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.error || ""}>{r.error || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Processing events timeline */}
      <Card flush>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)" }}>
          <span className="h2">Processing events</span>
          <span className="mono-sm" style={{ marginLeft: 8, color: "var(--ink-3)" }}>{events.length}</span>
        </div>
        {events.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No processing_events keyed to this order's id or source document.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr><th>When</th><th>Event</th><th>Object</th><th>Detail</th></tr></thead>
            <tbody>
              {events.map((ev: any) => (
                <tr key={ev.id}>
                  <td className="mono-sm">{new Date(ev.created_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                  <td className="mono">{ev.event_type}</td>
                  <td className="mono-sm">{ev.object_type}{ev.object_id ? "/" + String(ev.object_id).slice(0, 8) : ""}</td>
                  <td className="mono-sm" style={{ maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={JSON.stringify(ev.detail)}>
                    {JSON.stringify(ev.detail).slice(0, 200)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Raw normalized + raw_extract previews for the latest run */}
      {runs[0] && (
        <Card title="Latest run · raw output" eyebrow="truncated for readability">
          <details>
            <summary className="mono-sm" style={{ cursor: "pointer" }}>normalized_extract</summary>
            <pre className="mono-sm" style={{ whiteSpace: "pre-wrap", marginTop: 8, padding: 8, background: "var(--ink-bg-2)", borderRadius: 6, maxHeight: 320, overflow: "auto" }}>
              {JSON.stringify(runs[0].normalized_extract, null, 2)}
            </pre>
          </details>
          <details style={{ marginTop: 8 }}>
            <summary className="mono-sm" style={{ cursor: "pointer" }}>raw_extract</summary>
            <pre className="mono-sm" style={{ whiteSpace: "pre-wrap", marginTop: 8, padding: 8, background: "var(--ink-bg-2)", borderRadius: 6, maxHeight: 320, overflow: "auto" }}>
              {JSON.stringify(runs[0].raw_extract, null, 2)}
            </pre>
          </details>
        </Card>
      )}
    </div>
  );
};
