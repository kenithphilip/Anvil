// TReDS operator dashboard. Bet 6.
//
// Shows active factoring offers, won/settled discounts, and the
// AA consent queue. Surfaces the tenant's current sandbox /
// production mode so it is obvious whether the rows on this
// page are from a real M1xchange flow or the local mock.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

const fmtInr = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1e7) return "Rs " + (v / 1e7).toFixed(2) + " cr";
  if (v >= 1e5) return "Rs " + (v / 1e5).toFixed(2) + " lakh";
  return "Rs " + Math.round(v).toLocaleString("en-IN");
};

const fmtPct = (bps: number | null | undefined) =>
  (bps == null || !Number.isFinite(Number(bps))) ? "—" : (Number(bps) / 100).toFixed(2) + "% p.a.";

const TredsScreen: React.FC = () => {
  const [tab, setTab] = useState("active");
  const [list, setList] = useState<{ data: any; loading: boolean; error: any }>({ data: null, loading: true, error: null });
  const [consents, setConsents] = useState<{ data: any[]; loading: boolean }>({ data: [], loading: true });
  const [bump, setBump] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      Promise.resolve((AnvilBackend as any)?.treds?.list?.()),
      Promise.resolve((AnvilBackend as any)?.aa?.list?.()),
    ]).then(([t, c]) => {
      if (cancelled) return;
      setList({
        data: t.status === "fulfilled" ? t.value : null,
        loading: false,
        error: t.status === "rejected" ? t.reason : null,
      });
      setConsents({
        data: c.status === "fulfilled" ? (c.value?.consents || []) : [],
        loading: false,
      });
    });
    return () => { cancelled = true; };
  }, [bump]);

  const refresh = async (id: string) => {
    setBusyId(id);
    try {
      await (AnvilBackend as any)?.treds?.refreshOffer?.(id);
      (window as any).notifySuccess?.("Refreshed", "Auction state pulled from upstream.");
      setBump((n) => n + 1);
    } catch (err: any) {
      (window as any).notifyError?.("Refresh failed", err?.message || String(err));
    } finally {
      setBusyId(null);
    }
  };

  const accept = async (offerId: string) => {
    setBusyId(offerId);
    try {
      const r = await (AnvilBackend as any)?.treds?.acceptOffer?.(offerId);
      (window as any).notifySuccess?.(
        "Bid accepted",
        "Disbursement T+1 of " + fmtInr(r?.discount?.net_to_supplier_inr) + " (UTR " + (r?.discount?.utr || "-") + ")",
      );
      setBump((n) => n + 1);
    } catch (err: any) {
      (window as any).notifyError?.("Accept failed", err?.message || String(err));
    } finally {
      setBusyId(null);
    }
  };

  const refreshBuyers = async () => {
    setBusyId("buyers");
    try {
      const r = await (AnvilBackend as any)?.treds?.refreshEligibleBuyers?.();
      (window as any).notifySuccess?.("Buyers refreshed", (r?.count || 0) + " active buyers (" + (r?.mode || "?") + " mode)");
      setBump((n) => n + 1);
    } catch (err: any) {
      (window as any).notifyError?.("Refresh failed", err?.message || String(err));
    } finally {
      setBusyId(null);
    }
  };

  const kpis = useMemo(() => list.data?.kpis || null, [list.data]);
  const liveOffers = list.data?.offers_live || [];
  const wonOffers = list.data?.offers_won || [];
  const otherOffers = list.data?.offers_other || [];
  const discounts = list.data?.discounts || [];
  const hasSandbox = (kpis?.sandbox_offers_count || 0) > 0;

  if (list.loading) {
    return (
      <>
        <WSTitle eyebrow="Finance" title="TReDS" meta="loading" />
        <div className="ws-content">
          <Card><div className="body">Loading TReDS dashboard…</div></Card>
        </div>
      </>
    );
  }

  return (
    <>
      <WSTitle eyebrow="Finance" title="TReDS Receivables" meta="invoice factoring + AA" />
      <div className="ws-content">
        {hasSandbox && (
          <Banner kind="info" icon={Icon.info} title="TReDS is running in sandbox mode">
            <span className="mono-sm">
              The auctions on this page are mocked through the local M1xchange shim. Production
              activation needs the M1xchange channel-partner agreement + member ID + API key. The
              Setu AA gateway has the same shape: prod activation needs the FIU partnership +
              Sahamati certification. Read more in
              <span className="mono"> docs/STRATEGIC_BET_06_aa_treds_receivables.md</span>.
            </span>
          </Banner>
        )}
        {kpis && (
          <KPIRow>
            <KPI lbl="Live offers" v={String(liveOffers.length)} d="auction in progress" />
            <KPI lbl="Won offers" v={String(wonOffers.length)} d="ready to accept" />
            <KPI lbl="Discounted volume" v={fmtInr(kpis.total_discounted_inr)} d={kpis.discounts_count + " invoices"} />
            <KPI lbl="Mean rate" v={fmtPct(kpis.mean_rate_bps)} d="across discounts" />
          </KPIRow>
        )}
        <WSTabs
          tabs={[
            { id: "active", label: "Active offers", count: liveOffers.length },
            { id: "won", label: "Won / disbursed", count: wonOffers.length + discounts.length },
            { id: "other", label: "Withdrawn / expired", count: otherOffers.length },
            { id: "aa", label: "AA consents", count: consents.data.length },
          ]}
          active={tab}
          onChange={setTab}
        />
        <div className="row gap-sm" style={{ marginBottom: 8 }}>
          <Btn sm kind="ghost" disabled={busyId === "buyers"} onClick={refreshBuyers}>
            {busyId === "buyers" ? "Refreshing…" : "Refresh eligible buyers cache"}
          </Btn>
        </div>

        {tab === "active" && (
          <Card flush>
            {liveOffers.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No live offers. Submit an invoice for TReDS factoring from the Invoices screen.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Invoice</th>
                  <th>Platform</th>
                  <th className="r">Amount</th>
                  <th>Buyer GSTIN</th>
                  <th>Auction status</th>
                  <th className="r">Best rate</th>
                  <th>Actions</th>
                </tr></thead>
                <tbody>
                  {liveOffers.map((o: any) => (
                    <tr key={o.id}>
                      <td className="mono-sm">
                        <a className="link" href={"#/invoices?id=" + encodeURIComponent(o.invoice_id)}>
                          {o.invoice_id.slice(0, 8)}…
                        </a>
                      </td>
                      <td className="mono-sm">
                        <Chip k={o.is_sandbox ? "info" : "good"}>{o.treds_platform}</Chip>
                      </td>
                      <td className="r mono">{fmtInr(o.amount_inr)}</td>
                      <td className="mono-sm">{o.buyer_gstin}</td>
                      <td><Chip k={o.auction_status === "live" ? "good" : "info"}>{o.auction_status}</Chip></td>
                      <td className="r mono">{fmtPct(o.best_rate_bps)}</td>
                      <td>
                        <div className="row gap-sm">
                          <Btn sm kind="ghost" disabled={busyId === o.id} onClick={() => refresh(o.id)}>
                            {busyId === o.id ? "…" : "Refresh"}
                          </Btn>
                          {(o.auction_status === "live" || o.auction_status === "won") && (
                            <Btn sm kind="primary" disabled={busyId === o.id} onClick={() => accept(o.id)}>
                              Accept best bid
                            </Btn>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {tab === "won" && (
          <Card flush>
            {discounts.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No discounts yet. Once you accept a winning bid, the financier disburses T+1 and the row appears here.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Invoice</th>
                  <th>Financier</th>
                  <th className="r">Rate</th>
                  <th className="r">Gross</th>
                  <th className="r">Net to supplier</th>
                  <th>UTR</th>
                  <th>Settlement</th>
                  <th>Status</th>
                </tr></thead>
                <tbody>
                  {discounts.map((d: any) => (
                    <tr key={d.id}>
                      <td className="mono-sm">
                        <a className="link" href={"#/invoices?id=" + encodeURIComponent(d.invoice_id)}>
                          {d.invoice_id.slice(0, 8)}…
                        </a>
                      </td>
                      <td className="mono-sm">{d.financier_name}</td>
                      <td className="r mono">{fmtPct(d.rate_bps)}</td>
                      <td className="r mono">{fmtInr(d.amount_inr)}</td>
                      <td className="r mono">{fmtInr(d.net_to_supplier_inr)}</td>
                      <td className="mono-sm">{d.utr || "—"}</td>
                      <td className="mono-sm">
                        {d.settlement_at ? new Date(d.settlement_at).toLocaleDateString("en-IN") : "—"}
                      </td>
                      <td><Chip k={d.status === "settled" ? "good" : d.status === "disbursed" ? "info" : "warn"}>{d.status}</Chip></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {tab === "other" && (
          <Card flush>
            {otherOffers.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No withdrawn / expired / no-bid offers in the last 200 rows.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Invoice</th>
                  <th>Status</th>
                  <th className="r">Amount</th>
                  <th>Updated</th>
                </tr></thead>
                <tbody>
                  {otherOffers.map((o: any) => (
                    <tr key={o.id}>
                      <td className="mono-sm">{o.invoice_id.slice(0, 8)}…</td>
                      <td><Chip k="warn">{o.auction_status}</Chip></td>
                      <td className="r mono">{fmtInr(o.amount_inr)}</td>
                      <td className="mono-sm">{new Date(o.updated_at).toLocaleString("en-IN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {tab === "aa" && (
          <Card flush>
            {consents.data.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No Account Aggregator consents requested yet. AA consents are auto-issued from
                the TReDS offer flow when the financier needs bank-statement data.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Invoice</th>
                  <th>Status</th>
                  <th>Granted</th>
                  <th>Expires</th>
                  <th>Mode</th>
                </tr></thead>
                <tbody>
                  {consents.data.map((c: any) => (
                    <tr key={c.id}>
                      <td className="mono-sm">{c.invoice_id?.slice(0, 8)}…</td>
                      <td>
                        <Chip k={(c.status === "active" || c.status === "sandbox_active") ? "good"
                              : c.status === "pending" ? "warn"
                              : "info"}>
                          {c.status}
                        </Chip>
                      </td>
                      <td className="mono-sm">
                        {c.granted_at ? new Date(c.granted_at).toLocaleString("en-IN") : "—"}
                      </td>
                      <td className="mono-sm">
                        {c.expires_at ? new Date(c.expires_at).toLocaleDateString("en-IN") : "—"}
                      </td>
                      <td><Chip k={c.is_sandbox ? "info" : "good"}>{c.is_sandbox ? "sandbox" : "prod"}</Chip></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </div>
    </>
  );
};

export default TredsScreen;
