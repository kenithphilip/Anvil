// Shared helpers that every wired screen depends on. Lifted verbatim from
// the top of src/v3/screens-wired/wired-home.jsx where they used to live as
// top-level globals. Now plain ESM exports.
//
// Tests for behavior live in helpers.test.js next to this file.

import { useState, useEffect } from "react";

// useFetch: tiny hook that runs a thunk on mount, exposes
// { data, error, loading, reload }. Avoids pulling in a state library.
export const useFetch = (thunk, deps = []) => {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [bump, setBump] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve()
      .then(() => thunk())
      .then((data) => { if (!cancelled) setState({ data, error: null, loading: false }); })
      .catch((error) => { if (!cancelled) setState({ data: null, error, loading: false }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, bump]);
  return { ...state, reload: () => setBump((n) => n + 1) };
};

// Format a relative age like "14m" / "2h" / "1d 3h"
export const ageLabel = (iso) => {
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
export const fmtINRShort = (n) => {
  if (n == null) return "—";
  if (n >= 10_00_000) return `₹ ${(n / 1_00_000).toFixed(1)} L`;
  if (n >= 1000) return `₹ ${(n / 1000).toFixed(0)}k`;
  return `₹ ${n.toLocaleString("en-IN")}`;
};

// Map order_status enum to a v3 chip { label, k }.
export const stageOf = (status) => {
  const map = {
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
  return map[status] || { label: (status || "draft").toLowerCase(), k: "ghost" };
};

// Severity bucket used to color a row at a glance.
export const sevOf = (order) => {
  const s = order?.status;
  if (s === "BLOCKED" || s === "FAILED_TALLY_IMPORT") return "high";
  if (s === "PENDING_REVIEW" || s === "DUPLICATE") return "med";
  return "low";
};
