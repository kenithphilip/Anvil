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
// Read a single param off the current hash query string. The list /
// detail screens use this so #/X?id=abc lands the user on the
// detail card without needing a separate route file. Returns null
// when the param is missing or the runtime is server-side.
//
// Pair with `useHashParam` below for the React-state version that
// re-reads on hashchange.
export const readHashParam = (key: string): string | null => {
  if (typeof window === "undefined") return null;
  const q = (window.location.hash || "").split("?")[1];
  if (!q) return null;
  const v = new URLSearchParams(q).get(key);
  return v && v.length ? v : null;
};

export const useHashParam = (key: string): string | null => {
  const [v, setV] = useState<string | null>(readHashParam(key));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHash = () => setV(readHashParam(key));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [key]);
  return v;
};

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

// Order identifier resolution. Replaces the ad-hoc fallback chain
//   o.po_number || o.quote_number || `draft ${o.id.slice(0,8)}`
// that was inlined at ~15 call sites and gave the operator a row of
// "draft 8a3f1b2c" labels with no way to tell one DRAFT from another
// in a list of 50.
//
// Resolution order:
//   1. po_number       buyer's PO/RFQ ref once extracted
//   2. quote_number    our outbound quote ref
//   3. <CUSTOMER>-<DDMMM>-<id4>   e.g. "HYUND-19MAY-8a3f" when a
//      customer is set but no PO# yet (extraction pending, manual
//      intake-in-progress, etc.)
//   4. DRAFT-<DDMMM>-<id4>        e.g. "DRAFT-19MAY-8a3f" when no
//      customer yet either (very early intake state).
//
// The label evolves as the order picks up data: a draft with just an
// id renders DRAFT-..., gains the HYUND-... prefix as soon as the
// customer is set, and flips to the real P250432265 once extraction
// stamps po_number. No server-side persistence; everything is derived
// from columns the orders endpoint already returns.
export interface OrderLabelInput {
  id?: string | null;
  po_number?: string | null;
  quote_number?: string | null;
  created_at?: string | null;
  customer?: { customer_name?: string | null; customer_key?: string | null } | null;
}

const DRAFT_PREFIX_MAX = 5;
const LEGAL_SUFFIX_RX = /\b(Pvt|Ltd|LLP|Inc|Corp|GmbH|KK|AG|BV|SA|Company|Limited|Co)\b\.?/gi;
const MONTH_TAGS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const draftCustomerPrefix = (o: OrderLabelInput): string => {
  // Prefer the tenant-unique customer_key from the customer master --
  // it's already a short stable handle the operator recognises.
  const key = String(o.customer?.customer_key || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (key.length >= 2) return key.slice(0, DRAFT_PREFIX_MAX);
  const name = String(o.customer?.customer_name || "");
  if (!name.trim()) return "DRAFT";
  const cleaned = name.replace(LEGAL_SUFFIX_RX, " ").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (cleaned.length < 2) return "DRAFT";
  return cleaned.slice(0, DRAFT_PREFIX_MAX);
};

const draftDateTag = (iso: string | null | undefined): string => {
  if (!iso) return "NEW";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "NEW";
  return String(d.getDate()).padStart(2, "0") + MONTH_TAGS[d.getMonth()];
};

const draftIdTail = (id: string | null | undefined): string => {
  if (!id) return "";
  return String(id).replace(/-/g, "").slice(0, 4);
};

export const draftLabel = (o: OrderLabelInput | null | undefined): string => {
  if (!o) return "draft";
  if (o.po_number) return String(o.po_number);
  if (o.quote_number) return String(o.quote_number);
  const prefix = draftCustomerPrefix(o);
  const date = draftDateTag(o.created_at);
  const tail = draftIdTail(o.id);
  return [prefix, date, tail].filter(Boolean).join("-");
};
