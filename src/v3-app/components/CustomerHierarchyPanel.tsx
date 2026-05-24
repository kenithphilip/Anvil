import React, { useMemo, useState } from "react";
import { Btn, Chip } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";

// Customer hierarchy: pick a parent (corporate group / holding entity)
// and see the child entities that roll up under this customer. Backed by
// customers.parent_customer_id (migration 137). Saving sends the full
// customer object through customers.upsert so the partial change does
// not clobber other columns.

type Customer = any;

export const CustomerHierarchyPanel: React.FC<{
  customer: Customer;
  allCustomers: Customer[];
  onChanged?: () => void;
  onOpen?: (id: string) => void;
}> = ({ customer, allCustomers, onChanged, onOpen }) => {
  const [busy, setBusy] = useState(false);

  const nameOf = (c: Customer) => c?.customer_name || c?.customer_key || (c?.id ? c.id.slice(0, 8) : "");
  // Candidate parents: every other customer (exclude self). Cycle
  // prevention beyond self is intentionally light for v1.
  const options = useMemo(
    () => (allCustomers || []).filter((c) => c.id !== customer.id).sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
    [allCustomers, customer.id]
  );
  const parent = (allCustomers || []).find((c) => c.id === customer.parent_customer_id) || null;
  const children = useMemo(
    () => (allCustomers || []).filter((c) => c.parent_customer_id === customer.id),
    [allCustomers, customer.id]
  );

  const setParent = async (parentId: string) => {
    setBusy(true);
    try {
      await ObaraBackend?.customers?.upsert?.({ ...customer, parent_customer_id: parentId || null });
      window.notifySuccess?.("Hierarchy updated", parentId ? "Parent set" : "Parent cleared");
      onChanged?.();
    } catch (e: any) {
      window.notifyError?.("Could not update hierarchy", e?.message || String(e));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8 }}>Hierarchy</div>
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Parent / group</label>
        <select
          className="select"
          aria-label="Parent customer"
          disabled={busy}
          value={customer.parent_customer_id || ""}
          onChange={(e) => setParent(e.target.value)}
          style={{ minWidth: 220 }}
        >
          <option value="">No parent (top-level)</option>
          {options.map((c) => <option key={c.id} value={c.id}>{nameOf(c)}</option>)}
        </select>
        {parent && (
          <Btn sm kind="ghost" onClick={() => onOpen?.(parent.id)} title="Open parent">{"↑"} {nameOf(parent)}</Btn>
        )}
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 4 }}>
          Child entities {children.length ? `(${children.length})` : ""}
        </div>
        {children.length === 0 ? (
          <div className="mono-sm" style={{ color: "var(--ink-3)" }}>None roll up under this customer.</div>
        ) : (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {children.map((c) => (
              <Chip key={c.id} k="ghost">
                <span role="button" tabIndex={0} style={{ cursor: "pointer" }}
                  onClick={() => onOpen?.(c.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpen?.(c.id); }}>
                  {nameOf(c)}
                </span>
              </Chip>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default CustomerHierarchyPanel;
