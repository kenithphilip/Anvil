import React, { useEffect, useState } from "react";
import { ageLabel, useFetch } from "../lib/helpers.js";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";
import { ObaraBackend } from "../lib/api.js";

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

        <Card flush>
          {filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              {query ? <>No customers match <span className="mono">{query}</span>. <a onClick={() => setQuery("")} style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>clear search</a></> : "No customers yet."}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Customer</th>
                <th>Key</th>
                <th>GSTIN</th>
                <th>State</th>
                <th>Type</th>
                <th className="r">Last SO</th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => {
                  const tc = CUSTOMER_TYPE_CHIP(r.customer_type || r.type);
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
