import React, { useEffect, useMemo, useState } from "react";
import { Btn, Card, Chip, fmtINR } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";
import {
  composePrice,
  pricingProfileFromRow,
  PROFILE_GRANULAR,
  PROFILE_COMPACT,
  DEFAULT_FX,
  type FxSnapshot,
  type PricingProfile,
} from "../lib/pricing";

// Cost-composition preview for a quote's lines.
//
// Runs the pricing engine (lib/pricing) live over each line so the
// operator sees the full supplier -> landed -> margin -> discount
// waterfall, the recommended price, and (critically) the realized
// margin implied by the CURRENTLY quoted price. Margin health is
// colour-coded against the profile's floor/target so discount-driven
// profit churn is visible before the quote is sent.
//
// This is a preview/what-if surface: supplier prices and FX live in
// local state (not persisted). Persistence + per-tenant profile config
// land in the schema phase.

type Line = any;

// In-code fallback used when the tenant has no configured profiles yet
// (or the API is unavailable), so the preview always works.
const FALLBACK_PROFILES: PricingProfile[] = [PROFILE_GRANULAR, PROFILE_COMPACT];

const currencyForCountry = (sc?: string): string => {
  const s = (sc || "").toUpperCase();
  if (s.includes("KOR")) return "USD"; // Obara prices Korean supply in USD
  if (s.includes("JPN") || s.includes("JAPAN")) return "JPY";
  if (s.includes("CHN") || s.includes("CHINA")) return "CNY";
  if (s.includes("IND")) return "INR";
  return "INR";
};

const pct = (n: number) => (n * 100).toFixed(1) + "%";

const marginTone = (realized: number, floor: number, target: number): "good" | "warn" | "bad" => {
  if (realized < floor) return "bad";
  if (target > 0 && realized < target - 1e-9) return "warn";
  return "good";
};

