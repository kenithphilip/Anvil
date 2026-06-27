import React, { useEffect, useState } from "react";
import { ageLabel, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { CustomerContactsPanel } from "../components/CustomerContactsPanel";
import { CustomerHierarchyPanel } from "../components/CustomerHierarchyPanel";
import { CustomerRegistrationPanel } from "../components/CustomerRegistrationPanel";

// Create-customer modal. Customers usually auto-register from orders/email/
// BOM. Admins apply directly; everyone else submits for approval. The parent
// supplies onSubmit(payload) + whether this is the direct-apply path.
const NewCustomerModal: React.FC<{ onClose: () => void; onSubmit: (payload: any) => Promise<void>; apply: boolean }> = ({ onClose, onSubmit, apply }) => {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [gstin, setGstin] = useState("");
  const [currency, setCurrency] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) { window.notifyError?.("Name required", "Enter a customer name."); return; }
    setBusy(true);
    try {
      await onSubmit({ customer_name: name.trim(), customer_key: key.trim() || undefined, gstin: gstin.trim() || undefined, currency: currency.trim() || undefined });
    } finally { setBusy(false); }
  };
  return (
    <div className="cmdk-bg" onClick={onClose} role="dialog" aria-modal="true" aria-label="New customer">
      <div className="drawer" onClick={(e) => e.stopPropagation()} style={{ width: 460, maxHeight: "80vh" }}>
        <div className="drawer-h">
          <div><div className="h-eyebrow">Customers</div><div className="h2" style={{ marginTop: 2 }}>New customer</div></div>
          <button className="btn icon sm ghost" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close">{Icon.x}</button>
        </div>
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {!apply && <div className="mono-sm" style={{ color: "var(--ink-4)" }}>This will be submitted for approval before it is created.</div>}
          <div><div className="label">customer name *</div><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tata Motors Ltd." /></div>
          <div><div className="label">customer key (optional)</div><input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="auto from name if blank" /></div>
          <div><div className="label">GSTIN (optional)</div><input className="input mono" value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="29ABCDE1234F1Z5" /></div>
          <div><div className="label">currency (optional)</div><input className="input mono" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="INR" maxLength={3} /></div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Btn sm kind="ghost" onClick={onClose}>Cancel</Btn>
            <Btn sm kind="primary" disabled={busy} onClick={submit}>{busy ? "Saving…" : (apply ? "Create customer" : "Submit for approval")}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
};

// Read `id` from the hash so the customers screen can render a
// detail panel inline when a row is clicked. Avoids needing a
// separate route + screen file for the detail view.
const customerIdFromHash = (): string | null => {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash || "";
  const q = hash.split("?")[1];
  if (!q) return null;
  return new URLSearchParams(q).get("id");
};

// ============================================================
// ANVIL v3 — wired Customers
// Wave E · Master data
// Reads via ObaraBackend.customers.list (api/customers GET)
// ============================================================

const customerRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.customers)) return resp.customers;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

// Audit P9.3: customer health chip. Maps the API's green / yellow /
// red band into a Chip primitive kind. Score-only fallback when the
// band is absent (older rows scored before P7.3 dropped the band
// onto the row); otherwise the band wins.
const CUSTOMER_HEALTH_CHIP = (band, score) => {
  if (band === "green") return { k: "good", label: "green" + (Number.isFinite(Number(score)) ? " " + Math.round(Number(score)) : "") };
  if (band === "yellow") return { k: "warn", label: "yellow" + (Number.isFinite(Number(score)) ? " " + Math.round(Number(score)) : "") };
  if (band === "red") return { k: "bad", label: "red" + (Number.isFinite(Number(score)) ? " " + Math.round(Number(score)) : "") };
  if (Number.isFinite(Number(score))) {
    const n = Math.round(Number(score));
    if (n >= 75) return { k: "good", label: "green " + n };
    if (n >= 45) return { k: "warn", label: "yellow " + n };
    return { k: "bad", label: "red " + n };
  }
  return { k: "ghost", label: "health?" };
};

const CUSTOMER_TYPE_CHIP = (t) => {
  const map = {
    AUTO_OEM: { k: "info", label: "auto oem" },
    TIER_ONE: { k: "warn", label: "tier one" },
    OTHER:    { k: "ghost", label: "other" },
  };
  return map[t] || { k: "ghost", label: (t || "—").toLowerCase() };
};

