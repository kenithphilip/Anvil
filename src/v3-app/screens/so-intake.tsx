import React, { useEffect, useRef, useState } from "react";
import { Banner, Btn, Card, Chip, Dot, KV, Steps, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import { DocCropper } from "../components/DocCropper";

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
  // Audit P13.B.3 follow-up. The camera-capture path lands a raw
  // photo (often skewed); we route it through the 4-corner
  // perspective cropper before the upload so the OCR pipeline gets
  // a clean rectangle. Files chosen via "browse" go straight to
  // upload (no skew correction needed).
  const [pendingCrop, setPendingCrop] = u<File | null>(null);

  // Inline "create new customer" dialog. The user reported the
  // intake flow needs a way to add a customer without leaving the
  // page when the dropdown doesn't include the right one. The
  // dialog persists via /api/customers (POST), then auto-selects
  // the new customer in the dropdown above.
  const [newCustomerOpen, setNewCustomerOpen] = u(false);
  // Bug fix May 2026: the dialog state used to drop the contact_email
  // and contact_phone fields the docai extractor returns, so even
  // when the extractor caught the customer block on the PO header
  // the operator was forced to retype email/phone. Both columns
  // exist on the customers table (migration 061) and the API now
  // accepts them, so the dialog persists them straight through.
  const [newCustomer, setNewCustomer] = u({
    customer_name: "", gstin: "", state_code: "",
    currency: "INR", payment_terms: "Net 30", margin_floor_pct: "10",
    bill_to: "", ship_to: "",
    contact_email: "", contact_phone: "",
  });
  const [newCustomerErr, setNewCustomerErr] = u(null);
  const [newCustomerBusy, setNewCustomerBusy] = u(false);
  // May 2026 fix: stash the extracted line items + the partial
  // customer fragments so onContinue can hand them to the order
  // create call as orders.result.salesOrder.lineItems. Previously
  // the workspace's reconciliation tab read empty because the
  // intake dropped the extracted lines on the floor and only used
  // out.normalized.customer.
  const [extractedLines, setExtractedLines] = u<any[] | null>(null);
  const [extractMeta, setExtractMeta] = u<{ runId?: string | null; adapter?: string | null; confidence?: number | null }>({});
  // Bug fix May 2026 (customer-prefill report): keep the raw
  // extracted customer block around so the right-hand intake card
  // can render a "From PO" panel side-by-side with the existing-
  // customer record. Lets the operator spot e.g. a missing GSTIN
  // that the PO supplied even after auto-match.
  const [extractedCustomer, setExtractedCustomer] = u<any | null>(null);

  // Address picker. The user's spec says ship-to / bill-to should be
  // a "relational object from other existing addresses of other
  // customers in the database" -- i.e., the operator can pick an
  // existing customer_locations row instead of re-typing it.
  // Fetched once when the dialog opens.
  const [locationsList, setLocationsList] = u<{ data: any; loading: boolean }>({ data: null, loading: false });
  e(() => {
    if (!newCustomerOpen) return;
    let cancelled = false;
    setLocationsList({ data: null, loading: true });
    Promise.resolve(ObaraBackend?.customers?.listLocations?.() || Promise.resolve({ locations: [] }))
      .then((data) => { if (!cancelled) setLocationsList({ data, loading: false }); })
      .catch(() => { if (!cancelled) setLocationsList({ data: { locations: [] }, loading: false }); });
    return () => { cancelled = true; };
  }, [newCustomerOpen]);
  const locationRows: any[] = (locationsList.data?.locations) || [];
  const formatLocation = (l: any) => {
    const tag = l.location_code === "default_ship" ? "ship-to"
              : l.location_code === "default_bill" ? "bill-to"
              : l.location_code || "loc";
    const head = (l.customer_name || "?") + " (" + tag + ")";
    const addr = [l.address_line1, l.city, l.pincode].filter(Boolean).join(", ");
    return head + (addr ? " - " + addr : "");
  };
  const addressTextFromLocation = (l: any) =>
    [l.address_line1, l.address_line2, l.city, l.pincode].filter(Boolean).join("\n");

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
        contact_email: newCustomer.contact_email?.trim() || null,
        contact_phone: newCustomer.contact_phone?.trim() || null,
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
        contact_email: "", contact_phone: "",
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
      if (byGstin) return { customer: byGstin, confidence: "exact_gstin" };
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
      if (exact) return { customer: exact, confidence: "exact_name" };
    }
    return null;
  };

  // Bug fix May 2026 (customer-prefill report): the previous
  // matcher silently auto-selected on a loose name-prefix match
  // ("Tata" -> "Tata Steel Ltd"), suppressed the new-customer
  // dialog, and left the operator with a matched customer whose
  // record had no GSTIN / payment_terms / bill_to. The screen then
  // showed "—" for every field and the user thought
  // "fields not auto-populating". Loose matches now surface as a
  // *suggestion* but always open the new-customer dialog so the
  // operator can confirm or replace.
  const suggestLooseMatch = (extracted) => {
    if (!extracted?.name) return null;
    const list = customerList || [];
    const norm = (s) => String(s || "").toLowerCase()
      .replace(/^m\/s\.?\s*/i, "")
      .replace(/[.,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const target = norm(extracted.name);
    if (target.length < 3) return null;
    const candidate = list.find((c) => {
      const cn = norm(c.customer_name);
      if (cn.length < 3) return false;
      return cn.startsWith(target) || target.startsWith(cn);
    });
    return candidate || null;
  };

  // Run docai extraction on the just-uploaded file. Best-effort: a
  // failure here doesn't block the user; they can still pick the
  // customer manually.
  //
  // May 2026 fixes (per Daisy's bug report):
  //   1. Even when the extractor returns NO customer at all, open
  //      the new-customer dialog (with whatever fragments we have,
  //      plus a hint banner) so the operator has a clear next
  //      action. Previously a notify-warn toast was the only
  //      signal and there was no path forward.
  //   2. Persist out.normalized.lines into local state so the
  //      onContinue handoff can include them in the order's
  //      result.salesOrder.lineItems. Without this the workspace
  //      reconciliation tab stays empty even when extraction
  //      succeeded server-side.
  const runExtraction = async (file, documentId) => {
    setBusy("extract");
    try {
      const out = await ObaraBackend?.documents?.extract?.(file, { source_id: documentId });
      // Persist anything the extractor returned, even if customer
      // resolution falls through. Lines + cost meta land in the
      // order create payload.
      const lines = Array.isArray(out?.normalized?.lines) ? out.normalized.lines : null;
      if (lines && lines.length) setExtractedLines(lines);
      setExtractMeta({
        runId: out?.run_id || null,
        adapter: out?.adapter_used || null,
        confidence: typeof out?.confidence_overall === "number" ? out.confidence_overall : null,
      });

      const customer = out?.normalized?.customer || null;
      // Bug fix May 2026 (customer-prefill report): always stash
      // the extracted customer block so the right-hand intake card
      // can show it side-by-side with whatever existing-customer
      // record gets matched. This is the "From PO" panel the
      // operator wants to see EVEN when an existing customer is
      // selected, so they can spot e.g. a missing GSTIN that the
      // PO supplied.
      setExtractedCustomer(customer);

      if (!customer) {
        // No customer block extracted at all (docai missed the
        // header, adapter wasn't configured, etc.). Open the new-
        // customer dialog with empty fields. The operator can
        // still see the PO they uploaded in the doc preview, so
        // they have somewhere to copy from.
        setNewCustomer({
          customer_name: "", gstin: "", state_code: "",
          currency: "INR", payment_terms: "Net 30", margin_floor_pct: "10",
          bill_to: "", ship_to: "",
          contact_email: "", contact_phone: "",
        });
        setNewCustomerOpen(true);
        window.notifyLive?.(
          "Customer not auto-detected",
          "Fill in the customer details from the PO and confirm.",
        );
        return;
      }

      // Build the prefill payload once; both branches below use it.
      const billTo = customer.bill_to_address || customer.shipping_address || "";
      const shipTo = customer.ship_to_address || customer.bill_to_address || "";
      const prefill = {
        customer_name: customer.name || "",
        gstin: (customer.gstin || "").toUpperCase(),
        state_code: (customer.state_code || "").toUpperCase(),
        currency: customer.currency || "INR",
        payment_terms: customer.payment_terms || "Net 30",
        margin_floor_pct: "10",
        bill_to: billTo,
        ship_to: shipTo,
        contact_email: customer.email || "",
        contact_phone: customer.phone || "",
      };

      const matchResult = matchCustomerFromExtraction(customer);
      if (matchResult?.customer) {
        // High-confidence match (GSTIN exact OR normalized-name
        // exact). Auto-select. The right-hand card will still
        // render the "From PO" panel so the operator sees the
        // extracted fields next to the existing-customer record.
        setCustomerId(matchResult.customer.id);
        window.notifySuccess?.(
          "Customer matched",
          (matchResult.customer.customer_name || matchResult.customer.id?.slice(0, 8))
            + " (" + matchResult.confidence.replace(/_/g, " ") + ")",
        );
        return;
      }

      // Loose name-prefix candidate: SUGGEST but do not auto-select.
      // The new-customer dialog opens with the extracted prefill so
      // the operator can confirm "create new" or pick the existing
      // record from the dropdown.
      const loose = suggestLooseMatch(customer);
      setNewCustomer(prefill);
      setNewCustomerOpen(true);
      if (loose) {
        window.notifyLive?.(
          "Possible existing customer: " + loose.customer_name,
          "Pick from the list or confirm to add a new record from the PO.",
        );
      } else {
        window.notifyLive?.(
          "New customer detected",
          (customer.name || "this PO") + " is not in the database. Confirm to add.",
        );
      }
    } catch (err) {
      // Don't surface a hard error; the operator can still proceed.
      // eslint-disable-next-line no-console
      console.warn("[so-intake] extract failed: " + (err?.message || err));
      // Same UX as no-customer: open the dialog with empty fields
      // so the operator has somewhere to type instead of being
      // stranded.
      setNewCustomer({
        customer_name: "", gstin: "", state_code: "",
        currency: "INR", payment_terms: "Net 30", margin_floor_pct: "10",
        bill_to: "", ship_to: "",
        contact_email: "", contact_phone: "",
      });
      setNewCustomerOpen(true);
      window.notifyWarn?.(
        "Could not auto-extract customer",
        "Fill in the customer details from the PO.",
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
      // May 2026 fix: hand the extractor's line items to the order
      // create call so the workspace's reconciliation tab shows
      // populated rows immediately. The OCR + auto_ocr cron paths
      // can still amend the order's evidence_by_field + result
      // later, but the operator no longer stares at "0 lines"
      // while the cron worker catches up.
      // Bug fix May 2026 (customer-prefill report): carry the raw
      // extracted customer block onto the order's
      // result.salesOrder.customer so the workspace's right-hand
      // panel can render the PO header values regardless of which
      // customer record was matched.
      const initialResult: Record<string, any> = {};
      if (extractedLines && extractedLines.length) {
        initialResult.salesOrder = {
          lineItems: extractedLines,
          customer: extractedCustomer || null,
        };
      } else if (extractedCustomer) {
        initialResult.salesOrder = { customer: extractedCustomer };
      }

      const initialPreflight: Record<string, any> = {};
      if (doc?.id) initialPreflight.source_document_id = doc.id;
      // Bug fix May 2026 (stepper-lies report): only stamp
      // `extraction_run_id` when extraction actually produced
      // lines. A run_id without lines previously caused the
      // workspace stepper to mark Extract green even though the
      // reconciliation table was empty. The retry signal stays
      // available because the source_document_id is still stamped.
      if (extractMeta.runId && extractedLines && extractedLines.length) {
        initialPreflight.extraction_run_id = extractMeta.runId;
      }
      if (extractMeta.adapter) initialPreflight.adapter_used = extractMeta.adapter;
      if (extractMeta.confidence != null) initialPreflight.confidence_overall = extractMeta.confidence;

      const res = await ObaraBackend?.orders?.create?.({
        order_mode: mode,
        customer_id: customerId,
        status: "DRAFT",
        result: initialResult,
        preflight_payload: initialPreflight,
      });
      const newId = res?.order?.id || res?.id;
      if (!newId) throw new Error("Order create returned no id");
      // Best-effort OCR kickoff if a doc was uploaded; don't block navigation on it.
      if (doc?.id) {
        try { await ObaraBackend?.ocr?.run?.(doc.id, newId); } catch (_) { /* surface in workspace */ }
      }
      const linesMsg = extractedLines && extractedLines.length
        ? " (" + extractedLines.length + " line" + (extractedLines.length === 1 ? "" : "s") + " from PO)"
        : "";
      window.notifySuccess?.("Draft created", String(newId).slice(0, 8) + linesMsg);
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
                    {/* Audit P13.B.3.3. Camera-capable file input. The
                        `capture="environment"` attribute makes mobile
                        browsers (Chrome, Safari, Firefox) launch the
                        rear camera directly so a salesperson on the
                        floor can photo-capture a paper PO without
                        going through the gallery picker. Desktops
                        ignore the attribute and fall back to the
                        normal file picker; on mobile the OS gives
                        the user a "Camera | Files" choice. */}
                    <input
                      id="so-intake-camera"
                      type="file"
                      accept="image/*"
                      capture="environment"
                      style={{ display: "none" }}
                      onChange={(ev) => {
                        // Audit P13.B.3 follow-up. Route the camera
                        // capture through DocCropper for skew
                        // correction before the upload. The browse
                        // path (above) skips this since uploaded
                        // files are already deskewed by definition.
                        const f = ev.target.files?.[0];
                        if (f) setPendingCrop(f);
                        // Reset the input so re-taking the same
                        // file fires onChange again.
                        ev.target.value = "";
                      }}
                      aria-label="Take a photo of the purchase order"
                    />
                    <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
                      <Btn sm kind="ghost" onClick={() => fileRef.current?.click()} disabled={busy === "upload"}>
                        {busy === "upload" ? "uploading…" : <>{Icon.upload} browse</>}
                      </Btn>
                      <Btn sm kind="ghost" onClick={() => (document.getElementById("so-intake-camera") as HTMLInputElement | null)?.click()} disabled={busy === "upload"}>
                        {Icon.camera || Icon.upload} photo
                      </Btn>
                    </div>
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
                  Select a customer, or upload a PO and the customer
                  + GSTIN + currency + payment terms auto-populate
                  here from the PO header.
                </div>
              )}
            </Card>

            {/* Bug fix May 2026 (customer-prefill report): render
                the extracted customer block from the PO whenever
                docai returned one. Renders side-by-side with the
                "selected" card above so the operator sees both the
                existing-customer record and what the PO actually
                said. Mismatches (e.g. PO has a GSTIN the existing
                customer record doesn't) become visible. */}
            {extractedCustomer && (
              <Card title="From PO header" eyebrow="extracted by docai">
                <KV rows={[
                  ["Name",        extractedCustomer.name || "—"],
                  ["GSTIN",       (extractedCustomer.gstin || "").toUpperCase() || "—"],
                  ["State",       (extractedCustomer.state_code || "").toUpperCase() || "—"],
                  ["Currency",    extractedCustomer.currency || "—"],
                  ["Pay terms",   extractedCustomer.payment_terms || "—"],
                  ["Email",       extractedCustomer.email || "—"],
                  ["Phone",       extractedCustomer.phone || "—"],
                  ["Bill to",     extractedCustomer.bill_to_address || "—"],
                  ["Ship to",     extractedCustomer.ship_to_address || extractedCustomer.bill_to_address || "—"],
                ]} />
                {selectedCustomer && (
                  <div className="mono-sm" style={{ marginTop: 6, color: "var(--ink-3)" }}>
                    Selected customer's record will be used. Update
                    the customer record from the Customers screen if
                    the PO supplied newer info.
                  </div>
                )}
              </Card>
            )}

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
              <h2 id="new-customer-title" style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>
                {newCustomer.customer_name ? "New customer" : "Customer not detected"}
              </h2>
              <Btn sm kind="ghost" onClick={() => setNewCustomerOpen(false)} title="Close">{Icon.x}</Btn>
            </div>
            {/* May 2026 fix: when the dialog opens with empty fields
                because extraction couldn't find a customer header,
                surface a hint so the operator knows why they're
                being asked to type instead of confirm. */}
            {!newCustomer.customer_name && (
              <Banner kind="info" title="Fill in the customer details from the PO">
                <span className="mono-sm">
                  We could not auto-detect the customer header on this document. Type the details below; we'll create the customer record after you confirm.
                </span>
              </Banner>
            )}
            {newCustomer.customer_name && doc?.id && (
              <Banner kind="info" title="Confirm before creating">
                <span className="mono-sm">
                  We auto-filled these fields from the PO header. Review and confirm to add this customer to your database.
                </span>
              </Banner>
            )}
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
              <div>
                <label htmlFor="nc-email" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Contact email</label>
                <input id="nc-email" type="email" className="input" placeholder="ops@customer.com"
                       value={newCustomer.contact_email}
                       onChange={(e) => setNewCustomer((c) => ({ ...c, contact_email: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="nc-phone" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Contact phone</label>
                <input id="nc-phone" type="tel" className="input mono" placeholder="+91 98765 43210"
                       value={newCustomer.contact_phone}
                       onChange={(e) => setNewCustomer((c) => ({ ...c, contact_phone: e.target.value }))} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="nc-margin" className="mono-sm" style={{ display: "block", marginBottom: 4, color: "var(--ink-3)" }}>Margin floor (%)</label>
                <input id="nc-margin" className="input mono r" type="number" step="0.1" min="0" max="100"
                       value={newCustomer.margin_floor_pct}
                       onChange={(e) => setNewCustomer((c) => ({ ...c, margin_floor_pct: e.target.value }))} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <label htmlFor="nc-bill" className="mono-sm" style={{ color: "var(--ink-3)" }}>Bill-to address</label>
                  {locationRows.length > 0 && (
                    <select
                      className="select mono-sm"
                      style={{ height: 24, fontSize: 11, padding: "0 6px" }}
                      value=""
                      aria-label="Pick existing bill-to address"
                      onChange={(e) => {
                        const id = e.target.value;
                        if (!id) return;
                        const loc = locationRows.find((l) => l.id === id);
                        if (!loc) return;
                        setNewCustomer((c) => ({
                          ...c,
                          bill_to: addressTextFromLocation(loc),
                          gstin: c.gstin || loc.gstin || "",
                          state_code: c.state_code || loc.state_code || "",
                        }));
                      }}
                    >
                      <option value="">{locationsList.loading ? "loading addresses..." : "or pick existing..."}</option>
                      {locationRows.map((l) => (
                        <option key={l.id} value={l.id}>{formatLocation(l)}</option>
                      ))}
                    </select>
                  )}
                </div>
                <textarea id="nc-bill" className="input" rows={3} style={{ width: "100%", padding: 6 }}
                          value={newCustomer.bill_to}
                          placeholder="Plot 12, MIDC, Pune 411018"
                          onChange={(e) => setNewCustomer((c) => ({ ...c, bill_to: e.target.value }))} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <label htmlFor="nc-ship" className="mono-sm" style={{ color: "var(--ink-3)" }}>Ship-to address (defaults to bill-to if blank)</label>
                  <div className="row gap-sm">
                    {newCustomer.bill_to && newCustomer.bill_to !== newCustomer.ship_to && (
                      <button
                        type="button"
                        className="link-btn"
                        style={{ fontSize: 11, color: "var(--ink-3)" }}
                        onClick={() => setNewCustomer((c) => ({ ...c, ship_to: c.bill_to }))}
                      >
                        same as bill-to
                      </button>
                    )}
                    {locationRows.length > 0 && (
                      <select
                        className="select mono-sm"
                        style={{ height: 24, fontSize: 11, padding: "0 6px" }}
                        value=""
                        aria-label="Pick existing ship-to address"
                        onChange={(e) => {
                          const id = e.target.value;
                          if (!id) return;
                          const loc = locationRows.find((l) => l.id === id);
                          if (!loc) return;
                          setNewCustomer((c) => ({ ...c, ship_to: addressTextFromLocation(loc) }));
                        }}
                      >
                        <option value="">{locationsList.loading ? "loading addresses..." : "or pick existing..."}</option>
                        {locationRows.map((l) => (
                          <option key={l.id} value={l.id}>{formatLocation(l)}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
                <textarea id="nc-ship" className="input" rows={3} style={{ width: "100%", padding: 6 }}
                          value={newCustomer.ship_to}
                          placeholder="leave blank to use bill-to"
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

      {/* Audit P13.B.3 follow-up. 4-corner perspective cropper.
          Mounted on the camera-capture path: the operator drags
          the corner handles to mark the document edges and the
          cropper warps the image to a clean rectangle before the
          existing onPickFile pipeline (upload + extract) runs. */}
      {pendingCrop && (
        <DocCropper
          file={pendingCrop}
          onCancel={() => setPendingCrop(null)}
          onCropped={(cropped) => {
            setPendingCrop(null);
            onPickFile(cropped);
          }}
        />
      )}
    </>
  );
};


export default WiredSOIntake;