export const QuoteComposition: React.FC<{ lines: Line[]; currency?: string; quoteId?: string }> = ({ lines, quoteId }) => {
  const [profileCode, setProfileCode] = useState("granular");
  const [fx, setFx] = useState<FxSnapshot>({ ...DEFAULT_FX, rates: { ...DEFAULT_FX.rates } });
  // Supplier price + currency per line, keyed by line_index. Seeded with
  // a currency guess from source country, then overwritten by any saved
  // composition loaded for this quote.
  const [supplier, setSupplier] = useState<Record<number, { price: number; cur: string }>>({});
  const [selected, setSelected] = useState<number | null>(null);
  // Tenant-configured profiles from /api/admin/pricing_profiles; falls
  // back to the in-code defaults until a tenant configures its own.
  const [apiProfiles, setApiProfiles] = useState<PricingProfile[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp: any = await ObaraBackend?.admin?.listPricingProfiles?.();
        if (cancelled) return;
        const rows = Array.isArray(resp) ? resp : resp?.profiles || [];
        const mapped = rows.map((r: any) => pricingProfileFromRow(r)).filter((p: PricingProfile) => p.code && p.components.length);
        if (mapped.length) setApiProfiles(mapped);
      } catch { /* fall back to in-code defaults */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Restore any previously saved composition for this quote: seed
  // supplier inputs, the chosen profile and the FX snapshot.
  useEffect(() => {
    if (!quoteId) return;
    let cancelled = false;
    (async () => {
      try {
        const resp: any = await ObaraBackend?.admin?.listPriceComposition?.(quoteId);
        if (cancelled) return;
        const saved = Array.isArray(resp) ? resp : resp?.lines || [];
        if (!saved.length) return;
        const sup: Record<number, { price: number; cur: string }> = {};
        for (const r of saved) {
          if (r.line_index == null) continue;
          sup[r.line_index] = { price: Number(r.supplier_unit_price) || 0, cur: r.supplier_currency || "INR" };
        }
        setSupplier(sup);
        if (saved[0]?.profile_code) setProfileCode(saved[0].profile_code);
        if (saved[0]?.fx_snapshot && typeof saved[0].fx_snapshot === "object") {
          setFx({ ...DEFAULT_FX, ...saved[0].fx_snapshot, rates: { ...DEFAULT_FX.rates, ...(saved[0].fx_snapshot.rates || {}) } });
        }
      } catch { /* no saved composition yet */ }
    })();
    return () => { cancelled = true; };
  }, [quoteId]);

  const save = async () => {
    if (!quoteId) return;
    setSaving(true);
    setSavedMsg(null);
    try {
      const payloadLines = (lines || []).map((ln) => ({
        line_index: ln.line_index,
        part_no: ln.part_no || null,
        unit: ln.uom || null,
        qty: Number(ln.qty) || 0,
        source_country: ln.source_country || null,
        discount_pct: Number(ln.discount_pct) || 0,
        supplier_unit_price: Number((supplier[ln.line_index] || {}).price) || 0,
        supplier_currency: (supplier[ln.line_index] || {}).cur || currencyForCountry(ln.source_country),
      }));
      const resp: any = await ObaraBackend?.admin?.recomputePriceComposition?.({
        quote_id: quoteId,
        profile_code: profile.code,
        fx,
        lines: payloadLines,
      });
      const n = (resp?.lines || []).length;
      setSavedMsg(`Saved composition for ${n} line${n === 1 ? "" : "s"}.`);
      window.notifySuccess?.("Composition saved", `${n} line${n === 1 ? "" : "s"} priced`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      setSavedMsg(null);
      window.notifyError?.("Could not save composition", msg);
    } finally {
      setSaving(false);
    }
  };

  const profiles = apiProfiles && apiProfiles.length ? apiProfiles : FALLBACK_PROFILES;
  const profile = profiles.find((p) => p.code === profileCode) || profiles[0] || PROFILE_GRANULAR;

  const setFxRate = (cur: string, v: number) =>
    setFx((f) => ({ ...f, rates: { ...f.rates, [cur]: v } }));
  const setLoaded = (cur: string, v: number) =>
    setFx((f) => ({ ...f, multiplicationFactor: { ...(f.multiplicationFactor || {}), [cur]: v } }));
  const supFor = (ln: Line) =>
    supplier[ln.line_index] || { price: 0, cur: currencyForCountry(ln.source_country) };
  // Seed currency from the line's source country so the first price
  // edit converts at the right FX rate (not the INR default).
  const setSup = (ln: Line, patch: Partial<{ price: number; cur: string }>) =>
    setSupplier((s) => ({
      ...s,
      [ln.line_index]: { ...(s[ln.line_index] || { price: 0, cur: currencyForCountry(ln.source_country) }), ...patch },
    }));

  const rows = useMemo(() => {
    return (lines || []).map((ln) => {
      const sup = supplier[ln.line_index] || { price: 0, cur: currencyForCountry(ln.source_country) };
      const res = composePrice(
        profile,
        {
          qty: Number(ln.qty) || 0,
          supplierUnitPrice: Number(sup.price) || 0,
          supplierCurrency: sup.cur,
          sourceCountry: ln.source_country,
          discountPct: Number(ln.discount_pct) || 0,
        },
        fx
      );
      const listed = Number(ln.listed_unit_price) || 0;
      const disc = Number(ln.discount_pct) || 0;
      const net = listed * (1 - disc);
      const marginAtListed = net > 0 ? (net - res.perUnit.loadedCost) / net : 0;
      return { ln, sup, res, listed, net, marginAtListed };
    });
  }, [lines, supplier, profile, fx]);

  const totals = useMemo(() => {
    let loaded = 0;
    let engineSell = 0;
    let listedNet = 0;
    let belowFloor = 0;
    for (const r of rows) {
      const qty = Number(r.ln.qty) || 0;
      loaded += r.res.loadedTotal;
      engineSell += r.res.lineTotal;
      listedNet += r.net * qty;
      if (r.listed > 0 && r.marginAtListed < profile.marginFloorPct) belowFloor += 1;
    }
    const gp = listedNet > 0 ? (listedNet - loaded) / listedNet : 0;
    return { loaded, engineSell, listedNet, belowFloor, gp };
  }, [rows, profile]);

  const sel = selected != null ? rows.find((r) => r.ln.line_index === selected) : null;

  return (
    <>
      <div className="row" style={{ gap: 16, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Pricing profile</label>
          <select className="select" value={profileCode} onChange={(e) => setProfileCode(e.target.value)} aria-label="Pricing profile">
            {profiles.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
          </select>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {["USD", "CNY", "JPY"].map((c) => (
            <div key={c} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label className="mono-sm" style={{ color: "var(--ink-3)" }}>{c} spot</label>
              <input className="input mono r" type="number" step="0.01" style={{ width: 80 }}
                aria-label={c + " spot"}
                value={fx.rates[c] ?? ""} onChange={(e) => setFxRate(c, Number(e.target.value))} />
            </div>
          ))}
          {profileCode === "compact" && ["USD", "CNY", "JPY"].map((c) => (
            <div key={c + "L"} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label className="mono-sm" style={{ color: "var(--ink-3)" }}>{c} loaded</label>
              <input className="input mono r" type="number" step="0.01" style={{ width: 80 }}
                aria-label={c + " loaded"}
                value={fx.multiplicationFactor?.[c] ?? ""} onChange={(e) => setLoaded(c, Number(e.target.value))} />
            </div>
          ))}
        </div>
        <div className="row" style={{ gap: 8, marginLeft: "auto", alignItems: "center" }}>
          {savedMsg && <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{savedMsg}</span>}
          <Btn sm kind="primary" disabled={!quoteId || saving} onClick={save}
            title={quoteId ? "Recompute server-side and save this composition" : "Save the quote first"}>
            {saving ? "Saving..." : "Save composition"}
          </Btn>
        </div>
      </div>

      <Card flush>
        <table className="tbl" style={{ fontSize: 12 }}>
          <thead><tr>
            <th>#</th><th>Part</th><th className="r">Qty</th>
            <th className="r">Supplier</th><th>Cur</th>
            <th className="r">Loaded</th><th className="r">Recommended</th>
            <th className="r">Quoted (net)</th><th className="r">Margin @ quoted</th><th></th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={10} className="muted" style={{ padding: 18, textAlign: "center" }}>No lines to price yet.</td></tr>
            ) : rows.map(({ ln, sup, res, listed, net, marginAtListed }) => {
              const tone = listed > 0 ? marginTone(marginAtListed, profile.marginFloorPct, res.marginTarget) : "ghost";
              return (
                <tr key={ln.line_index} style={{ cursor: "pointer", background: selected === ln.line_index ? "var(--paper-2)" : undefined }}
                  onClick={() => setSelected(selected === ln.line_index ? null : ln.line_index)}>
                  <td className="mono">{(ln.line_index ?? 0) + 1}</td>
                  <td className="mono">{ln.part_no || "-"}</td>
                  <td className="r mono">{ln.qty ?? "-"}</td>
                  <td className="r"><input className="input mono r" style={{ width: 90 }} type="number" step="0.01"
                    aria-label={"supplier price line " + ((ln.line_index ?? 0) + 1)}
                    value={sup.price || ""} onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setSup(ln, { price: Number(e.target.value) })} /></td>
                  <td><input className="input mono" style={{ width: 56 }} maxLength={3}
                    aria-label={"supplier currency line " + ((ln.line_index ?? 0) + 1)}
                    value={sup.cur} onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setSup(ln, { cur: e.target.value.toUpperCase() })} /></td>
                  <td className="r mono">{res.perUnit.loadedCost ? fmtINR(res.perUnit.loadedCost) : "-"}</td>
                  <td className="r mono">{res.perUnit.finalPrice ? fmtINR(res.perUnit.finalPrice) : "-"}</td>
                  <td className="r mono">{listed ? fmtINR(net) : "-"}</td>
                  <td className="r"><Chip k={tone as any}>{listed > 0 ? pct(marginAtListed) : "-"}</Chip></td>
                  <td className="r">{res.warnings.length > 0 && <span title={res.warnings.map((w) => w.message).join("\n")}>{"⚠"}</span>}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ background: "var(--paper-2)" }}>
              <td colSpan={5} className="r mono"><b>Totals</b></td>
              <td className="r mono"><b>{fmtINR(totals.loaded)}</b></td>
              <td className="r mono"><b>{fmtINR(totals.engineSell)}</b></td>
              <td className="r mono"><b>{fmtINR(totals.listedNet)}</b></td>
              <td className="r"><Chip k={totals.gp < profile.marginFloorPct ? "bad" : "good"}>{pct(totals.gp)}</Chip></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </Card>

      {totals.belowFloor > 0 && (
        <div className="mono-sm" style={{ color: "var(--rust)", marginTop: 8 }}>
          {"⚠"} {totals.belowFloor} line{totals.belowFloor === 1 ? "" : "s"} priced below the {pct(profile.marginFloorPct)} margin floor.
        </div>
      )}

      {sel && (
        <Card title={`Waterfall - line ${(sel.ln.line_index ?? 0) + 1} ${sel.ln.part_no || ""}`}
          eyebrow="Supplier cost to final price" style={{ marginTop: 10 }}>
          <table className="tbl" style={{ fontSize: 12 }}>
            <thead><tr><th>Step</th><th>Kind</th><th className="r">Rate / amount</th><th className="r">+ / -</th><th className="r">Subtotal</th></tr></thead>
            <tbody>
              {sel.res.waterfall.map((s, i) => (
                <tr key={i}>
                  <td>{s.label}</td>
                  <td className="mono-sm" style={{ color: "var(--ink-3)" }}>{s.kind}</td>
                  <td className="r mono">{s.rate != null ? pct(s.rate) : s.amount != null ? fmtINR(s.amount) : "-"}</td>
                  <td className="r mono">{fmtINR(s.delta)}</td>
                  <td className="r mono"><b>{fmtINR(s.subtotal)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ gap: 18, marginTop: 8, flexWrap: "wrap" }}>
            <span className="mono-sm">Loaded cost: <b>{fmtINR(sel.res.perUnit.loadedCost)}</b></span>
            <span className="mono-sm">Recommended: <b>{fmtINR(sel.res.perUnit.finalPrice)}</b></span>
            <span className="mono-sm">Target margin: <b>{pct(sel.res.marginTarget)}</b></span>
            <span className="mono-sm">Realized (engine): <b>{pct(sel.res.marginRealized)}</b></span>
            <span className="mono-sm">Effective multiplier: <b>{sel.res.effectiveMultiplier.toFixed(1)}x</b></span>
          </div>
          {sel.res.warnings.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {sel.res.warnings.map((w, i) => (
                <div key={i} className="mono-sm" style={{ color: w.severity === "high" ? "var(--rust)" : "var(--amber)" }}>
                  {"⚠"} {w.message}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </>
  );
};

export default QuoteComposition;
