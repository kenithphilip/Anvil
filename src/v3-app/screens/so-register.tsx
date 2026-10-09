import React from "react";
import { fmtCurrency, fmtDate, stageOf } from "../lib/helpers";
import { Banner, Btn, Card, Chip, WSTitle, rowActivateProps } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3: Sales-order register
// One row per received PO, with what Anvil did with it: how it arrived,
// what extraction read, what reconciliation found, the order's status, and
// whether the ERP's own sales order is on file. In Mode B this is the
// record of every sales order received and analysed while the voucher
// lives in the ERP. Data: GET /api/orders/register (server-paginated).
// ============================================================

const CHANNEL_LABEL: Record<string, string> = {
  upload: "Upload",
  email: "Email",
  whatsapp: "WhatsApp",
  chat: "Chat",
  voice: "Voice",
  quote: "From quote",
  portal: "Portal",
  other: "Other",
};
const DEFAULT_CHANNELS = ["upload", "email", "whatsapp", "chat", "voice", "quote", "portal"];

const STATUSES = [
  "DRAFT", "PENDING_REVIEW", "APPROVED", "BLOCKED", "DUPLICATE", "REUSED",
  "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT", "RECONCILED", "CANCELLED",
];

const EXTRACTION_CHIP: Record<string, { k: string; label: string }> = {
  ok: { k: "good", label: "read" },
  low_confidence: { k: "warn", label: "low confidence" },
  failed: { k: "bad", label: "failed" },
  running: { k: "info", label: "running" },
  no_run: { k: "ghost", label: "no extraction run" },
  not_extracted: { k: "ghost", label: "not extracted" },
};

const PAGE_SIZE = 50;

type Filters = { from: string; to: string; customer: string; channel: string; status: string; hasFlags: boolean };
const EMPTY: Filters = { from: "", to: "", customer: "", channel: "", status: "", hasFlags: false };

// A local calendar day as the instant it starts, so "from 1 Oct" means the
// operator's own midnight, not UTC's. `to` is exclusive: the next midnight.
const dayStart = (ymd: string, plusDays = 0): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m || 1) - 1, (d || 1) + plusDays).toISOString();
};

export const registerParams = (f: Filters, page: number) => ({
  page,
  page_size: PAGE_SIZE,
  from: f.from ? dayStart(f.from) : "",
  to: f.to ? dayStart(f.to, 1) : "",
  customer: f.customer,
  channel: f.channel,
  status: f.status,
  has_flags: f.hasFlags ? "1" : "",
});

const pct = (v: number | null | undefined) => (v == null ? "" : Math.round(Number(v) * 100) + "%");

