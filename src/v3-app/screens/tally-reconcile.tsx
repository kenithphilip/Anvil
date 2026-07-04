import React, { useEffect, useState } from "react";
import { ageLabel, draftLabel, fmtINRShort, stageOf, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { tallyOrderRows, shortHash } from "../lib/tally";
import { useTallyBridgeStatus } from "../lib/tally-status";

// ============================================================
// ANVIL v3 - wired Tally · reconciliation
// Wave D · Finance
// Lists EXPORTED_TO_TALLY orders, calls AnvilBackend.tally.reconcile.
// Reuses tallyOrderRows + shortHash from wired-tally-masters-d.jsx.
// ============================================================
//
// Bet 5 (May 2026): drift reconciliation is a paid SKU. The screen
// fetches addon state via getReconState() and gates the drift-check
// button + findings cards behind the flag. When off, an upsell card
// renders. When the operator enables for the first time, the dialog
// surfaces the synchronous 30-day first-run scan results.

const WiredTallyReconcile = () => {
  const exported = useFetch(() => AnvilBackend?.orders?.list?.({ status: "EXPORTED_TO_TALLY", limit: 200 }) || Promise.resolve({ orders: [] }), []);
  const findings = useFetch(() => (AnvilBackend as any)?.tally?.listReconFindings?.(50) || Promise.resolve({ findings: [] }), []);
  const reconRuns = useFetch(() => (AnvilBackend as any)?.tally?.listReconRuns?.(20) || Promise.resolve({ runs: [] }), []);
  const reconState = useFetch(() => (AnvilBackend as any)?.tally?.getReconState?.() || Promise.resolve({ addon_enabled: false }), []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash]   = useState<{ kind: string; msg: string } | null>(null);
  const [driftBusy, setDriftBusy] = useState(false);
  const [enableBusy, setEnableBusy] = useState(false);
  const [firstRunSummary, setFirstRunSummary] = useState<any | null>(null);
  const bridge = useTallyBridgeStatus();

  const addonEnabled = !!(reconState.data as any)?.addon_enabled;
  const addonStartedAt = (reconState.data as any)?.addon_started_at || null;
  const addonPlan = (reconState.data as any)?.addon_billing_plan || null;

  const rows = tallyOrderRows(exported.data);

  const handleReconcile = async (order: any) => {
    setBusyId(order.id);
    setFlash(null);
    try {
      const tallyVoucherId =
        (order.result && order.result.tally && order.result.tally.voucherId) ||
        (order.result && order.result.tally_voucher_id) ||
        order.tally_voucher_id ||
        null;
      await AnvilBackend?.tally?.reconcile?.({
        orderId: order.id,
        status: "reconciled",
        tally_voucher_id: tallyVoucherId,
      });
      setFlash({ kind: "good", msg: `Reconciled ${order.po_number || order.id.slice(0, 8)}` });
      exported.reload();
    } catch (err: any) {
      setFlash({ kind: "bad", msg: String(err?.message || err) });
    } finally {
      setBusyId(null);
    }
  };

  const totalValue = rows.reduce((s: number, o: any) => s + (Number(o.result?.salesOrder?.grandTotal) || 0), 0);
  const oldest = rows.length ? ageLabel(rows[rows.length - 1].updated_at || rows[rows.length - 1].created_at) : "—";

  const findingRows: any[] = (findings.data as any)?.findings || [];
  const runRows: any[] = (reconRuns.data as any)?.runs || [];

  const runDriftCheck = async () => {
    setDriftBusy(true); setFlash(null);
    try {
      const out = await (AnvilBackend as any)?.tally?.driftCheck?.({
        scope: "tenant_recent",
        trigger: "manual",
      });
      setFlash({
        kind: out?.vouchers_drifted ? "warn" : "good",
        msg: `Reconciled ${out?.vouchers_considered || 0} voucher(s); ${out?.vouchers_drifted || 0} drift, ${out?.vouchers_clean || 0} clean, ${out?.auto_fixes_applied || 0} auto-fixed`,
      });
      await Promise.all([exported.reload(), findings.reload(), reconRuns.reload()]);
    } catch (err: any) {
      // Bet 5: 402 Payment Required when the addon is off. Reload
      // recon state so the upsell card renders if the flag flipped.
      if (err?.status === 402 || /addon_required/i.test(String(err?.message || ""))) {
        reconState.reload();
        setFlash({ kind: "warn", msg: "Drift reconciliation is a paid add-on. Enable below." });
      } else {
        setFlash({ kind: "bad", msg: String(err?.message || err) });
      }
    } finally { setDriftBusy(false); }
  };

  const enableAddon = async (plan: string) => {
    setEnableBusy(true); setFlash(null);
    try {
      const out = await (AnvilBackend as any)?.tally?.enableDriftAddon?.(plan);
      const fr = out?.first_run;
      if (fr) {
        setFirstRunSummary(fr);
      }
      setFlash({
        kind: "good",
        msg: fr
          ? `Drift reconciliation enabled. First-run scan: ${fr.vouchers_considered || 0} voucher(s); ${fr.vouchers_drifted || 0} drift, ${fr.vouchers_clean || 0} clean.`
          : "Drift reconciliation enabled.",
      });
      await Promise.all([reconState.reload(), findings.reload(), reconRuns.reload()]);
    } catch (err: any) {
      setFlash({ kind: "bad", msg: String(err?.message || err) });
    } finally { setEnableBusy(false); }
  };

  const resolveOne = async (id: string) => {
    try {
      await (AnvilBackend as any)?.tally?.resolveFinding?.(id);
      findings.reload();
    } catch (_e) { /* no-op */ }
  };

  return (
    <>
      <WSTitle
        eyebrow="Finance · Tally"
        title="Reconciliation"
        meta={`${rows.length} pushed · ${addonEnabled ? findingRows.length + " unresolved drift" : "drift add-on off"}`}
        right={<>
          {addonEnabled ? (
            <Btn sm kind="primary" disabled={driftBusy} onClick={runDriftCheck}>
              {driftBusy ? "Reconciling…" : "Run drift check"}
            </Btn>
          ) : (
            <Btn sm kind="primary" disabled={enableBusy} onClick={() => enableAddon("trial")}>
              {enableBusy ? "Enabling…" : "Enable drift reconciliation"}
            </Btn>
          )}
          <Btn icon kind="ghost" sm onClick={() => { exported.reload(); findings.reload(); reconRuns.reload(); reconState.reload(); }} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />

      <div className="ws-content">
        {!bridge.loading && !bridge.configured && (
          <Banner kind="warn" icon={Icon.alert} title="Tally bridge not configured">
            <span className="mono-sm">
              Reconciliation works without the bridge: it updates our records of what is in
              Tally based on what you mark here. To push fresh exports, set
              <code> TALLY_BRIDGE_URL</code> and <code>TALLY_BRIDGE_TOKEN</code> in Vercel env.
            </span>
          </Banner>
        )}
        {flash && (
          <Banner kind={flash.kind as any} icon={flash.kind === "bad" ? Icon.alert : Icon.check} title={flash.kind === "bad" ? "Reconcile failed" : flash.kind === "warn" ? "Heads up" : "Reconcile complete"}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
        )}

        {/* Bet 5: when the add-on is OFF, render the upsell card.
            Findings + runs cards are hidden because they would all be
            empty for a tenant that has never run drift reconciliation
            and would just confuse the operator. */}
        {!reconState.loading && !addonEnabled && (
          <Card title="Drift reconciliation" eyebrow="paid add-on · Phase F.6">
            <div className="body" style={{ padding: 14 }}>
              <p style={{ marginTop: 0 }}>
                <strong>Find drift before your auditor does.</strong>{" "}
                Every voucher we push to Tally, we check 30 minutes later, and 30 minutes after that.
                Totals, line counts, GSTIN, cancelled status. If anything moved, you know. With receipts.
              </p>
              <ul className="mono-sm" style={{ marginBottom: 12, paddingLeft: 18 }}>
                <li>Catches vouchers that were cancelled or altered after Anvil pushed them.</li>
                <li>Flags total mismatches above your tolerance (default 0.5%).</li>
                <li>Auto-fixes the safe cases (cancelled in Tally -&gt; mark order failed, missing -&gt; re-push).</li>
                <li>Monthly drift report you can forward to your auditor.</li>
              </ul>
              <div className="row gap-sm">
                <Btn sm kind="primary" disabled={enableBusy} onClick={() => enableAddon("trial")}>
                  {enableBusy ? "Enabling…" : "Start free trial"}
                </Btn>
                <Btn sm kind="ghost" onClick={() => { window.location.hash = "#/admin?tab=subscription&addon=drift"; }}>
                  See pricing
                </Btn>
              </div>
              <div className="mono-sm" style={{ marginTop: 8, color: "var(--ink-3)" }}>
                Free for Growth-tier tenants through 2026-12-31. Rs 2,000/mo for Starter. Bundled at Enterprise.
              </div>
            </div>
          </Card>
        )}

        {firstRunSummary && (
          <Banner kind={firstRunSummary.vouchers_drifted ? "warn" : "good"} icon={Icon.check} title="First-run drift scan complete">
            <span className="mono-sm">
              We scanned the last 30 days of pushed vouchers.{" "}
              {firstRunSummary.vouchers_considered || 0} considered,{" "}
              {firstRunSummary.vouchers_drifted || 0} drift,{" "}
              {firstRunSummary.vouchers_clean || 0} clean.
              {firstRunSummary.vouchers_drifted ? " Walk through the findings below." : " You are all clear."}
            </span>
          </Banner>
        )}

        {exported.error ? (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load Tally exports" action={<Btn sm onClick={exported.reload}>Retry</Btn>}>
            <span className="mono-sm">{String((exported.error as any).message || exported.error)}</span>
          </Banner>
        ) : null}

        <KPIRow cols={4}>
          <KPI lbl="Awaiting" v={String(rows.length)} d={rows.length ? `oldest ${oldest}` : "all clear"} live={rows.length > 0} />
          <KPI lbl="Total ₹"  v={fmtINRShort(totalValue)} d="value pending" />
          <KPI lbl="Today"    v={String(rows.filter((o: any) => { const t = o.updated_at || o.created_at; return t && new Date(t).toDateString() === new Date().toDateString(); }).length)} d="pushed today" />
          <KPI lbl="Stale"    v={String(rows.filter((o: any) => {
            const t = o.updated_at || o.created_at;
            if (!t) return false;
            return (Date.now() - new Date(t).getTime()) > 24 * 3600_000;
          }).length)} d=">24h waiting" dKind="down" />
        </KPIRow>

        {/* Phase F.6 + Bet 5: drift findings panel + run history.
            Hidden when the add-on is off; the upsell card above
            covers the empty state. */}
        {addonEnabled && findingRows.length > 0 && (
          <Card title="Drift findings" eyebrow={`${findingRows.length} unresolved`} flush>
            <table className="tbl">
              <thead><tr>
                <th>When</th>
                <th>Voucher</th>
                <th>Kind</th>
                <th>Severity</th>
                <th className="r">Diff %</th>
                <th>Auto-fix</th>
                <th></th>
              </tr></thead>
              <tbody>
                {findingRows.map((f: any) => (
                  <tr key={f.id}>
                    <td className="mono-sm">{f.created_at ? new Date(f.created_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                    <td className="mono-sm">{f.voucher_no || "—"}</td>
                    <td className="mono-sm">{f.finding_kind}</td>
                    <td><Chip k={f.severity === "critical" || f.severity === "error" ? "bad" : f.severity === "warn" ? "warn" : "info"}>{f.severity}</Chip></td>
                    <td className="r mono">{f.diff_pct != null ? Number(f.diff_pct).toFixed(2) + "%" : "—"}</td>
                    <td className="mono-sm">{f.auto_fix_applied || "—"}</td>
                    <td><Btn sm kind="ghost" onClick={() => resolveOne(f.id)}>Resolve</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {addonEnabled && runRows.length > 0 && (
          <Card title="Recent reconciliation runs" eyebrow={addonPlan ? `last 20 · plan: ${addonPlan}` : "last 20"} flush>
            <table className="tbl">
              <thead><tr>
                <th>Started</th>
                <th>Trigger</th>
                <th>Scope</th>
                <th className="r">Considered</th>
                <th className="r">Drifted</th>
                <th className="r">Clean</th>
                <th className="r">Auto-fixed</th>
                <th>Status</th>
                <th className="r">Latency</th>
              </tr></thead>
              <tbody>
                {runRows.map((r: any) => (
                  <tr key={r.id}>
                    <td className="mono-sm">{r.started_at ? new Date(r.started_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                    <td className="mono-sm">{r.trigger}</td>
                    <td className="mono-sm">{r.scope}{r.scope_value ? ":" + String(r.scope_value).slice(0, 8) : ""}</td>
                    <td className="r mono">{r.vouchers_considered}</td>
                    <td className="r mono">{r.vouchers_drifted}</td>
                    <td className="r mono">{r.vouchers_clean}</td>
                    <td className="r mono">{r.auto_fixes_applied}</td>
                    <td><Chip k={r.status === "ok" ? "good" : r.status === "partial_failure" ? "warn" : "bad"}>{r.status}</Chip></td>
                    <td className="r mono">{r.latency_ms != null ? r.latency_ms + "ms" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        <Card title="Pushed · awaiting Tally confirmation" eyebrow="mark reconciled when the voucher is confirmed in Tally" flush>
          {exported.loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading exports…</div>
          ) : rows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Nothing waiting for reconciliation.</div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th scope="col">Reference</th>
                <th scope="col">Customer</th>
                <th scope="col">Pushed at</th>
                <th scope="col">Voucher number</th>
                <th scope="col">Payload hash</th>
                <th scope="col">Status</th>
                <th scope="col" style={{ width: 160 }}></th>
              </tr></thead>
              <tbody>
                {rows.map((o: any) => {
                  const st = stageOf(o.status);
                  const pushedAt = o.updated_at || o.created_at;
                  const voucher =
                    (o.result && o.result.tally && (o.result.tally.voucherId || o.result.tally.voucherNo)) ||
                    o.tally_voucher_id ||
                    "—";
                  const hash = o.payload_hash || (o.approval && o.approval.payloadHash) || null;
                  return (
                    <tr key={o.id}>
                      <td className="mono"><span className="pri">{draftLabel(o)}</span></td>
                      <td>{o.customer?.customer_name || o.customer_id?.slice(0, 8) || "—"}</td>
                      <td className="mono-sm">{pushedAt ? new Date(pushedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                      <td className="mono-sm">{voucher}</td>
                      <td className="mono-sm">{shortHash(hash)}</td>
                      <td><Chip k={st.k}>{st.label}</Chip></td>
                      <td>
                        <Btn sm kind="primary" disabled={busyId === o.id} onClick={() => handleReconcile(o)}>
                          {busyId === o.id ? "marking…" : <>mark reconciled {Icon.check}</>}
                        </Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {addonEnabled && addonStartedAt && (
          <div className="mono-sm" style={{ marginTop: 14, color: "var(--ink-3)" }}>
            Drift add-on active since {new Date(addonStartedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}.
            {" "}
            <button
              type="button"
              className="link-btn"
              style={{ color: "var(--ink-3)", textDecoration: "underline" }}
              onClick={async () => {
                if (!window.confirm("Disable drift reconciliation? Findings + runs are preserved.")) return;
                try {
                  await (AnvilBackend as any)?.tally?.disableDriftAddon?.();
                  reconState.reload();
                } catch (_e) { /* no-op */ }
              }}
            >
              Manage subscription
            </button>
          </div>
        )}
      </div>
    </>
  );
};


export default WiredTallyReconcile;
