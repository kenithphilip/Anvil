import React, { useEffect, useMemo, useState } from "react";
import { Btn, Card, Chip, fmtINR } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import {
  composePrice,
  applyOverrides,
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

// A drawing-derived raw-material row the operator edits per line.
type MatRow = {
  raw_material_part_no: string;
  material: string;       // grade / spec
  form: string;           // block | rod | sheet | ...
  dimensions: string;     // free text, stored as { note }
  consumption_per_unit: string;
  uom: string;
};

// In-code fallback used when the tenant has no configured profiles yet
// (or the API is unavailable), so the preview always works.
const FALLBACK_PROFILES: PricingProfile[] = [PROFILE_GRANULAR, PROFILE_COMPACT];
// Used when the admin currency list (Admin > Settings) is empty.
const DEFAULT_CURRENCIES = ["INR", "USD", "EUR", "CNY", "KRW", "JPY", "GBP"];

const currencyForCountry = (sc?: string): string => {
  const s = (sc || "").toUpperCase();
  if (s.includes("KOR")) return "USD"; // Korean supply is priced in USD
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
  const [supplier, setSupplier] = useState<Record<number, { price: number; cur: string; name: string }>>({});
  const [selected, setSelected] = useState<number | null>(null);
  // Tenant-configured profiles from /api/admin/pricing_profiles; falls
  // back to the in-code defaults until a tenant configures its own.
  const [apiProfiles, setApiProfiles] = useState<PricingProfile[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  // P2 recipe-authoring: drawing-derived raw-material breakup per line,
  // keyed by line_index. Saving syncs into bill_of_materials so the
  // demand planner's BOM explosion is fed from this RFQ work.
  const [materials, setMaterials] = useState<Record<number, MatRow[]>>({});
  const [matSaving, setMatSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp: any = await AnvilBackend?.admin?.listPricingProfiles?.();
        if (cancelled) return;
        const rows = Array.isArray(resp) ? resp : resp?.profiles || [];
        const mapped = rows.map((r: any) => pricingProfileFromRow(r)).filter((p: PricingProfile) => p.code && p.components.length);
        if (mapped.length) setApiProfiles(mapped);
      } catch { /* fall back to in-code defaults */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const [syncing, setSyncing] = useState(false);
  // Per-line overhead adjustments: { line_index: { component_code: value } }.
  const [overridesByLine, setOverridesByLine] = useState<Record<number, Record<string, number>>>({});
  const setOverride = (li: number, code: string, val: number | null) =>
    setOverridesByLine((m) => {
      const cur = { ...(m[li] || {}) };
      if (val == null || Number.isNaN(val)) delete cur[code]; else cur[code] = val;
      return { ...m, [li]: cur };
    });
  const resetOverrides = (li: number) =>
    setOverridesByLine((m) => { const next = { ...m }; delete next[li]; return next; });
  // Admin-defined dropdowns: currencies (Admin > Settings) + supplier names
  // (suppliers master + RFQ vendors). Currencies fall back to a default set
  // so the dropdown is never empty.
  const [currencyOptions, setCurrencyOptions] = useState<string[]>([]);
  const [supplierOptions, setSupplierOptions] = useState<string[]>([]);
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const qs: any = await AnvilBackend?.admin?.quoteSettings?.();
        if (!cancel) setCurrencyOptions(Array.isArray(qs?.quote_currencies) && qs.quote_currencies.length ? qs.quote_currencies : DEFAULT_CURRENCIES);
      } catch { if (!cancel) setCurrencyOptions(DEFAULT_CURRENCIES); }
      try {
        const [sup, ven]: any[] = await Promise.all([
          Promise.resolve((AnvilBackend as any)?.inventory?.suppliers?.list?.()).catch(() => null),
          Promise.resolve(AnvilBackend?.supplierRfq?.listVendors?.()).catch(() => null),
        ]);
        if (cancel) return;
        const names = new Set<string>();
        (Array.isArray(sup) ? sup : (sup?.suppliers || sup?.rows || [])).forEach((s: any) => s?.supplier_name && names.add(s.supplier_name));
        (Array.isArray(ven) ? ven : (ven?.vendors || [])).forEach((v: any) => v?.vendor_name && names.add(v.vendor_name));
        setSupplierOptions(Array.from(names).sort());
      } catch { /* suppliers optional */ }
    })();
    return () => { cancel = true; };
  }, []);

  // Restore the saved composition for this quote: seed supplier inputs, the
  // chosen profile and the FX snapshot. Reusable so the "Sync awarded vendors"
  // button can re-pull after re-deriving from RFQ awards.
  const loadSaved = React.useCallback(async () => {
    if (!quoteId) return;
    try {
      const resp: any = await AnvilBackend?.admin?.listPriceComposition?.(quoteId);
      const saved = Array.isArray(resp) ? resp : resp?.lines || [];
      if (!saved.length) return;
      const sup: Record<number, { price: number; cur: string; name: string }> = {};
      const ovr: Record<number, Record<string, number>> = {};
      for (const r of saved) {
        if (r.line_index == null) continue;
        sup[r.line_index] = {
          price: Number(r.supplier_unit_price) || 0,
          cur: r.supplier_currency || "INR",
          name: r.supplier_name || "",
        };
        if (r.overrides && typeof r.overrides === "object" && Object.keys(r.overrides).length) ovr[r.line_index] = r.overrides;
      }
      setSupplier(sup);
      setOverridesByLine(ovr);
      if (saved[0]?.profile_code) setProfileCode(saved[0].profile_code);
      if (saved[0]?.fx_snapshot && typeof saved[0].fx_snapshot === "object") {
        setFx({ ...DEFAULT_FX, ...saved[0].fx_snapshot, rates: { ...DEFAULT_FX.rates, ...(saved[0].fx_snapshot.rates || {}) } });
      }
    } catch { /* no saved composition yet */ }
  }, [quoteId]);

  useEffect(() => { loadSaved(); }, [loadSaved]);

  // Re-derive supplier mapping from this quote's awarded RFQ winners, then
  // re-pull the saved composition so the inputs reflect the awarded vendors.
  const syncAwarded = async () => {
    if (!quoteId) return;
    setSyncing(true);
    try {
      const r: any = await AnvilBackend?.supplierRfq?.syncComposition?.(quoteId);
      await loadSaved();
      if (!r || (r.rfqs ?? 0) === 0) {
        window.notifyWarn?.("No linked RFQ", "No RFQ is linked to this quote. Raise one from the Vendor RFQ tab.");
      } else if ((r.fed ?? 0) > 0) {
        window.notifySuccess?.("Synced awarded vendors", `${r.fed} line(s) mapped. Click Save composition to recompute landed cost + margin.`);
      } else {
        window.notifyWarn?.("Nothing to sync", "No awarded winners found on the linked RFQ(s) yet.");
      }
    } catch (e: any) {
      window.notifyError?.("Sync failed", e?.message || String(e));
    } finally { setSyncing(false); }
  };

  // Restore any saved raw-material breakup for this quote, grouped by
  // the composition line it belongs to.
  useEffect(() => {
    if (!quoteId) return;
    let cancelled = false;
    (async () => {
      try {
        const resp: any = await AnvilBackend?.admin?.listCompositionMaterials?.(quoteId);
        if (cancelled) return;
        const saved = Array.isArray(resp) ? resp : resp?.lines || [];
        const byLine: Record<number, MatRow[]> = {};
        for (const r of saved) {
          const li = r.composition_line_index;
          if (li == null) continue;
          (byLine[li] = byLine[li] || []).push({
            raw_material_part_no: r.raw_material_part_no || "",
            material: r.material || "",
            form: r.form || "",
            dimensions: (r.dimensions && r.dimensions.note) || "",
            consumption_per_unit: r.consumption_per_unit != null ? String(r.consumption_per_unit) : "",
            uom: r.uom || "kg",
          });
        }
        if (Object.keys(byLine).length) setMaterials(byLine);
      } catch { /* no saved recipe yet */ }
    })();
    return () => { cancelled = true; };
  }, [quoteId]);

  const matRows = (li: number) => materials[li] || [];
  const addMat = (li: number) =>
    setMaterials((m) => ({ ...m, [li]: [...(m[li] || []), { raw_material_part_no: "", material: "", form: "", dimensions: "", consumption_per_unit: "", uom: "kg" }] }));
  const updMat = (li: number, i: number, patch: Partial<MatRow>) =>
    setMaterials((m) => { const arr = [...(m[li] || [])]; arr[i] = { ...arr[i], ...patch }; return { ...m, [li]: arr }; });
  const rmMat = (li: number, i: number) =>
    setMaterials((m) => { const arr = [...(m[li] || [])]; arr.splice(i, 1); return { ...m, [li]: arr }; });

  const saveMaterials = async (ln: Line) => {
    if (!quoteId) return;
    const li = ln.line_index;
    const arr = (materials[li] || []).filter((r) => r.raw_material_part_no.trim());
    setMatSaving(true);
    try {
      const resp: any = await AnvilBackend?.admin?.saveCompositionMaterials?.({
        quote_id: quoteId,
        lines: arr.map((r, seq) => ({
          composition_line_index: li,
          seq,
          finished_part_no: ln.part_no || null,
          raw_material_part_no: r.raw_material_part_no.trim(),
          material: r.material || null,
          form: r.form || null,
          dimensions: r.dimensions ? { note: r.dimensions } : {},
          consumption_per_unit: r.consumption_per_unit !== "" ? Number(r.consumption_per_unit) : null,
          uom: r.uom || "kg",
        })),
      });
      const synced = resp?.bom_synced ?? 0;
      window.notifySuccess?.(
        "Materials saved",
        `${arr.length} material${arr.length === 1 ? "" : "s"}${ln.part_no ? ` → ${synced} BOM row${synced === 1 ? "" : "s"} synced` : ""}`,
      );
    } catch (e: any) {
      window.notifyError?.("Could not save materials", e?.message || String(e));
    } finally {
      setMatSaving(false);
    }
  };

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
        supplier_name: (supplier[ln.line_index] || {}).name || null,
        overrides: overridesByLine[ln.line_index] || {},
      }));
      const resp: any = await AnvilBackend?.admin?.recomputePriceComposition?.({
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
    supplier[ln.line_index] || { price: 0, cur: currencyForCountry(ln.source_country), name: "" };
  // Seed currency from the line's source country so the first price
  // edit converts at the right FX rate (not the INR default).
  const setSup = (ln: Line, patch: Partial<{ price: number; cur: string; name: string }>) =>
    setSupplier((s) => ({
      ...s,
      [ln.line_index]: { ...(s[ln.line_index] || { price: 0, cur: currencyForCountry(ln.source_country), name: "" }), ...patch },
    }));

  const rows = useMemo(() => {
    return (lines || []).map((ln) => {
      const sup = supplier[ln.line_index] || { price: 0, cur: currencyForCountry(ln.source_country), name: "" };
      const res = composePrice(
        applyOverrides(profile, overridesByLine[ln.line_index]),
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
  }, [lines, supplier, profile, fx, overridesByLine]);

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
      {/* Admin-defined dropdowns for the supplier name + currency cells. */}
      <datalist id="comp-suppliers">{supplierOptions.map((s) => <option key={s} value={s} />)}</datalist>
      <datalist id="comp-currencies">{currencyOptions.map((c) => <option key={c} value={c} />)}</datalist>
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
          <Btn sm kind="ghost" disabled={!quoteId || syncing} onClick={syncAwarded}
            title={quoteId ? "Pull the awarded vendor's price + quote reference from this quote's RFQ(s) into the lines below" : "Save the quote first"}>
            {syncing ? "Syncing..." : "Sync awarded vendors"}
          </Btn>
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
            <th>Supplier</th>
            <th className="r">Price</th><th>Cur</th>
            <th className="r">Loaded</th><th className="r">Recommended</th>
            <th className="r">Quoted (net)</th><th className="r">Margin @ quoted</th><th></th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={11} className="muted" style={{ padding: 18, textAlign: "center" }}>No lines to price yet.</td></tr>
            ) : rows.map(({ ln, sup, res, listed, net, marginAtListed }) => {
              const tone = listed > 0 ? marginTone(marginAtListed, profile.marginFloorPct, res.marginTarget) : "ghost";
              return (
                <tr key={ln.line_index} style={{ cursor: "pointer", background: selected === ln.line_index ? "var(--paper-2)" : undefined }}
                  onClick={() => setSelected(selected === ln.line_index ? null : ln.line_index)}>
                  <td className="mono">{(ln.line_index ?? 0) + 1}</td>
                  <td className="mono">{ln.part_no || "-"}</td>
                  <td className="r mono">{ln.qty ?? "-"}</td>
                  <td><input className="input" style={{ width: 160 }} list="comp-suppliers"
                    aria-label={"supplier name line " + ((ln.line_index ?? 0) + 1)}
                    placeholder="who quoted this?"
                    value={sup.name || ""} onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setSup(ln, { name: e.target.value })} /></td>
                  <td className="r"><input className="input mono r" style={{ width: 90 }} type="number" step="0.01"
                    aria-label={"supplier price line " + ((ln.line_index ?? 0) + 1)}
                    value={sup.price || ""} onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setSup(ln, { price: Number(e.target.value) })} /></td>
                  <td><input className="input mono" style={{ width: 64 }} list="comp-currencies"
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
              <td colSpan={6} className="r mono"><b>Totals</b></td>
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
      <>
        <Card title={`Waterfall - line ${(sel.ln.line_index ?? 0) + 1} ${sel.ln.part_no || ""}`}
          eyebrow="Adjust overhead rates/amounts for this line" style={{ marginTop: 10 }}
          right={Object.keys(overridesByLine[sel.ln.line_index] ?? {}).length
            ? <Btn sm kind="ghost" onClick={() => resetOverrides(sel.ln.line_index)}>Reset adjustments</Btn>
            : undefined}>
          <table className="tbl" style={{ fontSize: 12 }}>
            <thead><tr><th>Step</th><th>Kind</th><th className="r">Rate / amount</th><th className="r">+ / -</th><th className="r">Subtotal</th></tr></thead>
            <tbody>
              {sel.res.waterfall.map((s, i) => {
                const li = sel.ln.line_index;
                const adjusted = (overridesByLine[li] || {})[s.code] != null;
                const editable = s.kind === "pct_of" || s.kind === "margin_markup" || s.kind === "discount" || s.kind === "per_unit";
                return (
                <tr key={i} style={adjusted ? { background: "var(--paper-2)" } : undefined}>
                  <td>{s.label}{adjusted ? " *" : ""}</td>
                  <td className="mono-sm" style={{ color: "var(--ink-3)" }}>{s.kind}</td>
                  <td className="r mono">
                    {!editable ? (s.rate != null ? pct(s.rate) : s.amount != null ? fmtINR(s.amount) : "-")
                      : s.kind === "per_unit" ? (
                        <input className="input mono r" style={{ width: 80 }} type="number" step="0.01"
                          value={Number((s.amount ?? 0).toFixed(4))}
                          onChange={(e) => setOverride(li, s.code, e.target.value === "" ? null : Number(e.target.value))} />
                      ) : (
                        <span><input className="input mono r" style={{ width: 64 }} type="number" step="0.1"
                          value={Number((((s.rate ?? 0) * 100)).toFixed(4))}
                          onChange={(e) => setOverride(li, s.code, e.target.value === "" ? null : Number(e.target.value) / 100)} />%</span>
                      )}
                  </td>
                  <td className="r mono">{fmtINR(s.delta)}</td>
                  <td className="r mono"><b>{fmtINR(s.subtotal)}</b></td>
                </tr>
              ); })}
            </tbody>
          </table>
          <div className="mono-sm" style={{ color: "var(--ink-4)", marginTop: 6 }}>
            Edit a rate/amount to adjust this line's overheads; * marks adjusted steps. Click Save composition to persist + recompute.
          </div>
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

        <Card
          title={`Raw materials (BOM) - line ${(sel.ln.line_index ?? 0) + 1} ${sel.ln.part_no || ""}`}
          eyebrow="From the engineering drawing - saving syncs the bill of materials"
          style={{ marginTop: 10 }}
        >
          <table className="tbl" style={{ fontSize: 12 }}>
            <thead><tr>
              <th>Raw material part</th><th>Grade</th><th>Form</th>
              <th>Dimensions</th><th className="r">Consumption / unit</th><th>UOM</th><th></th>
            </tr></thead>
            <tbody>
              {matRows(sel.ln.line_index).length === 0 ? (
                <tr><td colSpan={7} className="muted" style={{ padding: 14, textAlign: "center" }}>
                  No materials yet. Add the raw material(s) this part consumes.
                </td></tr>
              ) : matRows(sel.ln.line_index).map((m, i) => (
                <tr key={i}>
                  <td><input className="input mono" style={{ width: 140 }} placeholder="e.g. STEEL-EN8"
                    aria-label={"raw material part " + (i + 1)}
                    value={m.raw_material_part_no} onChange={(e) => updMat(sel.ln.line_index, i, { raw_material_part_no: e.target.value })} /></td>
                  <td><input className="input" style={{ width: 80 }} placeholder="EN8"
                    aria-label={"grade " + (i + 1)}
                    value={m.material} onChange={(e) => updMat(sel.ln.line_index, i, { material: e.target.value })} /></td>
                  <td><input className="input" style={{ width: 80 }} placeholder="rod"
                    aria-label={"form " + (i + 1)}
                    value={m.form} onChange={(e) => updMat(sel.ln.line_index, i, { form: e.target.value })} /></td>
                  <td><input className="input" style={{ width: 120 }} placeholder="Ø40 x 200mm"
                    aria-label={"dimensions " + (i + 1)}
                    value={m.dimensions} onChange={(e) => updMat(sel.ln.line_index, i, { dimensions: e.target.value })} /></td>
                  <td className="r"><input className="input mono r" style={{ width: 90 }} type="number" step="0.0001"
                    aria-label={"consumption per unit " + (i + 1)}
                    value={m.consumption_per_unit} onChange={(e) => updMat(sel.ln.line_index, i, { consumption_per_unit: e.target.value })} /></td>
                  <td><input className="input mono" style={{ width: 52 }}
                    aria-label={"uom " + (i + 1)}
                    value={m.uom} onChange={(e) => updMat(sel.ln.line_index, i, { uom: e.target.value })} /></td>
                  <td><Btn sm kind="ghost" onClick={() => rmMat(sel.ln.line_index, i)} title="Remove">×</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ gap: 8, marginTop: 8, alignItems: "center" }}>
            <Btn sm kind="ghost" onClick={() => addMat(sel.ln.line_index)}>+ Add material</Btn>
            <Btn sm kind="primary" disabled={!quoteId || matSaving} onClick={() => saveMaterials(sel.ln)}
              title={quoteId ? "Save the recipe and sync the bill of materials" : "Save the quote first"}>
              {matSaving ? "Saving..." : "Save materials → BOM"}
            </Btn>
            {!sel.ln.part_no && (
              <span className="mono-sm" style={{ color: "var(--amber)" }}>
                Set a part number on this line to sync a reusable BOM recipe.
              </span>
            )}
          </div>
        </Card>
      </>
      )}
    </>
  );
};

export default QuoteComposition;
