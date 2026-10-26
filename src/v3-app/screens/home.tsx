import React, { useEffect, useState } from "react";
import { ageLabel, draftLabel, fmtINRShort, sevOf, stageOf, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, Sev, Stream, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { lsGet } from "../lib/storage-keys";
import { Prefs } from "../lib/preferences";

// ============================================================
// ANVIL v3 — wired Home screens
// Replaces the static demo HomeEngineer/HomeManager/HomeAdmin
// with live data via AnvilBackend.* methods.
// ============================================================

// (React hooks imported from 'react')
// ─────────────────────────────────────────────────────────────
// useFetch: tiny hook that runs a thunk on mount, exposes
// { data, error, loading, reload }. Avoids pulling in a state library.
// ─────────────────────────────────────────────────────────────

// Format a relative age like "14m" / "2h" / "1d 3h"




// Statuses an order holds once it has been approved and not withdrawn.
const APPROVED_OR_LATER = new Set(["APPROVED", "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT", "RECONCILED"]);

const grandTotalOf = (o: any): number => Number(o?.result?.salesOrder?.grandTotal) || 0;

// The "done today" and "done this month" KPIs, by the tenant's processing mode.
//
// Mode A: an SO is done when Anvil has pushed it to Tally (unchanged).
// Mode B: Anvil never pushes (the team keys the SO into Tally by hand), so
// "Pushed" always read 0. The SO is done when it is approved: the count is
// orders approved and not since returned or cancelled, by orders.approved_at.
// Read from the orders the screen already lists; no new table.
// mode null (not read yet) shows Mode A, as the SO workspace does.
export const completionKpis = (list: any[], mode: "A" | "B" | null, now: Date = new Date()) => {
  const modeB = mode === "B";
  const isDone = (o: any) => (modeB
    ? APPROVED_OR_LATER.has(o?.status) && !!o?.approved_at
    : o?.status === "EXPORTED_TO_TALLY" || o?.status === "RECONCILED");
  const at = (o: any) => (modeB ? o.approved_at : (o.updated_at || o.created_at));
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const done = (Array.isArray(list) ? list : []).filter((o) => isDone(o) && at(o));
  const today = done.filter((o) => new Date(at(o)).toDateString() === now.toDateString());
  const mtd = done.filter((o) => new Date(at(o)).getTime() >= monthStart.getTime());
  const sum = (rows: any[]) => rows.reduce((s, o) => s + grandTotalOf(o), 0);
  return {
    verb: modeB ? "Approved" : "Pushed",
    today: { count: today.length, value: sum(today) },
    mtd: { count: mtd.length, value: sum(mtd) },
  };
};

// ─────────────────────────────────────────────────────────────
// HomeEngineer (wired) — replaces the static demo of the same name.
// ─────────────────────────────────────────────────────────────
const WiredHomeEngineer = () => {
  const orders = useFetch(() => AnvilBackend?.orders?.list?.({ limit: 50 }) || Promise.resolve([]), []);
  const audit = useFetch(() => AnvilBackend?.audit?.list?.({ limit: 6 }) || Promise.resolve([]), []);
  // The tenant's SO processing mode ("A" Anvil pushes, "B" Tally by hand);
  // null until read, which shows the Mode A labels.
  const [soMode, setSoMode] = useState<"A" | "B" | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve((AnvilBackend as any)?.docai?.soProcessingMode?.())
      .then((r: any) => { if (live) setSoMode(r?.mode === "B" ? "B" : r?.mode === "A" ? "A" : null); })
      .catch(() => { if (live) setSoMode(null); });
    return () => { live = false; };
  }, []);

  // GET /api/orders returns { orders } and GET /api/audit returns
  // { events }. Both lists read `rows`, which neither sends, so the
  // queue and the activity stream were always empty.
  const list = Array.isArray(orders.data) ? orders.data : (orders.data?.orders || []);

  const myQueue = list
    .filter((o) => o.status !== "RECONCILED" && o.status !== "CANCELLED")
    .slice(0, 8);

  const drafts = list.filter((o) => o.status === "DRAFT").length;
  const inApproval = list.filter((o) => o.status === "PENDING_REVIEW").length;
  // Audit P13.B.1.1: the 4th and 5th KPIs (today, and month to date). Same
  // backend payload, cut by the processing mode (completionKpis above).
  const done = completionKpis(list, soMode);

  const auditRows = (Array.isArray(audit.data) ? audit.data : (audit.data?.events || [])).slice(0, 6);

  if (orders.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="loading" title="Good morning." meta="fetching live state" />
        <div className="ws-content"><Card><div className="body">Loading queue…</div></Card></div>
      </div>
    );
  }

  if (orders.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="error" title="Could not load queue" meta="check Backend connection in Admin" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Backend unreachable" action={<Btn sm onClick={orders.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(orders.error.message || orders.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  return (
    <>
      <WSTitle
        eyebrow={new Date().toLocaleString("en-IN", { weekday: "long", hour: "2-digit", minute: "2-digit" })}
        title="Good morning."
        meta={`${list.length} orders in scope · ${myQueue.length} awaiting action`}
        right={<>
          <Btn icon kind="ghost" sm onClick={orders.reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn kind="primary" sm onClick={() => window.location.hash = "#/so?new=1"}>{Icon.plus} New SO</Btn>
        </>}
      />

      <div className="ws-content">
        {myQueue.length > 0 && (
          <Banner kind="live" icon={Icon.bolt}
                  title={`${myQueue.length} order${myQueue.length === 1 ? "" : "s"} in your queue · oldest ${ageLabel(myQueue[0]?.updated_at || myQueue[0]?.created_at)}`}
                  action={<Btn sm kind="live" onClick={() => window.location.hash = "#/so"}>Open queue</Btn>}>
            <span className="mono-sm">First up: {draftLabel(myQueue[0])} · {myQueue[0]?.customer?.customer_name || ""}</span>
          </Banner>
        )}

        <KPIRow cols={5}>
          <KPI lbl="My queue" v={String(myQueue.length)} d={myQueue.length ? `oldest ${ageLabel(myQueue[0]?.updated_at)}` : "all clear"} live={myQueue.length > 0} />
          <KPI lbl="Drafts" v={String(drafts)} d="autosaved locally" />
          <KPI lbl="In approval" v={String(inApproval)} d={inApproval ? "pending review" : "none pending"} />
          <KPI lbl={done.verb + " today"} v={fmtINRShort(done.today.value)} d={`${done.today.count} SOs`} dKind={done.today.count ? "up" : ""} />
          <KPI lbl={done.verb + " MTD"} v={fmtINRShort(done.mtd.value)} d={`${done.mtd.count} SOs this month`} dKind={done.mtd.count ? "up" : ""} />
        </KPIRow>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
          <Card flush>
            <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--hairline-2)" }}>
              <span className="h2">My Queue</span>
              <Chip k="live" lg>{myQueue.length} items</Chip>
              <span style={{ marginLeft: "auto" }} className="mono-sm">live · {new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            {myQueue.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                Nothing in your queue. <button type="button" onClick={() => window.location.hash = "#/so?new=1"} className="link-btn" style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>Create a new SO</button>
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th style={{ width: 22 }}></th>
                  <th>Reference</th>
                  <th>Customer</th>
                  <th>Stage</th>
                  <th className="r">Value</th>
                  <th className="r">Age</th>
                  <th style={{ width: 80 }}></th>
                </tr></thead>
                <tbody>
                  {myQueue.map((o, i) => {
                    const st = stageOf(o.status);
                    const value = Number(o.result?.salesOrder?.grandTotal) || 0;
                    return (
                      <tr key={o.id || i}>
                        <td><Sev k={sevOf(o)} /></td>
                        <td className="mono"><span className="pri">{draftLabel(o)}</span></td>
                        <td>{o.customer?.customer_name || o.customer_id?.slice(0, 8) || "—"}</td>
                        <td><Chip k={st.k}>{st.label}</Chip></td>
                        <td className="r mono">{value ? fmtINRShort(value) : "—"}</td>
                        <td className="r mono">{ageLabel(o.updated_at || o.created_at)}</td>
                        <td><Btn sm onClick={() => window.location.hash = `#/so?id=${o.id}`}>open {Icon.arrowR}</Btn></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {RBAC?.canRead?.("email-actions") && <MyEmailActions />}
            <Card title="Live activity" eyebrow="last events"
                  right={<Btn sm kind="ghost" onClick={() => window.location.hash = "#/audit"}>{Icon.history} log</Btn>}>
              {audit.loading ? (
                <div className="body">Loading…</div>
              ) : auditRows.length === 0 ? (
                <div className="mono-sm" style={{ color: "var(--ink-4)" }}>No recent activity.</div>
              ) : (
                <Stream rows={auditRows.map((a) => ({
                  t: new Date(a.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
                  a: (a.action || "evt").toUpperCase().slice(0, 5),
                  // Stream renders text, not HTML, so no markup here.
                  m: `${a.action || "event"} · ${a.object_type || ""} ${a.object_id ? a.object_id.slice(0, 8) : ""}`,
                }))} />
              )}
            </Card>

            <Card title="Backend" eyebrow="health">
              <KV rows={[
                ["Tenant", lsGet("v3_tenant_code") || "TENANT"],
                ["Role", (RBAC?.role() || "—").replace(/_/g, " ")],
                ["Session", AnvilBackend?.isReady?.() ? "live" : "anonymous"],
                ["Theme", Prefs?.theme() || "—"],
              ]} />
            </Card>
          </div>
        </div>
      </div>
    </>
  );
};

// My open email actions, beside My Queue (docs/EMAIL_ACCOUNTABILITY_SCOPE.md
// 6.10). Writers only, the same gate as the Email Actions screen.
const MyEmailActions: React.FC = () => {
  const resp = useFetch(() => AnvilBackend?.emailActions?.list?.({ scope: "mine" }) || Promise.resolve({ actions: [] }), []);
  const rows: any[] = (resp.data as any)?.actions || [];
  const overdue = rows.filter((a) => a.overdue).length;
  return (
    <Card title="My email actions" eyebrow={rows.length + " open" + (overdue ? " · " + overdue + " overdue" : "")}
          right={<Btn sm kind="ghost" onClick={() => window.location.hash = "#/email-actions?sub=mine"}>all {Icon.arrowR}</Btn>}>
      {resp.loading ? <div className="body">Loading…</div>
        : rows.length === 0 ? <div className="mono-sm" style={{ color: "var(--ink-4)" }}>No email action waits for you.</div>
        : (
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {rows.slice(0, 5).map((a) => (
              <li key={a.id}>
                <button type="button" className="link-btn" onClick={() => window.location.hash = "#/email-actions?sub=mine&id=" + a.id}>
                  {a.title}
                </button>{" "}
                <Chip k={a.overdue ? "bad" : a.priority_label === "critical" ? "bad" : a.priority_label === "high" ? "warn" : "info"}>
                  {a.overdue ? "overdue" : a.priority_label}
                </Chip>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
};

// Manager + Admin home: re-use the static demo for now (Phase 3 wires).
// The app.jsx HomeRoute checks role → component, so wiring here just
// shadows the engineer entry. Override window so app.jsx picks us up.


export default WiredHomeEngineer;
