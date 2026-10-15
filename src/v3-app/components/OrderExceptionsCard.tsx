import React from "react";
import { Btn, Card, Chip } from "../lib/primitives";
import { useReviewPaneSelection } from "./ReviewPaneContext";

// ============================================================
// ANVIL v3: the "Needs decision" card of the SO workspace
// One list of what needs a decision on the order (plan PR 9), built by
// src/api/_lib/order-exceptions.js and served by GET /api/orders/exceptions.
// Read-only: each row says where the issue is resolved and links there (a
// tab, a control, or a line in the grid). No decision is recorded here.
// ============================================================

export type ExceptionAction = {
  tab?: string;
  control?: string;
  target?: string | null;
  href?: string;
  label: string;
};

export type ResolutionOption = {
  option: string;
  label: string;
  applies_via: { kind: "endpoint" | "not_available_yet"; [k: string]: any };
};

// One row of GET /api/orders/exceptions (version 1). The screen renders the
// response as it comes, so an agent reading the API sees what a person sees.
export type ExceptionRow = {
  key: string;
  type: string;
  source: string;
  sources: string[];
  severity: "critical" | "high" | "warn" | "info" | string;
  blocks: "send" | "approval" | null;
  shadow: boolean;
  status: "open" | "decided";
  decided_note?: string;
  title: string;
  detail: string;
  payload: Record<string, any>;
  action: ExceptionAction | null;
  resolution_options: ResolutionOption[];
  agent_policy: "propose" | "apply" | "human_only" | string;
};

export type ExceptionsResult = {
  version?: number;
  order_id?: string | null;
  status?: string | null;
  rows: ExceptionRow[];
  info: ExceptionRow[];
  decided: ExceptionRow[];
  counts: { open: number; info: number; decided: number; blocking: number; by_severity: Record<string, number>; by_agent_policy?: Record<string, number> };
  clean: boolean;
  terms_state?: string;
  customer_match?: { basis: string; label: string } | null;
};

const SEVERITY_CHIP: Record<string, string> = { critical: "bad", high: "bad", warn: "warn", info: "info" };

export const SOURCE_LABEL: Record<string, string> = {
  terms: "terms check",
  finding: "finding",
  reconciliation: "quote check",
  customer: "customer match",
  delivery_date: "delivery date",
  anomaly: "anomaly rules",
  extraction: "extraction",
};

// The first rows shown before "show all". The quote-check banner listed ten.
export const FIRST_ROWS = 10;

const Row: React.FC<{
  row: ExceptionRow;
  onAction: (action: ExceptionAction, row: ExceptionRow) => void;
  disabledReason: (action: ExceptionAction | null) => string | null;
}> = ({ row, onAction, disabledReason }) => {
  const { setHoveredField, setSelectedField } = useReviewPaneSelection();
  const lineTarget = row.action?.target && row.action.target.startsWith("lines[") ? row.action.target : null;
  const blocked = disabledReason(row.action);
  const act = () => {
    if (!row.action) return;
    if (lineTarget) setSelectedField(lineTarget);
    onAction(row.action, row);
  };
  return (
    <li
      className="exc-row"
      data-testid="exception-row"
      data-key={row.key}
      data-type={row.type}
      data-severity={row.severity}
      onMouseEnter={lineTarget ? () => setHoveredField(lineTarget) : undefined}
      onMouseLeave={lineTarget ? () => setHoveredField(null) : undefined}
    >
      <div className="row gap-sm" style={{ alignItems: "center", flexWrap: "wrap" }}>
        <Chip k={SEVERITY_CHIP[row.severity] || "warn"}>{row.severity}</Chip>
        {row.blocks === "send" && <Chip k="bad">blocks sending</Chip>}
        {row.blocks === "approval" && <Chip k="bad">blocks approval</Chip>}
        {row.shadow && <Chip k="warn">shadow</Chip>}
        <span className="pri exc-title">{row.title}</span>
      </div>
      {row.detail && <div className="mono-sm exc-detail">{row.detail}</div>}
      <div className="mono-sm exc-meta" style={{ color: "var(--ink-3)" }}>
        <span>{(row.sources || [row.source]).map((s) => SOURCE_LABEL[s] || s).join(" + ")}</span>
        {row.decided_note && <span> · {row.decided_note}</span>}
        {row.action && (
          <>
            <span> · </span>
            <button
              type="button"
              className="link-btn exc-action"
              disabled={!!blocked}
              title={blocked || undefined}
              onClick={act}
              style={{ background: "none", border: "none", padding: 0, color: blocked ? "var(--ink-4)" : "var(--ink)", cursor: blocked ? "not-allowed" : "pointer", textDecoration: "underline", font: "inherit" }}
            >
              {row.action.label}
            </button>
          </>
        )}
      </div>
    </li>
  );
};

