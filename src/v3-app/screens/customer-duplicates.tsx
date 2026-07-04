import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// Audit P9.5: dedicated customer-duplicates screen with a merge
// flow. The order-level duplicates screen lives at #/duplicates;
// this surface (#/customer-duplicates) consumes
// customers.findDuplicates (P4.5) + customers.merge (P4.6).
//
// Layout: groups returned by the API rendered as cards. Each
// card shows the signal that fired (gstin / canonical_name /
// vendor_prefix), the candidate rows, a primary picker, and an
// "Apply merge" button. Operator confirms before the destructive
// call.

type CustomerRow = {
  id: string;
  customer_key: string | null;
  customer_name: string | null;
  gstin: string | null;
  contact_email: string | null;
  external_ref: Record<string, unknown> | null;
  created_at: string | null;
};

type Group = {
  signal: "gstin" | "canonical_name" | "vendor_prefix" | string;
  signal_value?: string | null;
  customers: CustomerRow[];
};

const SIGNAL_TONE: Record<string, "good" | "warn" | "bad" | "info"> = {
  gstin:           "good",
  canonical_name:  "warn",
  vendor_prefix:   "info",
};

const SIGNAL_LABEL: Record<string, string> = {
  gstin:          "GSTIN match",
  canonical_name: "Name match",
  vendor_prefix:  "Vendor-prefix mismatch",
};

const fmtRef = (ref: Record<string, unknown> | null | undefined): string => {
  if (!ref || typeof ref !== "object") return "—";
  const keys = Object.keys(ref).slice(0, 3);
  if (!keys.length) return "—";
  return keys.map((k) => k + "=" + String((ref as Record<string, unknown>)[k]).slice(0, 18)).join(", ");
};

