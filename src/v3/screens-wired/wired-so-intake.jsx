// ============================================================
// ANVIL v3 — wired SO Intake
// Capture step: pick mode + customer, drop a PO, kick off OCR.
// ============================================================

const ORDER_MODES = [
  { id: "SPARES",          ti: "Spares",            code: "SPARES · OIQTLC-** · INR",     desc: "Standard spares to a domestic customer. Margin floor 10%, target 30%. Road logistics. Most common mode." },
  { id: "SPARES_ASSEMBLY", ti: "Spares · Assembly", code: "SPARES_ASSEMBLY · OIQTLC-** · INR", desc: "Gun modification spares with assembly. Same prefix and floor as SPARES, but assembly service line is mandatory." },
  { id: "PROJECT_FOR",     ti: "Project · Free On Rail", code: "PROJECT_FOR · OFRPRJ-** · INR", desc: "Domestic project with freight inclusive in line price. Forward FX irrelevant. Floor 10%." },
  { id: "PROJECT_HSS",     ti: "Project · CIF Nhava Sheva", code: "PROJECT_HSS · OIQTHS-** · USD", desc: "Hyundai Steel / Voestalpine pattern. Forward FX explicit, USD line items, customs cost band, floor 10%." },
  { id: "INTERNAL",        ti: "Internal · Free of cost", code: "INTERNAL · INT-* · FOC",   desc: "Warranty replacement, product trial, expected PO, internal transfer. No margin, no Tally voucher." },
  { id: null,              ti: "Decide later",      code: "— · ASK ME LATER",            desc: "Capture documents now and let OCR + Claude pre-classifier suggest the mode at extraction time." },
];

