// Selection + verification context for the Review pane.
//
// Phase B introduced hovered/selected field state so the right-pane
// field list and the left-pane bbox overlay could highlight each
// other without prop drilling.
//
// Phase C layers a per-field verification state machine on top:
//   - status: "pending" | "confirmed" | "flagged" per field path
//   - confirmAll(paths): bulk "mark all correct"
//   - submitCorrection(...): persist an operator correction to
//     /api/docai/correction (records extraction_corrections +
//     learned_corrections + an rlhf_feedback row)
//   - config (extractionRunId, canCorrect) the provider is given once,
//     read by every FieldRow without prop drilling.
//
// Kept on one context so a single <ReviewPaneSelectionProvider> owns
// all per-pane state; two panes never interfere.

import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { AnvilBackend } from "../lib/api";

export type FieldStatus = "pending" | "confirmed" | "flagged";

export interface CorrectionResult { ok: boolean; error?: string }

export interface ReviewPaneSelection {
  hoveredField: string | null;
  selectedField: string | null;
  setHoveredField: (path: string | null) => void;
  setSelectedField: (path: string | null) => void;
  /**
   * Returns true when this field should render its "active" highlight:
   * either it's the hover target, or it's the click-selected one.
   */
  isActive: (path: string) => boolean;

  // Phase C: per-field verification.
  statusOf: (path: string) => FieldStatus;
  setFieldStatus: (path: string, status: FieldStatus) => void;
  confirmAll: (paths: string[]) => void;
  counts: (paths: string[]) => { confirmed: number; flagged: number; pending: number; total: number };

  // Per-pane config + correction submitter.
  canCorrect: boolean;
  extractionRunId: string | null;
  submitCorrection: (args: {
    fieldPath: string;
    originalValue: unknown;
    correctedValue: unknown;
    reason?: string;
  }) => Promise<CorrectionResult>;
}

const noopAsync = async (): Promise<CorrectionResult> => ({ ok: false, error: "no provider" });

const Ctx = createContext<ReviewPaneSelection>({
  hoveredField: null,
  selectedField: null,
  setHoveredField: () => undefined,
  setSelectedField: () => undefined,
  isActive: () => false,
  statusOf: () => "pending",
  setFieldStatus: () => undefined,
  confirmAll: () => undefined,
  counts: () => ({ confirmed: 0, flagged: 0, pending: 0, total: 0 }),
  canCorrect: false,
  extractionRunId: null,
  submitCorrection: noopAsync,
});

export const ReviewPaneSelectionProvider: React.FC<{
  children: React.ReactNode;
  canCorrect?: boolean;
  extractionRunId?: string | null;
}> = ({ children, canCorrect = false, extractionRunId = null }) => {
  const [hoveredField, setHoveredField] = useState<string | null>(null);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, FieldStatus>>({});

  const isActive = useCallback(
    (path: string) => path === hoveredField || path === selectedField,
    [hoveredField, selectedField],
  );

  const statusOf = useCallback(
    (path: string): FieldStatus => statusMap[path] || "pending",
    [statusMap],
  );

  const setFieldStatus = useCallback((path: string, status: FieldStatus) => {
    setStatusMap((m) => ({ ...m, [path]: status }));
  }, []);

  const confirmAll = useCallback((paths: string[]) => {
    setStatusMap((m) => {
      const next = { ...m };
      // Don't clobber a field the operator explicitly flagged; only
      // promote pending fields to confirmed.
      for (const p of paths) if (next[p] !== "flagged") next[p] = "confirmed";
      return next;
    });
  }, []);

  const counts = useCallback((paths: string[]) => {
    let confirmed = 0, flagged = 0, pending = 0;
    for (const p of paths) {
      const s = statusMap[p] || "pending";
      if (s === "confirmed") confirmed++;
      else if (s === "flagged") flagged++;
      else pending++;
    }
    return { confirmed, flagged, pending, total: paths.length };
  }, [statusMap]);

  const submitCorrection = useCallback(async (args: {
    fieldPath: string; originalValue: unknown; correctedValue: unknown; reason?: string;
  }): Promise<CorrectionResult> => {
    if (!extractionRunId) return { ok: false, error: "This order has no extraction run to attach a correction to." };
    try {
      const cfg: any = (AnvilBackend as any)?.getConfig?.() || {};
      const session: any = (AnvilBackend as any)?.getSession?.() || null;
      if (!cfg.url) return { ok: false, error: "Backend URL not configured" };
      const headers: any = { "Content-Type": "application/json" };
      if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
      if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
      const resp = await fetch(cfg.url.replace(/\/+$/, "") + "/api/docai/correction", {
        method: "POST",
        headers,
        body: JSON.stringify({
          extraction_run_id: extractionRunId,
          field_path: args.fieldPath,
          original_value: args.originalValue,
          corrected_value: args.correctedValue,
          reason: args.reason || null,
        }),
      });
      if (resp.ok) return { ok: true };
      const text = await resp.text().catch(() => "");
      // The endpoint requires "approve" permission; surface the 403
      // distinctly so the operator understands why the save was refused.
      if (resp.status === 403) return { ok: false, error: "Saving corrections needs sales_manager / finance / admin." };
      return { ok: false, error: text ? text.slice(0, 200) : ("HTTP " + resp.status) };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }, [extractionRunId]);

  const value = useMemo<ReviewPaneSelection>(() => ({
    hoveredField, selectedField,
    setHoveredField, setSelectedField,
    isActive,
    statusOf, setFieldStatus, confirmAll, counts,
    canCorrect, extractionRunId, submitCorrection,
  }), [hoveredField, selectedField, isActive, statusOf, setFieldStatus, confirmAll, counts, canCorrect, extractionRunId, submitCorrection]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useReviewPaneSelection = (): ReviewPaneSelection => useContext(Ctx);
