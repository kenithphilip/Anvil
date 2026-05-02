// @ts-nocheck — converted screen, types follow in a focused TS pass
import React, { useEffect, useState } from "react";
import { Card, WSTitle } from "../lib/primitives";

// ============================================================
// ANVIL v3 — Format guide (file format auto-detection rules)
// Migrates the legacy showFormatGuide info modal.
// Reached via #/format-guide.
// ============================================================

const WiredFormatGuide = () => (
  <>
    <WSTitle eyebrow="Help" title="Supported file formats"
             meta="Imports + exports across Anvil" />
    <div className="ws-content">
      <Card title="Imports" eyebrow="what we accept">
        <dl className="kv" style={{ gridTemplateColumns: "180px 1fr" }}>
          <dt>BOM library</dt>
          <dd>XLSX, XLS, CSV, TSV, TXT, ZIP. Headers must include recognizable part-number and part-name columns. Origin (India / Korea / China / Japan) auto-detected from filename.</dd>
          <dt>SO history</dt>
          <dd>XLSX, XLS, CSV, TSV, TXT. PO-tracker and Tally-export layouts auto-detected by column header signatures.</dd>
          <dt>Spare matrix</dt>
          <dd>XLSX, XLS, CSV, TSV, TXT. Use the template headers for reliable mapping.</dd>
          <dt>Customer PO</dt>
          <dd>PDF (image or text), DOCX, XLSX. Mistral OCR runs on first upload. Confidence shown per page.</dd>
          <dt>Customer quote</dt>
          <dd>PDF, DOCX, XLSX. Optional in SO Intake but improves reconciliation.</dd>
          <dt>Price comparison</dt>
          <dd>Previous-PO Excel for line-level price drift. Optional.</dd>
        </dl>
      </Card>

      <Card title="Exports" eyebrow="what we produce">
        <dl className="kv" style={{ gridTemplateColumns: "180px 1fr" }}>
          <dt>Spare matrix</dt>
          <dd>XLSX, CSV, TSV, JSON.</dd>
          <dt>Recommended spares</dt>
          <dd>XLSX, CSV, TSV, JSON.</dd>
          <dt>SO history</dt>
          <dd>XLSX, CSV, TSV, JSON.</dd>
          <dt>SO agent history</dt>
          <dd>JSON, CSV.</dd>
          <dt>Audit log</dt>
          <dd>CSV, JSON.</dd>
          <dt>Audit pack (per order)</dt>
          <dd>ZIP bundling PO + quote + price comp + result + signed evidence URLs.</dd>
        </dl>
      </Card>

      <Card title="Document safety" eyebrow="zip + scan + redact">
        <ul style={{ marginTop: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--ink-2)" }}>
          <li><b>ZIP guards</b>: file size limit 100 MB, member count cap, no nested ZIP, no executable extensions.</li>
          <li><b>ClamAV proxy</b> scans every accepted upload before OCR.</li>
          <li><b>Redaction firewall</b> on Claude calls: PII, credit cards, Aadhaar, PAN. Edit the rules in Security Center.</li>
          <li><b>Storage</b>: Supabase Storage bucket scoped to the tenant, signed URLs with 1-hour TTL.</li>
        </ul>
      </Card>

      <Card title="Tally + GSTN export" eyebrow="finance pipeline">
        <ul style={{ marginTop: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--ink-2)" }}>
          <li><b>Tally voucher</b>: XML over the Tally HTTP bridge with per-order idempotency hash.</li>
          <li><b>e-Invoice IRN</b>: GSTN compose-and-submit; 24-hour cancel window.</li>
          <li><b>Reconcile</b>: voucher-number capture marks orders RECONCILED.</li>
        </ul>
      </Card>
    </div>
  </>
);


export default WiredFormatGuide;
