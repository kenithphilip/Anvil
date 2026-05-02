// @ts-nocheck — converted screen, types follow in a focused TS pass
import React, { useEffect, useMemo, useState } from "react";
import { useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — wired Equipment hierarchy
// Plant > Line > Zone > Station > Gun + installed parts editor.
// Reads via ObaraBackend.admin.listEquipment, writes via
// upsertEquipment/deleteEquipment. Reached at #/items?view=equipment.
// ============================================================

const equipmentRowsOf = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.equipment)) return resp.equipment;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

// Compose a tree from the flat list. Each gun row is a leaf; we group up the
// parent levels by the textual path keys. Non-gun rows in the corpus carry a
// gun_no=null; we surface them as folder-only nodes too so admins can attach
// children. Returns:
//   [{kind:"customer", id, label, count, children:[
//      {kind:"location", id, label, count, children:[
//         {kind:"plant", id, label, children:[…]}, …]}, …]}, …]
const buildEquipmentTree = (rows, customersById) => {
  const customers = new Map();
  rows.forEach((r) => {
    const cid = r.customer_id || "—";
    const cName = customersById.get(cid)?.customer_name || customersById.get(cid)?.customer_key || cid.slice(0, 8);
    if (!customers.has(cid)) customers.set(cid, { kind: "customer", id: cid, label: cName, count: 0, locations: new Map() });
    const cust = customers.get(cid);
    cust.count += 1;
    const locKey = r.customer_location_id || "—";
    const locLabel = r.customer_location_id ? `loc ${String(r.customer_location_id).slice(0, 8)}` : "(no location)";
    if (!cust.locations.has(locKey)) cust.locations.set(locKey, { kind: "location", id: `${cid}/${locKey}`, customer_id: cid, customer_location_id: r.customer_location_id || null, label: locLabel, plants: new Map() });
    const loc = cust.locations.get(locKey);
    const plant = r.plant_name || "(no plant)";
    if (!loc.plants.has(plant)) loc.plants.set(plant, { kind: "plant", id: `${cid}/${locKey}/${plant}`, customer_id: cid, customer_location_id: r.customer_location_id || null, plant_name: plant, label: plant, lines: new Map() });
    const pl = loc.plants.get(plant);
    const line = r.line_name || "(no line)";
    if (!pl.lines.has(line)) pl.lines.set(line, { kind: "line", id: `${pl.id}/${line}`, customer_id: cid, customer_location_id: r.customer_location_id || null, plant_name: plant, line_name: line, label: line, zones: new Map() });
    const ln = pl.lines.get(line);
    const zone = r.zone_name || "(no zone)";
    if (!ln.zones.has(zone)) ln.zones.set(zone, { kind: "zone", id: `${ln.id}/${zone}`, customer_id: cid, customer_location_id: r.customer_location_id || null, plant_name: plant, line_name: line, zone_name: zone, label: zone, stations: new Map() });
    const zn = ln.zones.get(zone);
    const stn = r.station_name || "(no station)";
    if (!zn.stations.has(stn)) zn.stations.set(stn, { kind: "station", id: `${zn.id}/${stn}`, customer_id: cid, customer_location_id: r.customer_location_id || null, plant_name: plant, line_name: line, zone_name: zone, station_name: stn, label: stn, guns: [] });
    zn.stations.get(stn).guns.push({ kind: "gun", id: r.id, label: r.gun_no || "(no gun)", row: r });
  });
  // Convert maps to arrays, sorted alphabetically by label.
  const sortByLabel = (a, b) => String(a.label).localeCompare(String(b.label));
  return Array.from(customers.values()).sort(sortByLabel).map((c) => ({
    ...c,
    children: Array.from(c.locations.values()).sort(sortByLabel).map((loc) => ({
      ...loc,
      children: Array.from(loc.plants.values()).sort(sortByLabel).map((pl) => ({
        ...pl,
        children: Array.from(pl.lines.values()).sort(sortByLabel).map((ln) => ({
          ...ln,
          children: Array.from(ln.zones.values()).sort(sortByLabel).map((zn) => ({
            ...zn,
            children: Array.from(zn.stations.values()).sort(sortByLabel).map((stn) => ({
              ...stn,
              children: stn.guns.sort(sortByLabel),
            })),
          })),
        })),
      })),
    })),
  }));
};

