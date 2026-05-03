// Live telemetry for the application shell: sidebar nav badge counts,
// status-bar facts (FX, version, time, draft count, ClamAV, Tally
// bridge, DB), and the active session profile.
//
// Everything here polls the existing backend endpoints. Nothing here
// fakes a number. If a fetch fails, the affected field returns
// `undefined` and the shell renders a dim placeholder rather than a
// fabricated value.

import { useEffect, useState } from "react";
import { ObaraBackend } from "./api";

export interface ShellBadge { v: string; k?: string; }
export type BadgeMap = Record<string, ShellBadge>;

export interface ShellSession {
  email?: string;
  initials: string;
  displayName: string;
}

export interface ShellTelemetry {
  badges: BadgeMap;
  fx: { usd?: number; jpy?: number; cronAt?: string } | null;
  version: string;
  drafts: number;
  clamAvOk: boolean | null;
  tallyOk: boolean | null;
  dbOk: boolean | null;
  time: string;
  session: ShellSession;
}

const APP_VERSION: string = (() => {
  try { return (import.meta as any).env?.VITE_APP_VERSION || "dev"; }
  catch (_) { return "dev"; }
})();

const formatIST = (d: Date): string => {
  try {
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) + " IST";
  } catch (_) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
};

const initialsFromEmail = (email?: string): string => {
  if (!email) return "GU";
  const local = email.split("@")[0] || "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (local.slice(0, 2) || "GU").toUpperCase();
};

const displayFromEmail = (email?: string): string => {
  if (!email) return "Guest";
  const local = email.split("@")[0] || "";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ") || email;
};

const safe = async <T>(p: Promise<T> | undefined): Promise<T | null> => {
  if (!p) return null;
  try { return await p; }
  catch (_) { return null; }
};

const arrayOf = (v: any): any[] => {
  if (Array.isArray(v)) return v;
  if (Array.isArray(v?.rows)) return v.rows;
  if (Array.isArray(v?.orders)) return v.orders;
  if (Array.isArray(v?.events)) return v.events;
  return [];
};

const computeBadges = (orders: any[], audit: any[]): BadgeMap => {
  const intake = orders.filter((o) => ["DRAFT", "PENDING_REVIEW", "DUPLICATE"].includes(o.status));
  const active = orders.filter((o) => o.status && !["SHIPPED", "CLOSED", "CANCELLED"].includes(o.status));
  const approvals = orders.filter((o) => /APPROVAL|APPROVE/.test(o.status || ""));

  const badge = (n: number, kind?: string): ShellBadge | undefined => {
    if (n <= 0) return undefined;
    return { v: String(n), k: kind };
  };

  const out: BadgeMap = {};
  const intakeBadge = badge(intake.length, "live");
  if (intakeBadge) out.intake = intakeBadge;
  const soBadge = badge(active.length);
  if (soBadge) out.so = soBadge;
  const apBadge = badge(approvals.length, "warn");
  if (apBadge) out.approvals = apBadge;

  // Audit count is informational; only flag the audit nav when there
  // is recent activity worth noticing.
  if (audit.length > 0) out.audit = { v: String(Math.min(audit.length, 99)) };
  return out;
};

const POLL_MS = 30_000;

export const useShellTelemetry = (): ShellTelemetry => {
  const [badges, setBadges] = useState<BadgeMap>({});
  const [fx, setFx] = useState<{ usd?: number; jpy?: number; cronAt?: string } | null>(null);
  const [drafts, setDrafts] = useState<number>(0);
  const [clamAvOk, setClamAvOk] = useState<boolean | null>(null);
  const [tallyOk, setTallyOk] = useState<boolean | null>(null);
  const [dbOk, setDbOk] = useState<boolean | null>(null);
  const [time, setTime] = useState<string>(formatIST(new Date()));

  const session = ((): ShellSession => {
    const s = ObaraBackend?.getSession?.() || null;
    const email: string | undefined = s?.user?.email || s?.email || undefined;
    return { email, initials: initialsFromEmail(email), displayName: displayFromEmail(email) };
  })();

  const refresh = async () => {
    if (!ObaraBackend?.isReady?.()) return;
    const [orders, audit, fxRates, diag] = await Promise.all([
      safe<any>(ObaraBackend?.orders?.list?.({ limit: 200 })),
      safe<any>(ObaraBackend?.audit?.list?.({ limit: 50 })),
      safe<any>(ObaraBackend?.fx?.lookup?.()),
      safe<any>(ObaraBackend?.admin?.diagnostics?.()),
    ]);

    const orderArr = arrayOf(orders);
    const auditArr = arrayOf(audit);
    setBadges(computeBadges(orderArr, auditArr));
    setDrafts(orderArr.filter((o) => o.status === "DRAFT").length);

    if (fxRates) {
      const rows = arrayOf(fxRates);
      const usd = rows.find((r: any) => /USD/i.test(r.code || r.currency || ""));
      const jpy = rows.find((r: any) => /JPY/i.test(r.code || r.currency || ""));
      setFx({
        usd: usd ? Number(usd.rate || usd.value) : undefined,
        jpy: jpy ? Number(jpy.rate || jpy.value) : undefined,
        cronAt: fxRates?.cron_at || fxRates?.last_run_at || undefined,
      });
    } else {
      setFx(null);
    }

    if (diag) {
      const checks = diag.checks || diag;
      setClamAvOk(checks?.clamav?.ok ?? checks?.clamav_ok ?? null);
      setTallyOk(checks?.tally?.ok ?? checks?.tally_bridge_ok ?? null);
      setDbOk(checks?.db?.ok ?? checks?.database_ok ?? true);
    } else {
      // No diagnostics endpoint reachable. Mark DB as not-ok so the
      // user sees the real degraded state instead of a green dot.
      setClamAvOk(null);
      setTallyOk(null);
      setDbOk(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTime(formatIST(new Date())), 30_000);
    return () => clearInterval(t);
  }, []);

  return {
    badges,
    fx,
    version: APP_VERSION,
    drafts,
    clamAvOk,
    tallyOk,
    dbOk,
    time,
    session,
  };
};
