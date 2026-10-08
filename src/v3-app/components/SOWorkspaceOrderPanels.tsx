// SO Workspace order panels — extracted verbatim from screens/so-workspace.tsx
// (order header-fields editor, order-line tax components, Tally tab). Split out
// to keep so-workspace.tsx maintainable. No behavior change.

import React, { useState, useEffect } from "react";
import { Banner, Btn, Card, Chip, KV, fmtINR } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// GET /api/customers/contacts returns at most this many rows (the .limit in
// src/api/customers/contacts.js). Keep the two in step.
const CONTACTS_LIST_CAP = 500;

// Order header-fields editor. Mounted inside the SO workspace as the
// `Header fields` tab. Carries the six new columns added by migration
// 106: dispatch_mode, registration_serial_no, incoterm_code,
// delivery_terms, vendor_code, delivery_point_contact_id. Each save
// flows through the existing /api/orders/[id] PATCH endpoint with
// APPROVE_INPUTS already extended to accept them.
export const OrderHeaderEditor: React.FC<{ order: any; onSaved: () => void }> = ({ order, onSaved }) => {
  const buildDraft = (o: any) => ({
    dispatch_mode: o.dispatch_mode || "",
    registration_serial_no: o.registration_serial_no || "",
    incoterm_code: o.incoterm_code || o.incoterms || "",
    delivery_terms: o.delivery_terms || "",
    vendor_code: o.vendor_code || "",
    delivery_point_contact_id: o.delivery_point_contact_id || "",
    committed_delivery_date: (o.committed_delivery_date || "").slice(0, 10),
  });
  const [draft, setDraft] = React.useState<any>(buildDraft(order));
  // Audit fix May 2026: useState only runs its initialiser on the
  // first mount. When the parent re-renders with a fresh order
  // prop after save (setBump -> refetch), the draft retained the
  // pre-save snapshot and a second save would push stale values
  // over a concurrent edit. Re-sync the draft whenever the order
  // identity or updated_at changes.
  React.useEffect(() => {
    setDraft(buildDraft(order));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id, order.updated_at]);
  const [reference, setReference] = React.useState<any>({ incoterms: [] });
  // The customer's contacts for the delivery contact picker. null until
  // the list arrives, so the picker can tell "not loaded" apart from
  // "this customer has no such contact".
  const [contactRows, setContactRows] = React.useState<any[] | null>(null);
  const [contactsFailed, setContactsFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg: any = (AnvilBackend as any)?.getConfig?.() || {};
        const session: any = (AnvilBackend as any)?.getSession?.() || null;
        const headers: any = { "Content-Type": "application/json" };
        if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
        if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
        const base = cfg.url.replace(/\/+$/, "");
        const refResp = await fetch(base + "/api/admin/item_reference", { headers }).then((r) => r.ok ? r.json() : { incoterms: [] });
        if (cancelled) return;
        setReference({ incoterms: refResp.incoterms || [] });
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);

  // Contacts load through the client wrapper (GET /api/customers/contacts),
  // the same call CustomerContactsPanel makes. This used to fetch
  // /api/customer_contacts, a route the router never had: it 404ed, so the
  // picker only ever offered "Not set" and a saved contact was invisible.
  // Loaded on its own so a contacts failure cannot cost the incoterm list.
  React.useEffect(() => {
    let cancelled = false;
    setContactRows(null);
    setContactsFailed(false);
    // No customer means no list to check a saved contact against, so the
    // rows stay null (unknown) rather than an empty list that would read
    // as "this customer has no such contact".
    if (!order.customer_id) return;
    Promise.resolve(AnvilBackend?.customers?.listContacts?.({ customer_id: order.customer_id }))
      .then((resp: any) => {
        if (cancelled) return;
        const rows = Array.isArray(resp) ? resp : resp?.contacts;
        if (Array.isArray(rows)) setContactRows(rows);
        else setContactsFailed(true);
      })
      .catch(() => { if (!cancelled) setContactsFailed(true); });
    return () => { cancelled = true; };
  }, [order.customer_id]);

  const save = async () => {
    setBusy(true);
    try {
      // Audit fix May 2026: flip _header_field_sources for any
      // field the operator actually changed from the persisted
      // value, so the OCR pill drops after save instead of
      // re-rendering on the new server data. Stamped inside
      // result.salesOrder._header_field_sources, where so-intake
      // initially writes it. Side-effect: PATCHing `result`
      // invalidates approval per orders/[id].js:131 - that's the
      // correct behaviour (header-field edits should require
      // re-approval).
      const headerSourcesPrev: Record<string, string> =
        (order.result?.salesOrder?._header_field_sources) || {};
      const headerSourcesNext = { ...headerSourcesPrev };
      const HEADER_KEYS = [
        "dispatch_mode", "registration_serial_no", "incoterm_code",
        "delivery_terms", "vendor_code", "delivery_point_contact_id",
        "committed_delivery_date",
      ];
      let anyChanged = false;
      for (const k of HEADER_KEYS) {
        if ((draft[k] || "") !== (order[k] || "")) {
          anyChanged = true;
          if (headerSourcesNext[k] === "ocr") headerSourcesNext[k] = "human";
        }
      }
      const patch: any = {
        dispatch_mode: draft.dispatch_mode || null,
        registration_serial_no: draft.registration_serial_no || null,
        incoterm_code: draft.incoterm_code || null,
        delivery_terms: draft.delivery_terms || null,
        vendor_code: draft.vendor_code || null,
        delivery_point_contact_id: draft.delivery_point_contact_id || null,
        committed_delivery_date: draft.committed_delivery_date || null,
      };
      if (anyChanged && Object.keys(headerSourcesNext).length) {
        patch.result = {
          ...(order.result || {}),
          salesOrder: {
            ...(order.result?.salesOrder || {}),
            _header_field_sources: headerSourcesNext,
          },
        };
      }
      await AnvilBackend?.orders?.update?.(order.id, patch);
      window.notifySuccess?.("Header fields saved", order.po_number || order.id.slice(0, 8));
      onSaved();
    } catch (err: any) {
      window.notifyError?.("Could not save header fields", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  // Per-field provenance map populated by so-intake when the
  // extractor returned the value. We render "from PO" next to a
  // field whose label is still equal to the persisted column value;
  // once the operator types, the pill drops and the field reads as
  // operator-set. Stored under result.salesOrder._header_field_sources
  // so no schema migration is required.
  const headerSources: Record<string, string> = (order.result?.salesOrder?._header_field_sources) || {};
  const fieldOcr = (key: string, persistedValue: any, draftValue: any) =>
    headerSources[key] === "ocr" && (persistedValue || "") === (draftValue || "")
      ? <Chip k="ghost">OCR</Chip>
      : null;

  const labelWithPill = (text: string, key: string, persistedValue: any, draftValue: any) => (
    <label className="mono-sm" style={{ color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
      <span>{text}</span>
      {fieldOcr(key, persistedValue, draftValue)}
    </label>
  );

  // customer_contacts carries the person's name in `name`.
  const contactLabel = (c: any) => c?.name || c?.email || String(c?.id || "").slice(0, 8);
  // Inactive contacts (migration 128) are not offered for a new pick. A row
  // without is_active predates that column and counts as active.
  const activeContacts = (contactRows || []).filter((c: any) => c && c.is_active !== false);
  // The order can hold a contact the picker does not offer: one since
  // marked inactive, one on another customer, one past the list cap, or
  // any while the list is not loaded (or the order has no customer). Give
  // it its own option so it stays visible and can be cleared, instead of
  // the select showing "Not set" while every save quietly writes the
  // hidden id back.
  const savedContactId: string = draft.delivery_point_contact_id || "";
  const savedContactUnlisted = !!savedContactId && !activeContacts.some((c: any) => c.id === savedContactId);
  const savedContactRow = savedContactUnlisted ? (contactRows || []).find((c: any) => c && c.id === savedContactId) : null;
  // Absence from the list proves the contact is not on this customer only
  // when the list is complete. GET /api/customers/contacts stops at
  // CONTACTS_LIST_CAP rows (src/api/customers/contacts.js), so a full page
  // may simply have cut the saved contact off.
  const contactsListComplete = !!contactRows && contactRows.length < CONTACTS_LIST_CAP;
  const savedContactLabel = savedContactRow
    ? contactLabel(savedContactRow) + " (inactive)"
    : "Saved contact " + savedContactId.slice(0, 8) + (contactsListComplete ? " (not on this customer)" : "");

  return (
    <Card title="Order header fields" eyebrow="dispatch . terms . vendor mapping . delivery contact">
      <Banner kind="info">
        These fields apply to the whole order: the SO PDF, the Tally
        voucher, and the customer ack copy them verbatim. Values with
        an <Chip k="ghost">OCR</Chip> pill were auto-detected from
        the PO at intake. Edit any field to override; saving clears
        the OCR pill so the next reviewer can see the override.
      </Banner>
      <div className="row" style={{ gap: 14, flexWrap: "wrap", marginTop: 12 }}>
        <div style={{ flex: "1 1 220px" }}>
          {labelWithPill("Dispatch mode", "dispatch_mode", order.dispatch_mode, draft.dispatch_mode)}
          <select className="select" value={draft.dispatch_mode} onChange={(e) => setDraft({ ...draft, dispatch_mode: e.target.value })}>
            <option value="">Not set</option>
            <option value="By Ocean">By Ocean</option>
            <option value="By Air">By Air</option>
            <option value="By Road">By Road</option>
            <option value="By Rail">By Rail</option>
            <option value="By Courier">By Courier</option>
            <option value="Self Pickup">Self Pickup</option>
          </select>
        </div>
        <div style={{ flex: "1 1 220px" }}>
          {labelWithPill("Incoterm", "incoterm_code", order.incoterm_code, draft.incoterm_code)}
          <select className="select" value={draft.incoterm_code} onChange={(e) => setDraft({ ...draft, incoterm_code: e.target.value })}>
            <option value="">Not set</option>
            {(reference.incoterms || []).map((c: any) => (
              <option key={c.code} value={c.code}>{c.code} . {c.label}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: "1 1 220px" }}>
          {labelWithPill("Registration serial no", "registration_serial_no", order.registration_serial_no, draft.registration_serial_no)}
          <input className="input mono" value={draft.registration_serial_no} onChange={(e) => setDraft({ ...draft, registration_serial_no: e.target.value })} />
        </div>
        <div style={{ flex: "1 1 220px" }}>
          {labelWithPill("Vendor code (as buyer refers to us)", "vendor_code", order.vendor_code, draft.vendor_code)}
          <input className="input mono" value={draft.vendor_code} onChange={(e) => setDraft({ ...draft, vendor_code: e.target.value })} placeholder="e.g., TH1M" />
        </div>
        <div style={{ flex: "1 1 220px" }}>
          {labelWithPill("Delivery point contact", "delivery_point_contact_id", order.delivery_point_contact_id, draft.delivery_point_contact_id)}
          <select className="select" aria-label="Delivery point contact" value={savedContactId} onChange={(e) => setDraft({ ...draft, delivery_point_contact_id: e.target.value })}>
            <option value="">Not set</option>
            {savedContactUnlisted && <option value={savedContactId}>{savedContactLabel}</option>}
            {activeContacts.map((c: any) => (
              <option key={c.id} value={c.id}>{contactLabel(c)}</option>
            ))}
          </select>
          {contactsFailed && (
            <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 4 }}>{"Could not load this customer's contacts."}</div>
          )}
        </div>
        <div style={{ flex: "1 1 220px" }}>
          {labelWithPill("Committed delivery date", "committed_delivery_date", order.committed_delivery_date, draft.committed_delivery_date)}
          <input className="input mono" type="date" value={draft.committed_delivery_date || ""} onChange={(e) => setDraft({ ...draft, committed_delivery_date: e.target.value })} />
          <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 4 }}>Date we promised the customer. Feeds on-time-delivery (OTD) tracking.</div>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        {labelWithPill("Terms of delivery (free text)", "delivery_terms", order.delivery_terms, draft.delivery_terms)}
        <textarea className="input" rows={3} style={{ width: "100%" }} value={draft.delivery_terms} onChange={(e) => setDraft({ ...draft, delivery_terms: e.target.value })} placeholder="e.g., Door delivery during business hours. Wooden box must remain dry." />
      </div>
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <Btn sm kind="primary" disabled={busy} onClick={save}>{busy ? "Saving..." : "Save header"}</Btn>
      </div>

      <div style={{ marginTop: 18, borderTop: "1px solid var(--hairline-2)", paddingTop: 14 }}>
        <OrderLineTaxComponents orderId={order.id} lines={order.result?.salesOrder?.lineItems || []} />
      </div>
    </Card>
  );
};

// Per-line tax + charge decomposition panel. Reads / writes
// /api/admin/order_line_tax_components. The 15 component codes
// (SGST, CGST, IGST, UTGST, Cess, Excise, Ed. Cess, S-VAT, C-VAT,
// Tooling, P&F, Freight, Insurance, Handling, Others) are loaded
// from the global reference table via /api/admin/item_reference.
export const OrderLineTaxComponents: React.FC<{ orderId: string; lines: any[] }> = ({ orderId, lines }) => {
  const [components, setComponents] = React.useState<any[]>([]);
  const [codes, setCodes] = React.useState<any[]>([]);
  const [draft, setDraft] = React.useState<any>({ line_index: 0, component_code: "sgst", amount: 0 });

  const headers = () => {
    const cfg: any = (AnvilBackend as any)?.getConfig?.() || {};
    const session: any = (AnvilBackend as any)?.getSession?.() || null;
    const h: any = { "Content-Type": "application/json" };
    if (session?.access_token) h["Authorization"] = "Bearer " + session.access_token;
    if (cfg.tenantId) h["x-anvil-tenant"] = cfg.tenantId;
    return { h, base: cfg.url.replace(/\/+$/, "") };
  };

  const reload = React.useCallback(async () => {
    try {
      const { h, base } = headers();
      const [tc, ref] = await Promise.all([
        fetch(base + "/api/admin/order_line_tax_components?order_id=" + orderId, { headers: h }).then((r) => r.ok ? r.json() : { components: [] }),
        fetch(base + "/api/admin/item_reference", { headers: h }).then((r) => r.ok ? r.json() : { tax_component_codes: [] }),
      ]);
      setComponents(tc.components || []);
      setCodes(ref.tax_component_codes || []);
    } catch (_) {}
  }, [orderId]);

  React.useEffect(() => { reload(); }, [reload]);

  const save = async () => {
    if (!draft.component_code || draft.line_index == null) return;
    const { h, base } = headers();
    const body = JSON.stringify({ order_id: orderId, components: [draft] });
    try {
      const r = await fetch(base + "/api/admin/order_line_tax_components", { method: "POST", headers: h, body });
      if (!r.ok) throw new Error("HTTP " + r.status);
      window.notifySuccess?.("Tax component saved", draft.component_code);
      setDraft({ line_index: 0, component_code: "sgst", amount: 0 });
      reload();
    } catch (e: any) {
      window.notifyError?.("Could not save tax component", e?.message || String(e));
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Remove this tax component?")) return;
    const { h, base } = headers();
    try {
      const r = await fetch(base + "/api/admin/order_line_tax_components?id=" + id, { method: "DELETE", headers: h });
      if (!r.ok) throw new Error("HTTP " + r.status);
      reload();
    } catch (e: any) {
      window.notifyError?.("Could not delete", e?.message || String(e));
    }
  };

  return (
    <>
      <div className="row" style={{ alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Per-line tax + charge decomposition</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{components.length} component{components.length === 1 ? "" : "s"}</div>
        </div>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }}>
        <div>
          <label className="mono-sm">Line</label>
          <select className="select" value={draft.line_index} onChange={(e) => setDraft({ ...draft, line_index: Number(e.target.value) })}>
            {lines.length === 0 && <option value={0}>0</option>}
            {lines.map((_, i) => <option key={i} value={i}>Line {i + 1}</option>)}
          </select>
        </div>
        <div>
          <label className="mono-sm">Component</label>
          <select className="select" value={draft.component_code} onChange={(e) => setDraft({ ...draft, component_code: e.target.value })}>
            {(codes.length > 0 ? codes : [{ code: "sgst", label: "SGST" }, { code: "cgst", label: "CGST" }, { code: "igst", label: "IGST" }]).map((c: any) => (
              <option key={c.code} value={c.code}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mono-sm">Amount</label>
          <input className="input mono r" type="number" step="0.01" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) })} />
        </div>
        <div>
          <label className="mono-sm">Rate %</label>
          <input className="input mono r" type="number" step="0.01" value={draft.rate_pct ?? ""} onChange={(e) => setDraft({ ...draft, rate_pct: e.target.value === "" ? null : Number(e.target.value) })} />
        </div>
        <Btn sm kind="primary" onClick={save}>Add</Btn>
      </div>
      {components.length === 0 ? (
        <div className="mono-sm" style={{ color: "var(--ink-3)" }}>No tax components on file. Add SGST / CGST / IGST / Tooling / P&F etc above.</div>
      ) : (
        <table className="tbl">
          <thead><tr>
            <th>Line</th><th>Component</th><th className="r">Rate %</th><th className="r">Amount</th><th></th>
          </tr></thead>
          <tbody>
            {components.map((c) => (
              <tr key={c.id}>
                <td className="mono-sm">{c.line_index + 1}</td>
                <td><span className="pri">{c.component_label || c.component_code.toUpperCase()}</span></td>
                <td className="r mono">{c.rate_pct != null ? Number(c.rate_pct).toFixed(2) + "%" : "-"}</td>
                <td className="r mono">{fmtINR(Number(c.amount))}</td>
                <td className="r"><Btn sm kind="ghost" onClick={() => remove(c.id)}>remove</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
};

// ============================================================
// Phase F.6 Tally tab. Renders voucher record + Tally-side state,
// drift findings, run history, and a "Reconcile now" button that
// fires /api/tally/reconcile?mode=drift_check scoped to this order.
// ============================================================

export const TallyTab: React.FC<{
  orderId: string;
  order: any;
  onRefresh: () => void;
}> = ({ orderId, order, onRefresh }) => {
  const [recon, setRecon] = useState<{ data: any; loading: boolean; error: any }>({ data: null, loading: true, error: null });
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  // The tenant's sales-order processing mode (Admin > Sales-order processing).
  // In Mode B the push and the retry drain both refuse, so this tab says so
  // up front instead of leaving the operator to find out from a 409.
  const [mode, setMode] = useState<{ mode: string; label?: string } | null>(null);
  const [modeErr, setModeErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve((AnvilBackend as any)?.docai?.soProcessingMode?.())
      .then((r: any) => {
        if (!live) return;
        const m = r?.mode === "B" ? "B" : "A";
        // The label comes from the API, so this tab keeps no second copy of
        // what the modes are called.
        setMode({ mode: m, label: r?.modes?.[m]?.label });
      })
      .catch((e: any) => { if (live) setModeErr(e?.message || String(e)); });
    return () => { live = false; };
  }, []);

  const reload = React.useCallback(async () => {
    setRecon({ data: null, loading: true, error: null });
    try {
      const next = await (AnvilBackend as any)?.tally?.getOrderRecon?.(orderId);
      setRecon({ data: next, loading: false, error: null });
    } catch (err) {
      setRecon({ data: null, loading: false, error: err });
    }
  }, [orderId]);

  React.useEffect(() => { reload(); }, [reload]);

  const reconcileNow = async () => {
    setBusy(true); setBusyMsg(null);
    try {
      const out = await (AnvilBackend as any)?.tally?.driftCheck?.({
        scope: "order",
        scopeValue: orderId,
        trigger: "workspace",
      });
      setBusyMsg(
        out?.vouchers_drifted
          ? `Drift detected: ${out.vouchers_drifted} finding(s)`
          : "Clean: no drift detected"
      );
      await reload();
      onRefresh();
    } catch (e: any) {
      setBusyMsg("Error: " + String(e?.message || e));
    } finally { setBusy(false); }
  };

  const resolveFinding = async (findingId: string) => {
    try {
      await (AnvilBackend as any)?.tally?.resolveFinding?.(findingId);
      await reload();
    } catch (_e) { /* no-op */ }
  };

  const vrec = recon.data?.voucher_record || null;
  const findings: any[] = recon.data?.findings || [];
  const unresolved = findings.filter((f) => !f.resolved_at);
  const drift_summary = vrec?.drift_summary || {};
  const driftKeys = Object.keys(drift_summary);

  const tally_status = order.tally_status;
  const eyebrow = order.status === "EXPORTED_TO_TALLY" ? "exported"
    : order.status === "FAILED_TALLY_IMPORT" ? "failed"
    : order.status === "TALLY_RECONCILED" ? "reconciled"
    : "queued";

  return (
    <>
      {vrec?.last_drift_at && unresolved.length > 0 && (
        <Banner kind="bad" icon={Icon.alert} title={`Drift detected ${driftKeys.length === 0 ? "" : "(" + driftKeys.join(", ") + ")"}`}>
          <span className="mono-sm">
            {unresolved.length} unresolved finding{unresolved.length === 1 ? "" : "s"} since {new Date(vrec.last_drift_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}.
          </span>
        </Banner>
      )}

      {mode && (
        <Banner
          kind={mode.mode === "B" ? "warn" : "info"}
          title={"Mode " + mode.mode + (mode.label ? ": " + mode.label : "")}
        >
          <span className="mono-sm">
            {mode.mode === "B"
              ? "Your team enters this sales order in Tally by hand. Anvil does not push it: a push or a queued retry is refused."
              : "Anvil pushes this sales order to Tally as a voucher once it is approved."}
          </span>
        </Banner>
      )}
      {modeErr && (
        <Banner kind="warn" title="Sales-order processing mode unknown">
          <span className="mono-sm">Could not read the mode: {modeErr}</span>
        </Banner>
      )}

      <Card
        title="Tally"
        eyebrow={eyebrow}
        right={
          <Btn sm kind="primary" disabled={busy} onClick={reconcileNow}>
            {busy ? "Reconciling…" : "Reconcile now"}
          </Btn>
        }
      >
        <KV rows={[
          ["Voucher no", vrec?.voucher_no || "—"],
          ["Voucher status", vrec?.status || tally_status || "—"],
          ["Last reconciled", vrec?.last_reconciled_at ? new Date(vrec.last_reconciled_at).toLocaleString("en-IN") : "never"],
          ["Last drift", vrec?.last_drift_at ? new Date(vrec.last_drift_at).toLocaleString("en-IN") : "(no drift)"],
          ["Hash", order.payload_hash || "—"],
          ["Pushed", order.status === "EXPORTED_TO_TALLY" || order.status === "TALLY_RECONCILED" ? "yes" : "no"],
        ]} />
        {busyMsg && (
          <div className="mono-sm" style={{ marginTop: 8, color: "var(--ink-3)" }}>{busyMsg}</div>
        )}
      </Card>

      <Card title="Reconciliation findings" eyebrow={`${findings.length} total · ${unresolved.length} unresolved`} flush>
        {findings.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No reconciliation findings for this order. Run "Reconcile now" to check.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>When</th>
              <th>Kind</th>
              <th>Severity</th>
              <th>Diff %</th>
              <th>Expected</th>
              <th>Actual</th>
              <th>Auto-fix</th>
              <th>Status</th>
              <th></th>
            </tr></thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id}>
                  <td className="mono-sm">{f.created_at ? new Date(f.created_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                  <td className="mono-sm">{f.finding_kind}</td>
                  <td>
                    <Chip k={f.severity === "critical" || f.severity === "error" ? "bad" : f.severity === "warn" ? "warn" : "info"}>
                      {f.severity}
                    </Chip>
                  </td>
                  <td className="r mono">{f.diff_pct != null ? Number(f.diff_pct).toFixed(2) + "%" : "—"}</td>
                  <td className="mono-sm" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.expected ? JSON.stringify(f.expected) : "—"}
                  </td>
                  <td className="mono-sm" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.actual ? JSON.stringify(f.actual) : "—"}
                  </td>
                  <td className="mono-sm">{f.auto_fix_applied || "—"}</td>
                  <td>
                    <Chip k={f.resolved_at ? "good" : "warn"}>
                      {f.resolved_at ? "resolved" : "open"}
                    </Chip>
                  </td>
                  <td>
                    {!f.resolved_at && (
                      <Btn sm kind="ghost" onClick={() => resolveFinding(f.id)}>Mark resolved</Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};
