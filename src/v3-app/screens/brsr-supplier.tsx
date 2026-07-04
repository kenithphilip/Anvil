// BRSR supplier-side disclosure form. Bet 7.
//
// 12-section single-screen form. The tenant fills out the BRSR Core
// Annexure I attributes once per FY; the server recomputes Scope 1
// and Scope 2 from typed-in volumes against india_emission_factors
// so the chart of emissions is always provenance-traceable.
//
// Sections (Energy, Water, Waste, People, Inclusion, Openness,
// Compliance) all collapse to single-column at <768px. Auto-save
// every 30 s; explicit submit on the period locks it.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

type Disclosure = Record<string, any>;

const fmt = (n: number | null | undefined, d = 2) =>
  (n == null || !Number.isFinite(Number(n))) ? "—" : Number(n).toFixed(d);

const currentFy = (() => {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return "FY" + y + "-" + String((y + 1) % 100).padStart(2, "0");
})();

const prevFy = (fy: string) => {
  const m = fy.match(/^FY(\d{4})-(\d{2})$/);
  if (!m) return null;
  const a = parseInt(m[1], 10) - 1;
  const b = parseInt(m[2], 10) - 1;
  return "FY" + a + "-" + String(b).padStart(2, "0");
};

const NumberInput: React.FC<{
  label: string;
  field: string;
  value: any;
  onChange: (f: string, v: any) => void;
  unit?: string;
  disabled?: boolean;
  hint?: string;
}> = ({ label, field, value, onChange, unit, disabled, hint }) => (
  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
      {label}{unit ? <> &nbsp;<span className="mono-sm" style={{ color: "var(--ink-3)" }}>({unit})</span></> : null}
    </span>
    <input
      type="number"
      step="any"
      className="mono"
      disabled={disabled}
      value={value == null || value === "" ? "" : String(value)}
      onChange={(e) => onChange(field, e.target.value === "" ? null : Number(e.target.value))}
      style={{ padding: "6px 8px", border: "1px solid var(--hairline-2)", background: "transparent", color: "inherit", borderRadius: 4 }}
    />
    {hint && <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{hint}</span>}
  </label>
);