// Single tree row with chevron, label, hover actions.
const EquipTreeRow = ({ node, depth, expanded, onToggle, onSelect, selected, onAddChild, onEdit, onDelete }) => {
  const hasChildren = node.kind !== "gun" && Array.isArray(node.children) && node.children.length > 0;
  const isOpen = !!expanded[node.id];
  const isSelected = selected === node.id;
  const onKeyDown = (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      if (hasChildren) onToggle(node.id);
      onSelect(node);
      return;
    }
    if (ev.key === "ArrowRight" && hasChildren && !isOpen) { ev.preventDefault(); onToggle(node.id); return; }
    if (ev.key === "ArrowLeft" && hasChildren && isOpen) { ev.preventDefault(); onToggle(node.id); return; }
  };
  const kindLabel = {
    customer: "customer", location: "loc", plant: "plant", line: "line",
    zone: "zone", station: "station", gun: "gun",
  }[node.kind] || node.kind;
  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? isOpen : undefined}
      aria-selected={isSelected}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={`eq-row ${isSelected ? "sel" : ""}`}
      onClick={() => { if (hasChildren) onToggle(node.id); onSelect(node); }}
      style={{
        display: "flex", alignItems: "center", gap: 6, padding: "5px 8px",
        paddingLeft: 8 + depth * 14, borderBottom: "1px solid var(--hairline-2)",
        cursor: "pointer", background: isSelected ? "var(--paper-4)" : undefined,
        outline: "none", minHeight: 28,
      }}
    >
      <span style={{ width: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--ink-3)" }}>
        {hasChildren ? (isOpen ? Icon.caret : Icon.caretR) : null}
      </span>
      <span className="mono-sm" style={{ color: "var(--ink-4)", textTransform: "uppercase", fontSize: 9.5, minWidth: 56 }}>{kindLabel}</span>
      <span className={node.kind === "gun" ? "mono" : ""} style={{ flex: 1, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
        {node.label}
      </span>
      {node.kind !== "gun" && Array.isArray(node.children) && (
        <span className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10 }}>{node.children.length}</span>
      )}
      <span className="eq-row-act" style={{ display: "flex", gap: 4, opacity: isSelected ? 1 : 0.0 }} onClick={(e) => e.stopPropagation()}>
        {node.kind === "gun" && (
          <Btn icon kind="ghost" sm onClick={() => onEdit(node)} title="Edit">{Icon.wrench}</Btn>
        )}
        {node.kind !== "gun" && (
          <Btn icon kind="ghost" sm onClick={() => onAddChild(node)} title="Add gun">{Icon.plus}</Btn>
        )}
        {node.kind === "gun" && (
          <Btn icon kind="ghost" sm onClick={() => onDelete(node)} title="Delete">{Icon.x}</Btn>
        )}
      </span>
    </div>
  );
};

const EquipTree = ({ tree, expanded, onToggle, onSelect, selected, onAddChild, onEdit, onDelete }) => {
  const renderNode = (node, depth) => {
    const isOpen = !!expanded[node.id];
    const rows = [
      <EquipTreeRow
        key={node.id} node={node} depth={depth} expanded={expanded}
        onToggle={onToggle} onSelect={onSelect} selected={selected}
        onAddChild={onAddChild} onEdit={onEdit} onDelete={onDelete}
      />,
    ];
    if (isOpen && Array.isArray(node.children)) {
      node.children.forEach((c) => rows.push(...renderNode(c, depth + 1)));
    }
    return rows;
  };
  return <div role="tree" style={{ background: "var(--paper)" }}>{tree.flatMap((n) => renderNode(n, 0))}</div>;
};

