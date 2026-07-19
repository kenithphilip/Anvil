import React, { useState } from "react";
import { useFetch } from "../lib/helpers";
import { Btn, Card, Chip, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — FMECA criticality (reliability step 4c)
// Rate a part x failure-mode on severity / occurrence / detection;
// RPN = S*O*D. Occurrence can be auto-suggested from failure_events.
// Reads/writes AnvilBackend.fmeca; reached at #/fmeca.
// ============================================================

const SOD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const rpnOf = (s, o, d) => (s && o && d ? s * o * d : null);
const bandKind = (rpn) => (rpn == null ? "info" : rpn >= 200 ? "bad" : rpn >= 80 ? "warn" : "ok");
const bandLabel = (rpn) => (rpn == null ? "" : rpn >= 200 ? "high" : rpn >= 80 ? "med" : "low");
const emptyForm = () => ({ part_no: "", failure_mode_id: "", severity: "", occurrence: "", detection: "", suggested_occurrence: null as number | null, occurrence_basis: {} as Record<string, any>, notes: "" });

const WiredFmeca = () => {
  const rows = useFetch(() => AnvilBackend?.fmeca?.list?.() || Promise.resolve({ rows: [] }), []);
  const catalog = useFetch(() => AnvilBackend?.fmeca?.listCatalog?.() || Promise.resolve({ modes: [] }), []);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<any>(null);

  const modes: any[] = catalog.data?.modes || [];
  const list: any[] = rows.data?.rows || [];
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const rpnPreview = rpnOf(Number(form.severity), Number(form.occurrence), Number(form.detection));

  const doSuggest = async () => {
    if (!form.part_no.trim()) return;
    try {
      const r = await AnvilBackend.fmeca.suggest({ part_no: form.part_no.trim() });
      setSuggestions(r?.suggestions || []);
    } catch (e) { window.notifyError?.(e.message || String(e)); }
  };
  const applySuggestion = (s) => {
    set("occurrence", String(s.suggested_occurrence));
    setForm((f) => ({ ...f, suggested_occurrence: s.suggested_occurrence, occurrence_basis: { count: s.count, window_weeks: s.window_weeks, failure_mode: s.failure_mode } }));
  };
  const save = async () => {
    if (!form.part_no.trim() || !form.failure_mode_id) { window.notifyError?.("Part and failure mode are required."); return; }
    setBusy(true);
    try {
      await AnvilBackend.fmeca.upsert({
        part_no: form.part_no.trim(),
        failure_mode_id: form.failure_mode_id,
        severity: form.severity ? Number(form.severity) : null,
        occurrence: form.occurrence ? Number(form.occurrence) : null,
        detection: form.detection ? Number(form.detection) : null,
        suggested_occurrence: form.suggested_occurrence,
        occurrence_basis: form.occurrence_basis,
        notes: form.notes || null,
      });
      window.notifySuccess?.("Saved", "FMECA record saved.");
      setForm(emptyForm()); setSuggestions(null); rows.reload();
    } catch (e) { window.notifyError?.(e.message || String(e)); } finally { setBusy(false); }
  };
  const editRow = (r) => setForm({
    part_no: r.part_no || "", failure_mode_id: r.failure_mode_id || "",
    severity: r.severity != null ? String(r.severity) : "", occurrence: r.occurrence != null ? String(r.occurrence) : "",
    detection: r.detection != null ? String(r.detection) : "", suggested_occurrence: r.suggested_occurrence ?? null,
    occurrence_basis: r.occurrence_basis || {}, notes: r.notes || "",
  });
  const del = async (id) => {
    if (!window.confirm("Delete this FMECA record?")) return;
    try { await AnvilBackend.fmeca.remove(id); window.notifySuccess?.("Deleted", "FMECA record removed."); rows.reload(); }
    catch (e) { window.notifyError?.(e.message || String(e)); }
  };

  const fld = (label, ctrl) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="mono-sm" style={{ color: "var(--ink-3)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.04 }}>{label}</span>
      {ctrl}
    </label>
  );
  const sodSelect = (k, aria) => (
    <select className="select" value={form[k]} onChange={(e) => set(k, e.target.value)} aria-label={aria}>
      <option value="">—</option>{SOD.map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  );

  return (
    <>
      <WSTitle
        eyebrow="Data · Items · FMECA"
        title="FMECA criticality"
        meta={`${list.length} record${list.length === 1 ? "" : "s"} · severity × occurrence × detection → RPN`}
        right={<Btn icon kind="ghost" sm onClick={() => { rows.reload(); catalog.reload(); }} title="Refresh">{Icon.cycle}</Btn>}
      />
      <div className="ws-content">
        <div style={{ display: "grid", gridTemplateColumns: "minmax(340px, 40%) 1fr", gap: 14, alignItems: "start" }}>
          <Card title="Add / edit record" eyebrow="severity × occurrence × detection">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {fld("Part no *", (
                <>
                  <input className="input mono" list="fmeca-parts" value={form.part_no} onChange={(e) => set("part_no", e.target.value)} aria-label="Part no" />
                  <datalist id="fmeca-parts">{[...new Set(list.map((r) => r.part_no).filter(Boolean))].map((p) => <option key={p} value={p} />)}</datalist>
                </>
              ))}
              {fld("Failure mode *", (
                <select className="select" value={form.failure_mode_id} onChange={(e) => set("failure_mode_id", e.target.value)} aria-label="Failure mode">
                  <option value="">— pick mode —</option>
                  {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              ))}
              {fld("Severity (1-10)", sodSelect("severity", "Severity"))}
              {fld("Occurrence (1-10)", sodSelect("occurrence", "Occurrence"))}
              {fld("Detection (1-10)", sodSelect("detection", "Detection"))}
              {fld("RPN", (
                <div className="mono" style={{ padding: "6px 8px", fontWeight: 600, display: "flex", gap: 6, alignItems: "center" }}>
                  {rpnPreview == null ? "—" : rpnPreview}
                  {rpnPreview != null && <Chip k={bandKind(rpnPreview)}>{bandLabel(rpnPreview)}</Chip>}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Btn sm kind="ghost" onClick={doSuggest} disabled={!form.part_no.trim()}>Suggest occurrence from failures</Btn>
              {form.suggested_occurrence != null && (
                <span className="fieldnote">suggested O = {form.suggested_occurrence} (from {form.occurrence_basis?.count || 0} events / {form.occurrence_basis?.window_weeks || 104}w)</span>
              )}
            </div>
            {suggestions && (suggestions.length ? (
              <div style={{ marginTop: 8, borderTop: "1px solid var(--hairline-2)", paddingTop: 8 }}>
                {suggestions.map((s, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0" }}>
                    <span className="mono-sm" style={{ flex: 1 }}>{s.failure_mode || "(unlabelled)"} · {s.count} events → O={s.suggested_occurrence}</span>
                    <Btn sm kind="ghost" onClick={() => applySuggestion(s)}>Use</Btn>
                  </div>
                ))}
              </div>
            ) : <div className="fieldnote" style={{ marginTop: 8 }}>No breakdown/replacement events for this part in the last 104 weeks.</div>)}
            <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
              <span className="mono-sm" style={{ color: "var(--ink-3)", fontSize: 10.5, textTransform: "uppercase" }}>Notes</span>
              <textarea className="input" rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} aria-label="Notes" />
            </label>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Btn kind="primary" sm disabled={busy} onClick={save}>{busy ? "Saving…" : "Save record"}</Btn>
              <Btn kind="ghost" sm onClick={() => { setForm(emptyForm()); setSuggestions(null); }}>Clear</Btn>
            </div>
          </Card>

          <Card title="FMECA worklist" eyebrow="sorted by RPN" flush>
            {rows.loading && !rows.data ? (
              <div className="body" style={{ padding: 16 }}>Loading…</div>
            ) : list.length === 0 ? (
              <div className="body" style={{ padding: 18, textAlign: "center", color: "var(--ink-3)" }}>
                No FMECA records yet. Rate a part × failure mode on the left; occurrence can be suggested from logged failures.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Part</th><th>Failure mode</th><th className="r">S</th><th className="r">O</th><th className="r">D</th><th className="r">RPN</th><th style={{ width: 40 }}></th>
                </tr></thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => editRow(r)}>
                      <td className="mono-sm">{r.part_no || "—"}</td>
                      <td>{r.mode?.label || "—"}</td>
                      <td className="r mono-sm">{r.severity ?? "—"}</td>
                      <td className="r mono-sm">{r.occurrence ?? "—"}</td>
                      <td className="r mono-sm">{r.detection ?? "—"}</td>
                      <td className="r mono" style={{ fontWeight: 600 }}>
                        {r.rpn ?? "—"} {r.rpn != null && <Chip k={bandKind(r.rpn)}>{bandLabel(r.rpn)}</Chip>}
                      </td>
                      <td><Btn icon kind="ghost" sm onClick={(e) => { e.stopPropagation(); del(r.id); }} title="Delete">{Icon.x}</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
};

export default WiredFmeca;
