// Demand Story — "Buy Before the Shortage" (moat Bet 1 hero).
//
// Picks one opportunity and tells the causal story the forecast→BOM engine
// computes: the deal → its finished-good line items (× win-probability) → the
// raw materials its BOM explodes into → the draft procurement plans it drove.
// Read-only over /api/inventory/demand_story (which reuses the planner's engine
// so the numbers reconcile with the Planned-PO queue).

import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

const STAGE_CHIP: Record<string, "good" | "info" | "warn" | "bad"> = {
  CLOSE_WON: "good", NEGOTIATION_REVIEW: "warn", FOLLOW_UP: "warn",
  PROPOSAL_PRICE_QUOTE: "info", RFQ: "info",
};
const fmtPct = (p: number) => Math.round((Number(p) || 0) * 100) + "%";

const DemandStoryScreen: React.FC = () => {
  const [opps, setOpps] = useState<any[]>([]);
  const [oppId, setOppId] = useState<string>("");
  const [story, setStory] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(AnvilBackend?.sales?.listOpportunities?.() || { opportunities: [] })
      .then((r: any) => { if (!cancelled) setOpps(r?.opportunities || r?.data || []); })
      .catch(() => { /* the picker just stays empty; not fatal to the screen */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!oppId) { setStory(null); return; }
    let cancelled = false;
    setLoading(true); setError(null); setStory(null);
    Promise.resolve(AnvilBackend?.inventory?.demandStory?.(oppId))
      .then((r: any) => { if (!cancelled) setStory(r); })
      .catch((e: any) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [oppId]);

  const o = story?.opportunity;

  return (
    <div>
      <WSTitle eyebrow="Forecast → BOM" title="Demand Story" />
      <div className="mono-sm" style={{ opacity: 0.7, margin: "-4px 0 10px" }}>
        Buy before the shortage — what a deal in your pipeline will make you order, before the PO even arrives.
      </div>

      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="mono-sm" style={{ opacity: 0.7 }}>Opportunity</span>
          <select
            value={oppId}
            onChange={(e) => setOppId(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 6, minWidth: 320, background: "var(--surface-1)", color: "inherit", border: "1px solid var(--hairline-2)" }}
          >
            <option value="">Select an opportunity…</option>
            {opps.map((x) => (
              <option key={x.id} value={x.id}>{x.opportunity_name || x.id?.slice(0, 8)} — {x.stage}</option>
            ))}
          </select>
        </div>
      </Card>

      {loading && <Banner kind="info">Tracing demand…</Banner>}
      {error && <Banner kind="bad">{String(error?.message || error)}</Banner>}

      {o && (
        <>
          <Card title="The deal">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <strong>{o.opportunity_name || o.id?.slice(0, 8)}</strong>
              <Chip k={STAGE_CHIP[o.stage] || "info"}>{o.stage}</Chip>
              <span className="mono-sm">win probability {fmtPct(o.probability)}</span>
              {typeof o.ai_probability === "number" && (
                <span className="mono-sm" style={{ opacity: 0.6 }}>
                  (operator {o.operator_probability != null ? fmtPct(o.operator_probability) : "—"} · AI {Math.round(o.ai_probability)}%)
                </span>
              )}
            </div>
          </Card>

          <Card title="① This deal drives demand for">
            {(story.finished_goods || []).length === 0
              ? <div className="mono-sm" style={{ opacity: 0.6 }}>No line items with a matched part. Add part numbers on the opportunity's lines.</div>
              : story.finished_goods.map((f: any, i: number) => (
                  <div key={i} className="mono-sm" style={{ padding: "4px 0", borderTop: i ? "1px dashed var(--hairline-2)" : undefined }}>
                    <strong>{f.part_no}</strong> · {f.qty} × p {fmtPct(o.probability)} = {f.expected_qty} expected
                  </div>
                ))}
          </Card>

          <Card title="② Which explodes through the BOM into raw material">
            {(story.raw_materials || []).length === 0
              ? <div className="mono-sm" style={{ opacity: 0.6 }}>No BOM recipe reaches raw material for these parts yet — author the composition / assembly BOM to close the cascade.</div>
              : story.raw_materials.map((r: any, i: number) => (
                  <div key={i} className="mono-sm" style={{ padding: "4px 0", borderTop: i ? "1px dashed var(--hairline-2)" : undefined }}>
                    <strong>{r.part_no}</strong> · {r.expected_qty} expected
                    {Array.isArray(r.via) && r.via.length > 0 && (
                      <div style={{ opacity: 0.65, paddingLeft: 10 }}>via {r.via.join("; ")}</div>
                    )}
                  </div>
                ))}
          </Card>

          <Card title="③ So the planner drafted these preorders">
            {(story.contributing_plans || []).length === 0
              ? <div className="mono-sm" style={{ opacity: 0.6 }}>No draft plans reference this opportunity yet — plans are generated by the weekly planning run.</div>
              : (
                <>
                  {story.contributing_plans.map((p: any, i: number) => (
                    <div key={i} className="mono-sm" style={{ padding: "4px 0", borderTop: i ? "1px dashed var(--hairline-2)" : undefined }}>
                      <strong>{p.part_no}</strong> · qty {p.recommended_qty} · <Chip k={p.status === "released" ? "good" : "info"}>{p.status}</Chip>
                      {p.expected_arrival_date ? ` · ETA ${p.expected_arrival_date}` : ""}
                    </div>
                  ))}
                  <div style={{ marginTop: 10 }}>
                    <Btn sm kind="ghost" onClick={() => { window.location.hash = "#/inventory-plans"; }}>
                      {Icon.cal} open the Planned-PO queue
                    </Btn>
                  </div>
                </>
              )}
          </Card>
        </>
      )}
    </div>
  );
};

export default DemandStoryScreen;
