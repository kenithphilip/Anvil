// ============================================================
// ANVIL v3 — wired Items
// Wave E · Master data · 4 tabs (Item Master / Aliases / Inventory / BOM)
// ============================================================

const itemFetch = async (path) => {
  const cfg = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_config") || "{}"); } catch (_) { return {}; } })();
  const session = (() => { try { return JSON.parse(localStorage.getItem("obara:backend_session") || "null"); } catch (_) { return null; } })();
  if (!cfg.url) throw new Error("Backend URL not configured");
  const headers = { "Content-Type": "application/json" };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
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
  const [tab, setTab] = useStateW("master");

  const tabs = [
    { id: "master",    label: "Item Master" },
    { id: "aliases",   label: "Aliases" },
    { id: "inventory", label: "Inventory" },
    { id: "bom",       label: "BOM" },
  ];

  return (
    <>
      <WSTitle
        eyebrow="Master · Items"
        title="Items"
        meta="parts · aliases · stock · bills of material"
        right={<Btn sm kind="ghost"><span className="mono-sm">tenant: {localStorage.getItem("obara:v3_tenant_code") || "OBARA-IN"}</span></Btn>}
      />
      <WSTabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="ws-content">
        {tab === "master" && <ItemMasterTab />}
        {tab === "aliases" && <ItemAliasesTab />}
        {tab === "inventory" && <ItemInventoryTab />}
        {tab === "bom" && <ItemBomTab />}
      </div>
    </>
  );
};

const ItemMasterTab = () => {
  const list = useFetch(
    () => window.ObaraBackend?.admin?.listItemMaster?.() || itemFetch("/api/admin/item_master"),
    []
  );

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
  if (rows.length === 0) {
    return <Card><div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No items yet.</div></Card>;
  }

  return (
    <Card flush>
      <table className="tbl">
        <thead><tr>
          <th>Part #</th>
          <th>Description</th>
          <th>Source</th>
          <th>Currency</th>
          <th className="r">Purchase price</th>
          <th>HSN</th>
          <th>Lifecycle</th>
        </tr></thead>
        <tbody>
          {rows.slice(0, 200).map((r) => (
            <tr key={r.id || r.part_no}>
              <td className="mono"><span className="pri">{r.part_no || "—"}</span></td>
              <td>{r.description || "—"}</td>
              <td className="mono-sm">{r.source_country || "—"}</td>
              <td className="mono-sm">{r.currency || "INR"}</td>
              <td className="r mono">{r.purchase_price != null ? Number(r.purchase_price).toLocaleString("en-IN") : "—"}</td>
              <td className="mono-sm">{r.hsn || r.hsn_code || "—"}</td>
              <td><Chip k={r.lifecycle === "ACTIVE" ? "good" : r.lifecycle === "EOL" ? "bad" : "ghost"}>{(r.lifecycle || "—").toLowerCase()}</Chip></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && (
        <div className="mono-sm" style={{ padding: 12, textAlign: "center", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
          Showing 200 of {rows.length} items.
        </div>
      )}
    </Card>
  );
};

const ItemAliasesTab = () => {
  const list = useFetch(
    () => window.ObaraBackend?.aliases?.list?.() || Promise.resolve({ aliases: [] }),
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
    () => window.ObaraBackend?.admin?.listInventory?.() || itemFetch("/api/admin/inventory"),
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
    () => window.ObaraBackend?.bom?.list?.() || Promise.resolve({ rows: [] }),
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

window.Items = WiredItems;
