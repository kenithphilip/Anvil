// Attach one or more quotation PDFs to a customer PO.
//
// The discrepancy engine (orders/reconcile_quotes) already pools EVERY
// non-cancelled quote for the customer and matches the PO across all of them,
// so many-quotes-to-one-PO needs nothing new here — each upload simply becomes
// another quote for that customer, and the next reconcile picks it up.
//
// The three steps are deliberately visible. Upload, extract, attach: if the
// extractor cannot read a document, the file is still attached to the order and
// the operator is told which half worked, rather than being handed a success
// toast over a quote that was silently ignored.

import React, { useState } from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

type Step = "idle" | "uploading" | "extracting" | "attaching";

interface Attached {
  filename: string;
  ingested: boolean;
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
    const res: any = await AnvilBackend?.orders?.attachQuote?.(orderId, documentId, extracted);
    return {
      filename: file.name,
      ingested: !!res?.ingested,
      quote_number: res?.quote_number ?? null,
      lines_written: res?.lines_written ?? 0,
      reason: res?.reason ?? null,
    } as Attached;
  };

  const onPick = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setErr(null);
    const results: Attached[] = [];
    try {
      // Sequential: each attach ingests into quotes/quote_lines, and doing
      // several at once would race the same customer's quote numbering.
      for (const f of Array.from(files)) results.push(await attachOne(f));
      setDone((d) => [...results, ...d]);
      const ok = results.filter((r) => r.ingested).length;
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
            onChange={(e) => { const fs = e.target.files; e.target.value = ""; onPick(fs); }}
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
              <Chip k={d.ingested ? "good" : "warn"}>{d.ingested ? "read" : "attached only"}</Chip>
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
