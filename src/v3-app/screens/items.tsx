import React, { useEffect, useState } from "react";
import { useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { ItemDetailDrawer } from "../components/ItemDetailDrawer";

// ============================================================
// ANVIL v3 — wired Items
// Wave E · Master data · 4 tabs (Item Master / Aliases / Inventory / BOM)
// ============================================================

const itemFetch = async (path) => {
  const cfg = (AnvilBackend?.getConfig?.() || {});
  const session = (AnvilBackend?.getSession?.() || null);
  if (!cfg.url) throw new Error("Backend URL not configured");
  const headers = { "Content-Type": "application/json" };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
  const url = cfg.url.replace(/\/+$/, "") + path;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
};

const itemRowsOf = (resp, key) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (key && Array.isArray(resp[key])) return resp[key];
  if (Array.isArray(resp.rows)) return resp.rows;
  if (Array.isArray(resp.items)) return resp.items;
  return [];
};

const WiredItems = () => {
  const [tab, setTab] = useState("master");

  const tabs = [
    { id: "master",    label: "Item Master" },
    { id: "aliases",   label: "Aliases" },
    { id: "inventory", label: "Inventory" },
    { id: "assets",    label: "Assets (BOMs)" },
    { id: "bom",       label: "BOM" },
  ];

  return (
    <>
      <WSTitle
        eyebrow="Master · Items"
        title="Items"
        meta="parts · aliases · stock · bills of material"
        right={<>
          <Btn sm kind="primary" onClick={() => { window.location.hash = "#/items?view=import"; }}>{Icon.plus} Import BOM</Btn>
          <Btn sm kind="ghost"><span className="mono-sm">tenant: {localStorage.getItem("obara:v3_tenant_code") || "TENANT"}</span></Btn>
        </>}
      />
      <WSTabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="ws-content">
        {tab === "master" && <ItemMasterTab />}
        {tab === "aliases" && <ItemAliasesTab />}
        {tab === "inventory" && <ItemInventoryTab />}
        {tab === "assets" && <ItemAssetsTab />}
        {tab === "bom" && <ItemBomTab />}
      </div>
    </>
  );
};

