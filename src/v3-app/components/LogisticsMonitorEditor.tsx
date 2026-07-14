import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";

// Admin editor for the tenant's logistics monitor rules (Logistics Ops P1):
// a feature flag + one configurable rule per delay/SLA kind (active, severity,
// threshold days, SLA-clock hours, escalation roles). Replaces hardcoded
// thresholds so the monitor is configuration-driven. Saved via
// /api/admin/logistics_monitor_rules; run by the logistics-monitor-tick cron.
// Design: docs/LOGISTICS_OPS_DESIGN.md.

const SEVERITIES = ["info", "warn", "bad", "critical"];
const sevChip = (s: string) => (s === "critical" ? "bad" : s === "bad" ? "bad" : s === "warn" ? "warn" : "ghost");

type Rule = {
  rule_kind: string; label?: string; active?: boolean; severity?: string;
  threshold_days?: number | null; sla_hours?: number | null; escalate_roles?: string[]; _roles?: string;
};

export const LogisticsMonitorEditor: React.FC = () => {
  const canEdit = RBAC.isAdmin?.() ?? false;
  const [rules, setRules] = useState<Rule[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = () => {
    setErr(null);
    Promise.resolve(ObaraBackend?.logistics?.getMonitorRules?.())
      .then((r: any) => {
        const rs: Rule[] = (r?.rules || []).map((x: any) => ({ ...x, _roles: (x.escalate_roles || []).join(", ") }));
        setRules(rs);
        setEnabled(!!r?.logistics_monitor_enabled);
        setIsDefault(!!r?.is_default);
      })
      .catch((e: any) => setErr(e?.message || String(e)));
  };
  useEffect(load, []);

  const setRule = (i: number, patch: Partial<Rule>) =>
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const toggleEnabled = async (next: boolean) => {
    setBusy("flag"); setErr(null); setFlash(null);
    try {
      const r: any = await ObaraBackend?.logistics?.setMonitorEnabled?.(next);
      setEnabled(!!r?.logistics_monitor_enabled);
      setFlash(next ? "Logistics monitor enabled" : "Logistics monitor disabled");
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  const saveRule = async (i: number) => {
    const r = rules[i];
    setBusy(r.rule_kind); setErr(null); setFlash(null);
    try {
      const payload = {
        rule_kind: r.rule_kind,
        label: r.label || null,
        active: r.active !== false,
        severity: r.severity || "warn",
        threshold_days: r.threshold_days === null || r.threshold_days === undefined || (r.threshold_days as any) === "" ? null : Number(r.threshold_days),
        sla_hours: r.sla_hours === null || r.sla_hours === undefined || (r.sla_hours as any) === "" ? null : Number(r.sla_hours),
        escalate_roles: String(r._roles || "").split(",").map((x) => x.trim()).filter(Boolean),
      };
      const saved: any = await ObaraBackend?.logistics?.saveMonitorRule?.(payload);
      if (saved?.rule) {
        setRule(i, { ...saved.rule, _roles: (saved.rule.escalate_roles || []).join(", ") });
        setIsDefault(false);
      }
      setFlash("Saved rule: " + r.rule_kind);
      window.notifySuccess?.("Monitor rule saved", r.label || r.rule_kind);
    } catch (e: any) {
      setErr(e?.message || String(e));
      window.notifyError?.("Could not save monitor rule", e?.message || String(e));
    } finally { setBusy(null); }
  };

  return (
    <Card title="Logistics monitor" eyebrow="config-driven delay / SLA rules"
          right={
            <label className="mono-sm" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" disabled={!canEdit || busy === "flag"} checked={enabled} onChange={(e) => toggleEnabled(e.target.checked)} />
              monitor enabled
            </label>
          }>
      {err && <Banner kind="bad" title="Logistics monitor">{err}</Banner>}
      {flash && <Banner kind="good" title="Saved">{flash}</Banner>}
      {isDefault && <Banner kind="info" title="Using built-in defaults">Editing + saving a row creates this tenant's own rule.</Banner>}
      {!enabled && <Banner kind="warn" title="Monitor is off">The tick will not scan until you enable it above. Rules can still be configured.</Banner>}

      <div style={{ overflowX: "auto" }}>
        <table className="tbl" style={{ fontSize: 12, minWidth: 720 }}>
          <thead><tr>
            <th>Rule</th><th className="r">Active</th><th>Severity</th>
            <th className="r">Threshold (d)</th><th className="r">SLA (h)</th><th>Escalate roles</th><th></th>
          </tr></thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={r.rule_kind}>
                <td><div>{r.label || r.rule_kind}</div><div className="mono-sm" style={{ color: "var(--ink-4)" }}>{r.rule_kind}</div></td>
                <td className="r"><input type="checkbox" disabled={!canEdit} checked={r.active !== false} onChange={(e) => setRule(i, { active: e.target.checked })} /></td>
                <td>
                  <select className="select" disabled={!canEdit} value={r.severity || "warn"} onChange={(e) => setRule(i, { severity: e.target.value })}>
                    {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  {" "}<Chip k={sevChip(r.severity || "warn")}>{r.severity || "warn"}</Chip>
                </td>
                <td className="r"><input className="input mono" type="number" disabled={!canEdit} value={r.threshold_days ?? ""} onChange={(e) => setRule(i, { threshold_days: e.target.value === "" ? null : Number(e.target.value) })} style={{ width: 70 }} /></td>
                <td className="r"><input className="input mono" type="number" disabled={!canEdit} value={r.sla_hours ?? ""} onChange={(e) => setRule(i, { sla_hours: e.target.value === "" ? null : Number(e.target.value) })} style={{ width: 70 }} /></td>
                <td><input className="input" disabled={!canEdit} value={r._roles || ""} placeholder="procurement, admin" onChange={(e) => setRule(i, { _roles: e.target.value })} style={{ width: 170 }} /></td>
                <td className="r">{canEdit && <Btn sm kind="primary" disabled={busy === r.rule_kind} onClick={() => saveRule(i)}>{busy === r.rule_kind ? "…" : "Save"}</Btn>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!canEdit && <div className="mono-sm" style={{ color: "var(--ink-4)", marginTop: 8 }}>Admin to edit.</div>}
    </Card>
  );
};

export default LogisticsMonitorEditor;