// Right pane: edit form for the selected gun + installed parts table.
const EquipmentDetail = ({ node, customers, locations, onSave, onDelete, onCancel, busy }) => {
  const isGun = node?.kind === "gun";
  const seedRow = isGun ? node.row : null;
  const [draft, setDraft] = useState(() => ({
    id: seedRow?.id || null,
    customer_id: seedRow?.customer_id || node?.customer_id || "",
    customer_location_id: seedRow?.customer_location_id || node?.customer_location_id || "",
    plant_name: seedRow?.plant_name || node?.plant_name || "",
    line_name: seedRow?.line_name || node?.line_name || "",
    zone_name: seedRow?.zone_name || node?.zone_name || "",
    station_name: seedRow?.station_name || node?.station_name || "",
    robot_make: seedRow?.robot_make || "",
    robot_no: seedRow?.robot_no || "",
    gun_no: seedRow?.gun_no || "",
    gun_type: seedRow?.gun_type || "",
    qty: seedRow?.qty != null ? seedRow.qty : 1,
    timer_model: seedRow?.timer_model || "",
    atd_model: seedRow?.atd_model || "",
    notes: seedRow?.notes || "",
  }));
  const [parts, setParts] = useState(() => (seedRow?.installed_parts || []).map((p) => ({ ...p })));
  // Reset draft + parts whenever the selected node changes.
  useEffect(() => {
    setDraft({
      id: seedRow?.id || null,
      customer_id: seedRow?.customer_id || node?.customer_id || "",
      customer_location_id: seedRow?.customer_location_id || node?.customer_location_id || "",
      plant_name: seedRow?.plant_name || node?.plant_name || "",
      line_name: seedRow?.line_name || node?.line_name || "",
      zone_name: seedRow?.zone_name || node?.zone_name || "",
      station_name: seedRow?.station_name || node?.station_name || "",
      robot_make: seedRow?.robot_make || "",
      robot_no: seedRow?.robot_no || "",
      gun_no: seedRow?.gun_no || "",
      gun_type: seedRow?.gun_type || "",
      qty: seedRow?.qty != null ? seedRow.qty : 1,
      timer_model: seedRow?.timer_model || "",
      atd_model: seedRow?.atd_model || "",
      notes: seedRow?.notes || "",
    });
    setParts((seedRow?.installed_parts || []).map((p) => ({ ...p })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id]);

  const dirty = useMemo(() => {
    const cur = JSON.stringify(draft);
    const orig = JSON.stringify({
      id: seedRow?.id || null,
      customer_id: seedRow?.customer_id || node?.customer_id || "",
      customer_location_id: seedRow?.customer_location_id || node?.customer_location_id || "",
      plant_name: seedRow?.plant_name || node?.plant_name || "",
      line_name: seedRow?.line_name || node?.line_name || "",
      zone_name: seedRow?.zone_name || node?.zone_name || "",
      station_name: seedRow?.station_name || node?.station_name || "",
      robot_make: seedRow?.robot_make || "",
      robot_no: seedRow?.robot_no || "",
      gun_no: seedRow?.gun_no || "",
      gun_type: seedRow?.gun_type || "",
      qty: seedRow?.qty != null ? seedRow.qty : 1,
      timer_model: seedRow?.timer_model || "",
      atd_model: seedRow?.atd_model || "",
      notes: seedRow?.notes || "",
    });
    if (cur !== orig) return true;
    const partsCur = JSON.stringify(parts);
    const partsOrig = JSON.stringify((seedRow?.installed_parts || []).map((p) => ({ ...p })));
    return partsCur !== partsOrig;
  }, [draft, parts, seedRow, node?.id]);

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const setPart = (idx, k, v) => setParts((arr) => arr.map((p, i) => (i === idx ? { ...p, [k]: v } : p)));
  const removePart = (idx) => setParts((arr) => arr.filter((_, i) => i !== idx));
  const addPart = () => setParts((arr) => [...arr, { part_no: "", description: "", installed_qty: 1, is_critical: false }]);

  const validationError = useMemo(() => {
    if (!draft.customer_id) return "Customer is required.";
    if (isGun && !draft.gun_no) return "Gun number is required for a gun row.";
    if (draft.qty != null && draft.qty !== "" && Number.isNaN(Number(draft.qty))) return "Quantity must be numeric.";
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      if (p.part_no && Number.isNaN(Number(p.installed_qty))) return `Part #${i + 1}: installed qty must be numeric.`;
    }
    return null;
  }, [draft, parts, isGun]);

  const filteredLocations = useMemo(() => {
    if (!draft.customer_id) return [];
    return (locations || []).filter((l) => l.customer_id === draft.customer_id);
  }, [locations, draft.customer_id]);

  const handleSave = () => {
    if (validationError) return;
    onSave({
      equipment: {
        id: draft.id,
        customer_id: draft.customer_id,
        customer_location_id: draft.customer_location_id || null,
        plant_name: draft.plant_name || null,
        line_name: draft.line_name || null,
        zone_name: draft.zone_name || null,
        station_name: draft.station_name || null,
        robot_make: draft.robot_make || null,
        robot_no: draft.robot_no || null,
        gun_no: draft.gun_no || null,
        gun_type: draft.gun_type || null,
        qty: draft.qty != null && draft.qty !== "" ? Number(draft.qty) : 1,
        timer_model: draft.timer_model || null,
        atd_model: draft.atd_model || null,
        notes: draft.notes || null,
      },
      installed_parts: parts.filter((p) => p.part_no).map((p) => ({
        part_no: p.part_no,
        description: p.description || null,
        installed_qty: p.installed_qty != null && p.installed_qty !== "" ? Number(p.installed_qty) : 1,
        is_critical: !!p.is_critical,
        is_emergency_only: !!p.is_emergency_only,
        recommended_qty_90d: p.recommended_qty_90d != null && p.recommended_qty_90d !== "" ? Number(p.recommended_qty_90d) : null,
        recommended_qty_180d: p.recommended_qty_180d != null && p.recommended_qty_180d !== "" ? Number(p.recommended_qty_180d) : null,
        recommended_qty_365d: p.recommended_qty_365d != null && p.recommended_qty_365d !== "" ? Number(p.recommended_qty_365d) : null,
        last_replaced_at: p.last_replaced_at || null,
        notes: p.notes || null,
      })),
    });
  };

  const handleDelete = () => {
    if (!seedRow?.id) return;
    const partsCount = (seedRow.installed_parts || []).length;
    const msg = `Delete gun ${seedRow.gun_no || seedRow.id.slice(0, 8)}? This removes ${partsCount} installed part${partsCount === 1 ? "" : "s"}.`;
    if (window.confirm(msg)) onDelete(seedRow.id);
  };

  const fld = (label, ctrl, hint) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="mono-sm" style={{ color: "var(--ink-3)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.04 }}>{label}</span>
      {ctrl}
      {hint && <span className="fieldnote">{hint}</span>}
    </label>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card title={isGun ? `Gun ${seedRow?.gun_no || ""}` : `New ${node?.kind || "row"}`}
            eyebrow={isGun ? "edit" : "add child"}
            right={<>
              {dirty && <Chip k="warn">unsaved</Chip>}
              {validationError && <span className="mono-sm" style={{ color: "var(--rust-2)" }}>{validationError}</span>}
            </>}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {fld("Customer *", (
            <select className="select" value={draft.customer_id} onChange={(e) => set("customer_id", e.target.value)} aria-label="Customer">
              <option value="">— pick customer —</option>
              {(customers || []).map((c) => (
                <option key={c.id} value={c.id}>{c.customer_name || c.customer_key || c.id.slice(0, 8)}</option>
              ))}
            </select>
          ))}
          {fld("Location", (
            <select className="select" value={draft.customer_location_id || ""} onChange={(e) => set("customer_location_id", e.target.value)} aria-label="Location" disabled={!draft.customer_id}>
              <option value="">(no location)</option>
              {filteredLocations.map((l) => (
                <option key={l.id} value={l.id}>{l.location_code} {l.plant_name ? `· ${l.plant_name}` : ""}</option>
              ))}
            </select>
          ))}
          {fld("Plant name", (
            <input className="input" value={draft.plant_name} onChange={(e) => set("plant_name", e.target.value)} aria-label="Plant name" />
          ))}
          {fld("Line name", (
            <input className="input" value={draft.line_name} onChange={(e) => set("line_name", e.target.value)} aria-label="Line name" />
          ))}
          {fld("Zone name", (
            <input className="input" value={draft.zone_name} onChange={(e) => set("zone_name", e.target.value)} aria-label="Zone name" />
          ))}
          {fld("Station name", (
            <input className="input" value={draft.station_name} onChange={(e) => set("station_name", e.target.value)} aria-label="Station name" />
          ))}
          {fld("Robot make", (
            <input className="input mono" value={draft.robot_make} onChange={(e) => set("robot_make", e.target.value)} aria-label="Robot make" />
          ))}
          {fld("Robot no", (
            <input className="input mono" value={draft.robot_no} onChange={(e) => set("robot_no", e.target.value)} aria-label="Robot no" />
          ))}
          {fld("Gun no" + (isGun ? " *" : ""), (
            <input className="input mono" value={draft.gun_no} onChange={(e) => set("gun_no", e.target.value)} placeholder="SRTC-K6133-IND" aria-label="Gun no" />
          ))}
          {fld("Gun type", (
            <input className="input mono" value={draft.gun_type} onChange={(e) => set("gun_type", e.target.value)} aria-label="Gun type" />
          ))}
          {fld("Qty", (
            <input className="input mono" type="number" min="0" step="1" value={draft.qty} onChange={(e) => set("qty", e.target.value)} aria-label="Qty" />
          ))}
          {fld("Timer model", (
            <input className="input mono" value={draft.timer_model} onChange={(e) => set("timer_model", e.target.value)} aria-label="Timer model" />
          ))}
          {fld("ATD model", (
            <input className="input mono" value={draft.atd_model} onChange={(e) => set("atd_model", e.target.value)} aria-label="ATD model" />
          ))}
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
          <span className="mono-sm" style={{ color: "var(--ink-3)", fontSize: 10.5, textTransform: "uppercase" }}>Notes</span>
          <textarea className="input" rows={2} value={draft.notes} onChange={(e) => set("notes", e.target.value)} aria-label="Notes" />
        </label>
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <Btn kind="primary" sm disabled={!dirty || !!validationError || busy} onClick={handleSave}>
            {busy ? "Saving…" : "Save"}
          </Btn>
          <Btn kind="ghost" sm disabled={!dirty || busy} onClick={onCancel}>Discard</Btn>
          <span style={{ marginLeft: "auto" }} />
          {seedRow?.id && (
            <Btn kind="ghost" sm onClick={handleDelete} disabled={busy} title="Delete gun and its parts">{Icon.x} Delete</Btn>
          )}
        </div>
      </Card>

      <Card title="Installed parts" eyebrow={`${parts.length} part${parts.length === 1 ? "" : "s"}`}
            right={<Btn sm kind="ghost" onClick={addPart}>{Icon.plus} Add part</Btn>}
            flush>
        {parts.length === 0 ? (
          <div className="body" style={{ padding: 16, textAlign: "center", color: "var(--ink-3)" }}>
            No installed parts. Add a part to start populating this gun's spare matrix.
          </div>
        ) : (
          <table className="tbl">
            <thead><tr>
              <th>Part #</th>
              <th>Description</th>
              <th className="r">Qty</th>
              <th>Critical</th>
              <th className="r">90d</th>
              <th className="r">180d</th>
              <th className="r">365d</th>
              <th style={{ width: 40 }}></th>
            </tr></thead>
            <tbody>
              {parts.map((p, i) => (
                <tr key={i}>
                  <td><input className="input mono" style={{ height: 24 }} value={p.part_no || ""} onChange={(e) => setPart(i, "part_no", e.target.value)} aria-label={`Part ${i + 1} number`} /></td>
                  <td><input className="input" style={{ height: 24 }} value={p.description || ""} onChange={(e) => setPart(i, "description", e.target.value)} aria-label={`Part ${i + 1} description`} /></td>
                  <td className="r"><input className="input mono" type="number" min="0" step="0.01" style={{ height: 24, width: 60, textAlign: "right" }} value={p.installed_qty != null ? p.installed_qty : ""} onChange={(e) => setPart(i, "installed_qty", e.target.value)} aria-label={`Part ${i + 1} qty`} /></td>
                  <td><input type="checkbox" checked={!!p.is_critical} onChange={(e) => setPart(i, "is_critical", e.target.checked)} aria-label={`Part ${i + 1} critical`} /></td>
                  <td className="r"><input className="input mono" type="number" min="0" step="0.01" style={{ height: 24, width: 60, textAlign: "right" }} value={p.recommended_qty_90d != null ? p.recommended_qty_90d : ""} onChange={(e) => setPart(i, "recommended_qty_90d", e.target.value)} aria-label={`Part ${i + 1} 90d`} /></td>
                  <td className="r"><input className="input mono" type="number" min="0" step="0.01" style={{ height: 24, width: 60, textAlign: "right" }} value={p.recommended_qty_180d != null ? p.recommended_qty_180d : ""} onChange={(e) => setPart(i, "recommended_qty_180d", e.target.value)} aria-label={`Part ${i + 1} 180d`} /></td>
                  <td className="r"><input className="input mono" type="number" min="0" step="0.01" style={{ height: 24, width: 60, textAlign: "right" }} value={p.recommended_qty_365d != null ? p.recommended_qty_365d : ""} onChange={(e) => setPart(i, "recommended_qty_365d", e.target.value)} aria-label={`Part ${i + 1} 365d`} /></td>
                  <td><Btn icon kind="ghost" sm onClick={() => removePart(i)} title="Remove part">{Icon.x}</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
};

const WiredEquipmentHierarchy = () => {
  const equipment = useFetch(
    () => ObaraBackend?.admin?.listEquipment?.() || Promise.resolve({ equipment: [] }),
    []
  );
  const customersList = useFetch(
    () => ObaraBackend?.customers?.list?.() || Promise.resolve({ customers: [] }),
    []
  );
  const locationsList = useFetch(
    () => ObaraBackend?.admin?.listCustomerLocations?.() || Promise.resolve({ locations: [] }),
    []
  );

  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  // selectedNode is what the right pane renders. Keeping it in state lets us
  // also render "new child" forms for a clicked non-gun node.
  const [selectedNode, setSelectedNode] = useState(null);
  const [busy, setBusy] = useState(false);
  // Optimistic overlay: pending edits keyed by id, applied on top of the
  // server response so the UI reflects the change immediately.
  const [optimistic, setOptimistic] = useState({});

  const customersById = useMemo(() => {
    const m = new Map();
    const arr = customersList.data?.customers || customersList.data || [];
    (Array.isArray(arr) ? arr : []).forEach((c) => m.set(c.id, c));
    return m;
  }, [customersList.data]);

  const locations = useMemo(() => {
    const arr = locationsList.data?.locations || locationsList.data?.rows || locationsList.data || [];
    return Array.isArray(arr) ? arr : [];
  }, [locationsList.data]);

  const flatEquipment = useMemo(() => {
    const base = equipmentRowsOf(equipment.data);
    if (Object.keys(optimistic).length === 0) return base;
    // Merge optimistic upserts: replace by id, append for new ids.
    const map = new Map();
    base.forEach((r) => map.set(r.id, r));
    Object.values(optimistic).forEach((r) => {
      if (r === null) return; // deleted
      if (r.id) map.set(r.id, r);
    });
    // Apply tombstones (null = deleted).
    Object.entries(optimistic).forEach(([k, v]) => { if (v === null) map.delete(k); });
    return Array.from(map.values());
  }, [equipment.data, optimistic]);

  const filteredEquipment = useMemo(() => {
    if (!filter) return flatEquipment;
    return flatEquipment.filter((r) => r.customer_id === filter);
  }, [flatEquipment, filter]);

  const tree = useMemo(
    () => buildEquipmentTree(filteredEquipment, customersById),
    [filteredEquipment, customersById]
  );

  const totals = useMemo(() => {
    const guns = flatEquipment.filter((r) => r.gun_no).length;
    const cust = new Set(flatEquipment.map((r) => r.customer_id).filter(Boolean)).size;
    return { guns, cust };
  }, [flatEquipment]);

  const onToggle = (id) => setExpanded((e) => ({ ...e, [id]: !e[id] }));
  const onSelect = (node) => {
    setSelectedId(node.id);
    setSelectedNode(node);
  };
  const onAddChild = (node) => {
    // Build a synthetic "new gun" node prefilled with the parent context.
    const parent = node;
    setSelectedId(`new:${parent.id}`);
    setSelectedNode({
      kind: "gun",
      id: null,
      label: "(new gun)",
      row: null,
      customer_id: parent.customer_id,
      customer_location_id: parent.customer_location_id || null,
      plant_name: parent.plant_name || "",
      line_name: parent.line_name || "",
      zone_name: parent.zone_name || "",
      station_name: parent.station_name || "",
    });
    // Make sure the parent is open.
    setExpanded((e) => ({ ...e, [parent.id]: true }));
  };
  const onCancel = () => {
    // Re-seed the form by reselecting the same node (forces useEffect reset).
    if (selectedNode) {
      const same = selectedNode;
      setSelectedNode(null);
      setTimeout(() => setSelectedNode(same), 0);
    }
  };

  const handleSave = async ({ equipment: row, installed_parts }) => {
    setBusy(true);
    // Optimistic merge.
    const tempId = row.id || `tmp:${Date.now()}`;
    const optimisticRow = { ...row, id: tempId, installed_parts: installed_parts || [] };
    setOptimistic((o) => ({ ...o, [tempId]: optimisticRow }));
    try {
      const resp = await ObaraBackend.admin.upsertEquipment({ ...row, installed_parts });
      const saved = resp?.equipment || resp;
      // Drop the optimistic temp entry, refetch the list to get authoritative state.
      setOptimistic((o) => {
        const cp = { ...o };
        delete cp[tempId];
        if (saved?.id && row.id && row.id !== saved.id) delete cp[row.id];
        return cp;
      });
      window.notifySuccess?.("Saved", `Equipment ${saved?.gun_no || saved?.id?.slice(0, 8) || ""} saved.`);
      equipment.reload();
      // Re-select the saved node by id once the data refreshes.
      if (saved?.id) setSelectedId(saved.id);
    } catch (err) {
      // Revert.
      setOptimistic((o) => { const cp = { ...o }; delete cp[tempId]; return cp; });
      window.notifyError?.(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id) => {
    setBusy(true);
    setOptimistic((o) => ({ ...o, [id]: null }));
    try {
      await ObaraBackend.admin.deleteEquipment(id);
      window.notifySuccess?.("Deleted", "Equipment removed.");
      setOptimistic((o) => { const cp = { ...o }; delete cp[id]; return cp; });
      setSelectedId(null);
      setSelectedNode(null);
      equipment.reload();
    } catch (err) {
      // Revert tombstone.
      setOptimistic((o) => { const cp = { ...o }; delete cp[id]; return cp; });
      window.notifyError?.(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const loading = equipment.loading || customersList.loading;

  if (loading && !equipment.data) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Data · Items · Equipment hierarchy" title="Equipment hierarchy" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading equipment…</div></Card></div>
      </div>
    );
  }

  if (equipment.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Data · Items · Equipment hierarchy" title="Equipment hierarchy" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load equipment hierarchy"
                  action={<Btn sm onClick={equipment.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(equipment.error.message || equipment.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const customersForFilter = (customersList.data?.customers || []).slice().sort((a, b) =>
    String(a.customer_name || "").localeCompare(String(b.customer_name || ""))
  );

  return (
    <>
      <WSTitle
        eyebrow="Data · Items · Equipment hierarchy"
        title="Equipment hierarchy"
        meta={`${totals.guns} gun${totals.guns === 1 ? "" : "s"} across ${totals.cust} customer${totals.cust === 1 ? "" : "s"}`}
        right={<>
          <Btn icon kind="ghost" sm onClick={() => { equipment.reload(); customersList.reload(); locationsList.reload(); }} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => onAddChild({ kind: "root", id: "root", customer_id: filter || "", customer_location_id: null, plant_name: "", line_name: "", zone_name: "", station_name: "" })}>
            {Icon.plus} New gun
          </Btn>
        </>}
      />

      <div className="ws-content">
        <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 38%) 1fr", gap: 14, alignItems: "stretch" }}>
          <Card flush>
            <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--hairline-2)", display: "flex", gap: 6, alignItems: "center" }}>
              <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Customer filter" style={{ flex: 1 }}>
                <option value="">All customers ({customersForFilter.length})</option>
                {customersForFilter.map((c) => (
                  <option key={c.id} value={c.id}>{c.customer_name || c.customer_key || c.id.slice(0, 8)}</option>
                ))}
              </select>
              {filter && <Btn icon kind="ghost" sm onClick={() => setFilter("")} title="Clear filter">{Icon.x}</Btn>}
            </div>
            {tree.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                {filter ? "No equipment for the selected customer." : "No equipment yet. Click \"New gun\" to add one."}
              </div>
            ) : (
              <EquipTree
                tree={tree}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
                selected={selectedId}
                onAddChild={onAddChild}
                onEdit={(node) => onSelect(node)}
                onDelete={(node) => handleDelete(node.row.id)}
              />
            )}
          </Card>

          <div>
            {selectedNode ? (
              <EquipmentDetail
                key={selectedId || "new"}
                node={selectedNode}
                customers={customersForFilter}
                locations={locations}
                onSave={handleSave}
                onDelete={handleDelete}
                onCancel={onCancel}
                busy={busy}
              />
            ) : (
              <Card>
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                  Select a gun in the tree to edit it, or click <span className="mono">+</span> on a folder to add a new gun under it.
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    </>
  );
};


export default WiredEquipmentHierarchy;
