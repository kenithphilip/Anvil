import React, { useEffect, useRef, useState } from "react";
import { Banner, Btn, Chip } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";

// Typeahead picker for item_master rows. Used by:
//   - so-workspace.tsx recon table manual map (Layer A)
//   - Layer C "Accept suggestion" (when the operator wants to
//     override the LLM's pick with a different canonical item)
//
// Backed by GET /api/admin/item_master?q=<text>&limit=10. Returns
// the full item_master row to the caller so the recon line can
// stamp _mapped_item with all the resolver-equivalent fields
// (hsn_sac, uom, type_of_supply, etc.) without re-fetching.

export interface PickedItem {
  id: string;
  part_no: string;
  description?: string | null;
  alias?: string | null;
  print_name?: string | null;
  hsn_sac?: string | null;
  uom?: string | null;
  source_country?: string | null;
  gst_applicable?: boolean | null;
  taxability_type?: string | null;
  type_of_supply?: string | null;
  rate_of_duty_pct?: number | null;
  stock_group?: string | null;
  specification_code?: string | null;
}

// Lightweight fetch wrapper. Mirrors the pattern in
// ItemDetailDrawer.tsx so we don't depend on a new AnvilBackend
// method that doesn't exist yet.
const fetchJson = async (path: string): Promise<any> => {
  const cfg: any = (AnvilBackend as any)?.getConfig?.() || {};
  const session: any = (AnvilBackend as any)?.getSession?.() || null;
  if (!cfg.url) throw new Error("Backend URL not configured");
  const headers: any = { "Content-Type": "application/json" };
  if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
  if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
  const url = cfg.url.replace(/\/+$/, "") + path;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error("HTTP " + resp.status + (text ? ": " + text.slice(0, 200) : ""));
  }
  return resp.json();
};

export const ItemMasterPicker: React.FC<{
  open: boolean;
  onClose: () => void;
  onPick: (item: PickedItem) => void;
  initialQuery?: string;
  title?: string;
}> = ({ open, onClose, onPick, initialQuery = "", title = "Map to canonical item" }) => {
  const [q, setQ] = useState(initialQuery);
  const [results, setResults] = useState<PickedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Reset state on open, autofocus the input.
  useEffect(() => {
    if (!open) return;
    setQ(initialQuery);
    setErr(null);
    setResults([]);
    // Defer focus to next tick so the modal is in the DOM.
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, initialQuery]);

  // ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    const query = q.trim();
    if (!query) { setResults([]); return; }
    debounceRef.current = window.setTimeout(async () => {
      setLoading(true);
      setErr(null);
      try {
        const data = await fetchJson("/api/admin/item_master?limit=10&q=" + encodeURIComponent(query));
        setResults((data?.items || []) as PickedItem[]);
      } catch (e: any) {
        setErr(e?.message || String(e));
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => { if (debounceRef.current != null) window.clearTimeout(debounceRef.current); };
  }, [q, open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(8,10,12,0.55)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
        zIndex: 300,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 92vw)",
          background: "var(--bg)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          display: "flex",
          flexDirection: "column",
          maxHeight: "70vh",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
          <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Item master</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        </div>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
          <input
            ref={inputRef}
            className="input mono"
            placeholder="Search by part number or description..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {err && (
            <div style={{ padding: 12 }}>
              <Banner kind="bad" title="Search failed">
                <span className="mono-sm">{err}</span>
              </Banner>
            </div>
          )}
          {!err && loading && (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Searching...</div>
          )}
          {!err && !loading && q.trim() && results.length === 0 && (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No items match.</div>
          )}
          {!err && !loading && !q.trim() && (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Type to search the item master.</div>
          )}
          {!err && !loading && results.length > 0 && (
            <table className="tbl" style={{ width: "100%" }}>
              <thead>
                <tr><th>Part #</th><th>Description</th><th>Alias</th><th>HSN</th><th>UoM</th></tr>
              </thead>
              <tbody>
                {results.map((row) => (
                  <tr
                    key={row.id}
                    style={{ cursor: "pointer" }}
                    onClick={() => { onPick(row); onClose(); }}
                  >
                    <td className="mono"><span className="pri">{row.part_no}</span></td>
                    <td>{row.description || row.print_name || "-"}</td>
                    <td>{row.alias || <span style={{ color: "var(--ink-3)" }}>-</span>}</td>
                    <td className="mono-sm">{row.hsn_sac || "-"}</td>
                    <td className="mono-sm">{row.uom || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Chip k="ghost">ESC to close</Chip>
          <Btn sm kind="ghost" onClick={onClose}>cancel</Btn>
        </div>
      </div>
    </div>
  );
};
