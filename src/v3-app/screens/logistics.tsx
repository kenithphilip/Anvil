import React, { useState } from "react";
import { ageLabel, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Logistics: freight consolidation + LCL/FCL bidding (P4)
//
// Aggregates pipeline-driven procurement plans into ocean container
// fills by origin lane + arrival week, then runs a carrier bid: record
// quotes, award one. Backend: /api/logistics/consolidations + freight_bids.
// ============================================================

type Consol = any;
type Bid = any;

const STATUS_CHIP = (s: string) => {
  const k = s === "awarded" ? "good" : s === "bidding" ? "warn" : s === "shipped" ? "info" : s === "cancelled" ? "ghost" : "info";
  return <Chip k={k as any}>{s || "open"}</Chip>;
};

const fmtContainers = (c: any) => {
  if (!c) return "—";
  const parts: string[] = [];
  if (c.fcl_40) parts.push(`${c.fcl_40}×40ft`);
  if (c.fcl_20) parts.push(`${c.fcl_20}×20ft`);
  if (c.lcl_cbm) parts.push(`LCL ${c.lcl_cbm}cbm`);
  return parts.length ? parts.join(" + ") : (c.recommended_mode || "—");
};

const num = (v: any) => (v == null || v === "" || Number.isNaN(Number(v)) ? "—" : Number(v).toLocaleString());

const LogisticsScreen = () => {
  const [bump, setBump] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [draft, setDraft] = useState<{ carrier: string; service: string; total_cost: string; currency: string; transit_days: string }>(
    { carrier: "", service: "FCL_40", total_cost: "", currency: "USD", transit_days: "" });

  const list = useFetch(async () => {
    const r: any = await ObaraBackend?.logistics?.listConsolidations?.();
    return r?.consolidations || [];
  }, [bump]);

  const bids = useFetch(async () => {
    if (!selected) return [];
    const r: any = await ObaraBackend?.logistics?.listBids?.(selected);
    return r?.bids || [];
  }, [selected, bump]);

  const reload = () => setBump((n) => n + 1);

  const build = async () => {
    setBusy(true); setActionError(null);
    try {
      const r: any = await ObaraBackend?.logistics?.buildConsolidations?.({});
      window.notifySuccess?.("Consolidations built", `${r?.built || 0} lane/week group${(r?.built || 0) === 1 ? "" : "s"} from procurement plans`);
      reload();
    } catch (e: any) { setActionError(e); } finally { setBusy(false); }
  };

  const addBid = async (consolidationId: string) => {
    if (!draft.carrier.trim()) { window.notifyError?.("Carrier required", "Enter a carrier/forwarder name."); return; }
    setBusy(true); setActionError(null);
    try {
      await ObaraBackend?.logistics?.addBid?.({
        consolidation_id: consolidationId,
        carrier: draft.carrier.trim(),
        service: draft.service || null,
        total_cost: draft.total_cost !== "" ? Number(draft.total_cost) : null,
        currency: draft.currency || "USD",
        transit_days: draft.transit_days !== "" ? Number(draft.transit_days) : null,
      });
      setDraft({ carrier: "", service: "FCL_40", total_cost: "", currency: "USD", transit_days: "" });
      window.notifySuccess?.("Quote recorded", draft.carrier);
      reload();
    } catch (e: any) { setActionError(e); } finally { setBusy(false); }
  };

  const award = async (id: string) => {
    setBusy(true); setActionError(null);
    try {
      await ObaraBackend?.logistics?.awardBid?.(id);
      window.notifySuccess?.("Bid awarded", "Consolidation marked awarded.");
      reload();
    } catch (e: any) { setActionError(e); } finally { setBusy(false); }
  };

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Procurement · Logistics" title="Freight Bidding" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading consolidations…</div></Card></div>
      </div>
    );
  }
  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Procurement · Logistics" title="Freight Bidding" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load consolidations"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const rows: Consol[] = (list.data as any) || [];
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const sel = selected ? rows.find((r) => r.id === selected) : null;

  return (
    <>
      <WSTitle
        eyebrow="Procurement · Logistics"
        title="Freight Bidding"
        meta={`${rows.length} consolidation${rows.length === 1 ? "" : "s"}`}
        right={<>
          <Btn icon kind="ghost" sm onClick={reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" disabled={busy} onClick={build}
               title="Aggregate procurement plans into origin/week consolidations">
            {busy ? "Building…" : "Build from plans"}
          </Btn>
        </>}
      />

      <div className="ws-content">
        {actionError && (
          <Banner kind="bad" icon={Icon.alert} title="Action failed">
            <span className="mono-sm">{String(actionError.message || actionError)}</span>
          </Banner>
        )}

        <KPIRow cols={3}>
          <KPI lbl="Open" v={String(count("open"))} d="awaiting bids" live={count("open") > 0} />
          <KPI lbl="Bidding" v={String(count("bidding"))} d="quotes in" />
          <KPI lbl="Awarded" v={String(count("awarded"))} d="carrier booked" dKind={count("awarded") ? "up" : ""} />
        </KPIRow>

        <Card flush>
          {rows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No consolidations yet. Click “Build from plans” to aggregate procurement plans into freight lanes.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Lane</th><th>Arrival week</th><th className="r">Weight (kg)</th>
                <th className="r">Volume (cbm)</th><th>Containers</th><th>Status</th><th></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ cursor: "pointer", background: selected === r.id ? "var(--paper-2)" : undefined }}
                      onClick={() => setSelected(selected === r.id ? null : r.id)}>
                    <td className="mono">{(r.origin || "?") + " → " + (r.destination || "?")}</td>
                    <td className="mono-sm">{r.window_week || "—"}</td>
                    <td className="r mono-sm">{num(r.weight_kg)}</td>
                    <td className="r mono-sm">{num(r.volume_cbm)}</td>
                    <td className="mono-sm">{fmtContainers(r.containers)}</td>
                    <td>{STATUS_CHIP(r.status)}</td>
                    <td className="r"><Btn sm kind="ghost">{selected === r.id ? "hide" : "bids"}</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {sel && (
          <Card
            title={`Bids — ${(sel.origin || "?")} → ${(sel.destination || "?")} · ${sel.window_week || ""}`}
            eyebrow={`${fmtContainers(sel.containers)} · ${num(sel.weight_kg)} kg`}
            style={{ marginTop: 10 }}
          >
            {bids.loading ? <div className="body">Loading bids…</div> : (
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead><tr>
                  <th>Carrier</th><th>Service</th><th className="r">Total</th><th className="r">Transit (d)</th><th>Status</th><th></th>
                </tr></thead>
                <tbody>
                  {((bids.data as Bid[]) || []).length === 0 ? (
                    <tr><td colSpan={6} className="muted" style={{ padding: 12, textAlign: "center" }}>No quotes yet.</td></tr>
                  ) : ((bids.data as Bid[]) || []).map((b) => (
                    <tr key={b.id}>
                      <td className="mono">{b.carrier}</td>
                      <td className="mono-sm">{b.service || "—"}</td>
                      <td className="r mono">{b.total_cost != null ? `${b.currency || ""} ${Number(b.total_cost).toLocaleString()}` : "—"}</td>
                      <td className="r mono-sm">{b.transit_days ?? "—"}</td>
                      <td>{STATUS_CHIP(b.status)}</td>
                      <td className="r">
                        {b.status === "pending" && (
                          <Btn sm kind="primary" disabled={busy} onClick={() => award(b.id)} title="Award this bid">award</Btn>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {sel.status !== "awarded" && (
              <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <input className="input" style={{ width: 160 }} placeholder="carrier / forwarder"
                  aria-label="bid carrier" value={draft.carrier} onChange={(e) => setDraft({ ...draft, carrier: e.target.value })} />
                <select className="select" aria-label="bid service" value={draft.service} onChange={(e) => setDraft({ ...draft, service: e.target.value })}>
                  <option value="FCL_40">FCL 40ft</option><option value="FCL_20">FCL 20ft</option>
                  <option value="LCL">LCL</option><option value="mixed">Mixed</option>
                </select>
                <input className="input mono r" style={{ width: 100 }} type="number" placeholder="total"
                  aria-label="bid total" value={draft.total_cost} onChange={(e) => setDraft({ ...draft, total_cost: e.target.value })} />
                <input className="input mono" style={{ width: 56 }} maxLength={3}
                  aria-label="bid currency" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} />
                <input className="input mono r" style={{ width: 90 }} type="number" placeholder="transit d"
                  aria-label="bid transit" value={draft.transit_days} onChange={(e) => setDraft({ ...draft, transit_days: e.target.value })} />
                <Btn sm kind="primary" disabled={busy} onClick={() => addBid(sel.id)}>+ Add quote</Btn>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
};

export default LogisticsScreen;
