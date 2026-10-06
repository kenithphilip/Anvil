// The tenant's own registered identity — what customer-facing documents print
// as the seller.
//
// Migration 062 added these columns because the e-invoice handler had one
// tenant's seller block hardcoded. The columns landed; a way to fill them in
// did not, so the only route was raw SQL against tenant_settings.
//
// The cost of leaving them empty is quiet: orders/so_pdf.js wraps the read in
// try/catch and renders an EMPTY seller block, so a Sales Order goes to a
// customer with no legal name, GSTIN or address on it. Nothing errors. This
// panel exists so that is a choice rather than an accident, and it says up
// front which fields the PDF is still missing.
//
// Lives in its own file rather than inside admin.tsx, which is already ~4,000
// lines and carries a standing backlog item to be split.

import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

type Seller = Record<string, string | null>;

// Grouped the way the values appear on a GST certificate, so an operator can
// transcribe top-to-bottom rather than hunting.
const GROUPS: Array<{ title: string; note?: string; fields: Array<{ k: string; label: string; ph?: string; wide?: boolean }> }> = [
  {
    title: "Registered identity",
    note: "Must match the GSTN registration tied to your GSTIN — a mismatch is what GSTN rejects e-invoices for.",
    fields: [
      { k: "einvoice_seller_legal_name", label: "Legal name", ph: "As registered with GSTN", wide: true },
      { k: "einvoice_seller_trade_name", label: "Trade name", ph: "If you trade under a different name", wide: true },
      { k: "einvoice_seller_gstin", label: "GSTIN", ph: "27AAACM3025E1ZZ" },
      { k: "einvoice_seller_state_code", label: "State code", ph: "27" },
    ],
  },
  {
    title: "Registered address",
    fields: [
      { k: "einvoice_seller_address_line1", label: "Address line 1", wide: true },
      { k: "einvoice_seller_address_line2", label: "Address line 2", wide: true },
      { k: "einvoice_seller_locality", label: "Locality / city" },
      { k: "einvoice_seller_pincode", label: "PIN code", ph: "411018" },
    ],
  },
  {
    title: "Contact & statutory",
    note: "CIN and PAN print on the Sales Order; the contact details are used on e-invoice payloads.",
    fields: [
      { k: "einvoice_seller_phone", label: "Phone" },
      { k: "einvoice_seller_email", label: "Email" },
      { k: "cin", label: "CIN", ph: "L65990MH1945PLC004558", wide: true },
      { k: "pan", label: "PAN", ph: "AAACM3025E" },
    ],
  },
];

const LABEL: Record<string, string> = {};
for (const g of GROUPS) for (const f of g.fields) LABEL[f.k] = f.label;

export const SellerDetailsPanel: React.FC<{ canEdit?: boolean }> = ({ canEdit = true }) => {
  const [seller, setSeller] = useState<Seller | null>(null);
  const [draft, setDraft] = useState<Seller>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r: any = await AnvilBackend?.sellerDetails?.get?.();
      setSeller(r?.seller || {});
      setDraft(r?.seller || {});
      setMissing(r?.missing_for_pdf || []);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ? String(e.message) : "Could not load seller details.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const dirty = !!seller && JSON.stringify(draft) !== JSON.stringify(seller);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const r: any = await AnvilBackend?.sellerDetails?.save?.(draft);
      setSeller(r?.seller || draft);
      setDraft(r?.seller || draft);
      setMissing(r?.missing_for_pdf || []);
      window.notifySuccess?.("Seller details saved", "Customer-facing documents will use these.");
    } catch (e: any) {
      // The endpoint returns a specific field message; showing it beats a
      // generic failure the operator cannot act on.
      setErr(e?.message ? String(e.message) : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Card><div className="mono-sm" style={{ padding: 16 }}>Loading seller details…</div></Card>;

  return (
    <Card>
      <div style={{ padding: "14px 16px" }}>
        <WSTitle title="Company details" />
        <p className="mono-sm" style={{ color: "var(--ink-3)", margin: "4px 0 12px", maxWidth: "62ch" }}>
          Your own registered identity. This is what a customer sees as the seller on Sales Order
          PDFs, and what GSTN checks against your GSTIN on e-invoices.
        </p>

        {missing.length > 0 && (
          <Banner kind="warn" icon={Icon.alert} title="Sales Order PDFs are going out without a seller block">
            <div className="mono-sm">
              Missing: {missing.map((f) => LABEL[f] || f).join(", ")}. The PDF still renders — it just
              has no legal name or GSTIN on it, which a customer will notice before you do.
            </div>
          </Banner>
        )}
        {missing.length === 0 && seller && (
          <Banner kind="good" icon={Icon.check} title="Complete — documents carry your seller block" />
        )}
        {err && (
          <Banner kind="bad" icon={Icon.alert} title="Could not save">
            <div className="mono-sm">{err}</div>
          </Banner>
        )}

        {GROUPS.map((g) => (
          <div key={g.title} style={{ marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <b style={{ fontSize: 13 }}>{g.title}</b>
              {g.note && <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{g.note}</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 8 }}>
              {g.fields.map((f) => (
                <label key={f.k} style={{ display: "flex", flexDirection: "column", gap: 3, gridColumn: f.wide ? "1 / -1" : undefined }}>
                  <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                    {f.label}
                    {missing.includes(f.k) && <Chip k="warn">needed for PDF</Chip>}
                  </span>
                  <input
                    value={draft[f.k] ?? ""}
                    placeholder={f.ph}
                    disabled={!canEdit || saving}
                    aria-label={f.label}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.k]: e.target.value }))}
                    style={{
                      border: "1px solid var(--hairline)", borderRadius: 6, padding: "6px 9px",
                      font: "inherit", fontSize: 12.5, background: "var(--paper)", color: "var(--ink)",
                    }}
                  />
                </label>
              ))}
            </div>
          </div>
        ))}

        {canEdit && (
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <Btn kind="primary" onClick={save} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save company details"}
            </Btn>
            {dirty && <Btn kind="ghost" onClick={() => setDraft(seller || {})} disabled={saving}>Discard</Btn>}
          </div>
        )}
        {!canEdit && (
          <div className="mono-sm" style={{ marginTop: 14, color: "var(--ink-3)" }}>
            Read-only — changing the identity Anvil signs documents with needs approve rights.
          </div>
        )}
      </div>
    </Card>
  );
};
