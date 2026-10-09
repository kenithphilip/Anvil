import React, { useState } from "react";
import { Banner, Btn } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import { Icon } from "../lib/icons";

// Upload the sales order the ERP produced for this order.
//
// The three-way comparison (PO as the authority, Anvil, the ERP) needs the
// ERP's side, and that side is the sales order a person keyed into the ERP.
// In Mode B that document is the whole point: the Admin screen tells the
// tenant to upload it. The attach endpoint and its client method existed with
// no caller, so the "PO vs ERP" tab said "No sales order attached" forever.
// This is the caller.
//
// Three calls, in order, as DeliveryChallanUpload does: store the file, read
// it as a sales order, attach it to THIS order. The order id is passed, so
// the attach does not depend on the buyer reference reading; the endpoint
// records it as an explicit attach and says when the document's own
// reference names a different PO.

type Outcome = {
  voucherNo: string | null;
  reference: string | null;
  overrodeReference: boolean;
  comparable: boolean;
  // Why it cannot be compared, as the endpoint words it (comparability() in
  // _lib/sales-order-match.js), so the screen keeps no second copy.
  comparabilityDetail: string | null;
};

type Held = { documentId: string; extracted: any; reason: string };

export const ErpSalesOrderUpload: React.FC<{ orderId: string; onAttached?: () => void }> = ({ orderId, onAttached }) => {
  const [step, setStep] = useState<null | "uploading" | "reading" | "attaching">(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // A read the extractor itself was unsure of. Its lines become the ERP side
  // of the comparison, so it waits for an explicit decision.
  const [held, setHeld] = useState<Held | null>(null);

  const attach = async (documentId: string, extracted: any) => {
    setStep("attaching");
    const res: any = await AnvilBackend?.orders?.attachSalesOrder?.(documentId, extracted, orderId);
    if (!res?.attached) {
      throw new Error("The sales order was not attached to this order.");
    }
    setOutcome({
      voucherNo: extracted?.voucher_no ?? null,
      reference: res?.match?.reference ?? null,
      overrodeReference: !!res?.match?.overrode_reference,
      comparable: res?.comparable !== false,
      comparabilityDetail: res?.comparability?.detail ?? null,
    });
    onAttached?.();
  };

  const attachHeld = async () => {
    if (!held) return;
    const h = held;
    setHeld(null);
    setErr(null);
    try { await attach(h.documentId, h.extracted); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setStep(null); }
  };

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    setOutcome(null);
    setHeld(null);
    try {
      setStep("uploading");
      const up: any = await AnvilBackend?.documents?.upload?.(file, "sales_order", { autoScan: false });
      const documentId: string | undefined = up?.documentId;
      if (!documentId) throw new Error("Upload did not return a document id");

      setStep("reading");
      const out: any = await AnvilBackend?.documents?.extract?.(file, {
        kind: "sales_order",
        // extraction_runs.source_id is how the comparison finds this read:
        // three_way_report looks up the sales_order run by the attached
        // document's id.
        source_id: documentId,
        order_id: orderId,
      });
      const extracted = out?.normalized || null;
      if (!extracted) {
        throw new Error(out?.status_reason
          ? `The sales order could not be read (${out.status_reason}).`
          : "The sales order could not be read. Try a clearer copy.");
      }
      if (extracted.classification === "non_sales_order") {
        // Attaching it would put a document that is not the ERP's answer on
        // the ERP side of the comparison.
        throw new Error("This document was not read as a sales order, so nothing was attached. Upload the sales order your ERP produced.");
      }
      if (out?.large_pdf) {
        // Only page 1 was read. Comparing it would report every later line as
        // missing from the ERP.
        throw new Error(`This file runs to ${out.total_pages || "many"} pages and only the first was read, so nothing was attached. Upload the sales order pages on their own.`);
      }
      if (out?.status === "low_confidence") {
        setHeld({ documentId, extracted, reason: out?.status_reason || "the extractor was not sure of what it read" });
        return;
      }
      await attach(documentId, extracted);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setStep(null);
    }
  };

  const busy = step !== null;

  return (
    <div className="erp-so-upload" style={{ marginBottom: 12 }}>
      <label className="btn btn-sm" style={{ cursor: busy ? "wait" : "pointer" }}>
        {busy ? `${step}...` : <>{Icon.upload || "Upload"} Upload ERP sales order</>}
        <input
          type="file"
          accept=".pdf,.PDF,image/*"
          disabled={busy}
          style={{ display: "none" }}
          aria-label="Upload ERP sales order"
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
        The sales order your team raised in the ERP for this PO. It becomes the ERP side of the comparison.
      </span>

      {err && (
        <Banner kind="bad" title="Could not attach the sales order">
          <span className="mono-sm">{err}</span>
        </Banner>
      )}

      {held && (
        <Banner
          kind="warn"
          title="Read with low confidence, not attached yet"
          action={<Btn sm onClick={attachHeld}>Attach anyway</Btn>}
        >
          <span className="mono-sm">
            {held.reason}. Its lines become the ERP side of the comparison, so check the document before you attach it.
          </span>
        </Banner>
      )}

      {outcome && (
        <Banner
          kind={outcome.comparable && !outcome.overrodeReference ? "ok" : "warn"}
          title={`Sales order ${outcome.voucherNo || "(unnumbered)"} attached`}
        >
          {!outcome.comparable && (
            <span className="mono-sm">
              It cannot be compared. {outcome.comparabilityDetail || ""}
            </span>
          )}
          {outcome.overrodeReference && (
            <span className="mono-sm">
              {" "}It names PO {outcome.reference}, not this order's PO. It was attached here because you uploaded it on this order.
            </span>
          )}
        </Banner>
      )}
    </div>
  );
};

export default ErpSalesOrderUpload;
