import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";

// Admin editor for the tenant's ICP (Ideal Customer Profile) rubric: a hard
// gate + weighted scoring rules + tier cutoffs over generic attribute keys
// (from the customer-registration catalog + core columns). Saved via
// /api/admin/icp_profiles; scored by src/api/_lib/icp.js. Design:
// docs/ICP_FRAMEWORK_DESIGN.md. P2 of the ICP framework.

const OPS = ["equals", "not_equals", "in", "not_in", "exists", "absent", "gte", "lte", "range", "matches"];
const OP_HELP: Record<string, string> = {
  in: "comma-separated list", not_in: "comma-separated list", range: "min, max",
  exists: "(no value)", absent: "(no value)", matches: "regex", gte: "number", lte: "number",
};
const needsValue = (op: string) => op !== "exists" && op !== "absent";
const isList = (op: string) => op === "in" || op === "not_in" || op === "range";
const valueToStr = (op: string, v: any) => (isList(op) && Array.isArray(v)) ? v.join(", ") : (v ?? "");
const strToValue = (op: string, sv: string) => {
  if (!needsValue(op)) return undefined;
  if (isList(op)) return String(sv || "").split(",").map((x) => x.trim()).filter(Boolean);
  return sv;
};

type Rule = { attribute_key: string; op: string; _v?: string; weight?: number; label?: string };

