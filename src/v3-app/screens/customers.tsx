import React, { useEffect, useState } from "react";
import { ageLabel, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { CustomerContactsPanel } from "../components/CustomerContactsPanel";
import { CustomerHierarchyPanel } from "../components/CustomerHierarchyPanel";

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
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Total customers" v={String(total)} d="all-time in scope" />
          <KPI lbl="Auto OEM" v={String(autoOem)} d="tier-zero accounts" />
          <KPI lbl="Tier one" v={String(tierOne)} d="strategic accounts" />
          <KPI lbl="Other" v={String(otherCount)} d="long tail" />
        </KPIRow>

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
              <Btn sm kind="ghost" onClick={() => { setSelectedId(null); }}>{Icon.x} close</Btn>
            </>}
          >
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
    </>
  );
};


export default WiredCustomers;
