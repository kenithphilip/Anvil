// Allocations workbench (S5).
//
// Lists inventory_allocations with status chips. Operators can
// release a reservation back to the free pool, mark consumed, or
// create a new allocation.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

const STATUS_CHIP: Record<string, "good" | "info" | "warn" | "bad"> = {
  reserved: "info", consumed: "good", released: "warn", expired: "bad",
};

const InventoryAllocationsScreen: React.FC = () => {
  const [tab, setTab] = useState("reserved");
  const [allocs, setAllocs] = useState<{ data: any[]; loading: boolean }>({ data: [], loading: true });
  const [bump, setBump] = useState(0);

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
    Promise.resolve(ObaraBackend?.inventory?.allocations?.list?.(params))
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
      await (ObaraBackend as any)?.inventory?.allocations?.update?.(id, patch);
      window.notifySuccess?.("Allocation updated", id.slice(0, 8));
      setBump((n) => n + 1);
    } catch (err: any) {
      window.notifyError?.("Update failed", err?.message || String(err));
    }
  };

  return (
    <>
      <WSTitle eyebrow="Procurement" title="Allocations" meta={partFilter ? "filtered: " + partFilter : (allocs.data.length + " in view")} />
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
    </>
  );
};

export default InventoryAllocationsScreen;
