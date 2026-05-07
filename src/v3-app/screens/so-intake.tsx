import React, { useEffect, useRef, useState } from "react";
import { Banner, Btn, Card, Chip, Dot, KV, Steps, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

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

  // Inline "create new customer" dialog. The user reported the
  // intake flow needs a way to add a customer without leaving the
  // page when the dropdown doesn't include the right one. The
  // dialog persists via /api/customers (POST), then auto-selects
  // the new customer in the dropdown above.
  const [newCustomerOpen, setNewCustomerOpen] = u(false);
  const [newCustomer, setNewCustomer] = u({
    customer_name: "", gstin: "", state_code: "",
    currency: "INR", payment_terms: "Net 30", margin_floor_pct: "10",
    bill_to: "", ship_to: "",
  });
  const [newCustomerErr, setNewCustomerErr] = u(null);
  const [newCustomerBusy, setNewCustomerBusy] = u(false);

  const submitNewCustomer = async () => {
    setNewCustomerErr(null);
    if (!newCustomer.customer_name.trim()) { setNewCustomerErr({ message: "Customer name is required." }); return; }
    setNewCustomerBusy(true);
    try {
      const payload: any = {
        customer_name: newCustomer.customer_name.trim(),
        gstin: newCustomer.gstin.trim() || null,
        state_code: newCustomer.state_code.trim() || null,
        currency: newCustomer.currency || "INR",
        payment_terms: newCustomer.payment_terms || null,
        margin_floor_pct: newCustomer.margin_floor_pct ? Number(newCustomer.margin_floor_pct) : null,
        bill_to: newCustomer.bill_to || null,
        ship_to: newCustomer.ship_to || null,
      };
      const res = await ObaraBackend?.customers?.upsert?.(payload);
      const created = res?.customer || res?.row || res;
      // Re-fetch the list so the new customer shows up in the
      // dropdown, then auto-select it.
      const fresh = await ObaraBackend?.customers?.list?.();
      setCustomers({ data: fresh, loading: false, error: null });
      const newId = created?.id || (fresh?.customers || []).find((c: any) => c.customer_name === payload.customer_name)?.id;
      if (newId) setCustomerId(newId);
      window.notifySuccess?.("Customer created", payload.customer_name);
      setNewCustomerOpen(false);
      setNewCustomer({
        customer_name: "", gstin: "", state_code: "",
        currency: "INR", payment_terms: "Net 30", margin_floor_pct: "10",
        bill_to: "", ship_to: "",
      });
    } catch (err2: any) {
      setNewCustomerErr(err2);
      window.notifyError?.("Could not create customer", err2?.message || String(err2));
    } finally {
      setNewCustomerBusy(false);
    }
  };

  // Read shell health to decide which doc-pipeline guarantees are real
  // versus aspirational. Without it the pre-flight checklist below was
  // a hardcoded set of green dots regardless of actual integration state.
  const [health, setHealth] = u<{ integrations?: Array<{ id: string; configured: boolean }> } | null>(null);
  e(() => {
    let cancelled = false;
    Promise.resolve(ObaraBackend?.health?.()).then((h) => {
      if (!cancelled && h) setHealth(h);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const clamavConfigured = !!health?.integrations?.find((i: any) => i.id === "clamav")?.configured;

  e(() => {
    let cancelled = false;
    Promise.resolve(ObaraBackend?.customers?.list?.() || Promise.resolve({ customers: [] }))
      .then((data) => { if (!cancelled) setCustomers({ data, loading: false, error: null }); })
      .catch((error) => { if (!cancelled) setCustomers({ data: null, loading: false, error }); });
    return () => { cancelled = true; };
  }, []);

  const customerList = (customers.data?.customers) || (Array.isArray(customers.data) ? customers.data : []);
  const selectedCustomer = customerList.find((c) => c.id === customerId);

  // Best-effort fuzzy matcher: prefer GSTIN exact match (highest
  // confidence, can't false-positive across customers), then fall
  // back to case-insensitive customer_name. Returns the matched row
  // or null.
  const matchCustomerFromExtraction = (extracted) => {
    if (!extracted) return null;
    const list = customerList || [];
    const gstin = (extracted.gstin || "").trim().toUpperCase();
    if (gstin && /^[0-9A-Z]{15}$/.test(gstin)) {
      const byGstin = list.find((c) => (c.gstin || "").toUpperCase() === gstin);
      if (byGstin) return byGstin;
    }
    const name = (extracted.name || "").trim().toLowerCase();
    if (name) {
      // Strip common prefixes / punctuation that ERP records may
      // not include but the PO header does ("M/s.", trailing
      // "Pvt. Ltd.", etc.).
      const norm = (s) => String(s || "").toLowerCase()
        .replace(/^m\/s\.?\s*/i, "")
        .replace(/[.,]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const target = norm(name);
      const exact = list.find((c) => norm(c.customer_name) === target);
      if (exact) return exact;
      // Loose: one is a prefix of the other (3+ chars), used to
      // catch "Tata Steel" vs "Tata Steel Ltd.".
      const loose = list.find((c) => {
        const cn = norm(c.customer_name);
        if (cn.length < 3 || target.length < 3) return false;
        return cn.startsWith(target) || target.startsWith(cn);
      });
      if (loose) return loose;
    }
    return null;
  };

  // Run docai extraction on the just-uploaded file. Best-effort: a
  // failure here doesn't block the user; they can still pick the
  // customer manually.
  const runExtraction = async (file, documentId) => {
    setBusy("extract");
    try {
      const out = await ObaraBackend?.documents?.extract?.(file, { source_id: documentId });
      const customer = out?.normalized?.customer || null;
      if (!customer) {
        window.notifyWarn?.("Extraction returned no customer", "Pick a customer manually below.");
        return;
      }
      const matched = matchCustomerFromExtraction(customer);
      if (matched) {
        setCustomerId(matched.id);
        window.notifySuccess?.(
          "Customer matched",
          (matched.customer_name || matched.id?.slice(0, 8)) + " (from PO header)",
        );
        return;
      }
      // No match. Pre-fill the new-customer dialog with whatever the
      // extractor gave us so the operator just has to confirm.
      const billTo = customer.bill_to_address || customer.shipping_address || "";
      const shipTo = customer.ship_to_address || customer.bill_to_address || "";
      setNewCustomer({
        customer_name: customer.name || "",
        gstin: (customer.gstin || "").toUpperCase(),
        state_code: (customer.state_code || "").toUpperCase(),
        currency: customer.currency || "INR",
        payment_terms: customer.payment_terms || "Net 30",
        margin_floor_pct: "10",
        bill_to: billTo,
        ship_to: shipTo,
      });
      setNewCustomerOpen(true);
      window.notifyLive?.(
        "New customer detected",
        (customer.name || "this PO") + " is not in the database. Confirm to add.",
      );
    } catch (err) {
      // Don't surface a hard error; the operator can still proceed.
      // eslint-disable-next-line no-console
      console.warn("[so-intake] extract failed: " + (err?.message || err));
      window.notifyWarn?.(
        "Could not auto-extract customer",
        "Pick a customer manually below.",
      );
    } finally {
      setBusy(null);
    }
  };

  const onPickFile = async (file) => {
    if (!file) return;
    setErr(null);
    setBusy("upload");
    try {
      const meta = await ObaraBackend?.documents?.upload?.(file, "purchase_order");
      if (!meta || !meta.documentId) throw new Error("Upload returned no document id");
      setDoc({ id: meta.documentId, filename: file.name, size: file.size, scan: meta.scan || null });
      setBusy(null);
      // Kick off extraction on the still-in-memory File object. We
      // pass the documentId as source_id so the extraction_run row
      // is correlated with the document on the server.
      await runExtraction(file, meta.documentId);
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
      const res = await ObaraBackend?.orders?.create?.({
        order_mode: mode,
        customer_id: customerId,
        status: "DRAFT",
      });
      const newId = res?.order?.id || res?.id;
      if (!newId) throw new Error("Order create returned no id");
      // Best-effort OCR kickoff if a doc was uploaded; don't block navigation on it.
      if (doc?.id) {
        try { await ObaraBackend?.ocr?.run?.(doc.id, newId); } catch (_) { /* surface in workspace */ }
      }
      window.notifySuccess?.("Draft created", String(newId).slice(0, 8));
      window.location.hash = `#/so?id=${newId}`;
    } catch (e2: any) {
      setErr(String(e2?.message || e2));
      window.notifyError?.("Could not create draft", e2?.message || String(e2));
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
              <div className="choice-grid" style={{ ["--cols" as any]: 2 } as React.CSSProperties} role="radiogroup" aria-label="Order Mode">
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

            <Card title="Documents" eyebrow="PO required · customer auto-extracts on upload">
              {busy === "extract" && (
                <Banner kind="info" icon={Icon.cycle} title="Reading the PO…">
                  <span className="mono-sm">Auto-extracting customer name, GSTIN, addresses, currency, and payment terms.</span>
                </Banner>
              )}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <label htmlFor="so-intake-customer" className="label" style={{ marginBottom: 0 }}>Customer</label>
                <Btn sm kind="ghost" onClick={() => setNewCustomerOpen(true)} title="Create a new customer record">
                  {Icon.plus} new customer
                </Btn>
              </div>
              <select
                id="so-intake-customer"
                className="select"
                value={customerId}
                onChange={(ev) => setCustomerId(ev.target.value)}
                disabled={customers.loading || !!customers.error}
                style={{ marginBottom: 12 }}
              >
                <option value="">
                  {customers.loading ? "loading customers…"
                    : customers.error ? "could not load customers"
                    : "select a customer…"}
                </option>
                {customerList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.customer_name}{c.gstin ? ` · ${c.gstin}` : ""}
                  </option>
                ))}
              </select>
              {/*
               * Surface the fetch error inline. Without this banner the
               * customer dropdown showed an empty list silently and
               * the operator had no idea the API call had failed.
               */}
              {customers.error && (
                <Banner kind="bad" icon={Icon.alert}
                        title="Could not load customers"
                        action={<Btn sm onClick={() => window.location.reload()}>reload</Btn>}>
                  <span className="mono-sm">{String(customers.error?.message || customers.error)}</span>
                </Banner>
              )}

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
                    {doc.scan && (
                      <div style={{ marginTop: 8, display: "flex", justifyContent: "center" }}>
                        {doc.scan.status === "rejected" ? (
                          <Chip k="bad">quarantined · {(doc.scan.threats?.[0]?.code) || "rejected"}</Chip>
                        ) : doc.scan.status === "warn" ? (
                          <Chip k="warn">{doc.scan.clamav?.invoked ? "scanned · with warnings" : "unscanned"}</Chip>
                        ) : doc.scan.status === "clean" ? (
                          doc.scan.clamav?.invoked
                            ? <Chip k="live">scanned · clean</Chip>
                            : <Chip k="ghost">unscanned · AV not configured</Chip>
                        ) : doc.scan.status === "scan_error" ? (
                          <Chip k="warn">scan failed · {String(doc.scan.error).slice(0, 32)}</Chip>
                        ) : null}
                      </div>
                    )}
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
                {clamavConfigured
                  ? <><Dot k="good" /> ClamAV · scanned before parse<br /></>
                  : <><Dot k="warn" /> ClamAV · not configured · uploads pass through<br /></>}
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

      {/* Inline create-customer dialog. Lightweight modal so the
          operator never has to leave the intake flow. Persists via
          /api/customers (which already exists for the list endpoint
          and accepts upserts). */}
      {newCustomerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-customer-title"
          onClick={(e) => { if (e.target === e.currentTarget) setNewCustomerOpen(false); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
            display: "grid", placeItems: "center", zIndex: 200,
          }}
        >
          <div
            style={{
              background: "var(--paper)", border: "1px solid var(--hairline)",
              borderRadius: 8, width: "min(560px, 92vw)", maxHeight: "92vh",
              overflowY: "auto", padding: 18,
              boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
            }}
          >
            <div className="row" style={{ marginBottom: 12 }}>
              <h2 id="new-customer-title" style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>New customer</h2>
              <Btn sm kind="ghost" onClick={() => setNewCustomerOpen(false)} title="Close">{Icon.x}</Btn>
            </div>
            {newCustomerErr && (
              <Banner kind="bad" icon={Icon.alert} title="Could not create customer">
                <span className="mono-sm">{String(newCustomerErr?.message || newCustomerErr)}</span>
              </Banner>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <div style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="nc-name" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Customer name *</label>
                <input id="nc-name" className="input" value={newCustomer.customer_name}
                       onChange={(e) => setNewCustomer((c) => ({ ...c, customer_name: e.target.value }))}
                       autoFocus />
              </div>
              <div>
                <label htmlFor="nc-gstin" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>GSTIN</label>
                <input id="nc-gstin" className="input mono" placeholder="29ABCDE1234F1Z5"
                       value={newCustomer.gstin}
                       onChange={(e) => setNewCustomer((c) => ({ ...c, gstin: e.target.value.toUpperCase() }))} />
              </div>
              <div>
                <label htmlFor="nc-state" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>State code</label>
                <input id="nc-state" className="input mono" placeholder="MH / KA / 27"
                       value={newCustomer.state_code}
                       onChange={(e) => setNewCustomer((c) => ({ ...c, state_code: e.target.value.toUpperCase() }))} />
              </div>
              <div>
                <label htmlFor="nc-ccy" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Currency</label>
                <select id="nc-ccy" className="select" value={newCustomer.currency}
                        onChange={(e) => setNewCustomer((c) => ({ ...c, currency: e.target.value }))}>
                  {["INR", "USD", "EUR", "JPY", "GBP", "AUD", "SGD"].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="nc-terms" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Payment terms</label>
                <input id="nc-terms" className="input" placeholder="Net 30 / 50% advance / etc."
                       value={newCustomer.payment_terms}
                       onChange={(e) => setNewCustomer((c) => ({ ...c, payment_terms: e.target.value }))} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="nc-margin" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Margin floor (%)</label>
                <input id="nc-margin" className="input mono r" type="number" step="0.1" min="0" max="100"
                       value={newCustomer.margin_floor_pct}
                       onChange={(e) => setNewCustomer((c) => ({ ...c, margin_floor_pct: e.target.value }))} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="nc-bill" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Bill-to address</label>
                <textarea id="nc-bill" className="input" rows={2} style={{ width: "100%", padding: 6 }}
                          value={newCustomer.bill_to}
                          onChange={(e) => setNewCustomer((c) => ({ ...c, bill_to: e.target.value }))} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="nc-ship" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Ship-to address (defaults to bill-to if blank)</label>
                <textarea id="nc-ship" className="input" rows={2} style={{ width: "100%", padding: 6 }}
                          value={newCustomer.ship_to}
                          onChange={(e) => setNewCustomer((c) => ({ ...c, ship_to: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <Btn sm kind="ghost" onClick={() => setNewCustomerOpen(false)} disabled={newCustomerBusy}>Cancel</Btn>
              <Btn sm kind="primary" onClick={submitNewCustomer} disabled={newCustomerBusy}>
                {newCustomerBusy ? "Saving…" : "Create customer"}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
};


export default WiredSOIntake;
