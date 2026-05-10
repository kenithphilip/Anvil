import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, stageOf, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { tallyOrderRows, shortHash } from "../lib/tally";
import { useTallyBridgeStatus } from "../lib/tally-status";

// ============================================================
// ANVIL v3 — wired Tally · reconciliation
// Wave D · Finance
// Lists EXPORTED_TO_TALLY orders, calls ObaraBackend.tally.reconcile.
// Reuses tallyOrderRows + shortHash from wired-tally-masters-d.jsx.
// ============================================================

const WiredTallyReconcile = () => {
  const exported = useFetch(() => ObaraBackend?.orders?.list?.({ status: "EXPORTED_TO_TALLY", limit: 200 }) || Promise.resolve({ orders: [] }), []);
  const findings = useFetch(() => (ObaraBackend as any)?.tally?.listReconFindings?.(50) || Promise.resolve({ findings: [] }), []);
  const reconRuns = useFetch(() => (ObaraBackend as any)?.tally?.listReconRuns?.(20) || Promise.resolve({ runs: [] }), []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash]   = useState<{ kind: string; msg: string } | null>(null);
  const [driftBusy, setDriftBusy] = useState(false);
  const bridge = useTallyBridgeStatus();

  const rows = tallyOrderRows(exported.data);

  const handleReconcile = async (order) => {
    setBusyId(order.id);
    setFlash(null);
    try {
      const tallyVoucherId =
        (order.result && order.result.tally && order.result.tally.voucherId) ||
        (order.result && order.result.tally_voucher_id) ||
        order.tally_voucher_id ||
        null;
      await ObaraBackend?.tally?.reconcile?.({
        orderId: order.id,
        status: "reconciled",
        tally_voucher_id: tallyVoucherId,
      });
      setFlash({ kind: "good", msg: `Reconciled ${order.po_number || order.id.slice(0, 8)}` });
      exported.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
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
      const out = await (ObaraBackend as any)?.tally?.driftCheck?.({
        scope: "tenant_recent",
        trigger: "manual",
      });
      setFlash({
        kind: out?.vouchers_drifted ? "warn" : "good",
        msg: `Reconciled ${out?.vouchers_considered || 0} voucher(s); ${out?.vouchers_drifted || 0} drift, ${out?.vouchers_clean || 0} clean, ${out?.auto_fixes_applied || 0} auto-fixed`,
      });
      await Promise.all([exported.reload(), findings.reload(), reconRuns.reload()]);
    } catch (err: any) {
      setFlash({ kind: "bad", msg: String(err?.message || err) });
    } finally { setDriftBusy(false); }
  };

  const resolveOne = async (id: string) => {
    try {
      await (ObaraBackend as any)?.tally?.resolveFinding?.(id);
      findings.reload();
    } catch (_e) { /* no-op */ }
  };

  return (
    <>
      <WSTitle
        eyebrow="Finance · Tally"
        title="Reconciliation"
        meta={`${rows.length} pushed · ${findingRows.length} unresolved drift`}
        right={<>
          <Btn sm kind="primary" disabled={driftBusy} onClick={runDriftCheck}>
            {driftBusy ? "Reconciling…" : "Run drift check"}
          </Btn>
          <Btn icon kind="ghost" sm onClick={() => { exported.reload(); findings.reload(); reconRuns.reload(); }} title="Refresh">{Icon.cycle}</Btn>
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
          <Banner kind={flash.kind} icon={flash.kind === "bad" ? Icon.alert : Icon.check} title={flash.kind === "bad" ? "Reconcile failed" : "Reconcile complete"}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
        )}

        {exported.error ? (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load Tally exports" action={<Btn sm onClick={exported.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(exported.error.message || exported.error)}</span>
          </Banner>
        ) : null}

        <KPIRow cols={4}>
          <KPI lbl="Awaiting" v={String(rows.length)} d={rows.length ? `oldest ${oldest}` : "all clear"} live={rows.length > 0} />
          <KPI lbl="Total ₹"  v={fmtINRShort(totalValue)} d="value pending" />
          <KPI lbl="Today"    v={String(rows.filter((o) => { const t = o.updated_at || o.created_at; return t && new Date(t).toDateString() === new Date().toDateString(); }).length)} d="pushed today" />
          <KPI lbl="Stale"    v={String(rows.filter((o) => {
            const t = o.updated_at || o.created_at;
            if (!t) return false;
            return (Date.now() - new Date(t).getTime()) > 24 * 3600_000;
          }).length)} d=">24h waiting" dKind="down" />
        </KPIRow>

        {/* Phase F.6: drift findings panel + run history */}
        {findingRows.length > 0 && (
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

        {runRows.length > 0 && (
          <Card title="Recent reconciliation runs" eyebrow="last 20" flush>
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
                {rows.map((o) => {
                  const st = stageOf(o.status);
                  const pushedAt = o.updated_at || o.created_at;
                  const voucher =
                    (o.result && o.result.tally && (o.result.tally.voucherId || o.result.tally.voucherNo)) ||
                    o.tally_voucher_id ||
                    "—";
                  const hash = o.payload_hash || (o.approval && o.approval.payloadHash) || null;
                  return (
                    <tr key={o.id}>
                      <td className="mono"><span className="pri">{o.po_number || o.quote_number || "draft"}</span></td>
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
      </div>
    </>
  );
};


export default WiredTallyReconcile;
