// Shared helpers that every wired screen depends on. Lifted from the top
// of src/v3/screens-wired/wired-home.jsx where they used to live as
// top-level globals. Now plain ESM exports with explicit types.

import { useState, useEffect } from "react";

export interface FetchState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

export interface UseFetchResult<T> extends FetchState<T> {
  reload: () => void;
}

// useFetch: tiny hook that runs a thunk on mount, exposes
// { data, error, loading, reload }. Avoids pulling in a state library.
export const useFetch = <T = unknown>(thunk: () => Promise<T> | T, deps: ReadonlyArray<unknown> = []): UseFetchResult<T> => {
  const [state, setState] = useState<FetchState<T>>({ data: null, error: null, loading: true });
  const [bump, setBump] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve()
      .then(() => thunk())
      .then((data) => { if (!cancelled) setState({ data: data as T, error: null, loading: false }); })
      .catch((error: Error) => { if (!cancelled) setState({ data: null, error, loading: false }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, bump]);
  return { ...state, reload: () => setBump((n) => n + 1) };
};

// Format a relative age like "14m" / "2h" / "1d 3h"
export const ageLabel = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remH = hrs - days * 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
};

// INR short-format: lakhs above 10L, thousands above 1k.
export const fmtINRShort = (n: number | null | undefined): string => {
  if (n == null) return "—";
  if (n >= 10_00_000) return `₹ ${(n / 1_00_000).toFixed(1)} L`;
  if (n >= 1000) return `₹ ${(n / 1000).toFixed(0)}k`;
  return `₹ ${n.toLocaleString("en-IN")}`;
};

/*
 * Canonical currency + date formatters. Screens were previously
 * using `Intl.NumberFormat` inline, raw ISO strings, custom
 * helpers like `spoFmtDate`, etc. Standardising here keeps the
 * presentation consistent and makes locale changes a one-file
 * edit.
 */
export const fmtCurrency = (
  n: number | null | undefined,
  currency: string = "INR",
  opts: { compact?: boolean } = {},
): string => {
  if (n == null || Number.isNaN(Number(n))) return "—";
  if (opts.compact && currency === "INR") return fmtINRShort(Number(n));
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(n));
  } catch (_) {
    return `${currency} ${Number(n).toLocaleString()}`;
  }
};

// fmtDate: stable, locale-aware. Use "short" for table cells,
// "medium" for detail headers, "iso" if you really need YYYY-MM-DD.
export const fmtDate = (
  iso: string | Date | null | undefined,
  format: "short" | "medium" | "iso" = "short",
): string => {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  if (format === "iso") return d.toISOString().slice(0, 10);
  if (format === "medium") {
    return d.toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
  }
  return d.toLocaleDateString("en-IN", { month: "short", day: "2-digit", year: "2-digit" });
};

export interface StageChip { label: string; k: "info" | "warn" | "good" | "bad" | "ghost" | string; }

// Map order_status enum to a v3 chip { label, k }.
export const stageOf = (status: string | null | undefined): StageChip => {
  const map: Record<string, StageChip> = {
    DRAFT: { label: "intake", k: "info" },
    PENDING_REVIEW: { label: "validate", k: "warn" },
    APPROVED: { label: "approval", k: "good" },
    BLOCKED: { label: "blocked", k: "bad" },
    DUPLICATE: { label: "duplicate", k: "warn" },
    REUSED: { label: "reused", k: "info" },
    EXPORTED_TO_TALLY: { label: "tally", k: "info" },
    FAILED_TALLY_IMPORT: { label: "tally fail", k: "bad" },
    RECONCILED: { label: "shipped", k: "good" },
    CANCELLED: { label: "cancelled", k: "ghost" },
  };
  return map[status as string] || { label: (status || "draft").toLowerCase(), k: "ghost" };
};

// Severity bucket used to color a row at a glance.
export const sevOf = (order: { status?: string } | null | undefined): "high" | "med" | "low" => {
  const s = order?.status;
  if (s === "BLOCKED" || s === "FAILED_TALLY_IMPORT") return "high";
  if (s === "PENDING_REVIEW" || s === "DUPLICATE") return "med";
  return "low";
};
