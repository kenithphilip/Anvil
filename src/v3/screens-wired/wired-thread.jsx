// ============================================================
// ANVIL v3 — wired ThreadDrawer
// Replaces shell.jsx's static demo with a live timeline of the
// active order: audit events + communications + tally pushes.
// ============================================================

const WiredThreadDrawer = ({ open, onClose }) => {
  const { useState: uS, useEffect: uE } = React;
  const [order, setOrder] = uS({ data: null, loading: false, error: null });
  const [events, setEvents] = uS({ rows: [], loading: false, error: null });

  // Read order id from URL hash query (e.g. #/so?id=abc123)
  const orderId = (() => {
    try {
      const hash = window.location.hash || "";
      const qpos = hash.indexOf("?");
      if (qpos < 0) return null;
      const params = new URLSearchParams(hash.slice(qpos + 1));
      return params.get("id");
    } catch { return null; }
  })();

  uE(() => {
    if (!open || !orderId) return;
    let cancel = false;
    setOrder({ data: null, loading: true, error: null });
    setEvents({ rows: [], loading: true, error: null });

    Promise.all([
      window.ObaraBackend?.orders?.get?.(orderId).catch((e) => ({ error: e })),
      window.ObaraBackend?.audit?.list?.({ object_id: orderId, limit: 30 }).catch((e) => ({ error: e })),
    ]).then(([o, a]) => {
      if (cancel) return;
      if (o?.error) setOrder({ data: null, loading: false, error: o.error });
      else setOrder({ data: o, loading: false, error: null });
      if (a?.error) setEvents({ rows: [], loading: false, error: a.error });
      else {
        const rows = Array.isArray(a) ? a : (a?.rows || []);
        setEvents({ rows, loading: false, error: null });
      }
    });
    return () => { cancel = true; };
  }, [open, orderId]);

  if (!open) return null;

  // Map audit action → tag + color
  const tagFor = (action) => {
    const a = (action || "").toLowerCase();
    if (a.includes("upload") || a.includes("ocr")) return { k: "OC", c: "info" };
    if (a.includes("validation") || a.includes("finding")) return { k: "VA", c: "warn" };
    if (a.includes("approval") || a.includes("approve")) return { k: "AP", c: "good" };
    if (a.includes("tally") || a.includes("push")) return { k: "TA", c: "info" };
    if (a.includes("source_po") || a.includes("supplier")) return { k: "SP", c: "info" };
    if (a.includes("shipment")) return { k: "SH", c: "info" };
    if (a.includes("einvoice") || a.includes("irn")) return { k: "EI", c: "warn" };
    if (a.includes("communication") || a.includes("comm")) return { k: "CM", c: "info" };
    if (a.includes("po") || a.includes("order_create")) return { k: "PO", c: "good" };
    if (a.includes("quote")) return { k: "QU", c: "good" };
    return { k: "EV", c: "ghost" };
  };

  const orderRef = order.data?.po_number || order.data?.quote_number || orderId?.slice(0, 8);
  const customer = order.data?.customer?.customer_name || "—";

  return (
    <div className="cmdk-bg" style={{ padding: 0, alignItems: "stretch", justifyItems: "end" }} onClick={onClose} role="dialog" aria-modal="true" aria-label="Order thread">
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-h">
          <div>
            <div className="h-eyebrow">Thread {orderId ? `· ${orderRef}` : ""}</div>
            <div className="h2" style={{ marginTop: 2 }}>
              {orderId ? customer : "No order selected"}
            </div>
          </div>
          <button className="btn icon sm ghost" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close drawer">
            {window.Icon?.x}
          </button>
        </div>

        {!orderId ? (
          <div style={{ padding: "16px", color: "var(--ink-3)" }} className="body">
            Open a Sales Order or other detail page to see its thread.
          </div>
        ) : order.loading || events.loading ? (
          <div style={{ padding: "16px", color: "var(--ink-3)" }} className="body">
            Loading timeline…
          </div>
        ) : order.error || events.error ? (
          <div style={{ padding: "16px" }}>
            <Banner kind="bad" icon={window.Icon?.alert} title="Could not load thread">
              <span className="mono-sm">{String((order.error || events.error)?.message || order.error || events.error)}</span>
            </Banner>
          </div>
        ) : events.rows.length === 0 ? (
          <div style={{ padding: "16px", color: "var(--ink-3)" }} className="body">
            No events for this order yet.
          </div>
        ) : (
          <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10, overflow: "auto", flex: 1 }}>
            {events.rows.map((e, i) => {
              const tag = tagFor(e.action);
              const dt = new Date(e.created_at);
              return (
                <div key={e.id || i} style={{ display: "grid", gridTemplateColumns: "32px 1fr auto", gap: 10, alignItems: "start", padding: 10, border: "1px solid var(--hairline)", borderRadius: 6, background: "var(--paper)" }}>
                  <div style={{
                    width: 28, height: 28, display: "grid", placeItems: "center",
                    background: "var(--paper-3)",
                    borderRadius: 4, fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, color: "var(--ink)"
                  }}>{tag.k}</div>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {(e.action || "event").replace(/_/g, " ")}
                    </div>
                    <div className="mono-sm">
                      {dt.toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}
                      {e.actor_user_id && ` · ${e.actor_user_id.slice(0, 8)}`}
                      {e.detail?.role && ` · ${e.detail.role}`}
                    </div>
                  </div>
                  <Chip k={tag.c}>{tag.k.toLowerCase()}</Chip>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

window.ThreadDrawer = WiredThreadDrawer;
