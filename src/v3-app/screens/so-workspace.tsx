import React, { useEffect, useMemo, useState } from "react";
import { ageLabel, fmtINRShort, stageOf } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, Prov, Steps, Stream, WSTabs, WSTitle, fmtUSD } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";

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
  const grandTotal = Number(o.result?.salesOrder?.grandTotal) || 0;
  const subtotal = lines.reduce((s, ln) => s + (Number(ln.lineTotal) || (Number(ln.qty) * Number(ln.rate)) || 0), 0);
  const findings = Array.isArray(o.rule_findings) ? o.rule_findings : [];

  const canPushTally = RBAC?.canDo?.("so.push_tally");
  const canApprove = RBAC?.canDo?.("so.approve");
  const canCancel = RBAC?.canDo?.("so.cancel");
  const canWrite = RBAC?.canDo?.("so.write") !== false;
  const canAdmin = RBAC?.canDo?.("so.admin") !== false;

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
    setBusy(true);
    try {
      await ObaraBackend?.orders?.update?.(o.id, { status: "APPROVED" });
      window.notifySuccess?.("Order approved", o.po_number || o.id.slice(0, 8));
      setBump((n) => n + 1);
    } catch (err) {
      window.notifyError?.("Approve failed", err?.message || String(err));
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
      const out: any = await (ObaraBackend as any)?.docai?.extract?.({ source_id: sourceDocId });
      const lines = Array.isArray(out?.normalized?.lines) ? out.normalized.lines : [];
      const adapter = out?.adapter_used || null;
      const conf = typeof out?.confidence_overall === "number" ? out.confidence_overall : null;
      // 2. Merge the lines + run metadata into the order so the
      //    workspace's reconciliation tab populates immediately.
      const nextResult = { ...(o.result || {}) };
      nextResult.salesOrder = { ...(nextResult.salesOrder || {}), lineItems: lines };
      const nextPreflight = {
        ...(o.preflight_payload || {}),
        extraction_run_id: out?.run_id || null,
        adapter_used: adapter,
        confidence_overall: conf,
        last_extracted_at: new Date().toISOString(),
      };
      await ObaraBackend?.orders?.update?.(o.id, {
        result: nextResult,
        preflight_payload: nextPreflight,
      });
      // 3. Best-effort OCR for the evidence bbox overlay.
      try { await (ObaraBackend as any)?.ocr?.run?.(sourceDocId, o.id); } catch (_) { /* surface in audit */ }
      window.notifySuccess?.(
        "Extraction complete",
        lines.length + " line" + (lines.length === 1 ? "" : "s") + (adapter ? " (" + adapter + ")" : ""),
      );
      setBump((n) => n + 1);
    } catch (err: any) {
      window.notifyError?.("Extraction failed", err?.message || String(err));
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
      const candidate = o.result?.salesOrder || {};
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

  // Reconciliation columns: number, item, UoM, qty, rate, prev, delta, line ₹, evidence, issues
  const reconRow = (ln, i) => {
    const sku = ln.itemCode || ln.sku || ln.code || "";
    const desc = ln.description || ln.name || ln.item || "";
    const uom = ln.uom || ln.unit || "—";
    const qty = ln.qty != null ? ln.qty : ln.quantity;
    const qtyQuoted = ln.qtyQuoted != null ? ln.qtyQuoted : qty;
    const rate = Number(ln.rate || ln.unitPrice || 0);
    const ratePrev = Number(ln.ratePrev || ln.previousRate || 0);
    const drift = ratePrev > 0 ? (rate - ratePrev) / ratePrev : null;
    const lineTotal = Number(ln.lineTotal) || (Number(qty) * rate) || 0;
    const lineFindings = findings.filter((f) => Number(f.line_index) === i || Number(f.lineIndex) === i);
    const issueChip = lineFindings.length === 0
      ? "—"
      : lineFindings.map((f, j) => (
          <Chip key={j} k={f.severity === "ERROR" || f.blocks ? "bad" : f.severity === "WARNING" ? "warn" : "info"}>
            {(f.code || f.rule_id || "issue").toLowerCase()}
          </Chip>
        ));
    return (
      <tr key={i}>
        <td className="mono">{i + 1}</td>
        <td>
          <div style={{ fontWeight: 600 }}>{desc || "—"}</div>
          {sku && <div className="mono-sm">SKU {sku}</div>}
        </td>
        <td>{uom}</td>
        <td className="r mono">{qty != null ? qty : "—"}</td>
        <td className="r mono">{qtyQuoted != null ? qtyQuoted : "—"}</td>
        <td className="r mono">{rate ? fmtINRShort(rate) : "—"}</td>
        <td className="r mono">{ratePrev ? fmtINRShort(ratePrev) : "—"}</td>
        <td className="r mono" style={{ color: drift == null ? "var(--ink-4)" : drift > 0.10 ? "var(--rust)" : drift > 0 ? "var(--amber-2)" : "var(--sage)" }}>
          {drift == null ? "·" : (drift >= 0 ? "+" : "") + (drift * 100).toFixed(1) + "%"}
        </td>
        <td className="r mono"><span className="pri">{lineTotal ? fmtINRShort(lineTotal) : "—"}</span></td>
        <td className="row gap-sm">{ln.evidence?.page ? <Prov>p{ln.evidence.page}{ln.evidence.line ? `·l${ln.evidence.line}` : ""}</Prov> : "—"}</td>
        <td>{issueChip}</td>
      </tr>
    );
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

  const tabs = [
    { id: "recon", label: "Reconciliation", count: findings.length || null },
    { id: "margin", label: "Margin cockpit" },
    { id: "why", label: "Why" },
    { id: "evidence", label: "Evidence" },
    { id: "approval", label: "Approval" },
    { id: "tally", label: "Tally" },
    { id: "schedule", label: "Schedule", count: scheduleRows.length || null },
    { id: "shipments", label: "Shipments" },
    { id: "activity", label: "Activity", count: mergedTimeline.length || null },
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
          const hasExtraction = !!(o.preflight_payload?.extraction_run_id) || lines.length > 0;
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

        {tab === "recon" && (
          <Card flush>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)", display: "flex", gap: 10, alignItems: "center" }}>
              <span className="h2">Line reconciliation</span>
              <span className="mono-sm">{lines.length} line{lines.length === 1 ? "" : "s"} · {findings.length} issue{findings.length === 1 ? "" : "s"}</span>
            </div>
            {lines.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No line items extracted yet. Extraction completes after OCR finishes.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th style={{ width: 28 }}>#</th>
                  <th>Item</th>
                  <th>UoM</th>
                  <th className="r">Qty · PO</th>
                  <th className="r">Qty · Q</th>
                  <th className="r">Rate · PO</th>
                  <th className="r">Rate · prev</th>
                  <th className="r">Δ</th>
                  <th className="r">Line ₹</th>
                  <th>Evidence</th>
                  <th>Issues</th>
                </tr></thead>
                <tbody>{lines.map(reconRow)}</tbody>
                <tfoot>
                  <tr style={{ background: "var(--paper-2)" }}>
                    <td colSpan={8} className="r mono" style={{ paddingTop: 10, paddingBottom: 10 }}>
                      <span style={{ color: "var(--ink-3)" }}>subtotal · before tax & freight</span>
                    </td>
                    <td className="r mono"><b style={{ fontSize: 13 }}>{fmtINRShort(subtotal)}</b></td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            )}
          </Card>
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
                  <div className="mono-sm">{fmtINRShort(grandTotal - totalCost)} on {fmtINRShort(grandTotal)}</div>
                </div>
                <div>
                  <div className="h-eyebrow">Cost decomposition</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
                    {[
                      ["Materials · landed", pct(matCost), fmtINRShort(matCost)],
                      ["Freight",            pct(freight), fmtINRShort(freight)],
                      ["Customs · GST",      pct(customs), fmtINRShort(customs)],
                      ["Service",            pct(service), fmtINRShort(service)],
                      ["Margin",             Math.round(realizedMargin * 100), fmtINRShort(grandTotal - totalCost), true],
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
          <Card title="Tally" eyebrow={o.status === "EXPORTED_TO_TALLY" ? "exported" : o.status === "FAILED_TALLY_IMPORT" ? "failed" : "queued"}>
            <KV rows={[
              ["Voucher", o.payload_hash ? `SO/${o.order_mode || "GEN"}/${(o.po_number || o.id || "").slice(0, 12)}` : "—"],
              ["Hash", o.payload_hash || "—"],
              ["Status", o.status],
              ["Pushed", o.status === "EXPORTED_TO_TALLY" ? "yes" : "no"],
            ]} />
          </Card>
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
      </div>
    </div>
  );
};


export default WiredSOWorkspace;