export const IcpProfileEditor: React.FC = () => {
  const canEdit = RBAC.isAdmin?.() ?? false;
  const [prof, setProf] = useState<any>(null);
  const [attrKeys, setAttrKeys] = useState<any[]>([]);
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const norm = (arr: any[]) => (arr || []).map((r) => ({ ...r, _v: valueToStr(r.op, r.value) }));

  const load = () => {
    setErr(null);
    Promise.resolve(ObaraBackend?.customers?.getIcpProfile?.())
      .then((r: any) => {
        const p = r?.profile || {};
        setProf({ ...p, gate: norm(p.gate || []), rules: norm(p.rules || []), tiers: p.tiers || [] });
        setAttrKeys(r?.attribute_keys || []);
        setIsDefault(!!r?.is_default);
      })
      .catch((e: any) => setErr(e?.message || String(e)));
  };
  useEffect(load, []);

  const setRule = (kind: "gate" | "rules", i: number, patch: Partial<Rule>) =>
    setProf((p: any) => ({ ...p, [kind]: (p[kind] || []).map((r: Rule, idx: number) => idx === i ? { ...r, ...patch } : r) }));
  const addRule = (kind: "gate" | "rules") =>
    setProf((p: any) => ({ ...p, [kind]: [...(p[kind] || []), { attribute_key: attrKeys[0]?.key || "", op: "exists", _v: "", weight: kind === "rules" ? 10 : 0, label: "" }] }));
  const delRule = (kind: "gate" | "rules", i: number) =>
    setProf((p: any) => ({ ...p, [kind]: (p[kind] || []).filter((_: any, idx: number) => idx !== i) }));
  const setTier = (i: number, patch: any) =>
    setProf((p: any) => ({ ...p, tiers: (p.tiers || []).map((t: any, idx: number) => idx === i ? { ...t, ...patch } : t) }));
  const addTier = () => setProf((p: any) => ({ ...p, tiers: [...(p.tiers || []), { min: 0, tier: "C" }] }));
  const delTier = (i: number) => setProf((p: any) => ({ ...p, tiers: (p.tiers || []).filter((_: any, idx: number) => idx !== i) }));

  const totalWeight = (prof?.rules || []).reduce((s: number, r: Rule) => s + (Number(r.weight) || 0), 0);

  const save = async () => {
    setBusy(true); setErr(null); setFlash(null);
    try {
      const shape = (r: Rule) => ({ attribute_key: r.attribute_key, op: r.op, label: r.label || "", value: strToValue(r.op, r._v || "") });
      const payload = {
        id: isDefault ? undefined : prof.id,
        name: prof.name || "Default ICP",
        active: prof.active !== false,
        gate: (prof.gate || []).map(shape),
        rules: (prof.rules || []).map((r: Rule) => ({ ...shape(r), weight: Number(r.weight) || 0 })),
        tiers: (prof.tiers || []).map((t: any) => ({ min: Number(t.min) || 0, tier: String(t.tier || "") })),
      };
      const saved: any = await ObaraBackend?.customers?.saveIcpProfile?.(payload);
      if (saved?.profile) {
        const p = saved.profile;
        setProf({ ...p, gate: norm(p.gate || []), rules: norm(p.rules || []), tiers: p.tiers || [] });
      }
      setIsDefault(false);
      setFlash("ICP rubric saved");
      window.notifySuccess?.("ICP rubric saved", payload.name);
    } catch (e: any) {
      setErr(e?.message || String(e));
      window.notifyError?.("Could not save ICP rubric", e?.message || String(e));
    } finally { setBusy(false); }
  };

  const rescoreAll = async () => {
    setBusy(true); setErr(null); setFlash(null);
    try {
      const r: any = await ObaraBackend?.customers?.recomputeIcpAll?.();
      const tiers = r?.tiers ? Object.entries(r.tiers).map(([t, n]) => `${t}:${n}`).join(" · ") : "";
      const msg = `Re-scored ${r?.scored ?? 0} customers${tiers ? " (" + tiers + ")" : ""}${r?.errors ? ` · ${r.errors} skipped` : ""}`;
      setFlash(msg);
      window.notifySuccess?.("ICP re-scored", msg);
    } catch (e: any) {
      setErr(e?.message || String(e));
      window.notifyError?.("Could not re-score customers", e?.message || String(e));
    } finally { setBusy(false); }
  };

  if (!prof) return <Card title="ICP profile"><div className="body">{err ? <Banner kind="bad" title="ICP">{err}</Banner> : "Loading…"}</div></Card>;

  const ruleRow = (kind: "gate" | "rules") => (r: Rule, i: number) => {
    const attr = attrKeys.find((a) => a.key === r.attribute_key);
    const listId = Array.isArray(attr?.values) && attr.values.length ? `icp-vals-${kind}-${i}` : undefined;
    return (
    <div key={i} className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
      <select className="select" disabled={!canEdit} value={r.attribute_key} onChange={(e) => setRule(kind, i, { attribute_key: e.target.value })} style={{ minWidth: 170 }}>
        {attrKeys.map((a) => <option key={a.key} value={a.key}>{a.label} ({a.key})</option>)}
        {!attrKeys.find((a) => a.key === r.attribute_key) && <option value={r.attribute_key}>{r.attribute_key}</option>}
      </select>
      <select className="select" disabled={!canEdit} value={r.op} onChange={(e) => setRule(kind, i, { op: e.target.value })}>
        {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <input className="input" list={listId} disabled={!canEdit || !needsValue(r.op)} placeholder={OP_HELP[r.op] || "value"} value={r._v || ""} onChange={(e) => setRule(kind, i, { _v: e.target.value })} style={{ width: 150 }} />
      {listId && <datalist id={listId}>{attr.values.map((v: string) => <option key={v} value={v} />)}</datalist>}
      {kind === "rules" && (
        <input className="input mono" type="number" disabled={!canEdit} title="weight" value={r.weight ?? 0} onChange={(e) => setRule(kind, i, { weight: Number(e.target.value) })} style={{ width: 64 }} />
      )}
      <input className="input" disabled={!canEdit} placeholder="label" value={r.label || ""} onChange={(e) => setRule(kind, i, { label: e.target.value })} style={{ width: 160 }} />
      {canEdit && <Btn sm kind="ghost" onClick={() => delRule(kind, i)}>×</Btn>}
    </div>
    );
  };

  return (
    <Card title="ICP profile" eyebrow="ideal-customer-profile fit rubric"
          right={canEdit ? (
            <span className="row" style={{ gap: 6 }}>
              <Btn sm kind="ghost" disabled={busy} onClick={rescoreAll} title="Re-score all customers against the saved rubric">Re-score all</Btn>
              <Btn sm kind="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save rubric"}</Btn>
            </span>
          ) : <span className="mono-sm" style={{ color: "var(--ink-4)" }}>Admin to edit</span>}>
      {err && <Banner kind="bad" title="ICP">{err}</Banner>}
      {flash && <Banner kind="good" title="Saved">{flash}</Banner>}
      {isDefault && <Banner kind="info" title="Using the built-in default">Editing + saving creates this tenant's own rubric.</Banner>}

      <div className="row" style={{ gap: 10, alignItems: "center", margin: "8px 0" }}>
        <label className="mono-sm">Name <input className="input" disabled={!canEdit} value={prof.name || ""} onChange={(e) => setProf((p: any) => ({ ...p, name: e.target.value }))} style={{ width: 200 }} /></label>
        <label className="mono-sm" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" disabled={!canEdit} checked={prof.active !== false} onChange={(e) => setProf((p: any) => ({ ...p, active: e.target.checked }))} /> active
        </label>
        <Chip k={totalWeight === 100 ? "good" : "warn"}>weights total {totalWeight}{totalWeight !== 100 ? " (normalized)" : ""}</Chip>
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="mono-sm" style={{ color: "var(--ink-3)", fontWeight: 600, marginBottom: 4 }}>Gate — hard qualifiers (any fail → tier "Out")</div>
        {(prof.gate || []).length === 0 && <div className="mono-sm" style={{ color: "var(--ink-4)" }}>No gate (all customers scored).</div>}
        {(prof.gate || []).map(ruleRow("gate"))}
        {canEdit && <Btn sm kind="ghost" onClick={() => addRule("gate")}>+ gate rule</Btn>}
      </div>

      <div className="divider" />
      <div style={{ marginTop: 8 }}>
        <div className="mono-sm" style={{ color: "var(--ink-3)", fontWeight: 600, marginBottom: 4 }}>Scoring rules (attribute · op · value · weight · label)</div>
        {(prof.rules || []).map(ruleRow("rules"))}
        {canEdit && <Btn sm kind="ghost" onClick={() => addRule("rules")}>+ scoring rule</Btn>}
      </div>

      <div className="divider" />
      <div style={{ marginTop: 8 }}>
        <div className="mono-sm" style={{ color: "var(--ink-3)", fontWeight: 600, marginBottom: 4 }}>Tiers — score ≥ min → tier</div>
        {(prof.tiers || []).map((t: any, i: number) => (
          <div key={i} className="row" style={{ gap: 6, alignItems: "center", marginBottom: 6 }}>
            <span className="mono-sm">≥</span>
            <input className="input mono" type="number" disabled={!canEdit} value={t.min} onChange={(e) => setTier(i, { min: Number(e.target.value) })} style={{ width: 70 }} />
            <span className="mono-sm">→</span>
            <input className="input" disabled={!canEdit} value={t.tier} onChange={(e) => setTier(i, { tier: e.target.value })} style={{ width: 90 }} />
            {canEdit && <Btn sm kind="ghost" onClick={() => delTier(i)}>×</Btn>}
          </div>
        ))}
        {canEdit && <Btn sm kind="ghost" onClick={addTier}>+ tier</Btn>}
      </div>
    </Card>
  );
};

export default IcpProfileEditor;
