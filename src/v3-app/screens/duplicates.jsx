import React, { useEffect, useState } from "react";
import { useFetch } from "../lib/helpers.js";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";
import { ObaraBackend } from "../lib/api.js";

// ============================================================
// ANVIL v3 — wired Duplicates
// Wave E · KPI row + candidates table with mark/dismiss actions
// ============================================================

const dupRowsOf = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp.candidates)) return resp.candidates;
  if (Array.isArray(resp.results)) return resp.results;
  if (Array.isArray(resp.rows)) return resp.rows;
  if (Array.isArray(resp.duplicates)) return resp.duplicates;
  return [];
};

const WiredDuplicates = () => {
  const list = useFetch(
    () => ObaraBackend?.duplicates?.search?.({ minScore: 0.7 }) || Promise.resolve({ candidates: [] }),
    []
  );

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Duplicates" title="Duplicate detection" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading candidates…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Duplicates" title="Duplicate detection" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load duplicates"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const rows = dupRowsOf(list.data);
  const candidates = rows.length;
  const confirmed = rows.filter((r) => (r.status || "").toLowerCase() === "confirmed" || r.confirmed === true).length;
  const dismissed = rows.filter((r) => (r.status || "").toLowerCase() === "dismissed" || r.dismissed === true).length;

  return (
    <>
      <WSTitle
        eyebrow="Quality · Duplicates"
        title="Duplicate detection"
        meta={`${candidates} candidates · min score 0.70`}
        right={<>
          <Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={3}>
          <KPI lbl="Candidates" v={String(candidates)} d="awaiting review" live={candidates > 0} />
          <KPI lbl="Confirmed" v={String(confirmed)} d="marked as duplicate" />
          <KPI lbl="Dismissed" v={String(dismissed)} d="not duplicates" />
        </KPIRow>

        <Card flush>
          {rows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No duplicate candidates · all clear.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Order A</th>
                <th>Order B</th>
                <th className="r">Score</th>
                <th>Fields matched</th>
                <th>Status</th>
                <th style={{ width: 220 }}></th>
              </tr></thead>
              <tbody>
                {rows.slice(0, 200).map((r, i) => {
                  const score = Number(r.similarity || r.score || 0);
                  const fields = Array.isArray(r.fields_matched) ? r.fields_matched.join(", ") : (r.fields_matched || r.matched_fields || "—");
                  const status = (r.status || "open").toLowerCase();
                  return (
                    <tr key={r.id || i}>
                      <td className="mono"><span className="pri">{r.order_a_ref || r.a_ref || r.left_ref || (r.order_a_id ? r.order_a_id.slice(0, 8) : "—")}</span></td>
                      <td className="mono">{r.order_b_ref || r.b_ref || r.right_ref || (r.order_b_id ? r.order_b_id.slice(0, 8) : "—")}</td>
                      <td className="r mono" style={{ color: score >= 0.9 ? "var(--rust)" : score >= 0.8 ? "var(--amber-2)" : "var(--ink)" }}>
                        {(score * 100).toFixed(0)}%
                      </td>
                      <td className="mono-sm">{fields}</td>
                      <td><Chip k={status === "confirmed" ? "bad" : status === "dismissed" ? "ghost" : "warn"}>{status}</Chip></td>
                      <td>
                        {status !== "confirmed" && status !== "dismissed" && (
                          <div style={{ display: "flex", gap: 6 }}>
                            <Btn sm kind="primary">mark dup</Btn>
                            <Btn sm kind="ghost">dismiss</Btn>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
};


export default WiredDuplicates;
