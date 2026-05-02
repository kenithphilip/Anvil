// ============================================================
// ANVIL v3 — wired SO Workspace
// The hero screen: reconciliation grid + margin cockpit + why
// + evidence + approval + tally + shipments + activity, all
// keyed by ?id= in the URL hash.
// ============================================================

const WiredSOWorkspace = () => {
  const { useState: u, useEffect: e } = React;
  const [order, setOrder] = u({ data: null, loading: true, error: null });
  const [audit, setAudit] = u({ data: [], loading: true });
  const [cost, setCost] = u({ data: null, loading: true });
  const [tab, setTab] = u("recon");
  const [bump, setBump] = u(0);

  // Read order id from URL hash query: #/so?id=...
  const orderId = (() => {
    const hash = window.location.hash || "";
    const q = hash.split("?")[1];
    if (!q) return null;
    return new URLSearchParams(q).get("id");
  })();

  e(() => {
    if (!orderId) { setOrder({ data: null, loading: false, error: new Error("no order id in URL") }); return; }
    let cancelled = false;
    setOrder((s) => ({ ...s, loading: true }));
    Promise.resolve(window.ObaraBackend?.orders?.get?.(orderId))
      .then((data) => { if (!cancelled) setOrder({ data: data?.order || data, loading: false, error: null }); })
      .catch((error) => { if (!cancelled) setOrder({ data: null, loading: false, error }); });
    return () => { cancelled = true; };
  }, [orderId, bump]);

  e(() => {
    if (!orderId) return;
    let cancelled = false;
    Promise.resolve(window.ObaraBackend?.audit?.list?.({ object_id: orderId, limit: 50 }) || Promise.resolve([]))
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data) ? data : (data?.events || data?.rows || []);
        setAudit({ data: rows, loading: false });
      })
      .catch(() => { if (!cancelled) setAudit({ data: [], loading: false }); });
    return () => { cancelled = true; };
  }, [orderId, bump]);

  e(() => {
    if (!orderId || !order.data?.customer_id) return;
    let cancelled = false;
    Promise.resolve(window.ObaraBackend?.cost?.breakdown?.({ customer_id: order.data.customer_id }) || Promise.resolve(null))
      .then((data) => { if (!cancelled) setCost({ data, loading: false }); })
      .catch(() => { if (!cancelled) setCost({ data: null, loading: false }); });
    return () => { cancelled = true; };
  }, [orderId, order.data?.customer_id]);

  if (!orderId) {
    return (
      <>
        <WSTitle eyebrow="Sales Orders · Workspace" title="Pick an order" meta="no id in URL" />
        <div className="ws-content">
          <Banner kind="info" icon={Icon.info} title="No order selected"
                  action={<Btn sm onClick={() => window.location.hash = "#/so"}>open list</Btn>}>
            <span className="mono-sm">Pass an id via the URL: <code>#/so?id=ORDER_ID</code></span>
          </Banner>
        </div>
      </>
    );
  }

  if (order.loading) {
    return (
      <>
        <WSTitle eyebrow="Sales Orders · Workspace" title="Loading…" meta={orderId.slice(0, 8)} />
        <div className="ws-content"><Card><div className="body">Loading order…</div></Card></div>
      </>
    );
  }

  if (order.error || !order.data) {
    return (
      <>
        <WSTitle eyebrow="Sales Orders · Workspace" title="Could not load order" meta={orderId.slice(0, 8)} />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Order fetch failed"
                  action={<Btn sm onClick={() => setBump((n) => n + 1)}>retry</Btn>}>
            <span className="mono-sm">{String(order.error?.message || order.error || "not found")}</span>
          </Banner>
        </div>
      </>
    );
  }

  const o = order.data;
  const lines = o.result?.salesOrder?.lineItems || [];
  const grandTotal = Number(o.result?.salesOrder?.grandTotal) || 0;
  const subtotal = lines.reduce((s, ln) => s + (Number(ln.lineTotal) || (Number(ln.qty) * Number(ln.rate)) || 0), 0);
  const findings = Array.isArray(o.rule_findings) ? o.rule_findings : [];

  const canPushTally = window.RBAC?.canDo?.("so.push_tally");
  const canApprove = window.RBAC?.canDo?.("so.approve");
  const canCancel = window.RBAC?.canDo?.("so.cancel");

  // Audit pack export: bundle order + result + findings + signed
  // evidence URLs into a JSON file the user can hand to compliance.
  // Rich PDF + ZIP packaging is a follow-up; for now this matches the
  // legacy exportDocumentPackage shape closely enough.
  const exportAuditPack = async (orderObj) => {
    try {
      const docs = Array.isArray(orderObj.documents) ? orderObj.documents : [];
      const evidence = [];
      for (const d of docs) {
        try {
          const signed = await window.ObaraBackend?.documents?.fetch?.(d.id);
          evidence.push({ id: d.id, role: d.role, filename: d.filename, signed });
        } catch (err) {
          evidence.push({ id: d.id, role: d.role, error: String(err.message || err) });
        }
      }
      const pack = {
        exported_at: new Date().toISOString(),
        order: {
          id: orderObj.id,
          po_number: orderObj.po_number,
          quote_number: orderObj.quote_number,
          status: orderObj.status,
          customer: orderObj.customer,
          result: orderObj.result,
          rule_findings: orderObj.rule_findings,
          approval: orderObj.approval,
          payload_hash: orderObj.payload_hash,
        },
        evidence,
      };
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-pack-${orderObj.po_number || orderObj.id || "order"}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      window.notifySuccess?.("Audit pack exported", `Saved as ${a.download}`);
    } catch (err) {
      window.notifyError?.("Audit pack export failed", String(err.message || err));
    }
  };

  const customerName = o.customer?.customer_name || o.customer_name || (o.customer_id ? o.customer_id.slice(0, 8) : "—");
  const customerEmail = o.customer?.contact_email || o.customer?.email;

  const st = stageOf(o.status);

  // Reconciliation columns: number, item, UoM, qty, rate, prev, delta, line ₹, evidence, issues
  const reconRow = (ln, i) => {
    const sku = ln.itemCode || ln.sku || ln.code || "";
    const desc = ln.description || ln.name || ln.item || "";
    const uom = ln.uom || ln.unit || "—";
    const qty = ln.qty != null ? ln.qty : ln.quantity;
    const qtyQuoted = ln.qtyQuoted != null ? ln.qtyQuoted : qty;
    const rate = Number(ln.rate || ln.unitPrice || 0);
    const ratePrev = Number(ln.ratePrev || ln.previousRate || 0);
    const drift = ratePrev > 0 ? (rate - ratePrev) / ratePrev : null;
    const lineTotal = Number(ln.lineTotal) || (Number(qty) * rate) || 0;
    const lineFindings = findings.filter((f) => Number(f.line_index) === i || Number(f.lineIndex) === i);
    const issueChip = lineFindings.length === 0
      ? "—"
      : lineFindings.map((f, j) => (
          <Chip key={j} k={f.severity === "ERROR" || f.blocks ? "bad" : f.severity === "WARNING" ? "warn" : "info"}>
            {(f.code || f.rule_id || "issue").toLowerCase()}
          </Chip>
        ));
    return (
      <tr key={i}>
        <td className="mono">{i + 1}</td>
        <td>
          <div style={{ fontWeight: 600 }}>{desc || "—"}</div>
          {sku && <div className="mono-sm">SKU {sku}</div>}
        </td>
        <td>{uom}</td>
        <td className="r mono">{qty != null ? qty : "—"}</td>
        <td className="r mono">{qtyQuoted != null ? qtyQuoted : "—"}</td>
        <td className="r mono">{rate ? fmtINRShort(rate) : "—"}</td>
        <td className="r mono">{ratePrev ? fmtINRShort(ratePrev) : "—"}</td>
        <td className="r mono" style={{ color: drift == null ? "var(--ink-4)" : drift > 0.10 ? "var(--rust)" : drift > 0 ? "var(--amber-2)" : "var(--sage)" }}>
          {drift == null ? "·" : (drift >= 0 ? "+" : "") + (drift * 100).toFixed(1) + "%"}
        </td>
        <td className="r mono"><span className="pri">{lineTotal ? fmtINRShort(lineTotal) : "—"}</span></td>
        <td className="row gap-sm">{ln.evidence?.page ? <Prov>p{ln.evidence.page}{ln.evidence.line ? `·l${ln.evidence.line}` : ""}</Prov> : "—"}</td>
        <td>{issueChip}</td>
      </tr>
    );
  };

  // Margin cockpit data
  const policy = o.cost_policy_snapshot || {};
  const matCost = Number(policy.materialsLanded || policy.materials || 0);
  const freight = Number(policy.freight || 0);
  const customs = Number(policy.customs || 0);
  const service = Number(policy.service || 0);
  const totalCost = matCost + freight + customs + service;
  const realizedMargin = grandTotal > 0 ? (grandTotal - totalCost) / grandTotal : 0;
  const pct = (n) => grandTotal > 0 ? Math.round((n / grandTotal) * 100) : 0;

  const tabs = [
    { id: "recon", label: "Reconciliation", count: findings.length || null },
    { id: "margin", label: "Margin cockpit" },
    { id: "why", label: "Why" },
    { id: "evidence", label: "Evidence" },
    { id: "approval", label: "Approval" },
    { id: "tally", label: "Tally" },
    { id: "shipments", label: "Shipments" },
    { id: "activity", label: "Activity", count: audit.data.length || null },
  ];

  return (
    <div className="ws">
      <div className="ws-title" style={{ alignItems: "stretch", flexDirection: "column", gap: 8 }}>
        <div className="row" style={{ width: "100%" }}>
          <div>
            <div className="h-eyebrow">Sales Orders · Workspace</div>
            <div className="row gap-sm" style={{ marginTop: 2 }}>
              <h1>{o.po_number || o.quote_number || `draft ${o.id?.slice(0, 8)}`}</h1>
              {o.order_mode && <Chip k={o.order_mode === "INTERNAL" ? "plum" : o.order_mode.startsWith("PROJECT") ? "info" : "ghost"}>{o.order_mode}</Chip>}
              <Chip k={st.k}>{st.label}</Chip>
              {o.payload_hash && <Chip k="ghost">payload {String(o.payload_hash).slice(0, 8)}…</Chip>}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          {customerEmail && (
            <Btn sm kind="ghost" onClick={() => window.location.href = `mailto:${customerEmail}?subject=${encodeURIComponent(o.po_number || o.quote_number || "Order update")}`}>
              {Icon.send} email customer
            </Btn>
          )}
          <Btn sm kind="ghost" onClick={() => exportAuditPack(o)} title="Bundle PO + quote + result + signed evidence URLs into a JSON download">
            {Icon.download} audit pack
          </Btn>
          <Btn sm kind="ghost" disabled={!canCancel} title={canCancel ? "" : "needs sales_manager / admin"}>
            {Icon.x} cancel
          </Btn>
          <Btn sm kind="ghost" disabled={!canApprove} title={canApprove ? "" : "needs sales_manager / finance / admin"}>
            {Icon.shieldCheck} approve
          </Btn>
          <Btn sm kind="primary" disabled={!canPushTally} title={canPushTally ? "" : "needs finance / admin"}>
            {Icon.send} push to Tally
          </Btn>
        </div>
        <div className="row mono-sm" style={{ color: "var(--ink-3)" }}>
          {customerName}
          <span style={{ color: "var(--ink-5)" }}>·</span>
          <span>created {ageLabel(o.created_at)} ago</span>
          <span style={{ color: "var(--ink-5)" }}>·</span>
          <span>updated {ageLabel(o.updated_at || o.created_at)} ago</span>
          <span style={{ marginLeft: "auto" }}>id <span className="mono">{o.id?.slice(0, 8)}…</span></span>
        </div>
      </div>

      <WSTabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="ws-content">
        <Steps current={
          o.status === "DRAFT" ? 0
          : o.status === "PENDING_REVIEW" ? 3
          : o.status === "APPROVED" ? 4
          : o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED" ? 5
          : 2
        } items={["Capture", "Preflight", "Extract", "Validate", "Approve", "Push to Tally"]} />

        {tab === "recon" && (
          <Card flush>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)", display: "flex", gap: 10, alignItems: "center" }}>
              <span className="h2">Line reconciliation</span>
              <span className="mono-sm">{lines.length} line{lines.length === 1 ? "" : "s"} · {findings.length} issue{findings.length === 1 ? "" : "s"}</span>
            </div>
            {lines.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No line items extracted yet. Extraction completes after OCR finishes.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th style={{ width: 28 }}>#</th>
                  <th>Item</th>
                  <th>UoM</th>
                  <th className="r">Qty · PO</th>
                  <th className="r">Qty · Q</th>
                  <th className="r">Rate · PO</th>
                  <th className="r">Rate · prev</th>
                  <th className="r">Δ</th>
                  <th className="r">Line ₹</th>
                  <th>Evidence</th>
                  <th>Issues</th>
                </tr></thead>
                <tbody>{lines.map(reconRow)}</tbody>
                <tfoot>
                  <tr style={{ background: "var(--paper-2)" }}>
                    <td colSpan={8} className="r mono" style={{ paddingTop: 10, paddingBottom: 10 }}>
                      <span style={{ color: "var(--ink-3)" }}>subtotal · before tax & freight</span>
                    </td>
                    <td className="r mono"><b style={{ fontSize: 13 }}>{fmtINRShort(subtotal)}</b></td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            )}
          </Card>
        )}

        {tab === "margin" && (
          <Card title="Margin cockpit" eyebrow="this SO">
            {grandTotal === 0 ? (
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>No grand total yet — extraction or pricing has not completed.</div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                <div>
                  <div className="h-eyebrow">Realized margin</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 32, fontWeight: 500, letterSpacing: "-0.02em", color: "var(--ink)", marginTop: 4 }}>
                    {(realizedMargin * 100).toFixed(1)}%
                  </div>
                  <div className="mono-sm">{fmtINRShort(grandTotal - totalCost)} on {fmtINRShort(grandTotal)}</div>
                </div>
                <div>
                  <div className="h-eyebrow">Cost decomposition</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
                    {[
                      ["Materials · landed", pct(matCost), fmtINRShort(matCost)],
                      ["Freight",            pct(freight), fmtINRShort(freight)],
                      ["Customs · GST",      pct(customs), fmtINRShort(customs)],
                      ["Service",            pct(service), fmtINRShort(service)],
                      ["Margin",             Math.round(realizedMargin * 100), fmtINRShort(grandTotal - totalCost), true],
                    ].map((r, i) => (
                      <div key={i} className="row mono-sm">
                        <span style={{ minWidth: 130 }}>{r[0]}</span>
                        <div className="hbar" style={{ flex: 1 }}>
                          <span style={{ width: `${Math.max(0, Math.min(100, r[1]))}%`, background: r[3] ? "var(--accent-2)" : "var(--ink)" }} />
                        </div>
                        <span style={{ minWidth: 80, textAlign: "right" }}>{r[2]}</span>
                        <span style={{ minWidth: 36, textAlign: "right", color: "var(--ink-3)" }}>{r[1]}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {cost.data && (
              <>
                <div className="divider" />
                <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                  Customer cost-to-serve: {fmtUSD(cost.data.totalUsd || 0)} across {cost.data.totalSuccess || 0} successful SOs · per-success {fmtUSD(cost.data.costPerSuccess || 0)}.
                </div>
              </>
            )}
          </Card>
        )}

        {tab === "why" && (
          <Card title="Why · model reasoning" eyebrow="redacted · audit">
            {findings.length === 0 ? (
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>No findings recorded for this order.</div>
            ) : (
              <div className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {findings.map((f, i) => (
                  <div key={i} style={{ background: "var(--paper-3)", padding: 10, borderRadius: 4, lineHeight: 1.55 }}>
                    <b style={{ color: "var(--ink)" }}>{(f.code || f.rule_id || "finding").toUpperCase()}</b>
                    {f.line_index != null && <> · L{Number(f.line_index) + 1}</>}
                    {f.detail ? ` — ${f.detail}` : ""}
                    {f.suggested_fix && <div style={{ marginTop: 4, color: "var(--ink-3)" }}>suggested fix · {f.suggested_fix}</div>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {tab === "evidence" && (
          <Card title="Evidence" eyebrow={o.doc_fingerprint ? `fingerprint ${String(o.doc_fingerprint).slice(0, 12)}…` : "no fingerprint"}>
            {o.evidence_by_field && Object.keys(o.evidence_by_field).length > 0 ? (
              <table className="tbl">
                <thead><tr><th>Field</th><th>Page · line</th><th>Value</th></tr></thead>
                <tbody>
                  {Object.entries(o.evidence_by_field).map(([field, ev]) => (
                    <tr key={field}>
                      <td className="mono-sm">{field}</td>
                      <td className="mono-sm">{ev?.page ? `p${ev.page}${ev.line ? "·l" + ev.line : ""}` : "—"}</td>
                      <td>{ev?.value != null ? String(ev.value) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Evidence map is empty. After OCR + extraction completes, every populated field has a citation here.</div>
            )}
          </Card>
        )}

        {tab === "approval" && (
          <Card title="Approval" eyebrow={o.approval ? "decided" : "pending"}>
            {o.approval ? (
              <KV rows={[
                ["Status", o.approval.status || o.approval.decision || "—"],
                ["Approver", o.approval.approver || o.approval.approver_role || "—"],
                ["Reason", o.approval.reason || o.approval.comments || "—"],
                ["Payload hash", o.approval.payloadHash || o.payload_hash || "—"],
              ]} />
            ) : (
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                No approval recorded yet. Approvals are logged once a manager / finance role decides via the Approvals queue.
              </div>
            )}
          </Card>
        )}

        {tab === "tally" && (
          <Card title="Tally" eyebrow={o.status === "EXPORTED_TO_TALLY" ? "exported" : o.status === "FAILED_TALLY_IMPORT" ? "failed" : "queued"}>
            <KV rows={[
              ["Voucher", o.payload_hash ? `SO/${o.order_mode || "GEN"}/${(o.po_number || o.id || "").slice(0, 12)}` : "—"],
              ["Hash", o.payload_hash || "—"],
              ["Status", o.status],
              ["Pushed", o.status === "EXPORTED_TO_TALLY" ? "yes" : "no"],
            ]} />
          </Card>
        )}

        {tab === "shipments" && (
          <Card title="Shipments" eyebrow="schedule lines">
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
              Shipment timeline loads from <code>order_schedule_lines</code> in the Shipments route. Open <a onClick={() => window.location.hash = "#/shipments"} style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>shipments</a> to see active dispatches.
            </div>
          </Card>
        )}

        {tab === "activity" && (
          <Card title="Activity" eyebrow={`${audit.data.length} event${audit.data.length === 1 ? "" : "s"}`}>
            {audit.loading ? (
              <div className="body">Loading…</div>
            ) : audit.data.length === 0 ? (
              <div className="mono-sm" style={{ color: "var(--ink-4)" }}>No audit events for this order yet.</div>
            ) : (
              <Stream rows={audit.data.slice(0, 30).map((a) => ({
                t: new Date(a.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
                a: (a.action || "evt").toUpperCase().slice(0, 5),
                m: `<b>${a.action || "event"}</b> · ${a.object_type || ""}${a.detail ? " · " + a.detail : ""}`,
              }))} />
            )}
          </Card>
        )}
      </div>
    </div>
  );
};

window.SOWorkspace = WiredSOWorkspace;
