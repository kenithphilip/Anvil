// ============================================================
// ANVIL v3 — wired e-Invoice queue
// Wave D · Finance
// Reads via ObaraBackend.einvoice.list (api/einvoice GET).
// ============================================================

const EINVOICE_TABS = [
  { id: "PENDING_GSTN", label: "Pending" },
  { id: "GENERATED",    label: "Generated" },
  { id: "CANCELLED",    label: "Cancelled" },
  { id: "REJECTED",     label: "Rejected" },
];

const einvoiceRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.einvoices)) return resp.einvoices;
  if (Array.isArray(resp.rows)) return resp.rows;
  return [];
};

const einvoiceStatusChip = (status) => {
  switch (status) {
    case "DRAFT":         return { k: "ghost",  label: "DRAFT" };
    case "PENDING_GSTN":  return { k: "warn",   label: "PENDING_GSTN" };
    case "GENERATED":     return { k: "good",   label: "GENERATED" };
    case "CANCELLED":     return { k: "ghost",  label: "CANCELLED" };
    case "REJECTED":      return { k: "bad",    label: "REJECTED" };
    default:              return { k: "ghost",  label: status || "—" };
  }
};

// Hours remaining inside the GSTN 24h cancellation window.
const cancelCountdown = (ackDate, createdAt) => {
  const start = new Date(ackDate || createdAt || 0).getTime();
  if (!start) return null;
  const elapsedMs = Date.now() - start;
  const remainingMs = 24 * 3600_000 - elapsedMs;
  if (remainingMs <= 0) return { expired: true, label: "expired" };
  const hours = Math.floor(remainingMs / 3600_000);
  const mins = Math.floor((remainingMs % 3600_000) / 60_000);
  return { expired: false, label: `${hours}h ${mins}m` };
};

const WiredEInvoice = () => {
  const list = useFetch(() => window.ObaraBackend?.einvoice?.list?.() || Promise.resolve({ einvoices: [] }), []);
  const [active, setActive] = useStateW("PENDING_GSTN");
  const [busyId, setBusyId] = useStateW(null);
  const [flash, setFlash]   = useStateW(null);

  const rows = einvoiceRows(list.data);
  const counts = Object.fromEntries(EINVOICE_TABS.map((t) => [t.id, rows.filter((r) => r.status === t.id).length]));
  const drafts = rows.filter((r) => r.status === "DRAFT").length;
  const filtered = rows.filter((r) => r.status === active);

  const canCancel = !!(window.RBAC && window.RBAC.canDo && window.RBAC.canDo("einvoice.cancel"));

  const refresh = async (id) => {
    setBusyId(id);
    setFlash(null);
    try {
      // No GET-by-id; just refresh the list.
      list.reload();
      setFlash({ kind: "good", msg: "Refreshed e-Invoice list" });
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (row) => {
    if (!canCancel) return;
    setBusyId(row.id);
    setFlash(null);
    try {
      await window.ObaraBackend?.einvoice?.cancel?.({ id: row.id, cancel_reason: "1", cancel_remarks: "Cancelled by operator" });
      setFlash({ kind: "good", msg: `Cancelled ${row.invoice_number}` });
      list.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusyId(null);
    }
  };

  const resubmit = async (row) => {
    setBusyId(row.id);
    setFlash(null);
    try {
      await window.ObaraBackend?.einvoice?.sendToGstn?.(row.id);
      setFlash({ kind: "good", msg: `Resubmitted ${row.invoice_number}` });
      list.reload();
    } catch (err) {
      setFlash({ kind: "bad", msg: String(err.message || err) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <WSTitle
        eyebrow="Finance · e-Invoice"
        title="GSTN · IRN queue"
        meta={`${rows.length} total · ${drafts} drafts · ${counts.PENDING_GSTN} pending · ${counts.GENERATED} generated`}
        right={<>
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />
      <WSTabs
        tabs={EINVOICE_TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        {flash && (
          <Banner kind={flash.kind} icon={flash.kind === "bad" ? Icon.alert : Icon.check} title={flash.kind === "bad" ? "Action failed" : "Action complete"}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
        )}

        {list.error ? (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load e-Invoices" action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        ) : null}

        <KPIRow cols={4}>
          <KPI lbl="Drafts"        v={String(drafts)}                 d="awaiting send" />
          <KPI lbl="Pending GSTN"  v={String(counts.PENDING_GSTN)}    d="oldest first" live={counts.PENDING_GSTN > 0} />
          <KPI lbl="Generated"     v={String(counts.GENERATED)}       d="MTD" />
          <KPI lbl="Rejected"      v={String(counts.REJECTED)}        d="needs resubmit" dKind={counts.REJECTED ? "down" : ""} />
        </KPIRow>

        <Card flush>
          {list.loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading e-Invoices…</div>
          ) : filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No invoices in this view.</div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th scope="col">Invoice number</th>
                <th scope="col">IRN</th>
                <th scope="col">Customer</th>
                <th scope="col" className="r">Value</th>
                <th scope="col">Status</th>
                <th scope="col">Cancel window</th>
                <th scope="col" style={{ width: 160 }}></th>
              </tr></thead>
              <tbody>
                {filtered.map((r) => {
                  const chip = einvoiceStatusChip(r.status);
                  const value = Number(r.total_value) || 0;
                  const countdown = r.status === "GENERATED" ? cancelCountdown(r.ack_date, r.created_at) : null;
                  return (
                    <tr key={r.id}>
                      <td className="mono"><span className="pri">{r.invoice_number}</span></td>
                      <td className="mono-sm">{r.irn ? shortHash(r.irn) : "—"}</td>
                      <td>{(r.customer && r.customer.customer_name) || (r.customer_id ? r.customer_id.slice(0, 8) : "—")}<div className="mono-sm">{r.customer_gstin || ""}</div></td>
                      <td className="r mono">{value ? fmtINRShort(value) : "—"}</td>
                      <td><Chip k={chip.k}>{chip.label}</Chip></td>
                      <td className="mono-sm" style={{ color: countdown && countdown.expired ? "var(--ink-4)" : "var(--amber-2)" }}>
                        {r.status === "GENERATED" ? (countdown ? countdown.label : "—") : "—"}
                      </td>
                      <td>
                        {r.status === "PENDING_GSTN" && (
                          <Btn sm disabled={busyId === r.id} onClick={() => refresh(r.id)}>{busyId === r.id ? "…" : <>refresh {Icon.cycle}</>}</Btn>
                        )}
                        {r.status === "GENERATED" && (
                          <div className="row gap-sm">
                            {r.qr_code_b64 ? (
                              <a className="btn sm" href={"data:image/png;base64," + r.qr_code_b64} download={(r.invoice_number || "qr") + ".png"}>{Icon.download} QR</a>
                            ) : null}
                            <Btn sm kind="ghost" disabled={!canCancel || (countdown && countdown.expired) || busyId === r.id} onClick={() => cancel(r)}>
                              {busyId === r.id ? "…" : "cancel"}
                            </Btn>
                          </div>
                        )}
                        {r.status === "REJECTED" && (
                          <Btn sm kind="primary" disabled={busyId === r.id} onClick={() => resubmit(r)}>{busyId === r.id ? "…" : <>resubmit {Icon.send}</>}</Btn>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Banner kind="info" icon={Icon.info} title="Cancel-within-24h policy">
          <span className="mono-sm">An e-Invoice can be cancelled at GSTN within 24 hours of generation. After that, the only correction is a Credit Note. The 24h window starts at GSTN ack, not Anvil queue time.</span>
        </Banner>
      </div>
    </>
  );
};

window.EInvoice = WiredEInvoice;