const RowList: React.FC<{
  rows: ExceptionRow[];
  limit?: number;
  onAction: (action: ExceptionAction, row: ExceptionRow) => void;
  disabledReason: (action: ExceptionAction | null) => string | null;
}> = ({ rows, limit, onAction, disabledReason }) => {
  const [all, setAll] = React.useState(false);
  const shown = limit && !all ? rows.slice(0, limit) : rows;
  return (
    <>
      <ul className="exc-list" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {shown.map((r) => <Row key={r.key} row={r} onAction={onAction} disabledReason={disabledReason} />)}
      </ul>
      {limit && rows.length > limit && (
        <Btn sm kind="ghost" onClick={() => setAll((v) => !v)} style={{ marginTop: 6 }}>
          {all ? "Show the first " + limit : "Show all " + rows.length}
        </Btn>
      )}
    </>
  );
};

export const OrderExceptionsCard: React.FC<{
  result: ExceptionsResult | null;
  // "server" when GET /api/orders/exceptions answered, "local" when the
  // screen built the list from the order it holds (same builder).
  origin?: "server" | "local";
  onAction: (action: ExceptionAction, row: ExceptionRow) => void;
  // Why an action cannot run now (no permission, a busy screen), or null.
  disabledReason?: (action: ExceptionAction | null) => string | null;
}> = ({ result, origin, onAction, disabledReason = () => null }) => {
  if (!result) return null;
  const rows = result.rows || [];
  const info = result.info || [];
  const decided = result.decided || [];
  const blocking = rows.filter((r) => r.blocks && !r.shadow).length;
  return (
    <div data-testid="order-exceptions" data-origin={origin || "server"}>
      <Card
        title={rows.length ? "Needs decision (" + rows.length + ")" : "Needs decision"}
        eyebrow="one list · quote check, findings, anomaly rules, extraction, terms, customer"
        right={rows.length
          ? <span className="mono-sm">{blocking ? blocking + " blocking" : "0 blocking"}</span>
          : <Chip k="good">clean</Chip>}
      >
        {rows.length === 0
          ? <div className="mono-sm" data-testid="exceptions-clean" style={{ color: "var(--ink-2)" }}>Nothing needs a decision</div>
          : <RowList rows={rows} limit={FIRST_ROWS} onAction={onAction} disabledReason={disabledReason} />}
        {info.length > 0 && (
          <details className="exc-group" style={{ marginTop: 10 }}>
            <summary className="mono-sm" style={{ cursor: "pointer", color: "var(--ink-2)" }}>For information ({info.length})</summary>
            <div style={{ marginTop: 8 }}>
              <RowList rows={info} onAction={onAction} disabledReason={disabledReason} />
            </div>
          </details>
        )}
        {decided.length > 0 && (
          <details className="exc-group" style={{ marginTop: 10 }}>
            <summary className="mono-sm" style={{ cursor: "pointer", color: "var(--ink-2)" }}>Decided ({decided.length})</summary>
            <div style={{ marginTop: 8 }}>
              <RowList rows={decided} onAction={onAction} disabledReason={disabledReason} />
            </div>
          </details>
        )}
      </Card>
    </div>
  );
};

export default OrderExceptionsCard;