const BrsrSupplierScreen: React.FC = () => {
  const [fy, setFy] = useState(currentFy);
  const [periodId, setPeriodId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("open");
  const [disclosure, setDisclosure] = useState<Disclosure>({});
  const [computed, setComputed] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [attestation, setAttestation] = useState({ text: "", role: "" });
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  // Load (or create) the period + disclosure for the chosen FY.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const list = await (AnvilBackend as any)?.brsr?.periods?.({ fy, cadence: "annual" });
        let p = list?.periods?.[0];
        if (!p) {
          const r = await (AnvilBackend as any)?.brsr?.createPeriod?.({
            fiscal_year: fy, cadence: "annual",
          });
          p = r?.period;
        }
        if (cancelled || !p) return;
        setPeriodId(p.id);
        setStatus(p.status || "open");
        const d = await (AnvilBackend as any)?.brsr?.disclosure?.(p.id);
        if (cancelled) return;
        setDisclosure(d?.disclosure || {});
      } catch (err: any) {
        (window as any).notifyError?.("BRSR load failed", err?.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fy]);

  // Auto-save every 30s when dirty (skip when locked).
  useEffect(() => {
    if (!dirty || status === "locked" || status === "assured" || !periodId) return;
    const t = setTimeout(() => { void save(); }, 30_000);
    return () => clearTimeout(t);
  }, [dirty, status, periodId, disclosure]);

  const set = (field: string, value: any) => {
    setDisclosure((prev) => ({ ...prev, [field]: value }));
    setDirty(true);
  };

  const save = async () => {
    if (!periodId) return;
    setSaving(true);
    try {
      const r = await (AnvilBackend as any)?.brsr?.saveDisclosure?.({
        period_id: periodId,
        ...disclosure,
      });
      if (r?.disclosure) setDisclosure(r.disclosure);
      if (r?.computed) setComputed(r.computed);
      setDirty(false);
      (window as any).notifySuccess?.("Saved", "Scope 1 / 2 recomputed.");
    } catch (err: any) {
      (window as any).notifyError?.("Save failed", err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    if (!periodId) return;
    setSaving(true);
    try {
      await (AnvilBackend as any)?.brsr?.submitDisclosure?.({
        period_id: periodId,
        attestation_text: attestation.text,
        attestation_role: attestation.role,
      });
      setStatus("submitted");
      setConfirmSubmit(false);
      (window as any).notifySuccess?.("Submitted", "The period is now locked for editing.");
    } catch (err: any) {
      (window as any).notifyError?.("Submit failed", err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const onPrefill = async () => {
    const from = prevFy(fy);
    if (!from) return;
    try {
      const r = await (AnvilBackend as any)?.brsr?.prefill?.(from);
      if (r?.disclosure) {
        setDisclosure((prev) => ({ ...prev, ...r.disclosure }));
        setDirty(true);
        (window as any).notifySuccess?.("Prefilled", "Values copied from " + from + ".");
      } else {
        (window as any).notifyInfo?.("No prior period", "No disclosure on file for " + from + ".");
      }
    } catch (err: any) {
      (window as any).notifyError?.("Prefill failed", err?.message || String(err));
    }
  };

  const locked = status === "locked" || status === "assured";

  const kpis = useMemo(() => {
    const s1 = Number(disclosure.scope1_tco2e) || Number(computed?.scope1_tco2e) || 0;
    const s2 = Number(disclosure.scope2_tco2e) || Number(computed?.scope2_tco2e) || 0;
    return {
      s1, s2, total: s1 + s2,
    };
  }, [disclosure, computed]);

  if (loading) {
    return (
      <>
        <WSTitle eyebrow="Sustainability" title="BRSR Disclosure" meta="loading" />
        <div className="ws-content">
          <Card><div className="body">Loading disclosure…</div></Card>
        </div>
      </>
    );
  }

  return (
    <>
      <WSTitle
        eyebrow="Sustainability"
        title="BRSR Core Disclosure"
        meta={fy + " · " + status}
      />
      <div className="ws-content">
        <KPIRow>
          <KPI lbl="Scope 1 (direct)" v={fmt(kpis.s1, 2)} d="tCO2e from fuel" />
          <KPI lbl="Scope 2 (electricity)" v={fmt(kpis.s2, 2)} d="grid + renewable" />
          <KPI lbl="Total" v={fmt(kpis.total, 2)} d="tCO2e" />
          <KPI lbl="Period status" v={status} d={dirty ? "unsaved changes" : "in sync"} />
        </KPIRow>

        {locked && (
          <Banner kind="info" icon={Icon.lock} title={"Period " + status}>
            <span className="mono-sm">
              The disclosure for {fy} has been {status}. Open a new period to enter the next FY.
            </span>
          </Banner>
        )}

        <Card>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label className="mono-sm">FY
              <select
                value={fy}
                onChange={(e) => setFy(e.target.value)}
                className="mono"
                style={{ marginLeft: 8, padding: "4px 6px" }}
              >
                {[0, -1, -2, -3].map((delta) => {
                  const now = new Date();
                  const y = (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1) + delta;
                  const v = "FY" + y + "-" + String((y + 1) % 100).padStart(2, "0");
                  return <option key={v} value={v}>{v}</option>;
                })}
              </select>
            </label>
            <Btn sm kind="ghost" disabled={locked} onClick={onPrefill}>Copy from {prevFy(fy)}</Btn>
            <Btn sm kind="primary" disabled={locked || saving} onClick={save}>
              {saving ? "Saving…" : dirty ? "Save draft" : "Saved"}
            </Btn>
            {!locked && (
              <Btn sm kind="primary" disabled={saving} onClick={() => setConfirmSubmit(true)}>Submit + lock</Btn>
            )}
          </div>
        </Card>

        <Card title="Energy (BRSR Core attr 3) · GHG (attr 1)" eyebrow="Scope 1 / Scope 2 recomputed server-side">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <NumberInput label="Electricity consumption" unit="kWh" field="electricity_kwh"
              value={disclosure.electricity_kwh} onChange={set} disabled={locked} />
            <NumberInput label="Renewable share" unit="%" field="electricity_renewable_pct"
              value={disclosure.electricity_renewable_pct} onChange={set} disabled={locked}
              hint="0-100; reduces Scope 2 proportionally" />
            <NumberInput label="Diesel consumption" unit="litres" field="diesel_litres"
              value={disclosure.diesel_litres} onChange={set} disabled={locked} />
            <NumberInput label="Petrol consumption" unit="litres" field="petrol_litres"
              value={disclosure.petrol_litres} onChange={set} disabled={locked} />
            <NumberInput label="Natural gas" unit="scm" field="natural_gas_scm"
              value={disclosure.natural_gas_scm} onChange={set} disabled={locked} />
          </div>
        </Card>

        <Card title="Water (attr 2)">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <NumberInput label="Water withdrawal" unit="kL" field="water_withdrawal_kl"
              value={disclosure.water_withdrawal_kl} onChange={set} disabled={locked} />
            <NumberInput label="Water consumption" unit="kL" field="water_consumption_kl"
              value={disclosure.water_consumption_kl} onChange={set} disabled={locked} />
            <NumberInput label="Water discharge" unit="kL" field="water_discharge_kl"
              value={disclosure.water_discharge_kl} onChange={set} disabled={locked} />
          </div>
        </Card>

        <Card title="Waste / circularity (attr 4)">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <NumberInput label="Total waste generated" unit="MT" field="waste_total_mt"
              value={disclosure.waste_total_mt} onChange={set} disabled={locked} />
            <NumberInput label="Waste recycled / reused" unit="MT" field="waste_recycled_mt"
              value={disclosure.waste_recycled_mt} onChange={set} disabled={locked} />
            <NumberInput label="Waste sent to disposal" unit="MT" field="waste_disposed_mt"
              value={disclosure.waste_disposed_mt} onChange={set} disabled={locked} />
          </div>
        </Card>

        <Card title="People (attrs 5 · gender · 9 · wages)">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <NumberInput label="Women in workforce" unit="%" field="women_pct_workforce"
              value={disclosure.women_pct_workforce} onChange={set} disabled={locked} />
            <NumberInput label="Women in KMP" unit="%" field="women_pct_kmp"
              value={disclosure.women_pct_kmp} onChange={set} disabled={locked} />
            <NumberInput label="Women on board" unit="%" field="women_pct_board"
              value={disclosure.women_pct_board} onChange={set} disabled={locked} />
            <NumberInput label="POSH complaints filed" unit="count" field="posh_complaints"
              value={disclosure.posh_complaints} onChange={set} disabled={locked} />
            <NumberInput label="EHS lost-time injuries" unit="count" field="ehs_lost_time_injuries"
              value={disclosure.ehs_lost_time_injuries} onChange={set} disabled={locked} />
            <NumberInput label="EHS fatalities" unit="count" field="ehs_fatalities"
              value={disclosure.ehs_fatalities} onChange={set} disabled={locked} />
            <NumberInput label="Gross wages paid" unit="Rs" field="gross_wages_inr"
              value={disclosure.gross_wages_inr} onChange={set} disabled={locked} />
            <NumberInput label="Wages paid to women" unit="Rs" field="wages_paid_to_women_inr"
              value={disclosure.wages_paid_to_women_inr} onChange={set} disabled={locked} />
            <NumberInput label="Wages paid in tier 3-6 cities" unit="Rs" field="wages_paid_smaller_towns_inr"
              value={disclosure.wages_paid_smaller_towns_inr} onChange={set} disabled={locked} />
            <NumberInput label="Return-to-work after parental leave" unit="%" field="return_to_work_after_parental_pct"
              value={disclosure.return_to_work_after_parental_pct} onChange={set} disabled={locked} />
          </div>
        </Card>

        <Card title="Inclusion + Openness (attrs 6 · 7 · 8)">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <NumberInput label="Input from MSMEs" unit="%" field="msme_input_pct"
              value={disclosure.msme_input_pct} onChange={set} disabled={locked} />
            <NumberInput label="Sourced within India" unit="%" field="india_sourcing_pct"
              value={disclosure.india_sourcing_pct} onChange={set} disabled={locked} />
            <NumberInput label="Related-party purchases share" unit="%" field="related_party_purchases_pct"
              value={disclosure.related_party_purchases_pct} onChange={set} disabled={locked} />
            <NumberInput label="Anti-competitive complaints" unit="count" field="anti_competitive_complaints"
              value={disclosure.anti_competitive_complaints} onChange={set} disabled={locked} />
            <NumberInput label="Privacy / cyber breaches" unit="count" field="privacy_breaches"
              value={disclosure.privacy_breaches} onChange={set} disabled={locked} />
            <NumberInput label="Deductions on suppliers" unit="%" field="supplier_deductions_pct"
              value={disclosure.supplier_deductions_pct} onChange={set} disabled={locked} />
          </div>
        </Card>

        <Card title="Compliance attestations">
          <KV rows={[
            ["Pollution-consent valid",
              <label key="pcv" className="mono">
                <input type="checkbox" disabled={locked}
                  checked={!!disclosure.pollution_consent_valid}
                  onChange={(e) => set("pollution_consent_valid", e.target.checked)} />
                <span style={{ marginLeft: 6 }}>{disclosure.pollution_consent_valid ? "yes" : "no"}</span>
              </label>,
            ],
            ["Factory Act compliant",
              <label key="fac" className="mono">
                <input type="checkbox" disabled={locked}
                  checked={!!disclosure.factory_act_compliant}
                  onChange={(e) => set("factory_act_compliant", e.target.checked)} />
                <span style={{ marginLeft: 6 }}>{disclosure.factory_act_compliant ? "yes" : "no"}</span>
              </label>,
            ],
            ["Cyber security breaches (count)",
              <input key="csb" type="number" className="mono" disabled={locked}
                value={disclosure.cyber_security_breaches == null ? "" : String(disclosure.cyber_security_breaches)}
                onChange={(e) => set("cyber_security_breaches", e.target.value === "" ? null : Number(e.target.value))}
                style={{ padding: "4px 6px", border: "1px solid var(--hairline-2)", background: "transparent", color: "inherit", borderRadius: 4 }}
              />,
            ],
            ["Revenue for intensity ratio (Rs)",
              <input key="rev" type="number" className="mono" disabled={locked}
                value={disclosure.revenue_inr == null ? "" : String(disclosure.revenue_inr)}
                onChange={(e) => set("revenue_inr", e.target.value === "" ? null : Number(e.target.value))}
                style={{ padding: "4px 6px", border: "1px solid var(--hairline-2)", background: "transparent", color: "inherit", borderRadius: 4 }}
              />,
            ],
          ]} />
        </Card>

        <Card title="Provenance">
          <div className="body" style={{ color: "var(--ink-3)" }}>
            Scope 1 sums diesel + petrol + natural gas using
            <b> DEFRA 2025 </b> conversion factors. Scope 2 uses the
            <b> CEA Baseline v21.0 (Nov 2025) </b> grid factor of
            <b> 0.710 tCO2/MWh</b>, reduced by the renewable share you enter.
            Numbers recompute server-side every time you save, so the
            audit trail matches the page.
          </div>
        </Card>

        {confirmSubmit && (
          <div className="modal-backdrop" onClick={() => setConfirmSubmit(false)}>
            <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 540 }}>
              <div className="modal-h">
                <span className="ti">Confirm BRSR submission</span>
                <Btn icon kind="ghost" sm onClick={() => setConfirmSubmit(false)} aria-label="Close">{Icon.close}</Btn>
              </div>
              <div className="modal-body" style={{ display: "grid", gap: 10 }}>
                <Banner kind="warn" icon={Icon.alert} title="This will lock the disclosure">
                  <span className="mono-sm">
                    Once submitted, you cannot edit values for {fy}. The buyer side can read your
                    disclosure once you accept their invite under Relationships.
                  </span>
                </Banner>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm">Attestation text</span>
                  <textarea rows={3}
                    value={attestation.text}
                    onChange={(e) => setAttestation((a) => ({ ...a, text: e.target.value }))}
                    placeholder="I attest that the disclosure values are accurate to the best of my knowledge."
                    style={{ padding: 8, border: "1px solid var(--hairline-2)", background: "transparent", color: "inherit", borderRadius: 4 }}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm">Your role</span>
                  <input type="text" className="mono"
                    value={attestation.role}
                    onChange={(e) => setAttestation((a) => ({ ...a, role: e.target.value }))}
                    placeholder="Director / CFO / Compliance Head"
                    style={{ padding: "6px 8px", border: "1px solid var(--hairline-2)", background: "transparent", color: "inherit", borderRadius: 4 }}
                  />
                </label>
              </div>
              <div className="modal-f">
                <Btn kind="ghost" onClick={() => setConfirmSubmit(false)}>Cancel</Btn>
                <Btn kind="primary" disabled={saving} onClick={submit}>{saving ? "Submitting…" : "Submit + lock"}</Btn>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default BrsrSupplierScreen;