const CustomerDuplicatesScreen: React.FC = () => {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-group: which customer is the primary, and which dups are
  // selected for the merge.
  const [primaryByGroup, setPrimaryByGroup] = useState<Record<number, string>>({});
  const [selectedDupsByGroup, setSelectedDupsByGroup] = useState<Record<number, Set<string>>>({});
  const [mergingGroup, setMergingGroup] = useState<number | null>(null);
  const [mergedSignal, setMergedSignal] = useState<{ idx: number; primary: string; merged: number } | null>(null);

  const reload = () => {
    setLoading(true);
    setError(null);
    Promise.resolve(AnvilBackend?.customers?.findDuplicates?.())
      .then((r: any) => {
        const g: Group[] = Array.isArray(r?.groups) ? r.groups : [];
        setGroups(g);
        // Default each group's primary to the row with the
        // longest customer_name (best chance of being the
        // canonical entity), and leave dups unselected so the
        // operator picks deliberately.
        const primaries: Record<number, string> = {};
        const sels: Record<number, Set<string>> = {};
        g.forEach((grp, i) => {
          const sorted = [...grp.customers].sort((a, b) => (b.customer_name?.length || 0) - (a.customer_name?.length || 0));
          if (sorted[0]) primaries[i] = sorted[0].id;
          sels[i] = new Set();
        });
        setPrimaryByGroup(primaries);
        setSelectedDupsByGroup(sels);
        setLoading(false);
      })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  };

  useEffect(reload, []);

  const toggleDup = (gi: number, id: string) => {
    setSelectedDupsByGroup((s) => {
      const current = s[gi] || new Set<string>();
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { ...s, [gi]: next };
    });
  };

  const setPrimary = (gi: number, id: string) => {
    setPrimaryByGroup((s) => ({ ...s, [gi]: id }));
    // Drop the new primary from the selected-dups set if it was
    // there; merging a row into itself is a 400.
    setSelectedDupsByGroup((s) => {
      const current = s[gi] || new Set<string>();
      const next = new Set(current);
      next.delete(id);
      return { ...s, [gi]: next };
    });
  };

  const applyMerge = async (gi: number) => {
    const primary = primaryByGroup[gi];
    const dups = Array.from(selectedDupsByGroup[gi] || new Set());
    if (!primary || !dups.length) return;
    const confirmed = window.confirm(
      "Merge " + dups.length + " customer" + (dups.length === 1 ? "" : "s") + " into " + primary.slice(0, 8) +
      "?\n\nEvery row pointing at the duplicates (orders, invoices, contacts, etc.) is repointed to the primary, then the duplicate rows are deleted. This cannot be undone.",
    );
    if (!confirmed) return;
    setMergingGroup(gi);
    setError(null);
    try {
      await AnvilBackend?.customers?.merge?.({ primary_id: primary, duplicate_ids: dups });
      setMergedSignal({ idx: gi, primary, merged: dups.length });
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMergingGroup(null);
    }
  };

  const totals = {
    groups: groups.length,
    customers: groups.reduce((s, g) => s + g.customers.length, 0),
    bySignal: groups.reduce((acc, g) => {
      acc[g.signal] = (acc[g.signal] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };

  return (
    <div className="ws ws-no-rail">
      <WSTitle
        eyebrow="Quality · Customer duplicates"
        title="Customer duplicate review"
        meta={totals.groups + " group" + (totals.groups === 1 ? "" : "s") + " · " + totals.customers + " candidate row" + (totals.customers === 1 ? "" : "s")}
        right={<Btn sm kind="ghost" onClick={reload}>Refresh</Btn>}
      />
      <div className="ws-content">
        {error && <Banner kind="bad" title="Could not load duplicates">{error}</Banner>}
        {mergedSignal && (
          <Banner kind="good" title={"Merged " + mergedSignal.merged + " row" + (mergedSignal.merged === 1 ? "" : "s") + " into " + mergedSignal.primary.slice(0, 8)}>
            Re-running the duplicate detector below.
          </Banner>
        )}
        <KPIRow>
          <KPI lbl="Groups" v={String(totals.groups)} d="probable duplicates" />
          <KPI lbl="Rows" v={String(totals.customers)} d="across all groups" />
          <KPI lbl="GSTIN" v={String(totals.bySignal.gstin || 0)} d="high-confidence matches" />
          <KPI lbl="Name" v={String(totals.bySignal.canonical_name || 0)} d="canonical-name matches" />
          <KPI lbl="Vendor" v={String(totals.bySignal.vendor_prefix || 0)} d="ERP-prefixed key" />
        </KPIRow>

        {loading ? (
          <Card><div style={{ padding: 16 }}>Loading customer duplicate groups...</div></Card>
        ) : groups.length === 0 ? (
          <Card><div style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No duplicate groups detected. The canonicaliser is keeping the master table clean.</div></Card>
        ) : (
          groups.map((g, gi) => {
            const primary = primaryByGroup[gi];
            const dups = selectedDupsByGroup[gi] || new Set();
            const tone = SIGNAL_TONE[g.signal] || "info";
            const label = SIGNAL_LABEL[g.signal] || g.signal;
            return (
              <Card
                key={gi}
                title={<span><Chip k={tone}>{label}</Chip>{g.signal_value ? <span className="mono-sm" style={{ marginLeft: 8, color: "var(--ink-3)" }}>{g.signal_value}</span> : null}</span>}
                eyebrow={"group " + (gi + 1) + " · " + g.customers.length + " row" + (g.customers.length === 1 ? "" : "s")}
                right={<Btn
                  sm
                  kind="primary"
                  disabled={mergingGroup === gi || !primary || dups.size === 0}
                  onClick={() => applyMerge(gi)}
                >
                  {mergingGroup === gi ? "Merging..." : "Merge " + dups.size + " into primary"}
                </Btn>}
              >
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 70 }}>Primary</th>
                      <th style={{ width: 70 }}>Merge?</th>
                      <th>Customer</th>
                      <th>Customer key</th>
                      <th>GSTIN</th>
                      <th>Email</th>
                      <th>External refs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.customers.map((c) => {
                      const isPrimary = primary === c.id;
                      return (
                        <tr key={c.id}>
                          <td>
                            <input
                              type="radio"
                              name={"primary-" + gi}
                              checked={isPrimary}
                              onChange={() => setPrimary(gi, c.id)}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              disabled={isPrimary}
                              checked={dups.has(c.id)}
                              onChange={() => toggleDup(gi, c.id)}
                            />
                          </td>
                          <td><span className="pri">{c.customer_name || <span style={{ color: "var(--ink-3)" }}>(no name)</span>}</span></td>
                          <td><code>{c.customer_key || "-"}</code></td>
                          <td className="mono-sm">{c.gstin || "-"}</td>
                          <td className="mono-sm">{c.contact_email || "-"}</td>
                          <td className="mono-sm">{fmtRef(c.external_ref)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {dups.size > 0 && primary && (
                  <div className="mono-sm" style={{ padding: "8px 12px", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
                    Merging {dups.size} row{dups.size === 1 ? "" : "s"} will repoint orders, invoices, contacts, communications, and audit events to <code>{primary.slice(0, 8)}</code> and delete the duplicate rows. Cannot be undone.
                  </div>
                )}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
};

export default CustomerDuplicatesScreen;
