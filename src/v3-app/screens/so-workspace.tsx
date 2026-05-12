import React, { useEffect, useMemo, useState } from "react";
import { ageLabel, stageOf } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, Prov, Steps, Stream, WSTabs, WSTitle, fmtINR, fmtUSD } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { amountInWords } from "../lib/amount-words";
import { getFieldSource, markFieldEdited, FieldSource } from "../lib/field-sources";
import { ItemMasterPicker, PickedItem } from "../components/ItemMasterPicker";
import { computeLineTotals, TAX_AMOUNT_KEYS, AUX_AMOUNT_KEYS, COMPONENT_LABEL } from "../lib/line-totals";
import { ExtractionProgress } from "../components/ExtractionProgress";

// ============================================================
// ANVIL v3 — wired SO Workspace
// The hero screen: reconciliation grid + margin cockpit + why
// + evidence + approval + tally + schedule + shipments + activity,
// all keyed by ?id= in the URL hash.
// ============================================================

const WiredSOWorkspace = () => {
  const { useState: u, useEffect: e, useMemo: m } = React;
  const [order, setOrder] = u({ data: null, loading: true, error: null });
  const [audit, setAudit] = u({ data: [], loading: true });
  const [procEvents, setProcEvents] = u({ data: [], loading: true });
  const [cost, setCost] = u({ data: null, loading: true });
  const [schedule, setSchedule] = u({ data: [], loading: true, error: null });
  const [bump, setBump] = u(0);
  const [scheduleBump, setScheduleBump] = u(0);
  const [tsv, setTsv] = u("");
  const [busy, setBusy] = u(false);
  // Inline line-item editor state. Driven from the persisted lines
  // on the order; when null, the table renders the persisted values
  // directly. Once the operator changes a field, a draft is forked
  // and stays in state until Save (PATCHes /api/orders/[id]) or
  // Discard (clears the draft).
  const [linesDraft, setLinesDraft] = u<any[] | null>(null);
  const [savingLines, setSavingLines] = u(false);
  // Layer A: manual-map picker for un-mapped recon-table lines.
  // pickerLineIdx === null means closed; otherwise it's the index
  // of the line being mapped. onPick stamps _mapped_item with
  // match_via:"manual" and the server hook in orders/[id].js PATCH
  // writes an item_customer_parts row so future POs from the same
  // customer auto-resolve via the customer_part tier.
  const [pickerLineIdx, setPickerLineIdx] = u<number | null>(null);
  // Layer C: AI-assisted suggestions. Keyed by line index; each
  // value is the top-3 (or fewer) suggestions for that line.
  // Loaded lazily on "Suggest mappings" click; persists in
  // component state until the operator accepts/rejects or the
  // order's line items change.
  const [suggestionsByLine, setSuggestionsByLine] = u<Record<number, any[]>>({});
  const [suggesting, setSuggesting] = u(false);
  const [suggestError, setSuggestError] = u<string | null>(null);
  // Per-line tax-breakdown expander: an entry { [i]: true } means
  // row i's sub-row (CGST / SGST / IGST / UTGST / Cess / Excise /
  // Ed.cess / Tooling / P&F / Others) is currently visible and
  // editable. Operators with a Hyundai-style PO use this to fix
  // up extractor output that landed under the wrong tax cell.
  const [breakdownOpen, setBreakdownOpen] = u<Record<number, boolean>>({});
  // Phase 3.6 observability: pipeline-diagnostics state (lazy-
  // loaded the first time the operator opens the Diagnostics tab).
  const [pipelineState, setPipelineState] = u<{ data: any; loading: boolean; error: any }>({ data: null, loading: false, error: null });

  // Read order id + tab from URL hash query: #/so?id=...&tab=schedule
  const hashQuery = (() => {
    const hash = window.location.hash || "";
    const q = hash.split("?")[1];
    return new URLSearchParams(q || "");
  })();
  const orderId = hashQuery.get("id");
  const initialTab = hashQuery.get("tab") || "recon";
  const [tab, setTab] = u(initialTab);

  e(() => {
    if (!orderId) { setOrder({ data: null, loading: false, error: new Error("no order id in URL") }); return; }
    let cancelled = false;
    setOrder((s) => ({ ...s, loading: true }));
    Promise.resolve(ObaraBackend?.orders?.get?.(orderId))
      .then((data) => { if (!cancelled) setOrder({ data: data?.order || data, loading: false, error: null }); })
      .catch((error) => { if (!cancelled) setOrder({ data: null, loading: false, error }); });
    return () => { cancelled = true; };
  }, [orderId, bump]);

  e(() => {
    if (!orderId) return;
    let cancelled = false;
    Promise.resolve(ObaraBackend?.audit?.list?.({ object_id: orderId, limit: 100 }) || Promise.resolve([]))
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data) ? data : (data?.events || data?.rows || []);
        setAudit({ data: rows, loading: false });
      })
      .catch((err) => {
        // Audit list failures are non-fatal: the activity timeline
        // just shows fewer rows. Log to console so a dev sees the
        // problem without spamming the UI with a banner.
        if (!cancelled) {
          console.warn("[so-workspace] audit fetch failed", err);
          setAudit({ data: [], loading: false });
        }
      });
    return () => { cancelled = true; };
  }, [orderId, bump]);

  // Source 3 of merged Activity stream: processing_events keyed by case_id = orderId.
  e(() => {
    if (!orderId) return;
    let cancelled = false;
    Promise.resolve(ObaraBackend?.events?.list?.(orderId) || Promise.resolve([]))
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data) ? data : (data?.events || data?.rows || []);
        setProcEvents({ data: rows, loading: false });
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn("[so-workspace] processing-events fetch failed", err);
          setProcEvents({ data: [], loading: false });
        }
      });
    return () => { cancelled = true; };
  }, [orderId, bump]);

  e(() => {
    if (!orderId || !order.data?.customer_id) return;
    let cancelled = false;
    Promise.resolve(ObaraBackend?.cost?.breakdown?.({ customer_id: order.data.customer_id }) || Promise.resolve(null))
      .then((data) => { if (!cancelled) setCost({ data, loading: false }); })
      .catch((err) => {
        if (!cancelled) {
          console.warn("[so-workspace] cost-breakdown fetch failed", err);
          setCost({ data: null, loading: false });
        }
      });
    return () => { cancelled = true; };
  }, [orderId, order.data?.customer_id]);

  // Schedule lines: own bump so add/clear/delete refetches without reloading the order.
  e(() => {
    if (!orderId) return;
    let cancelled = false;
    setSchedule((s) => ({ ...s, loading: true }));
    Promise.resolve(ObaraBackend?.scheduleLines?.list?.(orderId) || Promise.resolve({ schedule_lines: [] }))
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data) ? data : (data?.schedule_lines || data?.rows || []);
        setSchedule({ data: rows, loading: false, error: null });
      })
      .catch((error) => { if (!cancelled) setSchedule({ data: [], loading: false, error }); });
    return () => { cancelled = true; };
  }, [orderId, scheduleBump]);

  // ─────────────────────────────────────────────────────────────
  // Schedule lines KPIs + helpers (Surface A)
  //
  // IMPORTANT: these useMemo calls MUST stay above the early
  // returns below. React's rules-of-hooks require the same
  // number of hooks per render; if the order is loading we'd
  // bail before these and trip React error #310 on the next
  // render once data arrived. Keeping them here makes the hook
  // count stable.
  // ─────────────────────────────────────────────────────────────
  const scheduleRows = m(() => {
    const rows = Array.isArray(schedule.data) ? schedule.data.slice() : [];
    rows.sort((a, b) => {
      const da = a.scheduled_date || "";
      const db = b.scheduled_date || "";
      if (da !== db) return da < db ? -1 : 1;
      return (a.line_index || 0) - (b.line_index || 0);
    });
    return rows;
  }, [schedule.data]);

  const scheduleKpis = m(() => {
    if (!scheduleRows.length) return { totalQty: 0, lineCount: 0, next: null, last: null };
    const totalQty = scheduleRows.reduce((s, r) => s + (Number(r.scheduled_qty) || 0), 0);
    const dates = scheduleRows.map((r) => r.scheduled_date).filter(Boolean).sort();
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = dates.find((d) => d >= today);
    return { totalQty, lineCount: scheduleRows.length, next: upcoming || dates[0] || null, last: dates[dates.length - 1] || null };
  }, [scheduleRows]);

  // Reset the line-edit draft whenever the persisted lines change.
  // Lives in the above-early-returns block so the hook count stays
  // stable when the loading branch returns early. Stringify is the
  // cheap cache key; lineItems rarely exceeds a few hundred rows.
  const persistedLinesKey = JSON.stringify(
    order.data?.result?.salesOrder?.lineItems || []
  );
  e(() => {
    setLinesDraft(null);
  }, [persistedLinesKey]);

  // ─────────────────────────────────────────────────────────────
  // Activity timeline merge (Surface B). Same hook-rule constraint:
  // must run on every render, including the loading and error
  // branches below, so the hook count stays constant.
  // ─────────────────────────────────────────────────────────────
  const mergedTimeline = m(() => {
    const all = [];
    const auditRows = Array.isArray(audit.data) ? audit.data : [];
    for (const a of auditRows) {
      const action = String(a.action || "");
      const isComm = action.startsWith("communication.") || action.startsWith("comm.") || action.includes("communication");
      all.push({
        ts: a.created_at || a.at || null,
        source: isComm ? "CM" : "AU",
        action,
        summary: `<b>${action || "event"}</b>${a.object_type ? " · " + a.object_type : ""}${a.detail ? " · " + a.detail : ""}`,
        raw: a,
      });
    }
    const procRows = Array.isArray(procEvents.data) ? procEvents.data : [];
    for (const p of procRows) {
      const action = String(p.event_type || p.action || p.type || "processing");
      const detail = p.detail || p.message || (p.payload ? (typeof p.payload === "string" ? p.payload : JSON.stringify(p.payload).slice(0, 120)) : "");
      all.push({
        ts: p.created_at || p.at || p.timestamp || null,
        source: "PR",
        action,
        summary: `<b>${action}</b>${p.stage ? " · " + p.stage : ""}${detail ? " · " + String(detail).slice(0, 160) : ""}`,
        raw: p,
      });
    }
    all.sort((x, y) => {
      const tx = x.ts ? new Date(x.ts).getTime() : 0;
      const ty = y.ts ? new Date(y.ts).getTime() : 0;
      return ty - tx;
    });
    return all;
  }, [audit.data, procEvents.data]);

  if (!orderId) {
    return (
      <>
        <WSTitle eyebrow="Sales Orders · Workspace" title="Pick an order" meta="no id in URL" />
        <div className="ws-content">
          <Banner kind="info" icon={Icon.info} title="No order selected"
                  action={<Btn sm onClick={() => window.location.hash = "#/so"}>open list</Btn>}>
            <span className="mono-sm">Pass an id via the URL: <code>#/so?id=ORDER_ID</code></span>
          </Banner>
        </div>
      </>
    );
  }

  if (order.loading) {
    return (
      <>
        <WSTitle eyebrow="Sales Orders · Workspace" title="Loading…" meta={orderId.slice(0, 8)} />
        <div className="ws-content"><Card><div className="body">Loading order…</div></Card></div>
      </>
    );
  }

  if (order.error || !order.data) {
    return (
      <>
        <WSTitle eyebrow="Sales Orders · Workspace" title="Could not load order" meta={orderId.slice(0, 8)} />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Order fetch failed"
                  action={<Btn sm onClick={() => setBump((n) => n + 1)}>retry</Btn>}>
            <span className="mono-sm">{String(order.error?.message || order.error || "not found")}</span>
          </Banner>
        </div>
      </>
    );
  }

  const o = order.data;
  const lines = o.result?.salesOrder?.lineItems || [];
  // draftLines is the source of truth for everything the operator
  // sees in the recon table + footer (subtotal, amount in words):
  // before any edit it equals the persisted lines, after an edit it
  // diverges, after Save the server reload clears the draft back to
  // null and the persisted lines take over again.
  const draftLines: any[] = linesDraft ?? lines;
  const grandTotal = Number(o.result?.salesOrder?.grandTotal) || 0;
  const subtotal = draftLines.reduce((s, ln) => s + (Number(ln.lineTotal) || (Number(ln.qty || ln.quantity) * Number(ln.rate || ln.unitPrice)) || 0), 0);
  const findings = Array.isArray(o.rule_findings) ? o.rule_findings : [];

  const canPushTally = RBAC?.canDo?.("so.push_tally");
  const canApprove = RBAC?.canDo?.("so.approve");
  const canCancel = RBAC?.canDo?.("so.cancel");
  // Audit fix May 2026: !== false silently granted permission
  // when RBAC was undefined (cold boot, stub test env). Tighten
  // to === true so a missing RBAC means denied, matching the
  // pattern already used for canApprove / canPushTally below.
  const canWrite = RBAC?.canDo?.("so.write") === true;
  const canAdmin = RBAC?.canDo?.("so.admin") === true;

  const cancelOrder = async () => {
    if (!o?.id) return;
    if (!confirm(`Cancel order ${o.po_number || o.quote_number || o.id.slice(0, 8)}? This sets status to CANCELLED.`)) return;
    setBusy(true);
    try {
      await ObaraBackend?.orders?.update?.(o.id, { status: "CANCELLED" });
      window.notifySuccess?.("Order cancelled", o.po_number || o.id.slice(0, 8));
      setBump((n) => n + 1);
    } catch (err) {
      window.notifyError?.("Cancel failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const approveOrder = async () => {
    if (!o?.id) return;
    // Bug fix May 2026 (audit P0): every approval used to fail
    // with 400 "Approval requires payload hash" because we sent
    // only { status: "APPROVED" } and the server requires
    // body.approval.payloadHash. The hash bound to the order
    // (computed at send-for-review time) IS the right hash to
    // anchor approval to: editing result.lineItems / line_edits
    // afterward clears the approval, which is the documented
    // invalidation contract.
    if (!o.payload_hash) {
      window.notifyError?.("Approve failed", "Order has no payload hash. Run 'send for review' first.");
      return;
    }
    setBusy(true);
    try {
      await ObaraBackend?.orders?.update?.(o.id, {
        status: "APPROVED",
        approval: { payloadHash: o.payload_hash },
      });
      window.notifySuccess?.("Order approved", o.po_number || o.id.slice(0, 8));
      setBump((n) => n + 1);
    } catch (err: any) {
      window.notifyError?.("Approve failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  // Bug fix May 2026 (manager-correction report): managers
  // reviewing an SO previously had only approve and cancel as
  // exits. When the operator entered a wrong ship-to address or
  // misread a rate, the manager had to phone the operator
  // out-of-band; the workspace had no formal "send this back" path.
  //
  // Return-for-correction transitions the order from
  // PENDING_REVIEW or APPROVED back to DRAFT with a required
  // reason text. The reason is persisted via audit_events so the
  // Activity tab + ThreadDrawer surface it next time the operator
  // opens the workspace. The status flip also clears the approval
  // queue entry so the row stops blocking the approver's view.
  const requestCorrection = async () => {
    if (!o?.id) return;
    const reason = window.prompt(
      "What needs to be corrected? This note is shared with the operator.",
      "",
    );
    if (reason == null) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      window.notifyWarn?.("Reason required", "Add a one-line note so the operator knows what to fix.");
      return;
    }
    setBusy(true);
    try {
      await ObaraBackend?.orders?.update?.(o.id, {
        status: "DRAFT",
        correction_reason: trimmed,
        correction_requested_by: RBAC?.role?.() || "sales_manager",
        correction_requested_at: new Date().toISOString(),
      });
      window.notifySuccess?.(
        "Sent back for correction",
        (o.po_number || o.id.slice(0, 8)) + " · operator notified",
      );
      setBump((n) => n + 1);
    } catch (err) {
      window.notifyError?.("Return-for-correction failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  // Bug fix May 2026: orders that arrived in DRAFT had no path
  // forward when the post-create OCR call from intake silently
  // failed (ClamAV missing, scan_status=unverified, transient
  // network). The pipeline rendered Capture forever with no
  // operator-facing trigger.
  //
  // Two new actions on the workspace action bar fix this:
  //
  //   1. Run extraction: re-runs docai/extract against the
  //      attached PO document, merges the normalized line items
  //      into orders.result.salesOrder.lineItems, and (best-
  //      effort) kicks off a Mistral OCR pass for the evidence
  //      bbox overlay. The merge happens client-side via
  //      orders.update so we don't need a new endpoint.
  //
  //   2. Send for review: explicit DRAFT to PENDING_REVIEW
  //      transition. The state machine in api/orders/[id].js
  //      already allows this; the workspace just had no UI for
  //      it.
  const sourceDocId = (() => {
    if (!o) return null;
    // Prefer the doc id stashed by the intake screen's preflight
    // payload (May 2026 fix). Fall back to the first attached
    // document on the order.
    const fromPreflight = o.preflight_payload?.source_document_id;
    if (fromPreflight) return fromPreflight;
    const docs = Array.isArray(o.documents) ? o.documents : [];
    return docs[0]?.id || null;
  })();

  const runExtraction = async () => {
    if (!o?.id) return;
    if (!sourceDocId) {
      window.notifyWarn?.(
        "No source document",
        "This order has no PO attached. Re-run from intake or attach a document.",
      );
      return;
    }
    setBusy(true);
    try {
      // 1. Hit /api/docai/extract using the existing source_id
      //    plumbing. The endpoint accepts source_id as a docai
      //    correlation key and returns out.normalized.{customer,
      //    lines}. We don't need to re-upload the file.
      // Phase 3.6 observability: pass order_id so extract events
      // are keyed for the workspace's Activity timeline + Pipeline
      // Diagnostics tab.
      const out: any = await (ObaraBackend as any)?.docai?.extract?.({
        source_id: sourceDocId,
        order_id: o.id,
      });
      const lines = Array.isArray(out?.normalized?.lines) ? out.normalized.lines : [];
      const customer = out?.normalized?.customer || null;
      const adapter = out?.adapter_used || null;
      const conf = typeof out?.confidence_overall === "number" ? out.confidence_overall : null;
      // 2. Merge the lines + customer + run metadata into the order
      //    so the workspace's reconciliation tab AND the "From PO"
      //    customer panel populate immediately.
      const nextResult = { ...(o.result || {}) };
      nextResult.salesOrder = {
        ...(nextResult.salesOrder || {}),
        lineItems: lines,
        customer: customer || nextResult.salesOrder?.customer || null,
      };
      // Bug fix May 2026 (stepper-lies report): only stamp
      // extraction_run_id when extraction actually produced lines
      // so the stepper does not green-light Extract on an empty
      // result. The previous run is preserved on the order's
      // audit_events history regardless.
      const nextPreflight = {
        ...(o.preflight_payload || {}),
        adapter_used: adapter,
        confidence_overall: conf,
        last_extracted_at: new Date().toISOString(),
      };
      if (lines.length > 0 && out?.run_id) {
        nextPreflight.extraction_run_id = out.run_id;
      }
      await ObaraBackend?.orders?.update?.(o.id, {
        result: nextResult,
        preflight_payload: nextPreflight,
      });
      // 3. Best-effort OCR for the evidence bbox overlay.
      try { await (ObaraBackend as any)?.ocr?.run?.(sourceDocId, o.id); } catch (_) { /* surface in audit */ }
      const tone = lines.length === 0 ? "notifyWarn" : "notifySuccess";
      window[tone]?.(
        lines.length === 0 ? "Extraction returned no lines" : "Extraction complete",
        lines.length + " line" + (lines.length === 1 ? "" : "s") + (adapter ? " (" + adapter + ")" : ""),
      );
      setBump((n) => n + 1);
    } catch (err: any) {
      // Phase C3: if the sync extractor refused the document
      // because it exceeds SYNC_MAX_TOTAL_PAGES, fall back to
      // creating a background extraction_jobs row. The cron
      // worker drains it chunk-by-chunk and writes the same
      // processing_events the sync flow does, so the
      // ExtractionProgress component above renders the same bar
      // regardless of which mode landed the work. We detect the
      // server-side PDF_TOO_LARGE error code; everything else is
      // a real failure and surfaces to the operator.
      const message = err?.message || String(err);
      const looksTooLarge = /PDF_TOO_LARGE|exceeds max \d+ pages|background-job mode/i.test(message);
      if (looksTooLarge && o?.id) {
        try {
          const cfg: any = (ObaraBackend as any)?.getConfig?.() || {};
          const session: any = (ObaraBackend as any)?.getSession?.() || null;
          const headers: any = { "Content-Type": "application/json" };
          if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
          if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
          const url = cfg.url.replace(/\/+$/, "") + "/api/orders/extraction_jobs";
          const resp = await fetch(url, {
            method: "POST", headers,
            body: JSON.stringify({
              order_id: o.id,
              document_id: sourceDocId,
              source_filename: "po.pdf",
            }),
          });
          if (resp.ok) {
            window.notifySuccess?.(
              "Large PDF queued for background extraction",
              "The progress bar above will keep you posted; this can take several minutes for documents over 60 pages.",
            );
            return;
          }
          const txt = await resp.text().catch(() => "");
          window.notifyError?.("Could not queue background job", txt || resp.statusText);
        } catch (e: any) {
          window.notifyError?.("Background job creation failed", e?.message || String(e));
        }
      } else {
        window.notifyError?.("Extraction failed", message);
      }
    } finally {
      setBusy(false);
    }
  };

  const sendForReview = async () => {
    if (!o?.id) return;
    setBusy(true);
    try {
      await ObaraBackend?.orders?.update?.(o.id, { status: "PENDING_REVIEW" });
      window.notifySuccess?.("Sent for review", o.po_number || o.id.slice(0, 8));
      setBump((n) => n + 1);
    } catch (err: any) {
      window.notifyError?.("Could not advance status", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  // Bug fix May 2026: the Validate step in the workspace stepper had
  // no operator-facing trigger. The /api/anomaly/compute endpoint
  // existed but was read-only: it returned flags without persisting
  // them, and nothing in the UI called it. Orders sat in DRAFT with
  // an empty rule_findings array forever. The new "run validation"
  // action calls compute with the order's lineItems + grandTotal as
  // the candidate, persists the returned flags into
  // orders.rule_findings (already an allow-listed update column), and
  // stamps the validation timestamp into preflight_payload so the
  // stepper can light step 3 (Validate) when findings exist.
  const runValidation = async () => {
    if (!o?.id) return;
    if (!o.customer_id) {
      window.notifyWarn?.(
        "No customer on order",
        "Anomaly rules need a customer to compare against. Set a customer first.",
      );
      return;
    }
    if (!lines.length) {
      window.notifyWarn?.(
        "No lines to validate",
        "Run extraction first; the rule library scores line items.",
      );
      return;
    }
    setBusy(true);
    try {
      // Audit fix May 2026: was using o.result.salesOrder which
      // is the persisted lines, ignoring any unsaved operator
      // edits in the recon table. Score what the operator is
      // looking at so the findings reflect current state, not
      // pre-edit state. linesDraft falls back to lines when
      // there is no diff, so this is correct in both modes.
      const candidateLines = linesDraft ?? (o.result?.salesOrder?.lineItems || []);
      const candidate = { ...(o.result?.salesOrder || {}), lineItems: candidateLines };
      const out: any = await (ObaraBackend as any)?.anomaly?.compute?.(o.customer_id, candidate);
      const flags = Array.isArray(out?.flags) ? out.flags : [];
      const nextPreflight = {
        ...(o.preflight_payload || {}),
        last_validated_at: new Date().toISOString(),
        rules_evaluated: out?.rulesEvaluated || null,
      };
      await ObaraBackend?.orders?.update?.(o.id, {
        rule_findings: flags,
        preflight_payload: nextPreflight,
      });
      const sev = flags.length === 0 ? "Success" : "Warning";
      const msg = flags.length === 0
        ? "All rules passed"
        : flags.length + " finding" + (flags.length === 1 ? "" : "s") + " logged";
      (sev === "Success" ? window.notifySuccess : window.notifyWarn)?.("Validation complete", msg);
      setBump((n) => n + 1);
    } catch (err: any) {
      window.notifyError?.("Validation failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const pushToTally = async () => {
    if (!o?.id) return;
    setBusy(true);
    try {
      const result = await ObaraBackend?.tally?.push?.({ orderId: o.id });
      if (result?.error) {
        window.notifyError?.("Tally push failed", result.error.message || "see audit log");
      } else {
        window.notifySuccess?.("Pushed to Tally", o.po_number || o.id.slice(0, 8));
      }
      setBump((n) => n + 1);
    } catch (err) {
      window.notifyError?.("Tally push failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  // Audit pack export: bundle order + result + findings + signed
  // Quote PDF download. Hits /api/quotes/pdf and triggers a browser
  // download. We do the request through the auth-aware client helper
  // so the Authorization + tenant headers are attached.
  const downloadQuotePdf = async (orderObj) => {
    if (!orderObj?.id) return;
    try {
      const blob = await ObaraBackend?.quotes?.pdfBlob?.(orderObj.id);
      if (!blob) throw new Error("Quote PDF helper unavailable");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "quote-" + (orderObj.quote_number || orderObj.po_number || String(orderObj.id).slice(0, 8)) + ".pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      window.notifySuccess?.("Quote PDF ready", "Saved to Downloads.");
    } catch (err: any) {
      window.notifyError?.("Quote PDF failed", err?.message || String(err));
    }
  };

  // Draft a new invoice from this order. Templates totals + line items
  // from result.salesOrder; the operator can edit fields on the
  // Invoices screen after creation. We navigate there on success.
  const createInvoiceForOrder = async (orderObj) => {
    if (!orderObj?.id) return;
    try {
      const resp: any = await ObaraBackend?.invoices?.create?.({
        order_id: orderObj.id,
        net_days: 30,
      });
      const inv = resp?.invoice;
      if (!inv) throw new Error("Invoice create returned no row");
      window.notifySuccess?.("Invoice drafted", inv.invoice_number);
      window.location.hash = "#/invoices";
    } catch (err: any) {
      window.notifyError?.("Could not create invoice", err?.message || String(err));
    }
  };

  // Share-link flow. Server uploads the PDF to storage and returns a
  // 7-day signed URL we copy to the operator's clipboard.
  const shareQuotePdf = async (orderObj) => {
    if (!orderObj?.id) return;
    try {
      const resp: any = await ObaraBackend?.quotes?.share?.(orderObj.id);
      const url = resp?.url;
      if (!url) throw new Error("Share endpoint did not return a URL");
      try { await navigator.clipboard.writeText(url); } catch (_) { /* ignore */ }
      window.notifySuccess?.("Share link copied", "Valid for 7 days.");
    } catch (err: any) {
      window.notifyError?.("Could not generate share link", err?.message || String(err));
    }
  };

  // evidence URLs into a JSON file the user can hand to compliance.
  // Rich PDF + ZIP packaging is a follow-up; for now this matches the
  // legacy exportDocumentPackage shape closely enough.
  const exportAuditPack = async (orderObj) => {
    try {
      const docs = Array.isArray(orderObj.documents) ? orderObj.documents : [];
      const evidence = [];
      for (const d of docs) {
        try {
          const signed = await ObaraBackend?.documents?.fetch?.(d.id);
          evidence.push({ id: d.id, role: d.role, filename: d.filename, signed });
        } catch (err) {
          evidence.push({ id: d.id, role: d.role, error: String(err.message || err) });
        }
      }
      const pack = {
        exported_at: new Date().toISOString(),
        order: {
          id: orderObj.id,
          po_number: orderObj.po_number,
          quote_number: orderObj.quote_number,
          status: orderObj.status,
          customer: orderObj.customer,
          result: orderObj.result,
          rule_findings: orderObj.rule_findings,
          approval: orderObj.approval,
          payload_hash: orderObj.payload_hash,
        },
        evidence,
      };
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-pack-${orderObj.po_number || orderObj.id || "order"}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      window.notifySuccess?.("Audit pack exported", `Saved as ${a.download}`);
    } catch (err) {
      window.notifyError?.("Audit pack export failed", String(err.message || err));
    }
  };

  const customerName = o.customer?.customer_name || o.customer_name || (o.customer_id ? o.customer_id.slice(0, 8) : "—");
  const customerEmail = o.customer?.contact_email || o.customer?.email;

  const st = stageOf(o.status);

  // Reconciliation columns: number, item, UoM, qty, rate, HSN,
  // GST%, taxable, tax, line total, issues.
  // Editable: description, SKU, UoM, qty, rate, HSN, GST%.
  // Each cell shows an "OCR" or "edited" pill based on the line's
  // `_field_sources` map: extracted values land as "ocr", operator
  // overrides flip to "human". Stamped at intake by
  // lib/field-sources.ts.
  // The Evidence column was dropped in May 2026: the extractor
  // does not populate ln.evidence today, so every row fell through
  // to "—" and the empty flex container looked like a stray box.
  // The Rate prev / Δ columns were dropped too; they relied on a
  // previous-rate stamp that no production caller writes. If
  // those return they should be opt-in behind a Settings flag.
  // Render the mapping affordance for a recon line. States:
  //  - mapped via "manual" / "llm_suggest" : `good` chip with
  //    part_no plus a small "change" link
  //  - mapped via any resolver tier        : `info` chip
  //  - unmapped with suggestions loaded    : list each suggestion
  //    with Accept / Reject buttons
  //  - unmapped, no suggestions            : "Map to canonical..."
  //    link that opens the picker
  const mapAffordance = (ln: any, i: number) => {
    const mi = ln._mapped_item;
    if (mi && (mi.match_via === "manual" || mi.match_via === "llm_suggest")) {
      const tone = mi.match_via === "llm_suggest" ? "info" : "good";
      const label = mi.match_via === "llm_suggest"
        ? "AI map" + (mi.confidence_pct != null ? " (" + Math.round(Number(mi.confidence_pct)) + "%)" : "")
        : "manual map";
      return (
        <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 2 }}>
          <Chip k={tone}>{label}: {mi.part_no || "-"}</Chip>
          {canEditLines && (
            <button
              type="button"
              onClick={() => setPickerLineIdx(i)}
              style={{ background: "none", border: "none", padding: 0, color: "var(--ink-3)", cursor: "pointer", fontSize: 11, textDecoration: "underline" }}
            >change</button>
          )}
        </div>
      );
    }
    if (mi && mi.part_no) {
      return (
        <div style={{ marginTop: 2 }}>
          <Chip k="info">{(mi.match_via || "auto").replace(/_/g, " ")}: {mi.part_no}</Chip>
        </div>
      );
    }
    if (!canEditLines) return null;
    const sugg = suggestionsByLine[i] || [];
    if (sugg.length) {
      return (
        <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 3 }}>
          {sugg.map((s: any, j: number) => (
            <div key={j} style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
              <Chip k="info">{s.part_no || "—"}</Chip>
              <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                {Math.round(Number(s.confidence_pct) || 0)}%
              </span>
              {s.alias && <span style={{ color: "var(--ink-3)", fontSize: 11 }}>{s.alias}</span>}
              <button
                type="button"
                onClick={() => acceptSuggestion(i, s)}
                style={{ background: "var(--brand)", color: "var(--ink-on-brand)", border: "none", borderRadius: 3, padding: "1px 6px", cursor: "pointer", fontSize: 11 }}
              >accept</button>
              <button
                type="button"
                onClick={() => rejectSuggestion(i, s)}
                style={{ background: "none", border: "1px solid var(--hairline-2)", borderRadius: 3, padding: "1px 6px", color: "var(--ink-3)", cursor: "pointer", fontSize: 11 }}
              >reject</button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setPickerLineIdx(i)}
            style={{ background: "none", border: "none", padding: 0, color: "var(--ink-3)", cursor: "pointer", fontSize: 11, textAlign: "left", textDecoration: "underline" }}
          >or map manually...</button>
        </div>
      );
    }
    return (
      <div style={{ marginTop: 2 }}>
        <button
          type="button"
          onClick={() => setPickerLineIdx(i)}
          style={{ background: "none", border: "1px dashed var(--hairline-2)", borderRadius: 3, padding: "1px 6px", color: "var(--ink-3)", cursor: "pointer", fontSize: 11 }}
        >Map to canonical...</button>
      </div>
    );
  };

  const reconRow = (ln: any, i: number) => {
    // Single source of truth for taxable / tax / line total. The
    // helper picks one of three paths depending on what the line
    // carries (explicit per-component amounts, gst_pct legacy
    // fast-path, or extractor-provided lineTotal). See
    // src/v3-app/lib/line-totals.ts for the priority order.
    const totals = computeLineTotals(ln);
    const { taxable, tax, aux, lineTotal, source } = totals;
    const lineFindings = findings.filter((f) => Number(f.line_index) === i || Number(f.lineIndex) === i);
    const issueChip = lineFindings.length === 0
      ? "—"
      : lineFindings.map((f, j) => (
          <Chip key={j} k={f.severity === "ERROR" || f.blocks ? "bad" : f.severity === "WARNING" ? "warn" : "info"}>
            {(f.code || f.rule_id || "issue").toLowerCase()}
          </Chip>
        ));
    const isOpen = !!breakdownOpen[i];
    // Tax-source chip: tells the operator which math path is
    // driving the displayed numbers. "explicit" wins; "pct"
    // means we are falling back to a single GST percentage; "—"
    // means no tax info at all.
    const taxSourceChip = source === "explicit"
      ? <Chip k="good">explicit</Chip>
      : source === "gst_pct"
        ? <Chip k="info">pct</Chip>
        : source === "lineTotal"
          ? <Chip k="ghost">total</Chip>
          : null;
    const mainRow = (
      <tr key={"row-" + i}>
        <td className="mono">{i + 1}</td>
        <td>
          <EditableCell line={ln} i={i} canonicalKey="description" type="text" placeholder="description" />
          <div style={{ marginTop: 2 }}>
            <EditableCell line={ln} i={i} canonicalKey="itemCode" type="text" placeholder="part / SKU" />
          </div>
          {mapAffordance(ln, i)}
        </td>
        <td><EditableCell line={ln} i={i} canonicalKey="uom" type="text" placeholder="Nos" /></td>
        <td className="r mono"><EditableCell line={ln} i={i} canonicalKey="qty" type="number" align="right" /></td>
        <td className="r mono"><EditableCell line={ln} i={i} canonicalKey="rate" type="number" align="right" /></td>
        <td><EditableCell line={ln} i={i} canonicalKey="hsn" type="text" placeholder="8482" /></td>
        <td className="r mono">
          <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-end" }}>
            <EditableCell line={ln} i={i} canonicalKey="gst_pct" type="number" align="right" placeholder="18" />
            {taxSourceChip}
          </div>
        </td>
        <td className="r mono">{taxable ? fmtINR(taxable) : "—"}</td>
        <td className="r mono" style={{ color: "var(--ink-3)" }}>
          {tax ? fmtINR(tax) : "—"}
        </td>
        <td className="r mono"><span className="pri">{lineTotal ? fmtINR(lineTotal) : "—"}</span></td>
        <td>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}>
            {issueChip}
            {canEditLines && (
              <button
                type="button"
                onClick={() => setBreakdownOpen((m) => ({ ...m, [i]: !m[i] }))}
                aria-expanded={isOpen}
                aria-label={isOpen ? "Hide tax breakdown for line " + (i + 1) : "Show tax breakdown for line " + (i + 1)}
                style={{ background: "none", border: "none", padding: 0, color: "var(--ink-3)", cursor: "pointer", fontSize: 11, textDecoration: "underline" }}
              >{isOpen ? "▾ hide tax" : "▸ tax detail"}</button>
            )}
          </div>
        </td>
      </tr>
    );
    if (!isOpen) return mainRow;
    // Sub-row: 10 editable per-unit cells in two rows of 5
    // (tax components, then auxiliary costs) plus a recap of
    // the helper's derived totals. The recap stays read-only;
    // operators change the source values, not the result.
    const editCell = (key: keyof typeof COMPONENT_LABEL, placeholder = "") => (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span className="mono-sm" style={{ color: "var(--ink-3)", fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          {COMPONENT_LABEL[key]}
        </span>
        <EditableCell line={ln} i={i} canonicalKey={key} type="number" align="right" placeholder={placeholder} />
      </div>
    );
    const breakdownRow = (
      <tr key={"brk-" + i} style={{ background: "var(--paper-2)" }}>
        <td></td>
        <td colSpan={10} style={{ padding: "10px 6px" }}>
          <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8, fontSize: 11 }}>
            Per-unit tax and auxiliary amounts. Set the ones the PO carries; the row above recomputes the line total from them. The "Rate" cell is the tax-exclusive ex-price.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(80px, 1fr))", gap: 8, marginBottom: 6 }}>
            {TAX_AMOUNT_KEYS.slice(0, 5).map((k) => (
              <div key={k}>{editCell(k as any, "0")}</div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(80px, 1fr))", gap: 8, marginBottom: 6 }}>
            {[...TAX_AMOUNT_KEYS.slice(5), ...AUX_AMOUNT_KEYS].map((k) => (
              <div key={k}>{editCell(k as any, "0")}</div>
            ))}
          </div>
          <div className="mono-sm" style={{ display: "flex", gap: 16, paddingTop: 6, borderTop: "1px dashed var(--hairline)", color: "var(--ink-2)", flexWrap: "wrap" }}>
            <span>taxable: <b>{taxable ? fmtINR(taxable) : "—"}</b></span>
            <span>tax: <b>{tax ? fmtINR(tax) : "—"}</b></span>
            {aux > 0 && <span>aux: <b>{fmtINR(aux)}</b></span>}
            <span>line: <b>{lineTotal ? fmtINR(lineTotal) : "—"}</b></span>
            <span style={{ color: "var(--ink-3)" }}>source: {source}</span>
          </div>
        </td>
      </tr>
    );
    return <React.Fragment key={"f-" + i}>{mainRow}{breakdownRow}</React.Fragment>;
  };

  // Margin cockpit data
  const policy = o.cost_policy_snapshot || {};
  const matCost = Number(policy.materialsLanded || policy.materials || 0);
  const freight = Number(policy.freight || 0);
  const customs = Number(policy.customs || 0);
  const service = Number(policy.service || 0);
  const totalCost = matCost + freight + customs + service;
  const realizedMargin = grandTotal > 0 ? (grandTotal - totalCost) / grandTotal : 0;
  const pct = (n) => grandTotal > 0 ? Math.round((n / grandTotal) * 100) : 0;

  const scheduleStatus = (row) => {
    // Synthetic status chip — schema has no status column; derive from date.
    const today = new Date().toISOString().slice(0, 10);
    const d = row.scheduled_date;
    if (!d) return { k: "ghost", label: "—" };
    if (d < today) return { k: "warn", label: "past" };
    if (d === today) return { k: "live", label: "today" };
    return { k: "info", label: "upcoming" };
  };

  // Parse pasted TSV: each non-empty line is `scheduled_date<TAB>qty[<TAB>part_no][<TAB>delivery_location][<TAB>remark]`
  // Tolerates commas as a fallback separator and trims whitespace. Returns
  // { rows, errors } where rows are the API-shaped inserts.
  const parseTsv = (txt) => {
    const out = [];
    const errors = [];
    const lines = (txt || "").split(/\r?\n/);
    let lineIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      // Split by tab, fall back to comma if no tab.
      const parts = raw.includes("\t") ? raw.split("\t") : raw.split(",");
      const date = (parts[0] || "").trim();
      const qty = Number((parts[1] || "").trim());
      if (!date) { errors.push(`row ${i + 1}: missing date`); continue; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(`row ${i + 1}: date "${date}" not YYYY-MM-DD`); continue; }
      if (!qty || qty <= 0 || Number.isNaN(qty)) { errors.push(`row ${i + 1}: qty must be > 0`); continue; }
      out.push({
        line_index: lineIdx++,
        scheduled_date: date,
        scheduled_qty: qty,
        part_no: (parts[2] || "").trim() || null,
        delivery_location: (parts[3] || "").trim() || null,
        remark: (parts[4] || "").trim() || null,
      });
    }
    return { rows: out, errors };
  };

  const handleBulkAdd = async () => {
    if (busy) return;
    const { rows, errors } = parseTsv(tsv);
    if (errors.length) {
      window.notifyError?.("Schedule paste rejected", errors.slice(0, 3).join(" · "));
      return;
    }
    if (!rows.length) {
      window.notifyError?.("Nothing to add", "Paste rows like 2026-05-15<TAB>1200");
      return;
    }
    setBusy(true);
    try {
      const resp = await ObaraBackend?.scheduleLines?.bulkCreate?.(orderId, rows);
      const inserted = resp?.inserted ?? rows.length;
      window.notifySuccess?.("Schedule lines added", `Inserted ${inserted} row${inserted === 1 ? "" : "s"}`);
      setTsv("");
      setScheduleBump((n) => n + 1);
    } catch (err) {
      window.notifyError?.("Bulk add failed", String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const handleClearAll = async () => {
    if (busy) return;
    if (!scheduleRows.length) return;
    const ok = window.confirm(`Delete ALL ${scheduleRows.length} schedule line${scheduleRows.length === 1 ? "" : "s"} for this order? This cannot be undone.`);
    if (!ok) return;
    setBusy(true);
    try {
      const resp = await ObaraBackend?.scheduleLines?.clear?.(orderId);
      const deleted = resp?.deleted ?? scheduleRows.length;
      window.notifySuccess?.("Schedule cleared", `Removed ${deleted} row${deleted === 1 ? "" : "s"}`);
      setScheduleBump((n) => n + 1);
    } catch (err) {
      window.notifyError?.("Clear failed", String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteOne = async (row) => {
    if (busy || !row?.id) return;
    // Match handleClearAll: schedule-line deletion is irreversible,
    // so confirm before firing. Without this a misclick on the row's
    // delete button silently dropped the line.
    const ok = window.confirm(`Delete schedule line for ${row.scheduled_date} (qty ${row.scheduled_qty})? This cannot be undone.`);
    if (!ok) return;
    setBusy(true);
    try {
      await ObaraBackend?.scheduleLines?.deleteOne?.(row.id);
      window.notifySuccess?.("Line deleted", `${row.scheduled_date} · qty ${row.scheduled_qty}`);
      setScheduleBump((n) => n + 1);
    } catch (err) {
      window.notifyError?.("Delete failed", String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const tagChipKind = (src) => src === "CM" ? "plum" : src === "PR" ? "info" : "ghost";

  // Line-edit handlers. The draft is forked from the persisted
  // lines on first edit; subsequent edits mutate the draft. The
  // reset useEffect lives above the early-return block (search the
  // file for "MUST stay above the early returns") so the hook count
  // stays stable across loading-state transitions.

  // Alias maps so the canonical key writes propagate to whichever
  // alias downstream consumers (Tally emit, anomaly compute, PDF
  // render) read. Without this, editing qty would only update
  // `line.qty` while the Tally amend still emitted `line.quantity`.
  // Keep in lock-step with src/v3-app/lib/field-sources.ts ALIASES.
  // When an extractor emits a line via "name" / "item" / "unit",
  // the recon table needs to find AND write back to the same
  // aliases or the Tally emit + anomaly compute will see a
  // stale value at the original key. Audit fix May 2026.
  const LINE_ALIAS: Record<string, string[]> = {
    itemCode: ["itemCode", "partNumber", "sku", "code"],
    description: ["description", "name", "item"],
    qty: ["qty", "quantity"],
    rate: ["rate", "unitPrice"],
    uom: ["uom", "unit"],
    hsn: ["hsn", "hsn_sac", "hsnCode"],
    gst_pct: ["gst_pct", "gstRate", "rate_of_duty_pct"],
    // Per-line tax-component aliases. Each one is the per-unit
    // amount (matching the Hyundai PO column layout). Identity
    // maps because the extractor and the DB use the same key.
    cgst_amount:    ["cgst_amount"],
    sgst_amount:    ["sgst_amount"],
    igst_amount:    ["igst_amount"],
    utgst_amount:   ["utgst_amount"],
    cess_amount:    ["cess_amount"],
    excise_amount:  ["excise_amount"],
    ed_cess_amount: ["ed_cess_amount"],
    tooling_amount: ["tooling_amount"],
    p_and_f_amount: ["p_and_f_amount"],
    others_amount:  ["others_amount"],
  };

  const linesDirty = linesDraft !== null
    && JSON.stringify(linesDraft) !== JSON.stringify(lines);
  // Bug fix May 2026 (audit P0): namespace was "orders.write" but
  // every other permission on this screen uses "so.*" (so.write,
  // so.admin, so.push_tally). The RBAC rules only define the
  // so.* namespace, so canEditLines was always false and every
  // line was read-only.
  const canEditLines = !!(RBAC && RBAC.canDo && RBAC.canDo("so.write"))
    && o.status !== "CANCELLED"
    && o.status !== "EXPORTED_TO_TALLY"
    && o.status !== "RECONCILED";

  const onEditLine = (i: number, canonicalKey: string, value: any) => {
    const base = linesDraft ?? lines;
    const next = base.slice();
    const line: any = { ...next[i] };
    for (const k of (LINE_ALIAS[canonicalKey] || [canonicalKey])) {
      line[k] = value;
    }
    next[i] = markFieldEdited(line, canonicalKey);
    setLinesDraft(next);
  };

  // Layer A: stamp _mapped_item on the line with match_via:"manual"
  // (or "llm_suggest" when the operator accepts an AI suggestion).
  // Mirrors the resolver's _mapped_item shape so downstream
  // (recon table, Tally emit, PDF) sees the canonical fields. Also
  // fills line.itemCode when blank so re-uploads of the same PO
  // resolve via the item_master.part_no tier without going through
  // item_customer_parts.
  const applyManualMap = (i: number, item: PickedItem, matchVia: "manual" | "llm_suggest" = "manual", confidencePct: number | null = null) => {
    const base = linesDraft ?? lines;
    const next = base.slice();
    const line: any = { ...next[i] };
    line._mapped_item = {
      id: item.id,
      part_no: item.part_no,
      alias: item.alias || null,
      print_name: item.print_name || null,
      description: item.description || null,
      customer_part_description: line._mapped_item?.customer_part_description || null,
      hsn_sac: item.hsn_sac || null,
      uom: item.uom || null,
      source_country: item.source_country || null,
      gst_applicable: item.gst_applicable || null,
      taxability_type: item.taxability_type || null,
      type_of_supply: item.type_of_supply || null,
      rate_of_duty_pct: item.rate_of_duty_pct != null ? Number(item.rate_of_duty_pct) : null,
      stock_group: item.stock_group || null,
      specification_code: item.specification_code || null,
      match_via: matchVia,
      confidence_pct: confidencePct,
    };
    // Backfill hsn / uom only when the line is blank; never
    // overwrite operator-visible numbers (same rule the resolver
    // applies in src/api/_lib/item-mapper.js).
    if (!line.hsn && !line.hsn_sac && item.hsn_sac) line.hsn = item.hsn_sac;
    if (!line.uom && !line.unit && item.uom) line.uom = item.uom;
    next[i] = markFieldEdited(line, "_mapped_item");
    setLinesDraft(next);
  };

  // Layer C: pull AI suggestions for every unmapped line on the
  // order. Lazy: fires on operator click, not inline on screen
  // load. The response is keyed by line index so the suggestion
  // chips render next to the right row without an extra fetch.
  const onSuggestMappings = async () => {
    if (suggesting || !o?.id) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const cfg: any = (ObaraBackend as any)?.getConfig?.() || {};
      const session: any = (ObaraBackend as any)?.getSession?.() || null;
      if (!cfg.url) throw new Error("Backend URL not configured");
      const headers: any = { "Content-Type": "application/json" };
      if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
      if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
      const url = cfg.url.replace(/\/+$/, "") + "/api/orders/suggest_mappings?order_id=" + encodeURIComponent(o.id) + "&max=10";
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      const byLine: Record<number, any[]> = {};
      for (const row of data.suggestions || []) {
        if (Array.isArray(row.suggestions) && row.suggestions.length) {
          byLine[row.line_index] = row.suggestions;
        }
      }
      setSuggestionsByLine(byLine);
      const total = Object.values(byLine).reduce((acc, arr) => acc + arr.length, 0);
      if (total === 0) {
        window.notifyWarn?.("No AI suggestions", "The model could not match any unmapped line against your item master.");
      } else {
        window.notifySuccess?.("Suggestions ready", `${total} candidate${total === 1 ? "" : "s"} across ${Object.keys(byLine).length} line${Object.keys(byLine).length === 1 ? "" : "s"}.`);
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      setSuggestError(msg);
      window.notifyError?.("Suggestion failed", msg);
    } finally {
      setSuggesting(false);
    }
  };

  // Accept a single suggestion from the per-line list. Routes
  // through applyManualMap (same code path as the manual picker)
  // but stamps match_via:"llm_suggest" so the server hook writes
  // an item_customer_parts row with created_via:"llm_suggest"
  // and the suggestion's confidence_pct.
  const acceptSuggestion = (i: number, suggestion: any) => {
    applyManualMap(i, {
      id: suggestion.item_id,
      part_no: suggestion.part_no,
      alias: suggestion.alias,
      print_name: suggestion.print_name,
      description: suggestion.description,
      hsn_sac: suggestion.hsn_sac,
      uom: suggestion.uom,
      source_country: suggestion.source_country,
      gst_applicable: suggestion.gst_applicable,
      taxability_type: suggestion.taxability_type,
      type_of_supply: suggestion.type_of_supply,
      rate_of_duty_pct: suggestion.rate_of_duty_pct,
      stock_group: suggestion.stock_group,
      specification_code: suggestion.specification_code,
    }, "llm_suggest", Number(suggestion.confidence_pct) || null);
    // Clear suggestions for this line so the UI collapses to the
    // accepted chip.
    setSuggestionsByLine((prev) => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
  };

  // Reject a single suggestion. Removes it from the per-line list
  // and (best-effort) lets the operator type-find a different one
  // via the manual picker. The rejection is not persisted server-
  // side in this iteration; if it becomes useful telemetry we can
  // POST to /api/orders/[id] with a small event payload.
  const rejectSuggestion = (i: number, suggestion: any) => {
    setSuggestionsByLine((prev) => {
      const remaining = (prev[i] || []).filter((s) => s.item_id !== suggestion.item_id);
      const next = { ...prev };
      if (remaining.length) next[i] = remaining;
      else delete next[i];
      return next;
    });
  };

  const onDiscardLineEdits = () => setLinesDraft(null);

  const onSaveLineEdits = async () => {
    if (!linesDirty || savingLines) return;
    setSavingLines(true);
    try {
      const nextResult = {
        ...(o.result || {}),
        salesOrder: {
          ...(o.result?.salesOrder || {}),
          lineItems: draftLines,
        },
      };
      await ObaraBackend?.orders?.update?.(o.id, { result: nextResult });
      // Audit fix May 2026: clear the draft immediately so a
      // second Save click during the reload window cannot fire a
      // duplicate PATCH. The useEffect on persistedLinesKey will
      // also null this when the new lines arrive, but it races
      // the click; we win the race here.
      setLinesDraft(null);
      window.notifySuccess?.("Line edits saved", `${draftLines.length} line${draftLines.length === 1 ? "" : "s"} on ${o.po_number || o.id.slice(0, 8)}`);
      setBump((n: number) => n + 1);
    } catch (err: any) {
      window.notifyError?.("Could not save line edits", err?.message || String(err));
    } finally {
      setSavingLines(false);
    }
  };

  const FieldPill: React.FC<{ src: FieldSource | null }> = ({ src }) => {
    if (src === "ocr") return <Chip k="ghost">OCR</Chip>;
    if (src === "human") return <Chip k="info">edited</Chip>;
    return null;
  };

  const EditableCell: React.FC<{
    line: any; i: number; canonicalKey: string;
    type: "text" | "number"; align?: "left" | "right";
    placeholder?: string;
  }> = ({ line, i, canonicalKey, type, align, placeholder }) => {
    const src = getFieldSource(line, canonicalKey);
    const raw = LINE_ALIAS[canonicalKey]
      .map((k) => line[k])
      .find((v) => v != null && v !== "");
    const value = raw == null ? "" : String(raw);
    // Tighter input styling: no implicit browser styling, no
    // outline ring, no min-width that would render an empty box
    // for short / blank values. The cell shows the value as plain
    // text until clicked; the hairline appears on focus.
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: align === "right" ? "flex-end" : "flex-start" }}>
        <input
          className={align === "right" ? "input mono-sm r" : "input mono-sm"}
          style={{
            background: "transparent",
            border: "1px solid transparent",
            outline: "none",
            WebkitAppearance: "none",
            MozAppearance: "none",
            appearance: "none" as any,
            padding: "2px 4px",
            textAlign: align === "right" ? "right" : "left",
            width: "100%",
            minWidth: 0,
            boxShadow: "none",
          }}
          value={value}
          placeholder={placeholder || ""}
          disabled={!canEditLines}
          onFocus={(e) => { e.currentTarget.style.border = "1px solid var(--hairline-2)"; e.currentTarget.style.background = "var(--paper)"; }}
          onBlur={(e) => { e.currentTarget.style.border = "1px solid transparent"; e.currentTarget.style.background = "transparent"; }}
          onChange={(e) => {
            const v = type === "number"
              ? (e.target.value === "" ? null : Number(e.target.value))
              : e.target.value;
            onEditLine(i, canonicalKey, v);
          }}
        />
        {src && <FieldPill src={src} />}
      </div>
    );
  };

  const tabs = [
    { id: "recon", label: "Reconciliation", count: findings.length || null },
    { id: "header", label: "Header fields" },
    { id: "margin", label: "Margin cockpit" },
    { id: "why", label: "Why" },
    { id: "evidence", label: "Evidence" },
    { id: "approval", label: "Approval" },
    { id: "tally", label: "Tally" },
    { id: "schedule", label: "Schedule", count: scheduleRows.length || null },
    { id: "shipments", label: "Shipments" },
    { id: "activity", label: "Activity", count: mergedTimeline.length || null },
    // Phase 3.6 observability: Pipeline Diagnostics tab. Reads
    // /api/orders/<id>/pipeline-state and renders extraction_runs +
    // processing_events + adapter health for the order's docai
    // pipeline. The tab the operator opens when "credits burned, no
    // result, stepper green" happens.
    { id: "diagnostics", label: "Pipeline diag" },
  ];

  return (
    <div className="ws ws-no-rail">
      {/*
       * ws-no-rail: this screen never renders a right-side rail,
       * so opt out of the grid template. Without it the WSTabs
       * sibling gets auto-placed into the (empty) rail column and
       * floats to the right edge instead of sitting under the
       * title.
       *
       * Title row layout:
       *   row 1: identity (eyebrow + PO + chips), wraps if narrow
       *   row 2: action bar, wraps to a 2nd line if narrow
       *   row 3: customer/timestamp meta
       * Each row is its own flex container with min-width: 0 so the
       * h1 can ellipsize without pushing the action buttons off the
       * left edge (the bug that produced the "NANCE SPARES-REV-1"
       * clipping). Action buttons get flex-shrink: 0 so they keep
       * their natural width when the row wraps.
       */}
      <div className="ws-title" style={{ alignItems: "stretch", flexDirection: "column", gap: 10 }}>
        <div className="row gap-sm" style={{ width: "100%", minWidth: 0, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ minWidth: 0, flex: "1 1 auto", overflow: "hidden" }}>
            <div className="h-eyebrow">Sales Orders · Workspace</div>
            <div className="row gap-sm" style={{ marginTop: 2, minWidth: 0, flexWrap: "wrap", alignItems: "center" }}>
              <h1 style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {o.po_number || o.quote_number || `draft ${o.id?.slice(0, 8)}`}
              </h1>
              {o.order_mode && <Chip k={o.order_mode === "INTERNAL" ? "plum" : o.order_mode.startsWith("PROJECT") ? "info" : "ghost"}>{o.order_mode}</Chip>}
              <Chip k={st.k}>{st.label}</Chip>
              {o.payload_hash && <Chip k="ghost">payload {String(o.payload_hash).slice(0, 8)}…</Chip>}
            </div>
          </div>
        </div>
        <div className="row gap-sm" style={{ width: "100%", flexWrap: "wrap", alignItems: "center" }}>
          {customerEmail && (
            <Btn sm kind="ghost" onClick={() => window.location.href = `mailto:${customerEmail}?subject=${encodeURIComponent(o.po_number || o.quote_number || "Order update")}`}>
              {Icon.send} email customer
            </Btn>
          )}
          <Btn sm kind="ghost"
               onClick={() => downloadQuotePdf(o)}
               title="Render a branded PDF of the quote and download it">
            {Icon.download} quote PDF
          </Btn>
          <Btn sm kind="ghost"
               onClick={() => createInvoiceForOrder(o)}
               title="Draft a new invoice templated from this order">
            {Icon.plus} new invoice
          </Btn>
          <Btn sm kind="ghost"
               onClick={() => shareQuotePdf(o)}
               title="Generate a 7-day signed share link to the quote PDF">
            {Icon.send} share link
          </Btn>
          <Btn sm kind="ghost" onClick={() => exportAuditPack(o)} title="Bundle PO + quote + result + signed evidence URLs into a JSON download">
            {Icon.download} audit pack
          </Btn>
          <span style={{ flex: 1 }} />
          <Btn sm kind="ghost"
               disabled={!canCancel || busy || o.status === "CANCELLED"}
               onClick={cancelOrder}
               title={canCancel ? "Set order status to CANCELLED" : "needs sales_manager / admin"}>
            {Icon.x} cancel
          </Btn>
          {/* Run extraction: rescues orders stuck in DRAFT when the
              post-create OCR call from intake silently failed
              (ClamAV missing, transient network, etc.). Re-runs
              docai/extract against the attached PO and merges the
              normalized lines into the order so the workspace's
              reconciliation tab populates. */}
          <Btn sm kind="ghost"
               disabled={!canWrite || busy || !sourceDocId || (o.status !== "DRAFT" && o.status !== "PENDING_REVIEW")}
               onClick={runExtraction}
               title={
                 !sourceDocId
                   ? "No PO attached to this order"
                   : (o.status !== "DRAFT" && o.status !== "PENDING_REVIEW")
                     ? "Extraction is only available before approval"
                     : "Re-run docai/extract against the attached PO"
               }>
            {Icon.cycle} {busy ? "extracting…" : "run extraction"}
          </Btn>
          {/* Run validation: scores the extracted lines against the
              anomaly rule library and persists findings into
              orders.rule_findings. The Validate step in the stepper
              lights as done once last_validated_at is stamped. */}
          <Btn sm kind="ghost"
               disabled={!canWrite || busy || !o.customer_id || lines.length === 0 || o.status === "CANCELLED"}
               onClick={runValidation}
               title={
                 !o.customer_id
                   ? "Set a customer first; rules need a tenant peer-set"
                   : lines.length === 0
                     ? "Run extraction first; the rules score line items"
                     : "Score the order against the anomaly rule library"
               }>
            {Icon.shield} {busy ? "validating…" : "run validation"}
          </Btn>
          {/* Send for review: explicit DRAFT to PENDING_REVIEW
              transition for orders that have lines but no operator
              has flipped them out of DRAFT yet. */}
          <Btn sm kind="ghost"
               disabled={!canWrite || busy || o.status !== "DRAFT"}
               onClick={sendForReview}
               title={
                 o.status !== "DRAFT"
                   ? "Already advanced past DRAFT"
                   : "Move from DRAFT to PENDING_REVIEW"
               }>
            {Icon.send} send for review
          </Btn>
          {/* Return for correction: manager exit-path when the SO has
              a wrong ship-to, rate, qty, etc. The operator sees the
              note next time they open the workspace. Available only
              to roles that can approve, and only before the order has
              been pushed to Tally. */}
          <Btn sm kind="ghost"
               disabled={!canApprove || busy || o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED" || o.status === "CANCELLED" || o.status === "DRAFT"}
               onClick={requestCorrection}
               title={
                 canApprove
                   ? "Send back to operator with a note explaining what to fix"
                   : "needs sales_manager / finance / admin"
               }>
            {Icon.cycle} return for fix
          </Btn>
          <Btn sm kind="ghost"
               disabled={!canApprove || busy || o.status === "APPROVED" || o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED"}
               onClick={approveOrder}
               title={canApprove ? "Approve order" : "needs sales_manager / finance / admin"}>
            {Icon.shieldCheck} approve
          </Btn>
          <Btn sm kind="primary"
               disabled={!canPushTally || busy || o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED" || o.status === "CANCELLED"}
               onClick={pushToTally}
               title={canPushTally ? "Push the order payload to Tally" : "needs finance / admin"}>
            {Icon.send} {busy ? "pushing…" : "push to Tally"}
          </Btn>
        </div>
        <div className="row mono-sm" style={{ color: "var(--ink-3)", flexWrap: "wrap", gap: 8 }}>
          <span>{customerName}</span>
          <span style={{ color: "var(--ink-5)" }}>·</span>
          <span>created {ageLabel(o.created_at)} ago</span>
          <span style={{ color: "var(--ink-5)" }}>·</span>
          <span>updated {ageLabel(o.updated_at || o.created_at)} ago</span>
          <span style={{ marginLeft: "auto" }}>id <span className="mono">{o.id?.slice(0, 8)}…</span></span>
        </div>
      </div>

      <WSTabs tabs={tabs} active={tab} onChange={setTab} />

      {/* Phase B2: live extraction progress strip. Renders only
          while busy is true (an extraction or related job is in
          flight). Polls /api/orders/extraction_status every 2s
          and stops on the first terminal event. Sits between
          the tab strip and the tab content so it's visible
          regardless of which tab the operator is on. */}
      {busy && o?.id && (
        <div style={{ padding: "8px 16px 0" }}>
          <ExtractionProgress orderId={o.id} active={busy === true} />
        </div>
      )}

      <div className="ws-content">
        {/* Bug fix May 2026: the previous stepper drove the entire
            6-step pipeline off `o.status` alone. That left step 1
            (Preflight) and step 2 (Extract) effectively blank for
            most orders because no status maps to them, so the
            operator could never tell whether OCR had completed or
            extraction was actually populated. The new derivation
            uses the same evidence the rest of the workspace already
            reads: source doc presence (Capture done), extraction
            run id (Preflight done after the file was accepted +
            scanned), populated lineItems (Extract done), recorded
            rule_findings or PENDING_REVIEW (Validate done), APPROVED
            status (Approve done), and EXPORTED_TO_TALLY / RECONCILED
            (Push done). We light the first un-done step so the
            operator sees what's currently in progress. */}
        <Steps current={(() => {
          // The Steps primitive renders "current" as the in-progress
          // step (i === current : "cur") and earlier steps as done
          // (i < current : "done"). So we return the index of the
          // first NOT-DONE step. If everything is done we return
          // items.length so all six render as completed.
          if (!o) return 0;
          const hasSourceDoc = !!sourceDocId;
          // Bug fix May 2026 (stepper-lies report): Extract is "done"
          // ONLY when line items are actually populated. Stamping
          // `extraction_run_id` was previously enough to mark Extract
          // green even on a failed extraction (Claude returned 0
          // lines but the API still emitted a run_id). The result
          // was a workspace stepper that lied: Capture/Preflight/
          // Extract all green, "0 lines · 0 issues" in the table.
          const hasExtraction = lines.length > 0;
          // Preflight is done when we have a source doc + at least
          // an attempt at extraction (the run_id stamp is the
          // attempt signal). If Preflight is done but Extract is
          // not, the operator can re-run extraction from the action
          // bar (see `runExtraction` button below).
          const extractionAttempted = !!(o.preflight_payload?.extraction_run_id);
          const hasValidation = !!(o.preflight_payload?.last_validated_at)
            || o.status === "PENDING_REVIEW"
            || (Array.isArray(o.rule_findings) && o.rule_findings.length > 0);
          const isApproved = o.status === "APPROVED" || o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED";
          const isPushed = o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED";
          // The order row in the workspace implies Capture is already
          // done (intake created it). So we start at 1 and walk
          // forward as each subsequent stage's evidence shows up.
          let step = 1;                    // Capture done. Preflight in progress.
          if (hasSourceDoc) step = 2;      // Preflight done. Extract in progress.
          if (hasExtraction) step = 3;     // Extract done. Validate in progress.
          if (hasValidation) step = 4;     // Validate done. Approve in progress.
          if (isApproved) step = 5;        // Approve done. Push in progress.
          if (isPushed) step = 6;          // Push done. Pipeline complete (no "cur").
          return step;
        })()} items={["Capture", "Preflight", "Extract", "Validate", "Approve", "Push to Tally"]} />

        {/* Bug fix May 2026 (stepper-lies report): if extraction was
            attempted but produced 0 lines, surface an explicit
            warning so the operator can retry instead of staring at
            an empty reconciliation table behind a green-stepper
            UI. The "run extraction" button on the action bar
            re-runs `docai/extract` against the attached PO. */}
        {/* Return-for-correction banner. Mounts when a manager has
            sent the order back to the operator. The correction note
            is shown so the operator knows exactly what to fix before
            re-submitting for review. Banner clears automatically
            once the order moves out of DRAFT. */}
        {o.correction_reason && o.status === "DRAFT" && (
          <Banner
            kind="warn"
            icon={Icon.alert}
            title="Sent back for correction"
          >
            <div className="mono-sm" style={{ marginBottom: 4 }}>
              <b>{o.correction_requested_by || "Manager"}</b>
              {o.correction_requested_at
                ? " at " + new Date(o.correction_requested_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
                : ""}
              :
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{o.correction_reason}</div>
          </Banner>
        )}

        {!!(o.preflight_payload?.extraction_run_id) && lines.length === 0 && o.status !== "CANCELLED" && (
          <Banner
            kind="warn"
            icon={Icon.alert}
            title="Extraction returned no line items"
            action={
              <Btn sm kind="primary" disabled={!sourceDocId || busy} onClick={runExtraction}>
                {Icon.cycle} retry extraction
              </Btn>
            }
          >
            <span className="mono-sm">
              The PO was attached and an extraction run was logged
              {o.preflight_payload?.adapter_used ? " (adapter: " + o.preflight_payload.adapter_used + ")" : ""}
              {typeof o.preflight_payload?.confidence_overall === "number" ? " at confidence " + o.preflight_payload.confidence_overall.toFixed(2) : ""},
              but no lines came back. Re-run from this banner or attach a higher-quality PO.
            </span>
          </Banner>
        )}

        {/* Bug fix May 2026 (customer-prefill report): render the
            extracted customer block from the PO header on the
            workspace so the operator sees what docai pulled out
            without bouncing back to the intake screen. The intake
            now carries this block onto orders.result.salesOrder.customer
            so it survives the round trip. */}
        {tab === "recon" && o.result?.salesOrder?.customer && (
          <Card title="Customer · from PO header" eyebrow="extracted by docai">
            <KV rows={[
              ["Name",        o.result.salesOrder.customer.name || "—"],
              ["GSTIN",       (o.result.salesOrder.customer.gstin || "").toUpperCase() || "—"],
              ["State",       (o.result.salesOrder.customer.state_code || "").toUpperCase() || "—"],
              ["Currency",    o.result.salesOrder.customer.currency || "—"],
              ["Pay terms",   o.result.salesOrder.customer.payment_terms || "—"],
              ["Email",       o.result.salesOrder.customer.email || "—"],
              ["Phone",       o.result.salesOrder.customer.phone || "—"],
              ["Bill to",     o.result.salesOrder.customer.bill_to_address || "—"],
              ["Ship to",     o.result.salesOrder.customer.ship_to_address
                              || o.result.salesOrder.customer.bill_to_address || "—"],
            ]} />
          </Card>
        )}
        {tab === "recon" && (
          <Card flush>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span className="h2">Line reconciliation</span>
              <span className="mono-sm">{draftLines.length} line{draftLines.length === 1 ? "" : "s"} · {findings.length} issue{findings.length === 1 ? "" : "s"}</span>
              <span className="mono-sm" style={{ color: "var(--ink-3)", marginLeft: 4 }}>
                <Chip k="ghost">OCR</Chip> = from PO &nbsp;·&nbsp;
                <Chip k="info">edited</Chip> = operator override
              </span>
              <span style={{ flex: 1 }} />
              {canEditLines && draftLines.some((ln) => !ln._mapped_item || !ln._mapped_item.id) && (
                <Btn
                  sm
                  kind="ghost"
                  onClick={onSuggestMappings}
                  disabled={suggesting}
                  title="Use Claude to surface up to 3 candidate item_master rows per unmapped line."
                >
                  {suggesting ? "Suggesting…" : "Suggest mappings"}
                </Btn>
              )}
              {linesDirty && (
                <>
                  <Btn sm kind="ghost" onClick={onDiscardLineEdits} disabled={savingLines}>
                    Discard
                  </Btn>
                  <Btn sm kind="primary" onClick={onSaveLineEdits} disabled={savingLines || !canEditLines}
                       title={canEditLines ? "Persist edited line items to the order" : "Order is not in an editable state"}>
                    {savingLines ? "Saving…" : "Save line edits"}
                  </Btn>
                </>
              )}
            </div>
            {suggestError && (
              <div className="mono-sm" style={{ padding: "8px 16px", color: "var(--rust)", background: "var(--paper-2)" }}>
                Suggestion request failed: {suggestError}
              </div>
            )}
            {!canEditLines && draftLines.length > 0 && (
              <div className="mono-sm" style={{ padding: "8px 16px", color: "var(--ink-3)", background: "var(--paper-2)" }}>
                Lines are read-only because the order is {o.status}. Reopen it (return for correction) to edit.
              </div>
            )}
            {linesDirty && o.approval && (
              <div className="mono-sm" style={{ padding: "8px 16px", color: "var(--rust)", background: "var(--paper-2)" }}>
                Editing line items will invalidate the existing approval. The order will need to be re-approved before push.
              </div>
            )}
            {draftLines.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No line items extracted yet. Use the "run extraction"
                button on the action bar to re-run docai/extract
                against the attached PO, or attach a higher-quality PO.
              </div>
            ) : (
              (() => {
                // Tax totals across the draft so the footer can
                // reconcile against what the Tally voucher will
                // emit. Sum is computed from the same
                // computeLineTotals() helper reconRow uses so the
                // displayed footer always matches the sum of
                // displayed line totals (no paise drift). Auxiliary
                // costs (tooling / P&F / others) appear in the
                // grand total too because the buyer is paying them.
                const round2 = (n: number) => Math.round(n * 100) / 100;
                const perLine = draftLines.map((ln: any) => computeLineTotals(ln));
                const taxableTotal = perLine.reduce((s, t) => s + t.taxable, 0);
                const taxTotal = perLine.reduce((s, t) => s + t.tax, 0);
                const auxTotal = perLine.reduce((s, t) => s + t.aux, 0);
                const grandWithTax = round2(taxableTotal + taxTotal + auxTotal);
                return (
                  <table className="tbl">
                    <thead><tr>
                      <th style={{ width: 28 }}>#</th>
                      <th>Item</th>
                      <th>UoM</th>
                      <th className="r">Qty</th>
                      <th className="r">Rate</th>
                      <th>HSN / SAC</th>
                      <th className="r">GST %</th>
                      <th className="r">Taxable ₹</th>
                      <th className="r">Tax ₹</th>
                      <th className="r">Line ₹</th>
                      <th>Issues</th>
                    </tr></thead>
                    <tbody>{draftLines.map(reconRow)}</tbody>
                    <tfoot>
                      <tr style={{ background: "var(--paper-2)" }}>
                        <td colSpan={7} className="r mono" style={{ paddingTop: 8 }}>
                          <span style={{ color: "var(--ink-3)" }}>subtotal · taxable</span>
                        </td>
                        <td className="r mono"><b>{fmtINR(taxableTotal)}</b></td>
                        <td className="r mono">{taxTotal ? fmtINR(taxTotal) : "—"}</td>
                        <td className="r mono"></td>
                        <td></td>
                      </tr>
                      {auxTotal > 0 && (
                        <tr style={{ background: "var(--paper-2)" }}>
                          <td colSpan={9} className="r mono">
                            <span style={{ color: "var(--ink-3)" }}>auxiliary · tooling / P&amp;F / others</span>
                          </td>
                          <td className="r mono">{fmtINR(auxTotal)}</td>
                          <td></td>
                        </tr>
                      )}
                      <tr style={{ background: "var(--paper-2)" }}>
                        <td colSpan={7} className="r mono" style={{ paddingBottom: 8 }}>
                          <span style={{ color: "var(--ink-3)" }}>
                            grand total · taxable + tax{auxTotal > 0 ? " + aux" : ""}
                          </span>
                        </td>
                        <td className="r mono"></td>
                        <td className="r mono"></td>
                        <td className="r mono"><b style={{ fontSize: 13 }}>{fmtINR(grandWithTax)}</b></td>
                        <td></td>
                      </tr>
                      {grandWithTax > 0 && (
                        <tr style={{ background: "var(--paper-2)" }}>
                          <td colSpan={11} className="mono-sm" style={{ paddingTop: 2, paddingBottom: 10, color: "var(--ink-3)" }}>
                            <span style={{ color: "var(--ink-3)" }}>amount chargeable (in words):</span>{" "}
                            <i>{amountInWords(grandWithTax, { currency: o.currency || "INR" })}</i>
                          </td>
                        </tr>
                      )}
                    </tfoot>
                  </table>
                );
              })()
            )}
          </Card>
        )}

        {tab === "header" && (
          <OrderHeaderEditor order={o} onSaved={() => setBump((n) => n + 1)} />
        )}

        {tab === "margin" && (
          <Card title="Margin cockpit" eyebrow="this SO">
            {grandTotal === 0 ? (
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>No grand total yet — extraction or pricing has not completed.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                <div>
                  <div className="h-eyebrow">Realized margin</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 32, fontWeight: 500, letterSpacing: "-0.02em", color: "var(--ink)", marginTop: 4 }}>
                    {(realizedMargin * 100).toFixed(1)}%
                  </div>
                  <div className="mono-sm">{fmtINR(grandTotal - totalCost)} on {fmtINR(grandTotal)}</div>
                </div>
                <div>
                  <div className="h-eyebrow">Cost decomposition</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
                    {[
                      ["Materials · landed", pct(matCost), fmtINR(matCost)],
                      ["Freight",            pct(freight), fmtINR(freight)],
                      ["Customs · GST",      pct(customs), fmtINR(customs)],
                      ["Service",            pct(service), fmtINR(service)],
                      ["Margin",             Math.round(realizedMargin * 100), fmtINR(grandTotal - totalCost), true],
                    ].map((r, i) => (
                      <div key={i} className="row mono-sm">
                        <span style={{ minWidth: 130 }}>{r[0]}</span>
                        <div className="hbar" style={{ flex: 1 }}>
                          <span style={{ width: `${Math.max(0, Math.min(100, Number(r[1])))}%`, background: r[3] ? "var(--accent-2)" : "var(--ink)" }} />
                        </div>
                        <span style={{ minWidth: 80, textAlign: "right" }}>{r[2]}</span>
                        <span style={{ minWidth: 36, textAlign: "right", color: "var(--ink-3)" }}>{r[1]}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {cost.data && (
              <>
                <div className="divider" />
                <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                  Customer cost-to-serve: {fmtUSD(cost.data.totalUsd || 0)} across {cost.data.totalSuccess || 0} successful SOs · per-success {fmtUSD(cost.data.costPerSuccess || 0)}.
                </div>
              </>
            )}
          </Card>
        )}

        {tab === "why" && (
          <Card title="Why · model reasoning" eyebrow="redacted · audit">
            {findings.length === 0 ? (
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>No findings recorded for this order.</div>
            ) : (
              <div className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {findings.map((f, i) => (
                  <div key={i} style={{ background: "var(--paper-3)", padding: 10, borderRadius: 4, lineHeight: 1.55 }}>
                    <b style={{ color: "var(--ink)" }}>{(f.code || f.rule_id || "finding").toUpperCase()}</b>
                    {f.line_index != null && <> · L{Number(f.line_index) + 1}</>}
                    {f.detail ? ` — ${f.detail}` : ""}
                    {f.suggested_fix && <div style={{ marginTop: 4, color: "var(--ink-3)" }}>suggested fix · {f.suggested_fix}</div>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {tab === "evidence" && (
          <Card title="Evidence" eyebrow={o.doc_fingerprint ? `fingerprint ${String(o.doc_fingerprint).slice(0, 12)}…` : "no fingerprint"}>
            {o.evidence_by_field && Object.keys(o.evidence_by_field).length > 0 ? (
              <table className="tbl">
                <thead><tr><th>Field</th><th>Page · line</th><th>Value</th></tr></thead>
                <tbody>
                  {Object.entries(o.evidence_by_field as Record<string, any>).map(([field, ev]: [string, any]) => (
                    <tr key={field}>
                      <td className="mono-sm">{field}</td>
                      <td className="mono-sm">{ev?.page ? `p${ev.page}${ev.line ? "·l" + ev.line : ""}` : "—"}</td>
                      <td>{ev?.value != null ? String(ev.value) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Evidence map is empty. After OCR + extraction completes, every populated field has a citation here.</div>
            )}
          </Card>
        )}

        {tab === "approval" && (
          <Card title="Approval" eyebrow={o.approval ? "decided" : "pending"}>
            {o.approval ? (
              <KV rows={[
                ["Status", o.approval.status || o.approval.decision || "—"],
                ["Approver", o.approval.approver || o.approval.approver_role || "—"],
                ["Reason", o.approval.reason || o.approval.comments || "—"],
                ["Payload hash", o.approval.payloadHash || o.payload_hash || "—"],
              ]} />
            ) : (
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                No approval recorded yet. Approvals are logged once a manager / finance role decides via the Approvals queue.
              </div>
            )}
          </Card>
        )}

        {tab === "tally" && (
          <TallyTab orderId={o.id} order={o} onRefresh={() => setBump((n: number) => n + 1)} />
        )}

        {tab === "schedule" && (
          <>
            <KPIRow cols={4}>
              <KPI lbl="Scheduled qty" v={scheduleKpis.totalQty ? scheduleKpis.totalQty.toLocaleString("en-IN") : "0"} d={scheduleKpis.lineCount ? "across all lines" : "no lines yet"} />
              <KPI lbl="Lines" v={String(scheduleKpis.lineCount)} d={scheduleKpis.lineCount ? "live" : "empty"} live={scheduleKpis.lineCount > 0} />
              <KPI lbl="Next delivery" v={scheduleKpis.next || "—"} d={scheduleKpis.next ? `in ${Math.max(0, Math.round((new Date(scheduleKpis.next).getTime() - Date.now()) / 86400000))}d` : "—"} />
              <KPI lbl="Last delivery" v={scheduleKpis.last || "—"} d={scheduleKpis.last && scheduleKpis.next ? `${Math.max(0, Math.round((new Date(scheduleKpis.last).getTime() - new Date(scheduleKpis.next).getTime()) / 86400000))}d span` : "—"} />
            </KPIRow>

            <Card flush>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)", display: "flex", gap: 10, alignItems: "center" }}>
                <span className="h2">Schedule lines</span>
                <span className="mono-sm">{scheduleRows.length} row{scheduleRows.length === 1 ? "" : "s"}</span>
                <span style={{ flex: 1 }} />
                <Btn sm kind="ghost" onClick={() => setScheduleBump((n) => n + 1)} title="Refresh">{Icon.cycle} refresh</Btn>
                <Btn sm kind="ghost" disabled={!scheduleRows.length || busy || !canAdmin} onClick={handleClearAll} title={canAdmin ? "Delete all schedule lines for this order" : "needs admin"}>
                  {Icon.x} clear all
                </Btn>
              </div>
              {schedule.loading ? (
                <div className="body" style={{ padding: 18 }}>Loading schedule lines…</div>
              ) : schedule.error ? (
                <div className="body" style={{ padding: 18, color: "var(--rust)" }}>
                  <Banner kind="bad" icon={Icon.alert} title="Could not load schedule lines"
                          action={<Btn sm onClick={() => setScheduleBump((n) => n + 1)}>retry</Btn>}>
                    <span className="mono-sm">{String(schedule.error?.message || schedule.error)}</span>
                  </Banner>
                </div>
              ) : scheduleRows.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                  No schedule lines yet. Paste a TSV below to bulk-load delivery dates.
                </div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th style={{ width: 40 }}>#</th>
                    <th>Date</th>
                    <th className="r">Qty</th>
                    <th>Part</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Remark</th>
                    <th style={{ width: 70 }}></th>
                  </tr></thead>
                  <tbody>
                    {scheduleRows.map((r, i) => {
                      const stChip = scheduleStatus(r);
                      return (
                        <tr key={r.id || i}>
                          <td className="mono">{r.line_index != null ? r.line_index : i + 1}</td>
                          <td className="mono-sm">{r.scheduled_date || "—"}</td>
                          <td className="r mono">{Number(r.scheduled_qty || 0).toLocaleString("en-IN")}</td>
                          <td className="mono-sm">{r.part_no || "—"}</td>
                          <td className="mono-sm">{r.delivery_location || "—"}</td>
                          <td><Chip k={stChip.k}>{stChip.label}</Chip></td>
                          <td className="mono-sm" style={{ color: "var(--ink-3)" }}>{r.remark || "—"}</td>
                          <td>
                            <Btn sm kind="ghost" disabled={busy || !canAdmin} onClick={() => handleDeleteOne(r)} title={canAdmin ? "Delete this line" : "needs admin"}>
                              {Icon.x} delete
                            </Btn>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="Bulk add" eyebrow="paste TSV"
                  right={<span className="mono-sm" style={{ color: "var(--ink-3)" }}>format: <code>YYYY-MM-DD</code> &lt;TAB&gt; <code>qty</code> [&lt;TAB&gt; part_no] [&lt;TAB&gt; location] [&lt;TAB&gt; remark]</span>}>
              <textarea
                value={tsv}
                onChange={(ev) => setTsv(ev.target.value)}
                placeholder={"2026-05-15\t1200\tMG-PART-A\tGurgaon\tBatch 1\n2026-05-29\t800\tMG-PART-A\tGurgaon\tBatch 2"}
                rows={6}
                spellCheck={false}
                style={{
                  width: "100%",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  padding: 10,
                  border: "1px solid var(--hairline-2)",
                  borderRadius: 4,
                  background: "var(--paper-2)",
                  color: "var(--ink)",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
                disabled={busy || !canWrite}
              />
              <div className="row" style={{ marginTop: 10, gap: 8, alignItems: "center" }}>
                <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                  {(() => {
                    const { rows, errors } = parseTsv(tsv);
                    if (!tsv.trim()) return "Paste rows above. One delivery per line.";
                    if (errors.length) return `${errors.length} issue${errors.length === 1 ? "" : "s"} · ${errors[0]}`;
                    return `Will insert ${rows.length} row${rows.length === 1 ? "" : "s"} on submit.`;
                  })()}
                </span>
                <span style={{ flex: 1 }} />
                <Btn sm kind="ghost" disabled={busy || !tsv.trim()} onClick={() => setTsv("")}>
                  {Icon.x} reset
                </Btn>
                <Btn sm kind="primary" disabled={busy || !tsv.trim() || !canWrite} onClick={handleBulkAdd} title={canWrite ? "" : "needs write permission"}>
                  {Icon.plus} bulk add
                </Btn>
              </div>
            </Card>
          </>
        )}

        {tab === "shipments" && (
          <Card title="Shipments" eyebrow="schedule lines">
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
              Shipment timeline loads from <code>order_schedule_lines</code> in the Shipments route. Open <button type="button" onClick={() => window.location.hash = "#/shipments"} className="link-btn" style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>shipments</button> to see active dispatches, or jump to the <button type="button" onClick={() => setTab("schedule")} className="link-btn" style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>Schedule</button> tab to edit lines.
            </div>
          </Card>
        )}

        {tab === "activity" && (
          <Card title="Activity" eyebrow={`${mergedTimeline.length} event${mergedTimeline.length === 1 ? "" : "s"} · merged`}
                right={<span className="row gap-sm mono-sm">
                  <Chip k="ghost">AU audit</Chip>
                  <Chip k="plum">CM comms</Chip>
                  <Chip k="info">PR processing</Chip>
                </span>}>
            {audit.loading || procEvents.loading ? (
              <div className="body">Loading…</div>
            ) : mergedTimeline.length === 0 ? (
              <div className="mono-sm" style={{ color: "var(--ink-4)" }}>No events for this order yet.</div>
            ) : (
              <Stream rows={mergedTimeline.slice(0, 80).map((ev) => ({
                t: ev.ts ? new Date(ev.ts).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—",
                a: ev.source,
                m: `<span class="chip ${tagChipKind(ev.source)}" style="margin-right:6px">${ev.source}</span>${ev.summary}`,
              }))} />
            )}
          </Card>
        )}

        {/* Phase 3.6 observability (audit close): Pipeline
            Diagnostics tab. Renders the result of
            /api/orders/<id>/pipeline-state which aggregates:
              - source document (filename, mime, scan_status)
              - extraction_runs (status, status_reason, adapter,
                attempts, normalized + raw previews, confidence)
              - processing_events keyed by order_id OR source_id
              - ocr_runs
              - tenant docai adapter health
            This is the single screen the operator opens when
            "credits burned, no result, stepper green" happens.
            Without it, every prior fix attempt was guessing. */}
        {tab === "diagnostics" && (
          <PipelineDiagnostics
            orderId={o.id}
            state={pipelineState}
            setState={setPipelineState}
          />
        )}
      </div>
      {/* Layer A: item_master picker. Renders only when the operator
          clicks "Map to canonical..." on an unmapped recon line. */}
      <ItemMasterPicker
        open={pickerLineIdx !== null}
        onClose={() => setPickerLineIdx(null)}
        onPick={(item) => {
          if (pickerLineIdx !== null) applyManualMap(pickerLineIdx, item, "manual", 100);
          setPickerLineIdx(null);
        }}
        initialQuery={pickerLineIdx !== null
          ? String((draftLines[pickerLineIdx]?.itemCode || draftLines[pickerLineIdx]?.partNumber || draftLines[pickerLineIdx]?.description || "")).slice(0, 60)
          : ""}
      />
    </div>
  );
};

// ============================================================
// Pipeline Diagnostics tab. Self-contained component that lazy-
// loads the order's pipeline-state on first open and renders the
// adapter chain + extraction runs + processing events.
// ============================================================
const PipelineDiagnostics: React.FC<{
  orderId: string;
  state: { data: any; loading: boolean; error: any };
  setState: (s: { data: any; loading: boolean; error: any }) => void;
}> = ({ orderId, state, setState }) => {
  React.useEffect(() => {
    if (state.data || state.loading) return;
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    Promise.resolve((ObaraBackend as any)?.orders?.pipelineState?.(orderId))
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
    fail_unknown: "Unknown failure",
  };
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
    <>
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
          <table className="tbl">
            <thead><tr>
              <th>Started</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Adapter</th>
              <th>Model</th>
              <th className="r">Conf</th>
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
                    <td>
                      <Chip k={reasonTone(r.status_reason || "")}>
                        {REASON_LABELS[r.status_reason] || r.status_reason || "—"}
                      </Chip>
                    </td>
                    <td className="mono-sm">{r.adapter_used || "—"}</td>
                    <td className="mono-sm" title={r.model_selection_reason || ""}>
                      {r.selected_model || "—"}
                    </td>
                    <td className="r mono">{r.confidence_overall != null ? Number(r.confidence_overall).toFixed(2) : "—"}</td>
                    <td className="mono-sm">{layerBadges || "L4"}</td>
                    <td className="mono-sm">{vText}</td>
                    <td className="mono-sm">
                      {Array.isArray(r.adapter_attempts)
                        ? r.adapter_attempts.map((a: any) => a.adapter + ":" + a.status).join(" · ")
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
                  <td className="mono-sm" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.error || "—"}</td>
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
                  <td className="mono-sm" style={{ maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
    </>
  );
};


export default WiredSOWorkspace;

// Order header-fields editor. Mounted inside the SO workspace as the
// `Header fields` tab. Carries the six new columns added by migration
// 106: dispatch_mode, registration_serial_no, incoterm_code,
// delivery_terms, vendor_code, delivery_point_contact_id. Each save
// flows through the existing /api/orders/[id] PATCH endpoint with
// APPROVE_INPUTS already extended to accept them.
const OrderHeaderEditor: React.FC<{ order: any; onSaved: () => void }> = ({ order, onSaved }) => {
  const buildDraft = (o: any) => ({
    dispatch_mode: o.dispatch_mode || "",
    registration_serial_no: o.registration_serial_no || "",
    incoterm_code: o.incoterm_code || o.incoterms || "",
    delivery_terms: o.delivery_terms || "",
    vendor_code: o.vendor_code || "",
    delivery_point_contact_id: o.delivery_point_contact_id || "",
  });
  const [draft, setDraft] = React.useState<any>(buildDraft(order));
  // Audit fix May 2026: useState only runs its initialiser on the
  // first mount. When the parent re-renders with a fresh order
  // prop after save (setBump -> refetch), the draft retained the
  // pre-save snapshot and a second save would push stale values
  // over a concurrent edit. Re-sync the draft whenever the order
  // identity or updated_at changes.
  React.useEffect(() => {
    setDraft(buildDraft(order));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id, order.updated_at]);
  const [reference, setReference] = React.useState<any>({ incoterms: [], contacts: [] });
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg: any = (ObaraBackend as any)?.getConfig?.() || {};
        const session: any = (ObaraBackend as any)?.getSession?.() || null;
        const headers: any = { "Content-Type": "application/json" };
        if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
        if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
        const base = cfg.url.replace(/\/+$/, "");
        const [refResp, contactsResp] = await Promise.all([
          fetch(base + "/api/admin/item_reference", { headers }).then((r) => r.ok ? r.json() : { incoterms: [] }),
          order.customer_id
            ? fetch(base + "/api/customer_contacts?customer_id=" + order.customer_id, { headers }).then((r) => r.ok ? r.json() : { contacts: [] })
            : Promise.resolve({ contacts: [] }),
        ]);
        if (cancelled) return;
        setReference({
          incoterms: refResp.incoterms || [],
          contacts: contactsResp.contacts || contactsResp.rows || [],
        });
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [order.customer_id]);

  const save = async () => {
    setBusy(true);
    try {
      // Audit fix May 2026: flip _header_field_sources for any
      // field the operator actually changed from the persisted
      // value, so the OCR pill drops after save instead of
      // re-rendering on the new server data. Stamped inside
      // result.salesOrder._header_field_sources, where so-intake
      // initially writes it. Side-effect: PATCHing `result`
      // invalidates approval per orders/[id].js:131 - that's the
      // correct behaviour (header-field edits should require
      // re-approval).
      const headerSourcesPrev: Record<string, string> =
        (order.result?.salesOrder?._header_field_sources) || {};
      const headerSourcesNext = { ...headerSourcesPrev };
      const HEADER_KEYS = [
        "dispatch_mode", "registration_serial_no", "incoterm_code",
        "delivery_terms", "vendor_code", "delivery_point_contact_id",
      ];
      let anyChanged = false;
      for (const k of HEADER_KEYS) {
        if ((draft[k] || "") !== (order[k] || "")) {
          anyChanged = true;
          if (headerSourcesNext[k] === "ocr") headerSourcesNext[k] = "human";
        }
      }
      const patch: any = {
        dispatch_mode: draft.dispatch_mode || null,
        registration_serial_no: draft.registration_serial_no || null,
        incoterm_code: draft.incoterm_code || null,
        delivery_terms: draft.delivery_terms || null,
        vendor_code: draft.vendor_code || null,
        delivery_point_contact_id: draft.delivery_point_contact_id || null,
      };
      if (anyChanged && Object.keys(headerSourcesNext).length) {
        patch.result = {
          ...(order.result || {}),
          salesOrder: {
            ...(order.result?.salesOrder || {}),
            _header_field_sources: headerSourcesNext,
          },
        };
      }
      await ObaraBackend?.orders?.update?.(order.id, patch);
      window.notifySuccess?.("Header fields saved", order.po_number || order.id.slice(0, 8));
      onSaved();
    } catch (err: any) {
      window.notifyError?.("Could not save header fields", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  // Per-field provenance map populated by so-intake when the
  // extractor returned the value. We render "from PO" next to a
  // field whose label is still equal to the persisted column value;
  // once the operator types, the pill drops and the field reads as
  // operator-set. Stored under result.salesOrder._header_field_sources
  // so no schema migration is required.
  const headerSources: Record<string, string> = (order.result?.salesOrder?._header_field_sources) || {};
  const fieldOcr = (key: string, persistedValue: any, draftValue: any) =>
    headerSources[key] === "ocr" && (persistedValue || "") === (draftValue || "")
      ? <Chip k="ghost">OCR</Chip>
      : null;

  const labelWithPill = (text: string, key: string, persistedValue: any, draftValue: any) => (
    <label className="mono-sm" style={{ color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
      <span>{text}</span>
      {fieldOcr(key, persistedValue, draftValue)}
    </label>
  );

  return (
    <Card title="Order header fields" eyebrow="dispatch . terms . vendor mapping . delivery contact">
      <Banner kind="info">
        These fields apply to the whole order: the SO PDF, the Tally
        voucher, and the customer ack copy them verbatim. Values with
        an <Chip k="ghost">OCR</Chip> pill were auto-detected from
        the PO at intake. Edit any field to override; saving clears
        the OCR pill so the next reviewer can see the override.
      </Banner>
      <div className="row" style={{ gap: 14, flexWrap: "wrap", marginTop: 12 }}>
        <div style={{ flex: "1 1 220px" }}>
          {labelWithPill("Dispatch mode", "dispatch_mode", order.dispatch_mode, draft.dispatch_mode)}
          <select className="select" value={draft.dispatch_mode} onChange={(e) => setDraft({ ...draft, dispatch_mode: e.target.value })}>
            <option value="">Not set</option>
            <option value="By Ocean">By Ocean</option>
            <option value="By Air">By Air</option>
            <option value="By Road">By Road</option>
            <option value="By Rail">By Rail</option>
            <option value="By Courier">By Courier</option>
            <option value="Self Pickup">Self Pickup</option>
          </select>
        </div>
        <div style={{ flex: "1 1 220px" }}>
          {labelWithPill("Incoterm", "incoterm_code", order.incoterm_code, draft.incoterm_code)}
          <select className="select" value={draft.incoterm_code} onChange={(e) => setDraft({ ...draft, incoterm_code: e.target.value })}>
            <option value="">Not set</option>
            {(reference.incoterms || []).map((c: any) => (
              <option key={c.code} value={c.code}>{c.code} . {c.label}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: "1 1 220px" }}>
          {labelWithPill("Registration serial no", "registration_serial_no", order.registration_serial_no, draft.registration_serial_no)}
          <input className="input mono" value={draft.registration_serial_no} onChange={(e) => setDraft({ ...draft, registration_serial_no: e.target.value })} />
        </div>
        <div style={{ flex: "1 1 220px" }}>
          {labelWithPill("Vendor code (as buyer refers to us)", "vendor_code", order.vendor_code, draft.vendor_code)}
          <input className="input mono" value={draft.vendor_code} onChange={(e) => setDraft({ ...draft, vendor_code: e.target.value })} placeholder="e.g., TH1M" />
        </div>
        <div style={{ flex: "1 1 220px" }}>
          {labelWithPill("Delivery point contact", "delivery_point_contact_id", order.delivery_point_contact_id, draft.delivery_point_contact_id)}
          <select className="select" value={draft.delivery_point_contact_id || ""} onChange={(e) => setDraft({ ...draft, delivery_point_contact_id: e.target.value })}>
            <option value="">Not set</option>
            {(reference.contacts || []).map((c: any) => (
              <option key={c.id} value={c.id}>{c.full_name || c.email || c.id?.slice(0, 8)}</option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        {labelWithPill("Terms of delivery (free text)", "delivery_terms", order.delivery_terms, draft.delivery_terms)}
        <textarea className="input" rows={3} style={{ width: "100%" }} value={draft.delivery_terms} onChange={(e) => setDraft({ ...draft, delivery_terms: e.target.value })} placeholder="e.g., Door delivery during business hours. Wooden box must remain dry." />
      </div>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <Btn sm kind="primary" disabled={busy} onClick={save}>{busy ? "Saving..." : "Save header"}</Btn>
      </div>

      <div style={{ marginTop: 18, borderTop: "1px solid var(--hairline-2)", paddingTop: 14 }}>
        <OrderLineTaxComponents orderId={order.id} lines={order.result?.salesOrder?.lineItems || []} />
      </div>
    </Card>
  );
};

// Per-line tax + charge decomposition panel. Reads / writes
// /api/admin/order_line_tax_components. The 15 component codes
// (SGST, CGST, IGST, UTGST, Cess, Excise, Ed. Cess, S-VAT, C-VAT,
// Tooling, P&F, Freight, Insurance, Handling, Others) are loaded
// from the global reference table via /api/admin/item_reference.
const OrderLineTaxComponents: React.FC<{ orderId: string; lines: any[] }> = ({ orderId, lines }) => {
  const [components, setComponents] = React.useState<any[]>([]);
  const [codes, setCodes] = React.useState<any[]>([]);
  const [draft, setDraft] = React.useState<any>({ line_index: 0, component_code: "sgst", amount: 0 });

  const headers = () => {
    const cfg: any = (ObaraBackend as any)?.getConfig?.() || {};
    const session: any = (ObaraBackend as any)?.getSession?.() || null;
    const h: any = { "Content-Type": "application/json" };
    if (session?.access_token) h["Authorization"] = "Bearer " + session.access_token;
    if (cfg.tenantId) h["x-obara-tenant"] = cfg.tenantId;
    return { h, base: cfg.url.replace(/\/+$/, "") };
  };

  const reload = React.useCallback(async () => {
    try {
      const { h, base } = headers();
      const [tc, ref] = await Promise.all([
        fetch(base + "/api/admin/order_line_tax_components?order_id=" + orderId, { headers: h }).then((r) => r.ok ? r.json() : { components: [] }),
        fetch(base + "/api/admin/item_reference", { headers: h }).then((r) => r.ok ? r.json() : { tax_component_codes: [] }),
      ]);
      setComponents(tc.components || []);
      setCodes(ref.tax_component_codes || []);
    } catch (_) {}
  }, [orderId]);

  React.useEffect(() => { reload(); }, [reload]);

  const save = async () => {
    if (!draft.component_code || draft.line_index == null) return;
    const { h, base } = headers();
    const body = JSON.stringify({ order_id: orderId, components: [draft] });
    try {
      const r = await fetch(base + "/api/admin/order_line_tax_components", { method: "POST", headers: h, body });
      if (!r.ok) throw new Error("HTTP " + r.status);
      window.notifySuccess?.("Tax component saved", draft.component_code);
      setDraft({ line_index: 0, component_code: "sgst", amount: 0 });
      reload();
    } catch (e: any) {
      window.notifyError?.("Could not save tax component", e?.message || String(e));
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Remove this tax component?")) return;
    const { h, base } = headers();
    try {
      const r = await fetch(base + "/api/admin/order_line_tax_components?id=" + id, { method: "DELETE", headers: h });
      if (!r.ok) throw new Error("HTTP " + r.status);
      reload();
    } catch (e: any) {
      window.notifyError?.("Could not delete", e?.message || String(e));
    }
  };

  return (
    <>
      <div className="row" style={{ alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Per-line tax + charge decomposition</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{components.length} component{components.length === 1 ? "" : "s"}</div>
        </div>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }}>
        <div>
          <label className="mono-sm">Line</label>
          <select className="select" value={draft.line_index} onChange={(e) => setDraft({ ...draft, line_index: Number(e.target.value) })}>
            {lines.length === 0 && <option value={0}>0</option>}
            {lines.map((_, i) => <option key={i} value={i}>Line {i + 1}</option>)}
          </select>
        </div>
        <div>
          <label className="mono-sm">Component</label>
          <select className="select" value={draft.component_code} onChange={(e) => setDraft({ ...draft, component_code: e.target.value })}>
            {(codes.length > 0 ? codes : [{ code: "sgst", label: "SGST" }, { code: "cgst", label: "CGST" }, { code: "igst", label: "IGST" }]).map((c: any) => (
              <option key={c.code} value={c.code}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mono-sm">Amount</label>
          <input className="input mono r" type="number" step="0.01" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) })} />
        </div>
        <div>
          <label className="mono-sm">Rate %</label>
          <input className="input mono r" type="number" step="0.01" value={draft.rate_pct ?? ""} onChange={(e) => setDraft({ ...draft, rate_pct: e.target.value === "" ? null : Number(e.target.value) })} />
        </div>
        <Btn sm kind="primary" onClick={save}>Add</Btn>
      </div>
      {components.length === 0 ? (
        <div className="mono-sm" style={{ color: "var(--ink-3)" }}>No tax components on file. Add SGST / CGST / IGST / Tooling / P&F etc above.</div>
      ) : (
        <table className="tbl">
          <thead><tr>
            <th>Line</th><th>Component</th><th className="r">Rate %</th><th className="r">Amount</th><th></th>
          </tr></thead>
          <tbody>
            {components.map((c) => (
              <tr key={c.id}>
                <td className="mono-sm">{c.line_index + 1}</td>
                <td><span className="pri">{c.component_label || c.component_code.toUpperCase()}</span></td>
                <td className="r mono">{c.rate_pct != null ? Number(c.rate_pct).toFixed(2) + "%" : "-"}</td>
                <td className="r mono">{fmtINR(Number(c.amount))}</td>
                <td className="r"><Btn sm kind="ghost" onClick={() => remove(c.id)}>remove</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
};

// ============================================================
// Phase F.6 Tally tab. Renders voucher record + Tally-side state,
// drift findings, run history, and a "Reconcile now" button that
// fires /api/tally/reconcile?mode=drift_check scoped to this order.
// ============================================================

const TallyTab: React.FC<{
  orderId: string;
  order: any;
  onRefresh: () => void;
}> = ({ orderId, order, onRefresh }) => {
  const [recon, setRecon] = useState<{ data: any; loading: boolean; error: any }>({ data: null, loading: true, error: null });
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setRecon({ data: null, loading: true, error: null });
    try {
      const next = await (ObaraBackend as any)?.tally?.getOrderRecon?.(orderId);
      setRecon({ data: next, loading: false, error: null });
    } catch (err) {
      setRecon({ data: null, loading: false, error: err });
    }
  }, [orderId]);

  React.useEffect(() => { reload(); }, [reload]);

  const reconcileNow = async () => {
    setBusy(true); setBusyMsg(null);
    try {
      const out = await (ObaraBackend as any)?.tally?.driftCheck?.({
        scope: "order",
        scopeValue: orderId,
        trigger: "workspace",
      });
      setBusyMsg(
        out?.vouchers_drifted
          ? `Drift detected: ${out.vouchers_drifted} finding(s)`
          : "Clean: no drift detected"
      );
      await reload();
      onRefresh();
    } catch (e: any) {
      setBusyMsg("Error: " + String(e?.message || e));
    } finally { setBusy(false); }
  };

  const resolveFinding = async (findingId: string) => {
    try {
      await (ObaraBackend as any)?.tally?.resolveFinding?.(findingId);
      await reload();
    } catch (_e) { /* no-op */ }
  };

  const vrec = recon.data?.voucher_record || null;
  const findings: any[] = recon.data?.findings || [];
  const unresolved = findings.filter((f) => !f.resolved_at);
  const drift_summary = vrec?.drift_summary || {};
  const driftKeys = Object.keys(drift_summary);

  const tally_status = order.tally_status;
  const eyebrow = order.status === "EXPORTED_TO_TALLY" ? "exported"
    : order.status === "FAILED_TALLY_IMPORT" ? "failed"
    : order.status === "TALLY_RECONCILED" ? "reconciled"
    : "queued";

  return (
    <>
      {vrec?.last_drift_at && unresolved.length > 0 && (
        <Banner kind="bad" icon={Icon.alert} title={`Drift detected ${driftKeys.length === 0 ? "" : "(" + driftKeys.join(", ") + ")"}`}>
          <span className="mono-sm">
            {unresolved.length} unresolved finding{unresolved.length === 1 ? "" : "s"} since {new Date(vrec.last_drift_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}.
          </span>
        </Banner>
      )}

      <Card
        title="Tally"
        eyebrow={eyebrow}
        right={
          <Btn sm kind="primary" disabled={busy} onClick={reconcileNow}>
            {busy ? "Reconciling…" : "Reconcile now"}
          </Btn>
        }
      >
        <KV rows={[
          ["Voucher no", vrec?.voucher_no || "—"],
          ["Voucher status", vrec?.status || tally_status || "—"],
          ["Last reconciled", vrec?.last_reconciled_at ? new Date(vrec.last_reconciled_at).toLocaleString("en-IN") : "never"],
          ["Last drift", vrec?.last_drift_at ? new Date(vrec.last_drift_at).toLocaleString("en-IN") : "(no drift)"],
          ["Hash", order.payload_hash || "—"],
          ["Pushed", order.status === "EXPORTED_TO_TALLY" || order.status === "TALLY_RECONCILED" ? "yes" : "no"],
        ]} />
        {busyMsg && (
          <div className="mono-sm" style={{ marginTop: 8, color: "var(--ink-3)" }}>{busyMsg}</div>
        )}
      </Card>

      <Card title="Reconciliation findings" eyebrow={`${findings.length} total · ${unresolved.length} unresolved`} flush>
        {findings.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No reconciliation findings for this order. Run "Reconcile now" to check.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>When</th>
              <th>Kind</th>
              <th>Severity</th>
              <th>Diff %</th>
              <th>Expected</th>
              <th>Actual</th>
              <th>Auto-fix</th>
              <th>Status</th>
              <th></th>
            </tr></thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id}>
                  <td className="mono-sm">{f.created_at ? new Date(f.created_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                  <td className="mono-sm">{f.finding_kind}</td>
                  <td>
                    <Chip k={f.severity === "critical" || f.severity === "error" ? "bad" : f.severity === "warn" ? "warn" : "info"}>
                      {f.severity}
                    </Chip>
                  </td>
                  <td className="r mono">{f.diff_pct != null ? Number(f.diff_pct).toFixed(2) + "%" : "—"}</td>
                  <td className="mono-sm" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.expected ? JSON.stringify(f.expected) : "—"}
                  </td>
                  <td className="mono-sm" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.actual ? JSON.stringify(f.actual) : "—"}
                  </td>
                  <td className="mono-sm">{f.auto_fix_applied || "—"}</td>
                  <td>
                    <Chip k={f.resolved_at ? "good" : "warn"}>
                      {f.resolved_at ? "resolved" : "open"}
                    </Chip>
                  </td>
                  <td>
                    {!f.resolved_at && (
                      <Btn sm kind="ghost" onClick={() => resolveFinding(f.id)}>Mark resolved</Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};