const WiredSOIntake = () => {
  const { useState: u, useEffect: e, useRef: r } = React;
  const [mode, setMode] = u("SPARES");
  const [customers, setCustomers] = u({ data: null, loading: true, error: null });
  const [customerId, setCustomerId] = u("");
  const [doc, setDoc] = u(null);
  const [busy, setBusy] = u(null);
  const [err, setErr] = u(null);
  const fileRef = r(null);

  e(() => {
    let cancelled = false;
    Promise.resolve(window.ObaraBackend?.customers?.list?.() || Promise.resolve({ customers: [] }))
      .then((data) => { if (!cancelled) setCustomers({ data, loading: false, error: null }); })
      .catch((error) => { if (!cancelled) setCustomers({ data: null, loading: false, error }); });
    return () => { cancelled = true; };
  }, []);

  const customerList = (customers.data?.customers) || (Array.isArray(customers.data) ? customers.data : []);
  const selectedCustomer = customerList.find((c) => c.id === customerId);

  const onPickFile = async (file) => {
    if (!file) return;
    setErr(null);
    setBusy("upload");
    try {
      const meta = await window.ObaraBackend?.documents?.upload?.(file, "purchase_order");
      if (!meta || !meta.documentId) throw new Error("Upload returned no document id");
      setDoc({ id: meta.documentId, filename: file.name, size: file.size });
      setBusy(null);
    } catch (e2) {
      setErr(String(e2.message || e2));
      setBusy(null);
    }
  };

  const onDrop = (ev) => {
    ev.preventDefault();
    const f = ev.dataTransfer?.files?.[0];
    if (f) onPickFile(f);
  };

  const onContinue = async () => {
    setErr(null);
    if (!mode) { setErr("Pick an order mode (or 'Decide later' is not allowed yet)."); return; }
    if (!customerId) { setErr("Pick a customer."); return; }
    setBusy("create");
    try {
      const res = await window.ObaraBackend?.orders?.create?.({
        order_mode: mode,
        customer_id: customerId,
        status: "DRAFT",
      });
      const newId = res?.order?.id || res?.id;
      if (!newId) throw new Error("Order create returned no id");
      // Best-effort OCR kickoff if a doc was uploaded; don't block navigation on it.
      if (doc?.id) {
        try { await window.ObaraBackend?.ocr?.run?.(doc.id, newId); } catch (_) { /* surface in workspace */ }
      }
      window.location.hash = `#/so?id=${newId}`;
    } catch (e2) {
      setErr(String(e2.message || e2));
      setBusy(null);
    }
  };

  return (
    <>
      <WSTitle
        eyebrow="Workflows · Sales Orders · New"
        title="Capture · choose Order Mode"
        meta="step 1 of 6"
        right={<>
          <Btn sm kind="ghost" onClick={() => window.location.hash = "#/so"}>cancel</Btn>
          <Btn sm kind="primary" disabled={busy === "create"} onClick={onContinue}>
            {busy === "create" ? "creating…" : <>continue {Icon.arrowR}</>}
          </Btn>
        </>}
      />

      <div className="ws-content">
        <Steps current={0} items={["Capture", "Preflight", "Extract", "Validate", "Approve", "Push to Tally"]} />

        {err && (
          <Banner kind="bad" icon={Icon.alert} title="Could not continue" action={<Btn sm onClick={() => setErr(null)}>dismiss</Btn>}>
            <span className="mono-sm">{err}</span>
          </Banner>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Card title="Order Mode" eyebrow="drives prefix · currency · logistics · margin floor">
              <div className="choice-grid" style={{ "--cols": 2 }} role="radiogroup" aria-label="Order Mode">
                {ORDER_MODES.map((m) => (
                  <div
                    key={m.code}
                    role="radio"
                    aria-checked={mode === m.id}
                    tabIndex={0}
                    className={`choice ${mode === m.id ? "sel" : ""}`}
                    onClick={() => setMode(m.id)}
                    onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setMode(m.id); } }}
                  >
                    <span className="code">{m.code}</span>
                    <span className="ti">{m.ti}</span>
                    <span className="desc">{m.desc}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card title="Documents" eyebrow="PO required · others optional">
              <label htmlFor="so-intake-customer" className="label" style={{ marginBottom: 6 }}>Customer</label>
              <select
                id="so-intake-customer"
                className="select"
                value={customerId}
                onChange={(ev) => setCustomerId(ev.target.value)}
                disabled={customers.loading}
                style={{ marginBottom: 12 }}
              >
                <option value="">{customers.loading ? "loading customers…" : "select a customer…"}</option>
                {customerList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.customer_name}{c.gstin ? ` · ${c.gstin}` : ""}
                  </option>
                ))}
              </select>

              <div
                onDragOver={(ev) => ev.preventDefault()}
                onDrop={onDrop}
                style={{
                  border: "1.5px dashed var(--hairline-3)", borderRadius: 6, padding: "32px 16px",
                  textAlign: "center", color: "var(--ink-3)", background: "var(--paper-2)",
                }}
              >
                {doc ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)" }}>{doc.filename}</div>
                    <div className="mono-sm" style={{ marginTop: 4 }}>document id {doc.id.slice(0, 8)} · {(doc.size / 1024).toFixed(1)} KB</div>
                    <Btn sm kind="ghost" style={{ marginTop: 12 }} onClick={() => setDoc(null)}>{Icon.x} remove</Btn>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)" }}>Drop the customer PO here</div>
                    <div className="mono-sm" style={{ marginTop: 4 }}>or pick a file · PDF · DOCX · XLSX</div>
                    <input
                      ref={fileRef}
                      id="so-intake-file"
                      type="file"
                      style={{ display: "none" }}
                      onChange={(ev) => onPickFile(ev.target.files?.[0])}
                      aria-label="Upload purchase order"
                    />
                    <Btn sm kind="ghost" style={{ marginTop: 12 }} onClick={() => fileRef.current?.click()} disabled={busy === "upload"}>
                      {busy === "upload" ? "uploading…" : <>{Icon.upload} browse</>}
                    </Btn>
                  </>
                )}
              </div>

              <div className="divider" />
              <div className="mono-sm">
                <Dot k="good" /> ZIP guard · 100 MB cap · no recursion<br />
                <Dot k="good" /> ClamAV · scanned before parse<br />
                <Dot k="good" /> PDF · max 80 pages<br />
                <Dot k="info" /> XLSX · max 12 sheets, parsed first then OCR
              </div>
            </Card>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Card title="Customer" eyebrow={selectedCustomer ? "selected" : "pick from the list"}>
              {selectedCustomer ? (
                <>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <div style={{ width: 32, height: 32, background: "var(--ink)", color: "var(--paper)", display: "grid", placeItems: "center", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 12 }}>
                      {(selectedCustomer.customer_name || "").slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{selectedCustomer.customer_name}</div>
                      <div className="mono-sm">{selectedCustomer.customer_key || selectedCustomer.id?.slice(0, 8)}</div>
                    </div>
                  </div>
                  <KV rows={[
                    ["GSTIN", selectedCustomer.gstin || "—"],
                    ["State", selectedCustomer.state_code || "—"],
                    ["Currency", selectedCustomer.currency || "INR"],
                    ["Pay terms", selectedCustomer.payment_terms || "—"],
                    ["Margin floor", selectedCustomer.margin_floor_pct != null ? `${selectedCustomer.margin_floor_pct}%` : "10% (default)"],
                  ]} />
                </>
              ) : (
                <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                  Select a customer to see GSTIN, state, currency, and margin floor.
                </div>
              )}
            </Card>

            <Card title="Profile match" eyebrow="prediction · cached">
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                Profile match runs after OCR completes. The pre-classifier picks Haiku when confidence is above 0.85,
                otherwise falls back to Sonnet and logs to <b>model_routing_log</b>.
              </div>
            </Card>

            <Card title="Estimated cost" eyebrow="this SO">
              <div className="row" style={{ alignItems: "baseline", gap: 6 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 600 }}>
                  {doc ? "₹ 2.40" : "—"}
                </span>
                <span className="mono-sm">{doc ? "all-in · OCR + Claude + Tally" : "upload a PO to estimate"}</span>
              </div>
              {doc && (
                <>
                  <div className="divider" />
                  <div className="mono-sm">
                    <div className="row"><span>OCR · Mistral</span><span style={{ marginLeft: "auto" }}>₹ 0.80</span></div>
                    <div className="row"><span>Pre-classifier · Haiku</span><span style={{ marginLeft: "auto" }}>₹ 1.20</span></div>
                    <div className="row"><span>Validation pass</span><span style={{ marginLeft: "auto" }}>₹ 0.40</span></div>
                  </div>
                </>
              )}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
};

window.SOIntake = WiredSOIntake;
