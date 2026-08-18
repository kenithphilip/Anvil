// Attach one or more quotation PDFs to a customer PO.
//
// The discrepancy engine (orders/reconcile_quotes) already pools EVERY
// non-cancelled quote for the customer and matches the PO across all of them,
// so many-quotes-to-one-PO needs nothing new here — each upload simply becomes
// another quote for that customer, and the next reconcile picks it up.
//
// The steps are deliberately visible. Upload, check, extract, attach: if the
// extractor cannot read a document, the file is still attached to the order and
// the operator is told which half worked, rather than being handed a success
// toast over a quote that was silently ignored.
//
// The CHECK step exists because the commonest quote attached to a PO is the one
// Anvil generated for it. The server recognises those and answers
// needs_extraction:false, so our own quote is linked without a model call and
// without touching the lines a human authored.

import React, { useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

type Step = "idle" | "uploading" | "checking" | "extracting" | "attaching";

interface Attached {
  filename: string;
  ingested: boolean;
  // Our own quote, linked rather than re-read. Neither a success nor a
  // failure to import — there was nothing to import.
  matchedAuthored?: boolean;
  quote_number?: string | null;
  lines_written?: number;
  reason?: string | null;
}

export const AttachQuotePanel: React.FC<{
  orderId: string;
  hasCustomer: boolean;
  onAttached?: () => void;
}> = ({ orderId, hasCustomer, onAttached }) => {
  const [step, setStep] = useState<Step>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Attached[]>([]);

  const busy = step !== "idle";

  const attachOne = async (file: File) => {
    setStep("uploading");
    const up: any = await AnvilBackend?.documents?.upload?.(file, "quote", { autoScan: false });
    const documentId = up?.documentId;
    if (!documentId) throw new Error("Upload did not return a document id");

    // Preflight: link it and ask whether a model is needed at all. Anvil's own
    // quote answers no, and we stop here having spent nothing.
    setStep("checking");
    const pre: any = await AnvilBackend?.orders?.attachQuote?.(orderId, documentId, null, false);
    if (pre && pre.needs_extraction === false) {
      return {
        filename: file.name,
        ingested: false,
        matchedAuthored: !!pre.matched_authored,
        quote_number: pre.quote_number ?? null,
        lines_written: 0,
        reason: pre.reason || null,
      } as Attached;
    }

    // kind:"quote" — the default "po" classifies a seller's quotation as
    // non_po and returns nothing usable.
    setStep("extracting");
    let extracted: any = null;
    try {
      const out: any = await AnvilBackend?.documents?.extract?.(file, { kind: "quote" });
      extracted = out?.normalized || null;
    } catch {
      // Non-fatal on purpose: attach the file anyway, report below.
      extracted = null;
    }

    setStep("attaching");
    const res: any = await AnvilBackend?.orders?.attachQuote?.(orderId, documentId, extracted, true);
    return {
      filename: file.name,
      ingested: !!res?.ingested,
      matchedAuthored: !!res?.matched_authored,
      quote_number: res?.quote_number ?? null,
      lines_written: res?.lines_written ?? 0,
      // The server's own explanation, then the ingest report's error, then a
      // generic. "could not be read" for a perfectly readable PDF sent the
      // operator hunting the document instead of the bug.
      reason: res?.reason || res?.report?.reports?.[0]?.error || null,
    } as Attached;
  };

  const onPick = async (files: File[]) => {
    if (!files.length) return;
    setErr(null);
    const results: Attached[] = [];
    try {
      // Sequential: each attach ingests into quotes/quote_lines, and doing
      // several at once would race the same customer's quote numbering.
      // Committed per file: an error on the third must not discard the first
      // two, which are already uploaded, linked and ingested server-side.
      for (const f of files) {
        const r = await attachOne(f);
        results.push(r);
        setDone((d) => [r, ...d]);
      }
      const ok = results.filter((r) => r.ingested || r.matchedAuthored).length;
      if (ok) {
        window.notifySuccess?.(
          `${ok} quote${ok === 1 ? "" : "s"} attached`,
          "Re-run the quote check to compare them against this PO.",
        );
      }
      onAttached?.();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setStep("idle");
    }
  };

  if (!hasCustomer) {
    return (
      <Banner kind="info" icon={Icon.info} title="Set the customer first">
        <span className="mono-sm">
          Quotes are matched to this PO by customer, so a quote attached now could never be
          compared against it.
        </span>
      </Banner>
    );
  }

  return (
    <Card title="Quotes for this PO" eyebrow="attach the quotation(s) this order was placed against">
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label className="btn btn-sm" style={{ cursor: busy ? "wait" : "pointer" }}>
          {busy ? `${step}…` : <>{Icon.upload || "↑"} Attach quote PDF</>}
          <input
            type="file" accept=".pdf,.PDF" multiple disabled={busy} style={{ display: "none" }}
            onChange={(e) => {
              // COPY the files out before resetting the input. `e.target.files`
              // is the input's own LIVE FileList, and setting value = "" empties
              // that same object in place — so onPick received a zero-length
              // list and returned before uploading anything. The picker opened,
              // a PDF was chosen, and the panel did literally nothing: no busy
              // label, no error, no toast.
              const fs = Array.from(e.target.files || []);
              e.target.value = "";
              onPick(fs);
            }}
          />
        </label>
        <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
          Several quotes can back one PO — attach each of them.
        </span>
      </div>

      {err && (
        <Banner kind="bad" icon={Icon.alert} title="Attach failed">
          <span className="mono-sm">{err}</span>
        </Banner>
      )}

      {done.length > 0 && (
        <div className="mono-sm" style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
          {done.map((d, i) => (
            <div key={i} className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <Chip k={d.ingested || d.matchedAuthored ? "good" : "warn"}>
                {d.matchedAuthored ? "already in Anvil" : d.ingested ? "read" : "attached only"}
              </Chip>
              <span>{d.filename}</span>
              {d.ingested
                ? <span style={{ color: "var(--ink-3)" }}>
                    {d.quote_number ? `${d.quote_number} · ` : ""}{d.lines_written} line(s) — re-run the quote check
                  </span>
                : <span style={{ color: "var(--ink-3)" }}>{d.reason || "could not be read"}</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

export default AttachQuotePanel;
