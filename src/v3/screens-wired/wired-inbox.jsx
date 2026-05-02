// ============================================================
// ANVIL v3 — wired Inbox
// Replaces the static demo Inbox with live data from documents
// + email-derived DRAFT orders + recent intake activity.
// ============================================================

const WiredInbox = () => {
  const { useState: u, useEffect: e } = React;
  const [orders, setOrders] = u({ data: null, loading: true, error: null });
  const [audit, setAudit] = u({ data: null, loading: true, error: null });
  const [bump, setBump] = u(0);

  e(() => {
    let cancelled = false;
    setOrders((s) => ({ ...s, loading: true }));
    Promise.resolve(window.ObaraBackend?.orders?.list?.({ limit: 200 }) || Promise.resolve([]))
      .then((data) => { if (!cancelled) setOrders({ data, loading: false, error: null }); })
      .catch((error) => { if (!cancelled) setOrders({ data: null, loading: false, error }); });
    return () => { cancelled = true; };
  }, [bump]);

  e(() => {
    let cancelled = false;
    Promise.resolve(window.ObaraBackend?.audit?.list?.({ limit: 50 }) || Promise.resolve([]))
      .then((data) => { if (!cancelled) setAudit({ data, loading: false, error: null }); })
      .catch((error) => { if (!cancelled) setAudit({ data: null, loading: false, error }); });
    return () => { cancelled = true; };
  }, [bump]);

  const reload = () => setBump((n) => n + 1);

  if (orders.loading) {
    return (
      <>
        <WSTitle eyebrow="Workflows · Inbox" title="Inbox" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading inbox…</div></Card></div>
      </>
    );
  }

  if (orders.error) {
    return (
      <>
        <WSTitle eyebrow="Workflows · Inbox" title="Inbox" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load inbox" action={<Btn sm onClick={reload}>Retry</Btn>}>
            <span className="mono-sm">{String(orders.error.message || orders.error)}</span>
          </Banner>
        </div>
      </>
    );
  }

  // The orders endpoint returns { orders: [...] }; older callers used .rows.
  // Handle both shapes plus a raw array.
  const orderList = Array.isArray(orders.data)
    ? orders.data
    : (orders.data?.orders || orders.data?.rows || []);
  const auditList = Array.isArray(audit.data)
    ? audit.data
    : (audit.data?.events || audit.data?.rows || []);

  // Inbox rows: drafts that originated from intake (capture surface).
  // We surface DRAFT, PENDING_REVIEW, and DUPLICATE so operators see anything
  // that hasn't been resolved yet, regardless of capture source.
  const intake = orderList.filter((o) => ["DRAFT", "PENDING_REVIEW", "DUPLICATE"].includes(o.status));

  const today = new Date().toDateString();
  const docsToday = intake.filter((o) => {
    const t = o.created_at;
    return t && new Date(t).toDateString() === today;
  }).length;
  const ocrPending = intake.filter((o) => {
    // Heuristic: if there's no extracted result yet but there's a preflight payload,
    // OCR is in flight or pending.
    const hasResult = o.result && o.result.salesOrder;
    return !hasResult;
  }).length;
  const emailBacklog = intake.filter((o) => o.preflight_payload?.source === "email_inbound").length;
  const recentUploads = auditList.filter((a) => /document_upload|upload_intent/i.test(a.action || "")).length;

  const sourceOf = (o) => {
    const src = o.preflight_payload?.source;
    if (src === "email_inbound") return "email";
    if (src === "drop") return "drop";
    if (src === "api") return "api";
    return o.po_number ? "drop" : "drop";
  };

  const fileNameOf = (o) => {
    return o.preflight_payload?.subject
      || o.po_number
      || o.quote_number
      || (o.preflight_payload?.from ? `from ${o.preflight_payload.from}` : null)
      || (o.id ? `draft ${o.id.slice(0, 8)}` : "draft");
  };

  const sizeOf = (o) => {
    const s = o.preflight_payload?.size_bytes;
    if (!s) return "—";
    if (s > 1024 * 1024) return (s / 1024 / 1024).toFixed(1) + " MB";
    if (s > 1024) return Math.round(s / 1024) + " KB";
    return s + " B";
  };

  const classifyChip = (o) => {
    const intent = o.preflight_payload?.intent;
    const map = {
      purchase_order: { k: "info", l: "Customer PO" },
      quote_request: { k: "ghost", l: "Quote request" },
      po_revision: { k: "warn", l: "PO revision" },
      status_request: { k: "ghost", l: "Status" },
    };
    if (intent && map[intent]) return map[intent];
    if (o.po_number) return { k: "info", l: "Customer PO" };
    if (o.quote_number) return { k: "ghost", l: "Quote" };
    return { k: "ghost", l: "untriaged" };
  };

  const ocrConfOf = (o) => {
    const c = o.evidence_by_field && Object.values(o.evidence_by_field)[0];
    if (typeof c === "object" && c?.confidence != null) return Number(c.confidence).toFixed(2);
    return "—";
  };

  return (
    <>
      <WSTitle
        eyebrow="Workflows · Inbox"
        title="Inbox"
        meta={`${intake.length} untriaged · email + drop + connectors`}
        right={<>
          <Btn icon kind="ghost" sm onClick={reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/intake"}>{Icon.upload} new SO from PO</Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Documents · today" v={String(docsToday)} d={docsToday ? "since 00:00 IST" : "no captures yet"} live={docsToday > 0} />
          <KPI lbl="OCR pending" v={String(ocrPending)} d={ocrPending ? "awaiting extract" : "queue clear"} dKind={ocrPending > 5 ? "down" : ""} />
          <KPI lbl="Email backlog" v={String(emailBacklog)} d={emailBacklog ? "from inbound provider" : "no inbound"} />
          <KPI lbl="Recent uploads" v={String(recentUploads)} d="last audit window" />
        </KPIRow>

        <Card flush>
          <div style={{ padding: "12px 16px" }}>
            <Banner kind="info" icon={Icon.upload} title="Drop or upload a document to capture intent"
                    action={<Btn sm kind="ghost" onClick={() => window.location.hash = "#/intake"}>open intake</Btn>}>
              <span className="mono-sm">PDF · DOCX · XLSX · ZIP · max 100 MB · ClamAV scanned · OCR auto-runs once accepted.</span>
            </Banner>
          </div>

          {intake.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No untriaged documents. <a onClick={() => window.location.hash = "#/intake"} style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>Capture a new PO</a>
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Source</th>
                <th>Subject / file</th>
                <th className="r">Size</th>
                <th>Detected</th>
                <th className="r">OCR conf</th>
                <th className="r">Age</th>
                <th style={{ width: 90 }}></th>
              </tr></thead>
              <tbody>
                {intake.slice(0, 100).map((o) => {
                  const cls = classifyChip(o);
                  const src = sourceOf(o);
                  return (
                    <tr key={o.id} onClick={() => window.location.hash = `#/so?id=${o.id}`} style={{ cursor: "pointer" }}>
                      <td className="mono-sm">{src}{o.preflight_payload?.from ? ` · ${o.preflight_payload.from}` : ""}</td>
                      <td>{fileNameOf(o)}</td>
                      <td className="r mono-sm">{sizeOf(o)}</td>
                      <td><Chip k={cls.k}>{cls.l}</Chip></td>
                      <td className="r mono">{ocrConfOf(o)}</td>
                      <td className="r mono">{ageLabel(o.created_at)}</td>
                      <td><Btn sm onClick={(ev) => { ev.stopPropagation(); window.location.hash = `#/so?id=${o.id}`; }}>open OCR {Icon.arrowR}</Btn></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {intake.length > 100 && (
            <div className="mono-sm" style={{ padding: 12, textAlign: "center", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
              Showing 100 of {intake.length}.
            </div>
          )}
        </Card>
      </div>
    </>
  );
};

window.Inbox = WiredInbox;
