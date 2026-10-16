import React, { useEffect, useId, useState } from "react";
import { Btn, Modal } from "../lib/primitives";

// One in-app dialog that asks WHY before a decision a person must explain.
// The SO workspace uses it for "return for fix" and "cancel".
//
// It replaces window.prompt, which a browser can suppress ("don't allow more
// dialogs"), so the button then did nothing. It also replaces the cancel
// confirmation, which recorded no reason at all.
//
// The reason is REQUIRED: trimmed, and at least REASON_MIN_LENGTH characters
// (the same rule as a terms decision). The confirm button stays disabled
// until the reason is valid, and onConfirm gets the trimmed text.
//
// Exported for the Approvals queue: plan PR 2 builds a small local reason box
// in approvals.tsx, which can switch to this one.

export const REASON_MIN_LENGTH = 10;

// The trimmed reason when it is long enough, else null.
export const cleanReason = (raw: unknown, min: number = REASON_MIN_LENGTH): string | null => {
  const r = typeof raw === "string" ? raw.trim() : "";
  return r.length >= min ? r : null;
};

export interface ReasonModalProps {
  open: boolean;
  title: string;
  /** What will happen, shown above the reason box. */
  intro?: React.ReactNode;
  /** The label of the reason box. */
  label?: string;
  placeholder?: string;
  /** The words on the confirm button. */
  confirmLabel: string;
  confirmKind?: "primary" | "danger";
  /** The words on the button that closes without a decision. */
  dismissLabel?: string;
  minLength?: number;
  /** True while the decision is being saved: the confirm button is disabled. */
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

export const ReasonModal: React.FC<ReasonModalProps> = ({
  open, title, intro, label = "Reason", placeholder, confirmLabel, confirmKind = "primary",
  dismissLabel = "Close", minLength = REASON_MIN_LENGTH, busy = false, onConfirm, onClose,
}) => {
  const [text, setText] = useState("");
  const fieldId = useId();
  // Each time the dialog opens, it starts empty.
  useEffect(() => { if (open) setText(""); }, [open]);
  const reason = cleanReason(text, minLength);
  const left = Math.max(0, minLength - text.trim().length);
  const submit = () => { if (reason && !busy) onConfirm(reason); };
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <Modal.Body>
        {intro}
        <label htmlFor={fieldId} className="mono-sm" style={{ color: "var(--ink-2)" }}>{label} (required)</label>
        <textarea
          id={fieldId}
          data-testid="reason-input"
          className="input"
          rows={3}
          value={text}
          placeholder={placeholder || `At least ${minLength} characters that say why.`}
          onChange={(ev) => setText(ev.target.value)}
          style={{ width: "100%", boxSizing: "border-box", resize: "vertical" }}
        />
        <span className="mono-sm" data-testid="reason-hint" style={{ color: "var(--ink-3)" }}>
          {reason ? "This reason is saved in the order's audit trail." : `Type ${left} more character${left === 1 ? "" : "s"}.`}
        </span>
      </Modal.Body>
      <Modal.Footer>
        <Btn kind="ghost" onClick={onClose}>{dismissLabel}</Btn>
        <Btn kind={confirmKind} disabled={!reason || busy} onClick={submit}>{confirmLabel}</Btn>
      </Modal.Footer>
    </Modal>
  );
};
