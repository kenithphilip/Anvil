// @ts-nocheck — converted screen, types follow in a focused TS pass
import React, { useEffect, useMemo, useState } from "react";
import { ageLabel, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";

// ============================================================
// ANVIL v3 — Profile Studio CRUD overlay
// Adds fingerprint editor + side-by-side diff between current
// version and any prior, plus a force-LLM-fallback toggle, on
// top of the read-only rollback list in wired-studio-e.jsx.
// Wins via load-order.
//
// Backend:
//   GET  /api/customers                         -> { customers, profiles }
//   POST /api/customers                         -> upsert + new profile version
//   GET  /api/customers/profile_versions        -> { versions }
//   POST /api/customers/profile_versions        -> rollback to a prior version
//
// Saving fingerprint: POST /api/customers with body.profile.fingerprint
// flips the previous current to is_current=false and inserts a new row
// as is_current=true at version+1. Carries over orders_processed,
// trusted, learned_rules, recipe, golden_examples, force_llm_fallback.
// ============================================================

const studioCrudFetch = async (path, opts = {}) => {
  const cfg = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_config") || "{}"); } catch (_) { return {}; } })();
  const session = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_session") || "null"); } catch (_) { return null; } })();
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
  const url = (cfg.url || "").replace(/\/+$/, "") + path;
  const resp = await fetch(url, {
    ...opts,
    headers,
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + (await resp.text()));
  if (resp.status === 204) return null;
  return resp.json();
};

const studioCrudRowsOf = (resp, key) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (key && Array.isArray(resp[key])) return resp[key];
  if (Array.isArray(resp.rows)) return resp.rows;
  if (Array.isArray(resp.versions)) return resp.versions;
  return [];
};

const tryParseJsonStudio = (s, fallback) => {
  try { return JSON.parse(s); } catch (_) { return fallback; }
};

// Compute a flat key-by-key diff. Returns { added, removed, changed, same }
// Each entry is { path, before, after }.
const fpDiff = (before, after) => {
  const flat = (obj, prefix = "", out = {}) => {
    if (obj == null || typeof obj !== "object") {
      out[prefix.replace(/^\./, "")] = obj;
      return out;
    }
    if (Array.isArray(obj)) {
      out[prefix.replace(/^\./, "")] = obj;
      return out;
    }
    for (const k of Object.keys(obj)) flat(obj[k], `${prefix}.${k}`, out);
    return out;
  };
  const a = flat(before || {});
  const b = flat(after || {});
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const result = { added: [], removed: [], changed: [], same: [] };
  for (const k of keys) {
    const inA = Object.prototype.hasOwnProperty.call(a, k);
    const inB = Object.prototype.hasOwnProperty.call(b, k);
    if (inA && !inB) result.removed.push({ path: k, before: a[k], after: undefined });
    else if (!inA && inB) result.added.push({ path: k, before: undefined, after: b[k] });
    else {
      const eq = JSON.stringify(a[k]) === JSON.stringify(b[k]);
      if (eq) result.same.push({ path: k, before: a[k], after: b[k] });
      else result.changed.push({ path: k, before: a[k], after: b[k] });
    }
  }
  for (const arr of [result.added, result.removed, result.changed, result.same]) {
    arr.sort((x, y) => x.path.localeCompare(y.path));
  }
  return result;
};

const fpPreviewVal = (v) => {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 60 ? `"${v.slice(0, 60)}…"` : `"${v}"`;
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 60) + "…" : s;
  } catch (_) { return String(v); }
};

