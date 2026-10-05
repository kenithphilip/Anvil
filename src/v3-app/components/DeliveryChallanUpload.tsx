import React, { useState } from "react";
import { Banner, Btn } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import { Icon } from "../lib/icons";

// Upload the Tally delivery challan for this order.
//
// The challan is the only document that carries the docket (LR) number and
// the quantity that actually left, per line. Without it dispatch_lines stays
// empty, so the invoice check reports "no docket" on every invoice and cannot
// say whether the billed quantity has shipped. The ingest endpoint and its
// client method existed with no caller; this is the caller.
//
// Three calls, in order: store the PDF, read it as a delivery note, record the
// despatch lines against THIS order. The endpoint checks the challan's own PO
// and invoice references against the order and refuses a mismatch, so a
// challan picked up on the wrong order is not recorded there.

type Candidate = { id?: string | null; invoice_id?: string | null; po_number?: string | null };
type Outcome =
  | { kind: "ok"; written: { inserted: number; updated: number }; docket: string | null; challan: string | null; basis: string | null }
  | { kind: "refused"; reason: string; detail: string; candidates: Candidate[] };

const REASON_TITLE: Record<string, string> = {
  order_mismatch: "This challan belongs to a different order",
  not_a_delivery_note: "This document was not read as a delivery challan",
  no_lines: "The challan has no line items",
  unresolved_order: "Could not tell which order this challan belongs to",
};

export const DeliveryChallanUpload: React.FC<{ orderId: string; onRecorded?: () => void }> = ({ orderId, onRecorded }) => {
  const [step, setStep] = useState<null | "uploading" | "reading" | "recording">(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    setOutcome(null);
    try {
      setStep("uploading");
      const up: any = await AnvilBackend?.documents?.upload?.(file, "delivery_note", { autoScan: false });
      const documentId: string | undefined = up?.documentId;
      if (!documentId) throw new Error("Upload did not return a document id");

      setStep("reading");
      const out: any = await AnvilBackend?.documents?.extract?.(file, {
        kind: "delivery_note",
        // extraction_runs.source_id is the only link from a run back to the
        // file it read; order_id keys the run to this order's activity.
        source_id: documentId,
        order_id: orderId,
      });
      const extracted = out?.normalized || null;
      if (!extracted) throw new Error("The challan could not be read. Try a clearer scan.");

      setStep("recording");
      const res: any = await AnvilBackend?.documents?.ingestDeliveryNote?.(documentId, extracted, orderId);
      if (res && res.ok) {
        setOutcome({
          kind: "ok",
          written: res.written || { inserted: 0, updated: 0 },
          docket: res.docket_no || null,
          challan: res.delivery_note_no || null,
          basis: res.matched_on || null,
        });
        onRecorded?.();
      } else {
        setOutcome({
          kind: "refused",
          reason: res?.reason || "unresolved_order",
          detail: res?.detail || "Nothing was recorded.",
          candidates: Array.isArray(res?.candidates) ? res.candidates : [],
        });
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setStep(null);
    }
  };

  const busy = step !== null;

  return (
    <div className="dcu" style={{ marginBottom: 12 }}>
      <label className="btn btn-sm" style={{ cursor: busy ? "wait" : "pointer" }}>
        {busy ? `${step}...` : <>{Icon.upload || "Upload"} Upload delivery challan</>}
        <input
          type="file"
          accept=".pdf,.PDF,image/*"
          disabled={busy}
          style={{ display: "none" }}
          aria-label="Upload delivery challan"
          onChange={(e) => {
            // Copy before resetting: e.target.files is the input's own live
            // FileList, and setting value = "" empties it in place.
            const f = e.target.files?.[0];
            e.target.value = "";
            onPick(f);
          }}
        />
      </label>
      <span className="mono-sm" style={{ marginLeft: 8, opacity: 0.7 }}>
        Records the docket number and the quantity despatched per line.
      </span>

      {err && (
        <Banner kind="bad" title="Could not record the challan">
          <span className="mono-sm">{err}</span>
        </Banner>
      )}

      {outcome?.kind === "ok" && (
        <Banner kind="ok" title={`Challan ${outcome.challan || "(unnumbered)"} recorded`}>
          <span className="mono-sm">
            {outcome.written.inserted} line{outcome.written.inserted === 1 ? "" : "s"} added, {outcome.written.updated} updated
            {outcome.docket ? `, docket ${outcome.docket}` : ", no docket number on the challan"}.
            {outcome.basis ? ` ${outcome.basis}.` : ""}
          </span>
        </Banner>
      )}

      {outcome?.kind === "refused" && (
        <Banner kind="warn" title={REASON_TITLE[outcome.reason] || "The challan was not recorded"}>
          <span className="mono-sm">{outcome.detail}</span>
          {outcome.candidates.filter((c) => c.id).length > 0 && (
            <div style={{ marginTop: 6 }}>
              {outcome.candidates.filter((c) => c.id).map((c) => (
                <Btn key={c.id as string} sm kind="ghost" onClick={() => { window.location.hash = `#/so?id=${c.id}`; }}>
                  {c.po_number ? `Open order for PO ${c.po_number}` : "Open the matching order"}
                </Btn>
              ))}
            </div>
          )}
        </Banner>
      )}
    </div>
  );
};

export default DeliveryChallanUpload;
