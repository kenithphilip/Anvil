import React, { useEffect, useState } from "react";
import { Banner, Btn, Modal } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import { canWrite } from "../lib/rbac";

// Offer to mark the opportunity won once a customer PO is linked to it.
//
// Decision D15 (docs/WORK_MANAGEMENT_SCOPE.md): a linked customer PO does
// NOT move the opportunity by itself. The SO workspace proposes the move,
// and the operator makes it with one click and a confirm. The move goes
// through the opportunity stage API, so its transition guard still
// applies, and a refusal (409) is shown as the server worded it.
//
// Shown only when all of these hold: the order carries a customer PO
// number, it is linked to an opportunity, the order is not cancelled, the
// opportunity is not already closed, and this role may edit opportunities.

const CLOSED_STAGES = new Set(["CLOSE_WON", "CLOSE_LOST", "REGRETTED"]);

export interface OpportunityWonOfferOrder {
  id: string;
  status?: string | null;
  po_number?: string | null;
  customer_id?: string | null;
  opportunity_id?: string | null;
}

export const OpportunityWonOffer: React.FC<{ order: OpportunityWonOfferOrder }> = ({ order }) => {
  const [opp, setOpp] = useState<any | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ status?: number; message: string } | null>(null);

  const eligible = !!(order?.opportunity_id && order?.po_number && order?.customer_id
    && order?.status !== "CANCELLED" && canWrite("opps"));

  useEffect(() => {
    setOpp(null);
    setErr(null);
    if (!eligible) return;
    let cancelled = false;
    (async () => {
      try {
        const resp: any = await AnvilBackend?.sales?.listOpportunities?.({ customer_id: order.customer_id });
        const all = Array.isArray(resp) ? resp : resp?.opportunities || [];
        const found = all.find((o: any) => o?.id === order.opportunity_id) || null;
        if (!cancelled) setOpp(found);
      } catch { /* no offer without the opportunity's stage */ }
    })();
    return () => { cancelled = true; };
  }, [eligible, order?.opportunity_id, order?.customer_id]);

  const markWon = async () => {
    if (!opp?.id) return;
    setBusy(true);
    setErr(null);
    try {
      const resp: any = await AnvilBackend?.sales?.updateOpportunity?.({ id: opp.id, stage: "CLOSE_WON" });
      setOpp({ ...opp, ...(resp?.opportunity || {}), stage: resp?.opportunity?.stage || "CLOSE_WON" });
      setConfirming(false);
      window.notifySuccess?.("Opportunity marked won", opp.opportunity_name || opp.id.slice(0, 8));
    } catch (e: any) {
      setConfirming(false);
      setErr({ status: e?.status, message: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!eligible || !opp) return null;
  const name = opp.opportunity_name || opp.name || opp.id.slice(0, 8);

  if (err) {
    return (
      <Banner kind="bad" title={err.status === 409 ? "The stage change was refused" : "Could not mark the opportunity won"}>
        {err.message}
      </Banner>
    );
  }
  if (CLOSED_STAGES.has(opp.stage)) return null;

  return (
    <>
      <Banner
        kind="info"
        title="This PO is linked to an open opportunity"
        action={<Btn sm kind="primary" disabled={busy} onClick={() => setConfirming(true)}>Mark opportunity won</Btn>}
      >
        <span className="mono-sm">{name} is at {opp.stage}. The customer PO {order.po_number} may close it.</span>
      </Banner>
      <Modal open={confirming} onClose={() => setConfirming(false)} title="Mark this opportunity won?">
        <Modal.Body>
          <p style={{ margin: 0 }}>
            Move <b>{name}</b> from <b>{opp.stage}</b> to <b>CLOSE_WON</b>.
          </p>
          <p className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 8 }}>
            The order does not change. CLOSE_WON is a closed stage, and the stage guard does not reopen it.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Btn kind="ghost" onClick={() => setConfirming(false)}>Not now</Btn>
          <Btn kind="primary" disabled={busy} onClick={markWon}>{busy ? "Saving..." : "Mark won"}</Btn>
        </Modal.Footer>
      </Modal>
    </>
  );
};

export default OpportunityWonOffer;