const WiredCustomers = () => {
  const list = useFetch(
    () => ObaraBackend?.customers?.list?.() || Promise.resolve({ customers: [] }),
    []
  );
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(customerIdFromHash());
  // Audit P9.3: per-customer refresh-health spinner.
  const [refreshingHealthId, setRefreshingHealthId] = useState<string | null>(null);
  // Customer data entry with approval. Admins apply directly; write-roles
  // submit a change request; approvers decide the queue.
  const role = RBAC.role();
  const canApply = RBAC.isAdmin();
  const canSubmit = ["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator"].includes(role);
  const canApprove = ["sales_manager", "finance", "admin"].includes(role);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<any[] | null>(null);
  const loadPending = () => {
    if (!canApprove) return;
    Promise.resolve(ObaraBackend?.customers?.listChangeRequests?.({ status: "pending" }))
      .then((r: any) => setPending(Array.isArray(r) ? r : (r?.requests || [])))
      .catch(() => setPending([]));
  };
  useEffect(loadPending, [canApprove]);
  const decide = async (id: string, decision: "approve" | "reject") => {
    const reason = decision === "reject" ? (window.prompt("Reason for rejection? (optional)") || "") : undefined;
    try {
      await ObaraBackend?.customers?.decideChangeRequest?.(id, decision, reason);
      window.notifySuccess?.(`Change ${decision === "approve" ? "approved" : "rejected"}`, "");
      loadPending();
      list.reload();
    } catch (e: any) { window.notifyError?.(`Could not ${decision}`, e?.message || String(e)); }
  };
  // Inline edit-details form for the selected customer.
  const [editDraft, setEditDraft] = useState<any>({});
  const startEdit = (c: any) => { setEditDraft({ customer_name: c.customer_name || "", gstin: c.gstin || "", currency: c.currency || "", customer_type: c.customer_type || "" }); setEditing(true); };
  const submitEdit = async (c: any) => {
    const payload: any = {};
    for (const k of ["customer_name", "gstin", "currency", "customer_type"]) {
      const v = (editDraft[k] || "").trim?.() ?? editDraft[k];
      if (v !== (c[k] || "")) payload[k] = v || null;
    }
    if (!Object.keys(payload).length) { setEditing(false); return; }
    try {
      if (canApply) {
        await ObaraBackend?.customers?.upsert?.({ customer_key: c.customer_key, ...payload });
        window.notifySuccess?.("Customer updated", c.customer_name || c.customer_key);
        list.reload();
      } else {
        await ObaraBackend?.customers?.submitChangeRequest?.({ change_type: "update", target_customer_id: c.id, payload });
        window.notifySuccess?.("Submitted for approval", c.customer_name || c.customer_key);
      }
      setEditing(false);
    } catch (e: any) { window.notifyError?.("Could not save changes", e?.message || String(e)); }
  };

  // Sync the selected customer with hash changes so back/forward and
  // direct links keep state coherent.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHash = () => setSelectedId(customerIdFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Master · Customers" title="Customers" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading customers…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Master · Customers" title="Customers" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load customers"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const rows = customerRows(list.data);
  const total = rows.length;
  const byType = (t) => rows.filter((r) => (r.customer_type || r.type) === t).length;
  const autoOem = byType("AUTO_OEM");
  const tierOne = byType("TIER_ONE");
  const otherCount = rows.filter((r) => {
    const t = r.customer_type || r.type;
    return !t || (t !== "AUTO_OEM" && t !== "TIER_ONE");
  }).length;

  const selectedCustomer = selectedId
    ? rows.find((r) => r.id === selectedId || r.customer_key === selectedId) || null
    : null;
  const profilesById = (list.data && list.data.profiles) || {};
  const selectedProfile = selectedCustomer ? profilesById[selectedCustomer.id] || null : null;

  const filtered = rows.filter((r) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      (r.customer_name || "").toLowerCase().includes(q) ||
      (r.customer_key || "").toLowerCase().includes(q) ||
      (r.gstin || "").toLowerCase().includes(q)
    );
  });

  return (
    <>
      <WSTitle
        eyebrow="Master · Customers"
        title="Customers"
        meta={`${total} total · ${autoOem} auto OEM · ${tierOne} tier 1`}
        right={<>
          <input
            className="input"
            placeholder="search name, key, GSTIN…"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            style={{ width: 240, height: 28 }}
            aria-label="Search customers"
          />
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
          {(canApply || canSubmit) && <Btn sm kind="primary" onClick={() => setShowNew(true)}>{Icon.plus} New customer</Btn>}
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Total customers" v={String(total)} d="all-time in scope" />
          <KPI lbl="Auto OEM" v={String(autoOem)} d="tier-zero accounts" />
          <KPI lbl="Tier one" v={String(tierOne)} d="strategic accounts" />
          <KPI lbl="Other" v={String(otherCount)} d="long tail" />
        </KPIRow>

        {canApprove && pending && pending.length > 0 && (
          <Card title={`Pending customer changes (${pending.length})`} eyebrow="data-entry requests awaiting approval">
            <div style={{ display: "flex", flexDirection: "column" }}>
              {pending.map((r) => (
                <div key={r.id} className="row" style={{ gap: 10, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--hairline-2)", flexWrap: "wrap" }}>
                  <Chip k={r.change_type === "create" ? "good" : "info"}>{r.change_type}</Chip>
                  <span className="mono-sm" style={{ flex: 1, minWidth: 220 }}>
                    {r.change_type === "create"
                      ? (r.payload?.customer_name || "(new customer)")
                      : (rows.find((x) => x.id === r.target_customer_id)?.customer_name || (r.target_customer_id || "").slice(0, 8))}
                    {" · "}
                    <span style={{ color: "var(--ink-3)" }}>{Object.entries(r.payload || {}).map(([k, v]) => `${k}=${v}`).join(", ")}</span>
                  </span>
                  <Btn sm kind="primary" onClick={() => decide(r.id, "approve")}>Approve</Btn>
                  <Btn sm kind="ghost" onClick={() => decide(r.id, "reject")}>Reject</Btn>
                </div>
              ))}
            </div>
          </Card>
        )}

        {selectedCustomer && (
          <Card
            title={selectedCustomer.customer_name || selectedCustomer.customer_key}
            eyebrow={"customer detail · " + (selectedCustomer.customer_key || "")}
            right={<>
              <Btn sm kind={selectedCustomer.ai_health_score == null ? "live" : "ghost"} disabled={refreshingHealthId === selectedCustomer.id}
                   onClick={async () => {
                     setRefreshingHealthId(selectedCustomer.id);
                     try { await ObaraBackend?.customers?.healthScore?.(selectedCustomer.id); list.reload(); }
                     finally { setRefreshingHealthId(null); }
                   }}
                   title="Run /api/customers/health_score for this customer">
                {refreshingHealthId === selectedCustomer.id ? "Scoring..." : (selectedCustomer.ai_health_score == null ? "Score health" : "Re-score health")}
              </Btn>
              {(canApply || canSubmit) && !editing && <Btn sm kind="ghost" onClick={() => startEdit(selectedCustomer)}>{Icon.settings} Edit details</Btn>}
              <Btn sm kind="ghost" onClick={() => { setSelectedId(null); setEditing(false); }}>{Icon.x} close</Btn>
            </>}
          >
            {editing && (
              <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {!canApply && <div className="mono-sm" style={{ color: "var(--ink-4)" }}>Changes are submitted for approval before they apply.</div>}
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <div><div className="label">customer name</div><input className="input" value={editDraft.customer_name} onChange={(e) => setEditDraft((d: any) => ({ ...d, customer_name: e.target.value }))} style={{ width: 220 }} /></div>
                  <div><div className="label">GSTIN</div><input className="input mono" value={editDraft.gstin} onChange={(e) => setEditDraft((d: any) => ({ ...d, gstin: e.target.value }))} style={{ width: 180 }} /></div>
                  <div><div className="label">currency</div><input className="input mono" maxLength={3} value={editDraft.currency} onChange={(e) => setEditDraft((d: any) => ({ ...d, currency: e.target.value.toUpperCase() }))} style={{ width: 90 }} /></div>
                  <div><div className="label">type</div><input className="input mono" value={editDraft.customer_type} onChange={(e) => setEditDraft((d: any) => ({ ...d, customer_type: e.target.value }))} style={{ width: 140 }} /></div>
                </div>
                <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
                  <Btn sm kind="ghost" onClick={() => setEditing(false)}>Cancel</Btn>
                  <Btn sm kind="primary" onClick={() => submitEdit(selectedCustomer)}>{canApply ? "Save" : "Submit for approval"}</Btn>
                </div>
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
              <KV rows={[
                ["Customer name", selectedCustomer.customer_name || "—"],
                ["Customer key",  selectedCustomer.customer_key || "—"],
                ["GSTIN",         selectedCustomer.gstin || "—"],
                ["State",         selectedCustomer.state_code || selectedCustomer.state || "—"],
                ["Type",          selectedCustomer.customer_type || selectedCustomer.type || "—"],
              ]} />
              <KV rows={[
                ["Currency",       selectedCustomer.currency || "INR"],
                ["Payment terms",  selectedCustomer.payment_terms || selectedCustomer.default_payment_terms || "—"],
                ["Margin floor",   selectedCustomer.margin_floor_pct != null ? selectedCustomer.margin_floor_pct + "%" : "10% (default)"],
                ["Credit limit",   selectedCustomer.credit_limit != null ? "₹" + Number(selectedCustomer.credit_limit).toLocaleString("en-IN") : "—"],
                ["Contact email",  selectedCustomer.contact_email || "—"],
                ["Health",         (() => {
                  const c = CUSTOMER_HEALTH_CHIP(selectedCustomer.ai_health_band, selectedCustomer.ai_health_score);
                  return <Chip k={c.k}>{c.label}</Chip>;
                })()],
                ["Health reasoning", selectedCustomer.ai_health_reasoning || <span style={{ color: "var(--ink-3)" }}>—</span>],
              ]} />
            </div>
            {(selectedCustomer.bill_to || selectedCustomer.ship_to) && (
              <>
                <div className="divider" />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 10 }}>
                  <div>
                    <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 4 }}>Bill to</div>
                    <pre style={{ font: "inherit", fontSize: 12.5, color: "var(--ink-2)", whiteSpace: "pre-wrap", margin: 0 }}>
                      {selectedCustomer.bill_to || "—"}
                    </pre>
                  </div>
                  <div>
                    <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 4 }}>Ship to</div>
                    <pre style={{ font: "inherit", fontSize: 12.5, color: "var(--ink-2)", whiteSpace: "pre-wrap", margin: 0 }}>
                      {selectedCustomer.ship_to || selectedCustomer.bill_to || "—"}
                    </pre>
                  </div>
                </div>
              </>
            )}
            {selectedProfile && (
              <>
                <div className="divider" />
                <div className="row gap-md" style={{ marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <Chip k={selectedProfile.trusted ? "good" : "warn"}>
                    {selectedProfile.trusted ? "trusted profile" : "profile pending review"}
                  </Chip>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                    v{selectedProfile.version} · {selectedProfile.orders_processed || 0} orders processed
                  </span>
                  {selectedProfile.last_format_changed && (
                    <Chip k="warn">format changed recently</Chip>
                  )}
                </div>
                {/* Design-package "Format profile · v4" card surfaced
                    layout fingerprint + extractor / backend path so
                    operators can see at a glance which recipe is
                    handling this customer's POs. Both come straight
                    out of customer_format_profiles.{fingerprint,
                    recipe} (migration 001). The fingerprint preview
                    is the first 8 hex chars of a sha-style digest;
                    full JSON is one click away via the version
                    drawer on the profile_versions endpoint. */}
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                  <KV rows={[
                    ["Layout fingerprint", (() => {
                      const fp = selectedProfile.fingerprint || {};
                      const keys = Object.keys(fp);
                      if (!keys.length) return <span style={{ color: "var(--ink-3)" }}>—</span>;
                      const stamp = (fp.sha || fp.hash || fp.digest || "");
                      const preview = stamp ? String(stamp).slice(0, 12) : `${keys.length} field${keys.length === 1 ? "" : "s"}`;
                      return <span className="mono-sm" title={JSON.stringify(fp)}>{preview}</span>;
                    })()],
                    ["Extractor / backend", (() => {
                      const r = selectedProfile.recipe || {};
                      const backend = r.extractor || r.backend || r.pipeline || r.adapter;
                      if (!backend) return <span style={{ color: "var(--ink-3)" }}>—</span>;
                      return <span className="mono-sm">{String(backend)}</span>;
                    })()],
                  ]} />
                  <KV rows={[
                    ["Learned rules", (() => {
                      const lr = selectedProfile.learned_rules || {};
                      const n = Array.isArray(lr) ? lr.length : Object.keys(lr).length;
                      return <span className="mono-sm">{n} rule{n === 1 ? "" : "s"}</span>;
                    })()],
                    ["Last updated", selectedProfile.updated_at
                      ? <span className="mono-sm">{new Date(selectedProfile.updated_at).toISOString().slice(0, 10)}</span>
                      : <span style={{ color: "var(--ink-3)" }}>—</span>],
                  ]} />
                </div>
              </>
            )}
            <div className="divider" />
            <div style={{ marginTop: 10 }}>
              <CustomerHierarchyPanel
                customer={selectedCustomer}
                allCustomers={rows}
                onChanged={list.reload}
                onOpen={(id) => setSelectedId(id)}
              />
            </div>
            <div className="divider" />
            <div style={{ marginTop: 10 }}>
              <CustomerContactsPanel customerId={selectedCustomer.id} />
            </div>
            <div className="divider" />
            <div style={{ marginTop: 10 }}>
              <CustomerRegistrationPanel customerId={selectedCustomer.id} />
            </div>
          </Card>
        )}

        <Card flush>
          {filtered.length === 0 ? (
            <div className="body" style={{ padding: 28, textAlign: "center", color: "var(--ink-3)", display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
              {query ? (
                <>
                  <div>No customers match <span className="mono">{query}</span>.</div>
                  <Btn sm onClick={() => setQuery("")}>{Icon.x} clear search</Btn>
                </>
              ) : (
                <>
                  <div>No customers yet. Customers appear here once an order, email, or BOM ties them to your tenant.</div>
                  <div className="row gap-sm">
                    <Btn sm onClick={() => { window.location.hash = "#/so?new=1"; }} title="Start a new sales order, which will register the customer">
                      {Icon.plus} new sales order
                    </Btn>
                    <Btn sm kind="ghost" onClick={() => window.location.hash = "#/studio"} title="Open Profile Studio to seed a customer + extraction profile">
                      {Icon.settings} profile studio
                    </Btn>
                  </div>
                </>
              )}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Customer</th>
                <th>Health</th>
                <th>Key</th>
                <th>GSTIN</th>
                <th>State</th>
                <th>Type</th>
                <th className="r">Last SO</th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => {
                  const tc = CUSTOMER_TYPE_CHIP(r.customer_type || r.type);
                  const hc = CUSTOMER_HEALTH_CHIP(r.ai_health_band, r.ai_health_score);
                  const last = r.last_so_date || r.last_order_at || r.updated_at || r.created_at;
                  return (
                    <tr
                      key={r.id || r.customer_key}
                      tabIndex={0}
                      onClick={() => window.location.hash = `#/customers?id=${r.id || r.customer_key}`}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          window.location.hash = `#/customers?id=${r.id || r.customer_key}`;
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <td><span className="pri">{r.customer_name || "—"}</span></td>
                      <td title={r.ai_health_reasoning || (r.ai_health_score == null ? "Run /api/customers/health_score to populate" : "")}>
                        <Chip k={hc.k}>{hc.label}</Chip>
                      </td>
                      <td className="mono-sm">{r.customer_key || "—"}</td>
                      <td className="mono-sm">{r.gstin || "—"}</td>
                      <td className="mono-sm">{r.state_code || r.state || "—"}</td>
                      <td><Chip k={tc.k}>{tc.label}</Chip></td>
                      <td className="r mono">{last ? ageLabel(last) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {filtered.length > 200 && (
            <div className="mono-sm" style={{ padding: 12, textAlign: "center", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
              Showing 200 of {filtered.length} customers · refine the search.
            </div>
          )}
        </Card>
      </div>
      {showNew && (
        <NewCustomerModal
          apply={canApply}
          onClose={() => setShowNew(false)}
          onSubmit={async (payload) => {
            try {
              if (canApply) {
                const r: any = await ObaraBackend?.customers?.upsert?.(payload);
                const created = r?.customer || r;
                window.notifySuccess?.("Customer created", payload.customer_name);
                setShowNew(false);
                list.reload();
                if (created?.id) window.location.hash = `#/customers?id=${created.id}`;
              } else {
                await ObaraBackend?.customers?.submitChangeRequest?.({ change_type: "create", payload });
                window.notifySuccess?.("Submitted for approval", payload.customer_name);
                setShowNew(false);
              }
            } catch (e: any) {
              window.notifyError?.("Could not save customer", e?.message || String(e));
            }
          }}
        />
      )}
    </>
  );
};


export default WiredCustomers;
