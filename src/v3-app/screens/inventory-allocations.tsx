// Allocations workbench (S5).
//
// Lists inventory_allocations with status chips. Operators can
// release a reservation back to the free pool, mark consumed, or
// create a new allocation.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

const STATUS_CHIP: Record<string, "good" | "info" | "warn" | "bad"> = {
  reserved: "info", consumed: "good", released: "warn", expired: "bad",
};

const InventoryAllocationsScreen: React.FC = () => {
  const [tab, setTab] = useState("reserved");
  const [allocs, setAllocs] = useState<{ data: any[]; loading: boolean }>({ data: [], loading: true });
  const [bump, setBump] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<{
    part_no: string;
    qty: string;
    required_by: string;
    project_id: string;
    order_id: string;
    opportunity_id: string;
  }>({ part_no: "", qty: "", required_by: "", project_id: "", order_id: "", opportunity_id: "" });
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const submitCreate = async () => {
    setCreateBusy(true); setCreateErr(null);
    try {
      const payload: any = {
        part_no: createForm.part_no,
        qty: Number(createForm.qty),
        required_by: createForm.required_by || null,
        project_id: createForm.project_id || null,
        order_id: createForm.order_id || null,
        opportunity_id: createForm.opportunity_id || null,
      };
      if (!payload.part_no || !Number.isFinite(payload.qty) || payload.qty <= 0) {
        throw new Error("part_no and qty (>0) required");
      }
      await (AnvilBackend as any)?.inventory?.allocations?.create?.(payload);
      window.notifySuccess?.("Allocation created", payload.part_no + " x " + payload.qty);
      setShowCreate(false);
      setCreateForm({ part_no: "", qty: "", required_by: "", project_id: "", order_id: "", opportunity_id: "" });
      setBump((n) => n + 1);
    } catch (err: any) {
      setCreateErr(String(err?.message || err));
    } finally { setCreateBusy(false); }
  };

  const partFilter = (() => {
    const hash = window.location.hash || "";
    const q = hash.split("?")[1];
    return new URLSearchParams(q || "").get("part_no") || "";
  })();

  useEffect(() => {
    let cancelled = false;
    const params: any = {};
    if (tab !== "all") params.status = tab;
    if (partFilter) params.part_no = partFilter;
    Promise.resolve(AnvilBackend?.inventory?.allocations?.list?.(params))
      .then((r: any) => { if (!cancelled) setAllocs({ data: r?.allocations || [], loading: false }); })
      .catch(() => { if (!cancelled) setAllocs({ data: [], loading: false }); });
    return () => { cancelled = true; };
  }, [tab, partFilter, bump]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { reserved: 0, consumed: 0, released: 0, expired: 0 };
    for (const a of allocs.data) out[a.status] = (out[a.status] || 0) + 1;
    return out;
  }, [allocs.data]);

  const onUpdate = async (id: string, patch: any) => {
    try {
      await (AnvilBackend as any)?.inventory?.allocations?.update?.(id, patch);
      window.notifySuccess?.("Allocation updated", id.slice(0, 8));
      setBump((n) => n + 1);
    } catch (err: any) {
      window.notifyError?.("Update failed", err?.message || String(err));
    }
  };

  return (
    <>
      <WSTitle
        eyebrow="Procurement"
        title="Allocations"
        meta={partFilter ? "filtered: " + partFilter : (allocs.data.length + " in view")}
        right={<>
          <Btn sm kind="primary" onClick={() => setShowCreate(true)}>New allocation</Btn>
        </>}
      />
      <div className="ws-content">
        <KPIRow>
          <KPI lbl="Reserved" v={String(counts.reserved || 0)} d="active" />
          <KPI lbl="Consumed" v={String(counts.consumed || 0)} d="shipped" />
          <KPI lbl="Released" v={String(counts.released || 0)} d="returned to pool" />
          <KPI lbl="Expired"  v={String(counts.expired || 0)} d="past required-by" />
        </KPIRow>
        <WSTabs
          tabs={[
            { id: "reserved",  label: "Reserved",  count: counts.reserved },
            { id: "consumed",  label: "Consumed",  count: counts.consumed },
            { id: "released",  label: "Released",  count: counts.released },
            { id: "expired",   label: "Expired",   count: counts.expired },
            { id: "all",       label: "All" },
          ]}
          active={tab}
          onChange={setTab}
        />
        {allocs.loading ? (
          <Card><div className="body">Loading allocations…</div></Card>
        ) : allocs.data.length === 0 ? (
          <Banner kind="info" icon={Icon.info} title="No allocations">
            Allocations get created when an order moves to APPROVED with a
            schedule line, or by the operator from this screen.
          </Banner>
        ) : (
          <Card flush>
            <table className="tbl">
              <thead><tr>
                <th>Item</th>
                <th className="r">Qty</th>
                <th>Required by</th>
                <th>Status</th>
                <th>Project</th>
                <th>Order</th>
                <th></th>
              </tr></thead>
              <tbody>
                {allocs.data.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <a className="link" href={"#/inventory-item?part_no=" + encodeURIComponent(a.part_no)}>{a.part_no}</a>
                    </td>
                    <td className="r mono">{Number(a.qty)}</td>
                    <td className="mono-sm">{a.required_by}</td>
                    <td><Chip k={STATUS_CHIP[a.status] || "info"}>{a.status}</Chip></td>
                    <td className="mono-sm">{a.project_id ? a.project_id.slice(0, 8) : "—"}</td>
                    <td className="mono-sm">{a.order_id ? a.order_id.slice(0, 8) : "—"}</td>
                    <td className="row gap-sm">
                      {a.status === "reserved" && (
                        <>
                          <Btn sm kind="ghost" onClick={() => onUpdate(a.id, { status: "consumed" })}>consume</Btn>
                          <Btn sm kind="ghost" onClick={() => onUpdate(a.id, { status: "released" })}>release</Btn>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="modal-h">
              <span className="ti">New allocation</span>
              <Btn icon kind="ghost" sm onClick={() => setShowCreate(false)} aria-label="Close" title="Close (Esc)">{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <label className="lbl">Part number
                <input type="text" value={createForm.part_no}
                  onChange={(ev) => setCreateForm({ ...createForm, part_no: ev.target.value })} />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="lbl">Qty
                  <input type="number" min={1} value={createForm.qty}
                    onChange={(ev) => setCreateForm({ ...createForm, qty: ev.target.value })} />
                </label>
                <label className="lbl">Required by
                  <input type="date" value={createForm.required_by}
                    onChange={(ev) => setCreateForm({ ...createForm, required_by: ev.target.value })} />
                </label>
              </div>
              <label className="lbl">Project ID (optional)
                <input type="text" value={createForm.project_id}
                  onChange={(ev) => setCreateForm({ ...createForm, project_id: ev.target.value })} />
              </label>
              <label className="lbl">Order ID (optional)
                <input type="text" value={createForm.order_id}
                  onChange={(ev) => setCreateForm({ ...createForm, order_id: ev.target.value })} />
              </label>
              <label className="lbl">Opportunity ID (optional)
                <input type="text" value={createForm.opportunity_id}
                  onChange={(ev) => setCreateForm({ ...createForm, opportunity_id: ev.target.value })} />
              </label>
              {createErr && (
                <Banner kind="bad" icon={Icon.alert} title="Could not create">
                  <span className="mono-sm">{createErr}</span>
                </Banner>
              )}
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={() => setShowCreate(false)}>Cancel</Btn>
              <Btn kind="primary" disabled={createBusy} onClick={submitCreate}>{createBusy ? "Creating…" : "Create"}</Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default InventoryAllocationsScreen;
