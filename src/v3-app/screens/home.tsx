import React, { useEffect, useState } from "react";
import { ageLabel, draftLabel, fmtINRShort, sevOf, stageOf, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, Sev, Stream, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
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




// ─────────────────────────────────────────────────────────────
// HomeEngineer (wired) — replaces the static demo of the same name.
// ─────────────────────────────────────────────────────────────
const WiredHomeEngineer = () => {
  const orders = useFetch(() => AnvilBackend?.orders?.list?.({ limit: 50 }) || Promise.resolve([]), []);
  const audit = useFetch(() => AnvilBackend?.audit?.list?.({ limit: 6 }) || Promise.resolve([]), []);

  const list = Array.isArray(orders.data) ? orders.data : (orders.data?.rows || []);

  const myQueue = list
    .filter((o) => o.status !== "RECONCILED" && o.status !== "CANCELLED")
    .slice(0, 8);

  const drafts = list.filter((o) => o.status === "DRAFT").length;
  const inApproval = list.filter((o) => o.status === "PENDING_REVIEW").length;
  const isPushed = (o: any) => o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED";
  const pushedToday = list.filter((o) => {
    if (!isPushed(o)) return false;
    const t = o.updated_at || o.created_at;
    return t && new Date(t).toDateString() === new Date().toDateString();
  });
  const pushedValueToday = pushedToday.reduce((sum, o) => sum + (Number(o.result?.salesOrder?.grandTotal) || 0), 0);

  // Audit P13.B.1.1. Add the design's 5th KPI (₹ pushed MTD).
  // Same backend payload, different cut so the operator can see
  // monthly volume without leaving the home screen.
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const pushedMtd = list.filter((o) => {
    if (!isPushed(o)) return false;
    const t = o.updated_at || o.created_at;
    return t && new Date(t).getTime() >= monthStart.getTime();
  });
  const pushedValueMtd = pushedMtd.reduce((sum, o) => sum + (Number(o.result?.salesOrder?.grandTotal) || 0), 0);

  const auditRows = (Array.isArray(audit.data) ? audit.data : (audit.data?.rows || [])).slice(0, 6);

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
          <KPI lbl="Pushed today" v={fmtINRShort(pushedValueToday)} d={`${pushedToday.length} SOs`} dKind={pushedToday.length ? "up" : ""} />
          <KPI lbl="Pushed MTD" v={fmtINRShort(pushedValueMtd)} d={`${pushedMtd.length} SOs this month`} dKind={pushedMtd.length ? "up" : ""} />
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
                  m: `<b>${a.action || "event"}</b> · ${a.object_type || ""} ${a.object_id ? a.object_id.slice(0, 8) : ""}`,
                }))} />
              )}
            </Card>

            <Card title="Backend" eyebrow="health">
              <KV rows={[
                ["Tenant", localStorage.getItem("obara:v3_tenant_code") || "TENANT"],
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

// Manager + Admin home: re-use the static demo for now (Phase 3 wires).
// The app.jsx HomeRoute checks role → component, so wiring here just
// shadows the engineer entry. Override window so app.jsx picks us up.


export default WiredHomeEngineer;