const WiredStudioCRUD = () => {
  const { useState: u, useEffect: e, useMemo: m } = React;

  const customers = useFetch(
    () => ObaraBackend?.customers?.list?.() || studioCrudFetch("/api/customers"),
    []
  );

  const [customerId, setCustomerId] = u("");
  const [versions, setVersions] = u({ data: null, loading: false, error: null });
  const [rollingBack, setRollingBack] = u(null);
  const [err, setErr] = u(null);
  const [okMsg, setOkMsg] = u(null);

  // Editor state for the current version
  const [fpText, setFpText] = u("");
  const [editing, setEditing] = u(false);
  const [saving, setSaving] = u(false);
  const [fallback, setFallback] = u(false);
  const [trusted, setTrusted] = u(false);

  // Diff state: which prior version are we comparing the current to?
  const [diffAgainst, setDiffAgainst] = u(null);

  const canWrite = RBAC?.canDo?.("studio.write") ?? true;

  const loadVersions = (id) => {
    if (!id) {
      setVersions({ data: null, loading: false, error: null });
      return;
    }
    setVersions({ data: null, loading: true, error: null });
    setErr(null);
    Promise.resolve(ObaraBackend?.profileVersions?.list?.(id)
                    || studioCrudFetch("/api/customers/profile_versions?customerId=" + encodeURIComponent(id)))
      .then((data) => setVersions({ data, loading: false, error: null }))
      .catch((error) => setVersions({ data: null, loading: false, error }));
  };

  const onPickCustomer = (id) => {
    setCustomerId(id);
    setEditing(false);
    setDiffAgainst(null);
    loadVersions(id);
  };

  const customerList = m(() => {
    const d = customers.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    if (Array.isArray(d.customers)) return d.customers;
    if (Array.isArray(d.rows)) return d.rows;
    return [];
  }, [customers.data]);

  const profilesByCustomer = m(() => {
    const d = customers.data;
    if (d && d.profiles && typeof d.profiles === "object") return d.profiles;
    return {};
  }, [customers.data]);

  const versionRows = m(() => {
    return studioCrudRowsOf(versions.data, "versions")
      .slice()
      .sort((a, b) => {
        const va = Number(a.version_no ?? a.version ?? 0);
        const vb = Number(b.version_no ?? b.version ?? 0);
        if (va !== vb) return vb - va;
        const ta = new Date(a.created_at || 0).getTime();
        const tb = new Date(b.created_at || 0).getTime();
        return tb - ta;
      });
  }, [versions.data]);

  const selectedCustomer = m(
    () => customerList.find((c) => (c.id || c.customer_key) === customerId),
    [customerList, customerId]
  );

  const currentProfile = m(() => {
    if (!selectedCustomer) return null;
    const p = profilesByCustomer[selectedCustomer.id];
    if (p) return p;
    return versionRows.find((v) => v.is_current || v.current === true) || null;
  }, [selectedCustomer, profilesByCustomer, versionRows]);

  // Sync editor state when current profile changes.
  e(() => {
    if (!currentProfile) {
      setFpText("");
      setFallback(false);
      setTrusted(false);
      return;
    }
    const fp = currentProfile.fingerprint || {};
    setFpText(JSON.stringify(fp, null, 2));
    setFallback(!!currentProfile.force_llm_fallback);
    setTrusted(!!currentProfile.trusted);
  }, [currentProfile?.id]);

  const doRollback = async (versionId) => {
    if (!versionId) return;
    if (!confirm("Roll back to this version? It will become the new current.")) return;
    setRollingBack(versionId);
    setErr(null);
    try {
      await (ObaraBackend?.profileVersions?.rollback?.(versionId)
             || studioCrudFetch("/api/customers/profile_versions", { method: "POST", body: { profileVersionId: versionId } }));
      setOkMsg("Rolled back");
      loadVersions(customerId);
      customers.reload?.();
    } catch (error) {
      setErr(error);
    } finally {
      setRollingBack(null);
    }
  };

  const saveProfile = async () => {
    if (!selectedCustomer) return;
    const parsed = tryParseJsonStudio(fpText, undefined);
    if (parsed === undefined) {
      setErr(new Error("Fingerprint must be valid JSON"));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const payload = {
        customer_key: selectedCustomer.customer_key,
        customer_name: selectedCustomer.customer_name,
        gstin: selectedCustomer.gstin,
        state_code: selectedCustomer.state_code,
        default_payment_terms: selectedCustomer.default_payment_terms,
        default_incoterms: selectedCustomer.default_incoterms,
        default_quote_validity_days: selectedCustomer.default_quote_validity_days,
        notes: selectedCustomer.notes,
        profile: {
          version: currentProfile?.version || currentProfile?.version_no || 0,
          fingerprint: parsed,
          orders_processed: currentProfile?.orders_processed || 0,
          last_format_changed: !!currentProfile?.last_format_changed,
          format_change_summary: currentProfile?.format_change_summary || null,
          trusted,
          learned_rules: currentProfile?.learned_rules || {},
          recipe: currentProfile?.recipe || {},
          force_llm_fallback: fallback,
          golden_examples: Array.isArray(currentProfile?.golden_examples) ? currentProfile.golden_examples : [],
        },
      };
      await (ObaraBackend?.customers?.upsert?.(payload)
             || studioCrudFetch("/api/customers", { method: "POST", body: payload }));
      setOkMsg("Profile saved as new version");
      setEditing(false);
      loadVersions(customerId);
      customers.reload?.();
    } catch (error) {
      setErr(error);
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    if (!currentProfile) return;
    setFpText(JSON.stringify(currentProfile.fingerprint || {}, null, 2));
    setFallback(!!currentProfile.force_llm_fallback);
    setTrusted(!!currentProfile.trusted);
    setEditing(false);
  };

  // Diff computation
  const diffData = m(() => {
    if (!diffAgainst) return null;
    const target = versionRows.find((v) => v.id === diffAgainst);
    if (!target || !currentProfile) return null;
    return {
      target,
      diff: fpDiff(target.fingerprint || {}, currentProfile.fingerprint || {}),
    };
  }, [diffAgainst, versionRows, currentProfile?.id]);

  if (customers.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Profile Studio" title="Profile Studio" meta="loading customers…" />
        <div className="ws-content"><Card><div className="body">Loading customers…</div></Card></div>
      </div>
    );
  }
  if (customers.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Profile Studio" title="Profile Studio" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load customers"
                  action={<Btn sm onClick={customers.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(customers.error.message || customers.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  return (
    <>
      <WSTitle
        eyebrow="Quality · Profile Studio"
        title="Profile Studio"
        meta={selectedCustomer ? `${selectedCustomer.customer_name || selectedCustomer.customer_key} · v${currentProfile?.version || currentProfile?.version_no || "—"}` : "pick a customer"}
        right={<>
          <select
            className="input"
            style={{ minWidth: 240, height: 28 }}
            value={customerId}
            onChange={(ev) => onPickCustomer(ev.target.value)}
            aria-label="Pick customer"
          >
            <option value="">— select customer —</option>
            {customerList.map((c) => (
              <option key={c.id || c.customer_key} value={c.id || c.customer_key}>
                {c.customer_name || c.customer_key || (c.id ? c.id.slice(0, 8) : "—")}
              </option>
            ))}
          </select>
        </>}
      />

      <div className="ws-content">
        {okMsg && (
          <Banner kind="good" icon={Icon.check} title={okMsg} action={<Btn sm onClick={() => setOkMsg(null)}>Dismiss</Btn>}>
            <span className="mono-sm">{new Date().toLocaleTimeString()}</span>
          </Banner>
        )}
        {err && (
          <Banner kind="bad" icon={Icon.alert} title="Action failed" action={<Btn sm onClick={() => setErr(null)}>Dismiss</Btn>}>
            <span className="mono-sm">{String(err.message || err)}</span>
          </Banner>
        )}

        {!customerId && (
          <Card>
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              Select a customer above to view and edit profile versions.
            </div>
          </Card>
        )}

        {customerId && versions.loading && (
          <Card><div className="body">Loading versions…</div></Card>
        )}
        {customerId && versions.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load profile versions"
                  action={<Btn sm onClick={() => loadVersions(customerId)}>Retry</Btn>}>
            <span className="mono-sm">{String(versions.error.message || versions.error)}</span>
          </Banner>
        )}

        {customerId && currentProfile && (
          <Card title="Current fingerprint" eyebrow={`v${currentProfile.version || currentProfile.version_no || "—"} · ${currentProfile.is_current ? "is_current" : "(no is_current flag)"}`}>
            <div style={{ padding: 12, display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                <label className="lbl" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" disabled={!editing || !canWrite} checked={trusted}
                         onChange={(ev) => setTrusted(ev.target.checked)} />
                  Trusted
                </label>
                <label className="lbl" style={{ display: "flex", gap: 6, alignItems: "center" }} title="Force Claude/LLM fallback even when fingerprint matches">
                  <input type="checkbox" disabled={!editing || !canWrite} checked={fallback}
                         onChange={(ev) => setFallback(ev.target.checked)} />
                  Force LLM fallback
                </label>
                <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                  Orders processed: {currentProfile.orders_processed ?? 0}
                </span>
                {currentProfile.last_format_changed && (
                  <Chip k="warn">format change pending</Chip>
                )}
              </div>

              <textarea
                className="mono"
                rows={editing ? 16 : 10}
                readOnly={!editing}
                value={fpText}
                onChange={(ev) => setFpText(ev.target.value)}
                style={{ width: "100%", fontFamily: "var(--mono)" }}
              />

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                {!editing && canWrite && (
                  <Btn sm kind="primary" onClick={() => setEditing(true)}>{Icon.edit} Edit fingerprint</Btn>
                )}
                {editing && (
                  <>
                    <Btn sm kind="ghost" onClick={cancelEdit} disabled={saving}>Cancel</Btn>
                    <Btn sm kind="primary" disabled={saving} onClick={saveProfile}>
                      {saving ? "Saving…" : "Save as new version"}
                    </Btn>
                  </>
                )}
              </div>

              <div className="hint mono-sm" style={{ color: "var(--ink-3)" }}>
                Save inserts a new is_current row at version+1. Previous current row
                is preserved in history.
              </div>
            </div>
          </Card>
        )}

        {customerId && versionRows.length > 0 && (
          <Card title="Version history" eyebrow={`${versionRows.length} versions · newest first`} flush>
            <table className="tbl">
              <thead><tr>
                <th>Version</th>
                <th>Created</th>
                <th>Author</th>
                <th>Fingerprint</th>
                <th></th>
                <th style={{ width: 220 }}></th>
              </tr></thead>
              <tbody>
                {versionRows.map((v) => {
                  const fp = typeof v.fingerprint === "string" ? v.fingerprint : (v.fingerprint ? JSON.stringify(v.fingerprint) : "");
                  const fpPreview = fp ? (fp.length > 52 ? fp.slice(0, 52) + "…" : fp) : "—";
                  const isCurrent = v.is_current || v.current === true;
                  return (
                    <tr key={v.id}>
                      <td className="mono"><span className="pri">v{v.version_no || v.version || "—"}</span></td>
                      <td className="mono-sm">{v.created_at ? `${new Date(v.created_at).toLocaleDateString("en-IN")} · ${ageLabel(v.created_at)}` : "—"}</td>
                      <td className="mono-sm">{v.created_by || v.author || "—"}</td>
                      <td className="mono-sm" title={fp}>{fpPreview}</td>
                      <td>{isCurrent ? <Chip k="good">current</Chip> : null}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {!isCurrent && (
                          <Btn sm kind="ghost" onClick={() => setDiffAgainst(v.id)} title="Compare current to this version">
                            Diff
                          </Btn>
                        )}
                        {!isCurrent && canWrite && (
                          <Btn sm
                               disabled={rollingBack === v.id}
                               onClick={() => doRollback(v.id)}>
                            {rollingBack === v.id ? "rolling…" : "rollback"}
                          </Btn>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {diffData && (
        <div className="modal-backdrop" onClick={() => setDiffAgainst(null)}>
          <div className="modal" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 920, maxHeight: "80vh", overflow: "auto" }}>
            <div className="modal-h">
              <span className="ti">
                Diff · v{diffData.target.version_no || diffData.target.version || "—"} → current
              </span>
              <Btn icon kind="ghost" sm onClick={() => setDiffAgainst(null)}>{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <div className="mono-sm" style={{ display: "flex", gap: 16, color: "var(--ink-3)" }}>
                <span>Added: <b style={{ color: "var(--green-2, #2c7)" }}>{diffData.diff.added.length}</b></span>
                <span>Removed: <b style={{ color: "var(--rust)" }}>{diffData.diff.removed.length}</b></span>
                <span>Changed: <b style={{ color: "var(--amber-2)" }}>{diffData.diff.changed.length}</b></span>
                <span>Same: <span style={{ color: "var(--ink-3)" }}>{diffData.diff.same.length}</span></span>
              </div>

              {diffData.diff.added.length === 0 && diffData.diff.removed.length === 0 && diffData.diff.changed.length === 0 ? (
                <div className="body mono-sm" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                  Fingerprints are identical at every flat key.
                </div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th>Kind</th>
                    <th>Path</th>
                    <th>Before (v{diffData.target.version_no || diffData.target.version || "—"})</th>
                    <th>After (current)</th>
                  </tr></thead>
                  <tbody>
                    {diffData.diff.changed.map((d) => (
                      <tr key={"c:" + d.path}>
                        <td><Chip k="warn">changed</Chip></td>
                        <td className="mono-sm">{d.path}</td>
                        <td className="mono-sm">{fpPreviewVal(d.before)}</td>
                        <td className="mono-sm">{fpPreviewVal(d.after)}</td>
                      </tr>
                    ))}
                    {diffData.diff.added.map((d) => (
                      <tr key={"a:" + d.path}>
                        <td><Chip k="good">added</Chip></td>
                        <td className="mono-sm">{d.path}</td>
                        <td className="mono-sm" style={{ color: "var(--ink-4)" }}>—</td>
                        <td className="mono-sm">{fpPreviewVal(d.after)}</td>
                      </tr>
                    ))}
                    {diffData.diff.removed.map((d) => (
                      <tr key={"r:" + d.path}>
                        <td><Chip k="bad">removed</Chip></td>
                        <td className="mono-sm">{d.path}</td>
                        <td className="mono-sm">{fpPreviewVal(d.before)}</td>
                        <td className="mono-sm" style={{ color: "var(--ink-4)" }}>—</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={() => setDiffAgainst(null)}>Close</Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
};


export default WiredStudioCRUD;