const SoRegister: React.FC = () => {
  const [filters, setFilters] = React.useState<Filters>(EMPTY);
  const [page, setPage] = React.useState(1);
  const [customers, setCustomers] = React.useState<any[]>([]);
  const [state, setState] = React.useState<{ rows: any[]; total: number | null; hasMore: boolean; channels: string[]; loading: boolean; error: any }>(
    { rows: [], total: null, hasMore: false, channels: DEFAULT_CHANNELS, loading: true, error: null },
  );
  const [exporting, setExporting] = React.useState(false);
  const [exportErr, setExportErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    Promise.resolve(AnvilBackend?.customers?.list?.() || { customers: [] })
      .then((r: any) => {
        const list = (r?.customers || []).filter((c: any) => c && c.id);
        list.sort((a: any, b: any) => String(a.customer_name || "").localeCompare(String(b.customer_name || "")));
        setCustomers(list);
      })
      .catch(() => setCustomers([]));
  }, []);

  React.useEffect(() => {
    let cancel = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve(AnvilBackend?.orders?.register?.(registerParams(filters, page)))
      .then((r: any) => {
        if (cancel) return;
        setState({
          rows: Array.isArray(r?.rows) ? r.rows : [],
          total: typeof r?.total === "number" ? r.total : null,
          hasMore: !!r?.has_more,
          channels: Array.isArray(r?.channels) && r.channels.length ? r.channels : DEFAULT_CHANNELS,
          loading: false,
          error: null,
        });
      })
      .catch((err: any) => { if (!cancel) setState((s) => ({ ...s, rows: [], loading: false, error: err })); });
    return () => { cancel = true; };
  }, [filters, page]);

  // Any filter change starts again at page 1.
  const setFilter = (patch: Partial<Filters>) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };
  const anyFilter = JSON.stringify(filters) !== JSON.stringify(EMPTY);

  const exportXlsx = async () => {
    setExporting(true); setExportErr(null);
    try {
      const out: any = await AnvilBackend?.orders?.registerExportBlob?.(registerParams(filters, 1));
      if (!out?.blob) throw new Error("Export helper unavailable");
      const url = URL.createObjectURL(out.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = out.filename || "SO_register.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err: any) {
      setExportErr(err?.message || String(err));
    } finally { setExporting(false); }
  };

  const pages = state.total != null ? Math.max(1, Math.ceil(state.total / PAGE_SIZE)) : null;
  const selectStyle = { background: "transparent", border: "none", color: "inherit", font: "inherit", outline: "none", cursor: "pointer", padding: 0 };

  return (
    <>
      <WSTitle
        eyebrow="Workflows · Sales Orders"
        title="Sales-order register"
        meta={state.total != null ? `${state.total} order${state.total === 1 ? "" : "s"}` : ""}
        right={<>
          <Btn sm kind="ghost" onClick={() => { window.location.hash = "#/so"; }}>Sales orders</Btn>
          <Btn sm kind="ghost" onClick={exportXlsx} disabled={exporting}>{Icon.download} {exporting ? "exporting…" : "Excel"}</Btn>
        </>}
      />

      <div className="row gap-sm" style={{
        padding: "8px 16px",
        borderTop: "1px solid var(--hairline)",
        borderBottom: "1px solid var(--hairline)",
        alignItems: "center", flexWrap: "wrap",
        background: "var(--paper)",
      }}>
        <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{Icon.filter} filter</span>
        <Chip k={filters.from || filters.to ? "fill" : undefined}>
          received:&nbsp;
          <input type="date" aria-label="Received from" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} style={selectStyle} />
          &nbsp;to&nbsp;
          <input type="date" aria-label="Received to" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} style={selectStyle} />
        </Chip>
        <Chip k={filters.customer ? "fill" : undefined}>
          customer:&nbsp;
          <select aria-label="Filter by customer" value={filters.customer} onChange={(e) => setFilter({ customer: e.target.value })} style={{ ...selectStyle, maxWidth: 200 }}>
            <option value="">any</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.id.slice(0, 8)}</option>)}
          </select>
        </Chip>
        <Chip k={filters.channel ? "fill" : undefined}>
          channel:&nbsp;
          <select aria-label="Filter by channel" value={filters.channel} onChange={(e) => setFilter({ channel: e.target.value })} style={selectStyle}>
            <option value="">any</option>
            {state.channels.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c] || c}</option>)}
          </select>
        </Chip>
        <Chip k={filters.status ? "fill" : undefined}>
          status:&nbsp;
          <select aria-label="Filter by status" value={filters.status} onChange={(e) => setFilter({ status: e.target.value })} style={selectStyle}>
            <option value="">any</option>
            {STATUSES.map((s) => <option key={s} value={s}>{stageOf(s).label} ({s})</option>)}
          </select>
        </Chip>
        <Chip k={filters.hasFlags ? "fill" : undefined}>
          <label style={{ cursor: "pointer" }}>
            <input type="checkbox" aria-label="Only orders with reconciliation flags" checked={filters.hasFlags}
                   onChange={(e) => setFilter({ hasFlags: e.target.checked })} />
            &nbsp;has flags
          </label>
        </Chip>
        {anyFilter && (
          <button type="button" onClick={() => { setFilters(EMPTY); setPage(1); }}
                  style={{ background: "none", border: "none", color: "var(--ink-3)", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
            clear filters
          </button>
        )}
      </div>

      <div className="ws-content">
        {state.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load the register">
            <span className="mono-sm">{String(state.error?.message || state.error)}</span>
          </Banner>
        )}
        {exportErr && (
          <Banner kind="bad" icon={Icon.alert} title="Could not export the register">
            <span className="mono-sm">{exportErr}</span>
          </Banner>
        )}

        <Card flush>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead><tr>
                <th>Received</th>
                <th>Channel</th>
                <th>Customer</th>
                <th>PO number · date</th>
                <th className="r">Value</th>
                <th className="r">Lines</th>
                <th>Extraction</th>
                <th>Reconciliation</th>
                <th>Status</th>
                <th>ERP SO</th>
                <th>Handoff</th>
              </tr></thead>
              <tbody>
                {state.loading ? (
                  <tr><td colSpan={11} className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading the register…</td></tr>
                ) : state.rows.length === 0 ? (
                  <tr><td colSpan={11} className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                    {anyFilter ? "No orders match these filters." : "No orders received yet."}
                  </td></tr>
                ) : state.rows.map((r) => {
                  const st = stageOf(r.status);
                  const ex = EXTRACTION_CHIP[r.extraction?.status] || { k: "ghost", label: r.extraction?.status || "unknown" };
                  const rec = r.reconciliation || {};
                  return (
                    <tr key={r.id} {...rowActivateProps(
                      () => { window.location.hash = `#/so?id=${r.id}`; },
                      `Open order ${r.po_number || r.id.slice(0, 8)}`,
                    )}>
                      <td className="mono-sm">{fmtDate(r.received_at)}</td>
                      <td><Chip k="ghost">{CHANNEL_LABEL[r.channel] || r.channel}</Chip></td>
                      <td>{r.customer_name || <span style={{ color: "var(--ink-3)" }}>unassigned</span>}</td>
                      <td className="mono-sm"><span className="pri">{r.po_number || "no PO number"}</span><div style={{ color: "var(--ink-3)" }}>{fmtDate(r.po_date)}</div></td>
                      <td className="r mono">{r.value != null ? fmtCurrency(r.value, r.currency || "INR") : ""}</td>
                      <td className="r mono">{r.line_count ?? 0}</td>
                      <td><Chip k={ex.k as any}>{ex.label}</Chip>{r.extraction?.confidence != null ? <span className="mono-sm"> {pct(r.extraction.confidence)}</span> : null}</td>
                      <td className="mono-sm">
                        {!rec.analysed ? <span style={{ color: "var(--ink-3)" }}>not analysed</span> : (
                          <>
                            {rec.matched ?? "?"}/{rec.total ?? "?"} matched
                            <div>
                              <Chip k={rec.line_flags ? "warn" : "ghost"}>{rec.line_flags} line flag{rec.line_flags === 1 ? "" : "s"}</Chip>
                              <Chip k={rec.terms_flags ? "warn" : "ghost"}>{rec.terms_flags} terms flag{rec.terms_flags === 1 ? "" : "s"}</Chip>
                            </div>
                          </>
                        )}
                      </td>
                      <td><Chip k={st.k as any}>{st.label}</Chip></td>
                      <td className="mono-sm">{r.erp_so?.attached ? (r.erp_so.voucher_no || "attached") : <span style={{ color: "var(--ink-3)" }}>none</span>}</td>
                      {/* Placeholder until the order-processing handoff ships. */}
                      <td className="mono-sm" style={{ color: "var(--ink-3)" }}>{r.handoff?.status === "not_sent" ? "not sent" : (r.handoff?.status || "not sent")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row gap-sm" style={{ padding: 12, justifyContent: "flex-end", alignItems: "center", borderTop: "1px solid var(--hairline-2)" }}>
            <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
              Page {page}{pages != null ? ` of ${pages}` : ""}
            </span>
            <Btn sm kind="ghost" disabled={page <= 1 || state.loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Btn>
            <Btn sm kind="ghost" disabled={!state.hasMore || state.loading} onClick={() => setPage((p) => p + 1)}>Next</Btn>
          </div>
        </Card>
      </div>
    </>
  );
};

export default SoRegister;
