import React, { useEffect, useState } from "react";
import { useFetch } from "../lib/helpers";
import { Banner, Btn, Card, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { useTallyBridgeStatus } from "../lib/tally-status";

// ============================================================
// ANVIL v3 — wired Tally · masters
// Wave D · Finance
// Backed by ObaraBackend.tally.listMasters(type)
// ============================================================

const TALLY_MASTER_TABS = [
  { id: "stock_item",    label: "Stock items" },
  { id: "ledger",        label: "Ledgers" },
  { id: "gst_ledger",    label: "GST ledgers" },
  { id: "uom",           label: "UoM" },
  { id: "voucher_type",  label: "Voucher types" },
];

// Shared helpers for the Wave D Tally screens. Declared here (loaded first
// in the screen-wired bundle) so push + reconcile can reuse them without
// re-declaration in the shared babel scope.
const tallyMasterRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.masters)) return resp.masters;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const tallyOrderRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.orders)) return resp.orders;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const shortHash = (h) => {
  if (!h) return "—";
  const s = String(h);
  return s.length > 10 ? s.slice(0, 10) + "…" : s;
};

const renderMastersTable = (type, rows) => {
  if (!rows.length) {
    return (
      <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
        No {TALLY_MASTER_TABS.find((t) => t.id === type)?.label.toLowerCase() || "masters"} synced yet.
      </div>
    );
  }
  if (type === "stock_item") {
    return (
      <table className="tbl">
        <thead><tr>
          <th scope="col">Name</th>
          <th scope="col">Parent group</th>
          <th scope="col">Base UoM</th>
          <th scope="col" className="r">Opening qty</th>
          <th scope="col" className="r">Closing qty</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const p = r.payload || {};
            return (
              <tr key={r.id || i}>
                <td><span className="pri">{r.name}</span></td>
                <td className="mono-sm">{p.parent_group || p.parentGroup || "—"}</td>
                <td className="mono-sm">{p.base_uom || p.baseUom || p.uom || "—"}</td>
                <td className="r mono">{p.opening_qty != null ? p.opening_qty : (p.openingQty != null ? p.openingQty : "—")}</td>
                <td className="r mono">{p.closing_qty != null ? p.closing_qty : (p.closingQty != null ? p.closingQty : "—")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
  if (type === "ledger") {
    return (
      <table className="tbl">
        <thead><tr>
          <th scope="col">Name</th>
          <th scope="col">Parent group</th>
          <th scope="col" className="r">Opening balance</th>
          <th scope="col">Currency</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const p = r.payload || {};
            return (
              <tr key={r.id || i}>
                <td><span className="pri">{r.name}</span></td>
                <td className="mono-sm">{p.parent_group || p.parentGroup || p.group || "—"}</td>
                <td className="r mono">{p.opening_balance != null ? p.opening_balance : (p.openingBalance != null ? p.openingBalance : "—")}</td>
                <td className="mono-sm">{p.currency || "INR"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
  if (type === "gst_ledger") {
    return (
      <table className="tbl">
        <thead><tr>
          <th scope="col">Name</th>
          <th scope="col">GSTIN</th>
          <th scope="col">GST type</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const p = r.payload || {};
            return (
              <tr key={r.id || i}>
                <td><span className="pri">{r.name}</span></td>
                <td className="mono-sm">{p.gstin || "—"}</td>
                <td className="mono-sm">{p.gst_type || p.gstType || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
  if (type === "uom") {
    return (
      <table className="tbl">
        <thead><tr>
          <th scope="col">Name</th>
          <th scope="col" className="r">Conversion factor</th>
          <th scope="col">Tally UoM</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const p = r.payload || {};
            return (
              <tr key={r.id || i}>
                <td><span className="pri">{r.name}</span></td>
                <td className="r mono">{p.conversion_factor != null ? p.conversion_factor : (p.conversionFactor != null ? p.conversionFactor : "1")}</td>
                <td className="mono-sm">{p.tally_uom || p.tallyUom || r.name}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
  // voucher_type
  return (
    <table className="tbl">
      <thead><tr>
        <th scope="col">Name</th>
        <th scope="col">Parent type</th>
        <th scope="col">Default narration</th>
      </tr></thead>
      <tbody>
        {rows.map((r, i) => {
          const p = r.payload || {};
          return (
            <tr key={r.id || i}>
              <td><span className="pri">{r.name}</span></td>
              <td className="mono-sm">{p.parent_type || p.parentType || "—"}</td>
              <td className="mono-sm">{p.default_narration || p.defaultNarration || "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

const WiredTallyMasters = () => {
  const [active, setActive] = useState("stock_item");
  const bridge = useTallyBridgeStatus();

  // Fetch each master type once for KPI counts.
  const stock    = useFetch(() => ObaraBackend?.tally?.listMasters?.("stock_item")   || Promise.resolve({ masters: [] }), []);
  const ledgers  = useFetch(() => ObaraBackend?.tally?.listMasters?.("ledger")       || Promise.resolve({ masters: [] }), []);
  const gst      = useFetch(() => ObaraBackend?.tally?.listMasters?.("gst_ledger")   || Promise.resolve({ masters: [] }), []);
  const uoms     = useFetch(() => ObaraBackend?.tally?.listMasters?.("uom")          || Promise.resolve({ masters: [] }), []);
  const vouchers = useFetch(() => ObaraBackend?.tally?.listMasters?.("voucher_type") || Promise.resolve({ masters: [] }), []);

  const byType = {
    stock_item:   tallyMasterRows(stock.data),
    ledger:       tallyMasterRows(ledgers.data),
    gst_ledger:   tallyMasterRows(gst.data),
    uom:          tallyMasterRows(uoms.data),
    voucher_type: tallyMasterRows(vouchers.data),
  };

  const loading  = stock.loading || ledgers.loading || gst.loading || uoms.loading || vouchers.loading;
  const error    = stock.error || ledgers.error || gst.error || uoms.error || vouchers.error;
  const reloadAll = () => {
    stock.reload(); ledgers.reload(); gst.reload(); uoms.reload(); vouchers.reload();
  };

  const activeRows = byType[active] || [];

  return (
    <>
      <WSTitle
        eyebrow="Finance · Tally"
        title="Tally · masters"
        meta={`${byType.stock_item.length} items · ${byType.ledger.length} ledgers · ${byType.gst_ledger.length} GST · ${byType.uom.length} UoM · ${byType.voucher_type.length} voucher types`}
        right={<>
          <Btn icon kind="ghost" sm onClick={reloadAll} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />
      <WSTabs
        tabs={TALLY_MASTER_TABS.map((t) => ({ id: t.id, label: t.label, count: byType[t.id].length }))}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        {!bridge.loading && !bridge.configured && (
          <Banner kind="warn" icon={Icon.alert} title="Tally bridge not configured">
            <span className="mono-sm">
              The masters list below shows what was last synced from Tally. To trigger a fresh
              sync, set <code>TALLY_BRIDGE_URL</code> and <code>TALLY_BRIDGE_TOKEN</code> in
              Vercel env.
            </span>
          </Banner>
        )}
        {error ? (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load Tally masters" action={<Btn sm onClick={reloadAll}>Retry</Btn>}>
            <span className="mono-sm">{String(error.message || error)}</span>
          </Banner>
        ) : null}

        <KPIRow cols={5}>
          <KPI lbl="Stock items"   v={String(byType.stock_item.length)}   d="synced from Tally" />
          <KPI lbl="Ledgers"       v={String(byType.ledger.length)}       d="all groups" />
          <KPI lbl="GST ledgers"   v={String(byType.gst_ledger.length)}   d="tax categories" />
          <KPI lbl="UoM"           v={String(byType.uom.length)}          d="unit conversions" />
          <KPI lbl="Voucher types" v={String(byType.voucher_type.length)} d="document types" />
        </KPIRow>

        <Card flush>
          {loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading masters…</div>
          ) : (
            renderMastersTable(active, activeRows)
          )}
        </Card>
      </div>
    </>
  );
};


export default WiredTallyMasters;