const ItemMasterTab = () => {
  // Guard rail (2026-06): item-master edits are admin-only. Non-admins get a
  // read-only list + read-only detail drawer.
  const canEdit = RBAC.isAdmin();
  const list = useFetch(
    () => AnvilBackend?.admin?.listItemMaster?.() || itemFetch("/api/admin/item_master"),
    []
  );
  // Item-detail drawer state. null = closed, {} = create-new,
  // any other object = edit-existing. The drawer is responsible for
  // hydrating per-item satellites (spec, customer parts, custom fields).
  const [editing, setEditing] = useState<any | null>(null);

  if (list.loading) return <Card><div className="body">Loading item master…</div></Card>;
  if (list.error) {
    return (
      <Banner kind="bad" icon={Icon.alert} title="Could not load item master"
              action={<Btn sm onClick={list.reload}>Retry</Btn>}>
        <span className="mono-sm">{String(list.error.message || list.error)}</span>
      </Banner>
    );
  }

  const rows = itemRowsOf(list.data, "items");

  return (
    <>
      {canEdit && (
        <div className="row" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
          <Btn sm kind="primary" onClick={() => setEditing({})}>{Icon.plus} New item</Btn>
        </div>
      )}
      <Card flush>
        {rows.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
            No items yet. Click <b>New item</b> above to add one.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Part #</th>
              <th>Description</th>
              <th>Alias</th>
              <th>UoM</th>
              <th>Source</th>
              <th>HSN</th>
              <th>Lifecycle</th>
              <th></th>
            </tr></thead>
            <tbody>
              {rows.slice(0, 200).map((r: any) => (
                <tr key={r.id || r.part_no} style={{ cursor: "pointer" }} onClick={() => setEditing(r)}>
                  <td className="mono"><span className="pri">{r.part_no || "—"}</span></td>
                  <td>{r.description || "—"}</td>
                  <td className="mono-sm">{r.alias || "—"}</td>
                  <td className="mono-sm">{r.uom || "—"}</td>
                  <td className="mono-sm">{r.source_country || "—"}</td>
                  <td className="mono-sm">{r.hsn_sac || r.hsn || r.hsn_code || "—"}</td>
                  <td><Chip k={r.lifecycle === "ACTIVE" ? "good" : r.lifecycle === "OBSOLETE" || r.lifecycle === "DISCONTINUED" ? "bad" : "ghost"}>{(r.lifecycle || "—").toLowerCase()}</Chip></td>
                  <td className="r">
                    <Btn sm kind="ghost" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>{canEdit ? "edit" : "view"}</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows.length > 200 && (
          <div className="mono-sm" style={{ padding: 12, textAlign: "center", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
            Showing 200 of {rows.length} items.
          </div>
        )}
      </Card>
      {editing != null && (
        <ItemDetailDrawer
          item={editing && editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.reload?.(); }}
          canEdit={canEdit}
        />
      )}
    </>
  );
};

const ItemAliasesTab = () => {
  const list = useFetch(
    () => AnvilBackend?.aliases?.list?.() || Promise.resolve({ aliases: [] }),
    []
  );

  if (list.loading) return <Card><div className="body">Loading aliases…</div></Card>;
  if (list.error) {
    return (
      <Banner kind="bad" icon={Icon.alert} title="Could not load aliases"
              action={<Btn sm onClick={list.reload}>Retry</Btn>}>
        <span className="mono-sm">{String(list.error.message || list.error)}</span>
      </Banner>
    );
  }

  const rows = itemRowsOf(list.data, "aliases");
  if (rows.length === 0) {
    return <Card><div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No aliases mapped yet.</div></Card>;
  }

  return (
    <Card flush>
      <table className="tbl">
        <thead><tr>
          <th>Customer</th>
          <th>Their part / description</th>
          <th>Canonical part #</th>
          <th className="r">Confidence</th>
        </tr></thead>
        <tbody>
          {rows.slice(0, 200).map((r) => (
            <tr key={r.id}>
              <td>{r.customer_name || r.customer_key || (r.customer_id ? r.customer_id.slice(0, 8) : "—")}</td>
              <td><span className="pri">{r.raw_part || r.raw || "—"}</span></td>
              <td className="mono">{r.canonical_part_no || r.canonical || "—"}</td>
              <td className="r mono">{r.confidence != null ? `${(Number(r.confidence) * 100).toFixed(0)}%` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
};

const ItemInventoryTab = () => {
  const list = useFetch(
    () => AnvilBackend?.admin?.listInventory?.() || itemFetch("/api/admin/inventory"),
    []
  );

  if (list.loading) return <Card><div className="body">Loading inventory…</div></Card>;
  if (list.error) {
    return (
      <Banner kind="bad" icon={Icon.alert} title="Could not load inventory"
              action={<Btn sm onClick={list.reload}>Retry</Btn>}>
        <span className="mono-sm">{String(list.error.message || list.error)}</span>
      </Banner>
    );
  }

  const rows = itemRowsOf(list.data, "inventory");
  if (rows.length === 0) {
    return <Card><div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No stock records.</div></Card>;
  }

  return (
    <Card flush>
      <table className="tbl">
        <thead><tr>
          <th>Item</th>
          <th className="r">ATP qty</th>
          <th className="r">In stock</th>
          <th className="r">On order</th>
        </tr></thead>
        <tbody>
          {rows.slice(0, 200).map((r) => (
            <tr key={r.id || r.part_no}>
              <td className="mono"><span className="pri">{r.part_no || r.item || r.sku || "—"}</span></td>
              <td className="r mono">{r.atp_qty != null ? Number(r.atp_qty).toLocaleString("en-IN") : "—"}</td>
              <td className="r mono">{r.in_stock != null ? Number(r.in_stock).toLocaleString("en-IN") : (r.on_hand != null ? Number(r.on_hand).toLocaleString("en-IN") : "—")}</td>
              <td className="r mono">{r.on_order != null ? Number(r.on_order).toLocaleString("en-IN") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
};

const ItemBomTab = () => {
  const list = useFetch(
    () => AnvilBackend?.bom?.list?.() || Promise.resolve({ rows: [] }),
    []
  );

  if (list.loading) return <Card><div className="body">Loading BOMs…</div></Card>;
  if (list.error) {
    return (
      <Banner kind="bad" icon={Icon.alert} title="Could not load BOMs"
              action={<Btn sm onClick={list.reload}>Retry</Btn>}>
        <span className="mono-sm">{String(list.error.message || list.error)}</span>
      </Banner>
    );
  }

  const rows = itemRowsOf(list.data, "bom");
  if (rows.length === 0) {
    return <Card><div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No BOM entries.</div></Card>;
  }

  return (
    <Card flush>
      <table className="tbl">
        <thead><tr>
          <th>Parent item</th>
          <th>Child item</th>
          <th className="r">Qty</th>
        </tr></thead>
        <tbody>
          {rows.slice(0, 200).map((r) => (
            <tr key={r.id || `${r.parent_item}-${r.child_item}`}>
              <td className="mono"><span className="pri">{r.parent_item || r.parent || "—"}</span></td>
              <td className="mono">{r.child_item || r.child || "—"}</td>
              <td className="r mono">{r.qty != null ? Number(r.qty).toLocaleString("en-IN") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
};

// Imported BOMs / assets browser (PR4 Phase 3 follow-up). Lists bom_assets
// and expands to the as-imported lines + project/customer where-used.
const ItemAssetsTab = () => {
  const list = useFetch(() => AnvilBackend?.bom?.assets?.() || Promise.resolve({ assets: [] }), []);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, any>>({});

  if (list.loading) return <Card><div className="body">Loading assets…</div></Card>;
  if (list.error) {
    return (
      <Banner kind="bad" icon={Icon.alert} title="Could not load assets"
              action={<Btn sm onClick={list.reload}>Retry</Btn>}>
        <span className="mono-sm">{String(list.error.message || list.error)}</span>
      </Banner>
    );
  }
  const assets = (list.data && list.data.assets) || [];
  if (!assets.length) {
    return <Card><div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
      No imported BOMs yet. Use the <b>Import BOM</b> button (top right) to upload a parts list.
    </div></Card>;
  }

  const toggle = async (a) => {
    if (open === a.id) { setOpen(null); return; }
    setOpen(a.id);
    if (!detail[a.id]) {
      try { const d = await AnvilBackend.bom.asset(a.id); setDetail((m) => ({ ...m, [a.id]: d })); }
      catch (e: any) { setDetail((m) => ({ ...m, [a.id]: { error: String(e.message || e) } })); }
    }
  };

  return (
    <Card flush>
      <table className="tbl">
        <thead><tr>
          <th>Asset code</th><th>Name</th><th>Source</th><th>Status</th><th style={{ width: 90 }}></th>
        </tr></thead>
        <tbody>
          {assets.map((a) => (
            <React.Fragment key={a.id}>
              <tr>
                <td className="mono"><span className="pri">{a.asset_code}</span></td>
                <td>{a.name || "—"}</td>
                <td className="mono-sm">{a.source_format || a.source_country || "—"}</td>
                <td><Chip k="ghost">{a.approval_status || "imported"}</Chip></td>
                <td><Btn sm kind="ghost" onClick={() => toggle(a)}>{open === a.id ? "hide" : "lines"}</Btn></td>
              </tr>
              {open === a.id && (
                <tr><td colSpan={5} style={{ background: "var(--paper-2)", padding: 12 }}>
                  {!detail[a.id] ? <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Loading lines…</div>
                   : detail[a.id].error ? <div className="mono-sm" style={{ color: "var(--bad)" }}>{detail[a.id].error}</div>
                   : (() => {
                       const d = detail[a.id];
                       const lines = d.lines || [];
                       const projects = d.projects || [];
                       return (<>
                         {projects.length ? (
                           <div className="mono-sm" style={{ marginBottom: 8, color: "var(--ink-3)" }}>
                             Used in: {projects.map((p) => p.project_code || p.project_name || p.project_id).join(", ")}
                           </div>
                         ) : null}
                         <table className="tbl">
                           <thead><tr><th>#</th><th>Lvl</th><th>Part</th><th>Name</th><th>Material</th><th>Supplier part</th><th className="r">Qty</th></tr></thead>
                           <tbody>
                             {lines.slice(0, 500).map((ln) => (
                               <tr key={ln.id}>
                                 <td className="mono-sm">{ln.seq_no}</td>
                                 <td className="mono-sm">{ln.level ? ("L" + ln.level) : "—"}</td>
                                 <td className="mono"><span className="pri">{ln.part_no}</span></td>
                                 <td>{ln.part_name || "—"}</td>
                                 <td className="mono-sm">{ln.material || "—"}</td>
                                 <td className="mono-sm">{ln.supplier_part_no || "—"}</td>
                                 <td className="r mono">{ln.qty != null ? ln.qty : "—"}</td>
                               </tr>
                             ))}
                           </tbody>
                         </table>
                         <div className="mono-sm" style={{ marginTop: 6, color: "var(--ink-4)" }}>{lines.length} line{lines.length === 1 ? "" : "s"}</div>
                       </>);
                     })()}
                </td></tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </Card>
  );
};


export default WiredItems;
