import React, { useEffect, useRef, useState } from "react";
import { Banner, Btn, Card, KV, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Master Data Graph (Cytoscape)
// Replaces the read-only stub in wired-graph-e.jsx with a real
// interactive Cytoscape view.
// Customer / order / source-po / part / alias / bom nodes colored
// by type, layouts switchable, click-node side drawer.
// ============================================================

// cytoscape + dagre + cytoscape-dagre are bundled deps loaded via dynamic
// import (CSP blocks third-party CDN <script> loads). Code-split into a
// local chunk fetched the first time the graph renders. window.cytoscape /
// window.dagre are still set so the rest of the screen's checks work.
let __cytoPromise: Promise<any> | null = null;
const ensureCytoscape = async () => {
  if (window.cytoscape) return window.cytoscape;
  if (!__cytoPromise) {
    __cytoPromise = Promise.all([
      import("cytoscape"),
      import("dagre"),
      import("cytoscape-dagre"),
    ]).then(([cyMod, dagreMod, cyDagreMod]: any[]) => {
      const cytoscape = cyMod.default || cyMod;
      const dagre = dagreMod.default || dagreMod;
      const cyDagre = cyDagreMod.default || cyDagreMod;
      try { cytoscape.use(cyDagre); } catch (_) { /* already registered */ }
      try { window.cytoscape = cytoscape; window.dagre = dagre; } catch (_) { /* noop */ }
      return cytoscape;
    });
  }
  const cy = await __cytoPromise;
  if (!cy) throw new Error("cytoscape failed to load");
  return cy;
};

const NODE_COLORS = {
  customer: { bg: "#1F4FA0", border: "#112D5E" },
  order:    { bg: "#355E3B", border: "#1F3A24" },
  source_po:{ bg: "#B57810", border: "#6F4805" },
  part:     { bg: "#5C6068", border: "#15171A" },
  alias:    { bg: "#A23A1F", border: "#6E2613" },
  bom:      { bg: "#4A2D5C", border: "#2D1A38" },
};

const layoutFor = (name, hasDagre) => {
  if (name === "dagre" && hasDagre) {
    return { name: "dagre", rankDir: "TB", nodeSep: 50, rankSep: 80, animate: true };
  }
  if (name === "breadthfirst") return { name: "breadthfirst", animate: true };
  if (name === "concentric")   return { name: "concentric", animate: true };
  if (name === "circle")       return { name: "circle", animate: true };
  if (name === "grid")         return { name: "grid", animate: true };
  return { name: "cose", animate: true, padding: 30, nodeRepulsion: 8000 };
};

const WiredGraphCytoscape = () => {
  const { useState: uS, useEffect: uE, useRef: uR } = React;
  const [graph, setGraph] = uS({ data: null, loading: true, error: null });
  const [selected, setSelected] = uS(null);
  const [layout, setLayout] = uS("cose");
  const [customers, setCustomers] = uS([]);
  const [customerId, setCustomerId] = uS("");
  const [cyReady, setCyReady] = uS(false);
  const containerRef = uR(null);
  const cyRef = uR(null);

  // Load customers for the filter dropdown
  uE(() => {
    let cancel = false;
    Promise.resolve(AnvilBackend?.customers?.list?.() || [])
      .then((r) => {
        if (cancel) return;
        const list = Array.isArray(r) ? r : (r?.rows || []);
        setCustomers(list);
      });
    return () => { cancel = true; };
  }, []);

  // Fetch graph data when customerId changes
  uE(() => {
    let cancel = false;
    setGraph({ data: null, loading: true, error: null });
    const params = customerId ? { customerId, depth: 2 } : { depth: 1 };
    Promise.resolve(AnvilBackend?.masterData?.graph?.(params) || { nodes: [], edges: [] })
      .then((data) => {
        if (cancel) return;
        setGraph({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (cancel) return;
        setGraph({ data: null, loading: false, error: err });
      });
    return () => { cancel = true; };
  }, [customerId]);

  // Initialize Cytoscape and render the graph
  uE(() => {
    if (!graph.data || !containerRef.current) return;
    let destroyed = false;
    (async () => {
      try {
        const cy = await ensureCytoscape();
        if (destroyed) return;
        const nodes = (graph.data.nodes || []).map((n) => ({
          data: { id: n.id, label: n.label || n.id, type: n.type, attrs: n.attrs || {} },
        }));
        const edges = (graph.data.edges || []).map((e, i) => ({
          data: { id: "e" + i, source: e.source, target: e.target, kind: e.kind || "rel" },
        }));
        const hasDagre = !!window.cytoscape?.use && !!window.dagre;
        if (cyRef.current) {
          try { cyRef.current.destroy(); } catch (_) {}
          cyRef.current = null;
        }
        cyRef.current = cy({
          container: containerRef.current,
          elements: { nodes, edges },
          style: [
            { selector: "node", style: {
                "background-color": "data(bgColor)",
                "border-color": "data(borderColor)",
                "border-width": 2,
                "label": "data(label)",
                "font-family": "var(--mono, monospace)",
                "font-size": 9,
                "color": "var(--ink, #15171A)",
                "text-wrap": "ellipsis",
                "text-max-width": "120px",
                "text-valign": "bottom",
                "text-margin-y": 4,
                "width": 22,
                "height": 22,
            } },
            { selector: "edge", style: {
                "width": 1.2,
                "line-color": "rgba(92,96,104,0.4)",
                "target-arrow-color": "rgba(92,96,104,0.6)",
                "target-arrow-shape": "triangle",
                "curve-style": "bezier",
                "label": "data(kind)",
                "font-family": "var(--mono, monospace)",
                "font-size": 8,
                "color": "var(--ink-3, #5C6068)",
                "text-rotation": "autorotate",
            } },
            { selector: ":selected", style: {
                "border-color": "var(--accent-2, #6BBA00)",
                "border-width": 4,
            } },
          ],
          layout: layoutFor(layout, hasDagre),
        });
        // Apply colors via per-node bgColor + borderColor data
        cyRef.current.nodes().forEach((n) => {
          const t = n.data("type") || "part";
          const c = NODE_COLORS[t] || NODE_COLORS.part;
          n.data("bgColor", c.bg);
          n.data("borderColor", c.border);
        });
        cyRef.current.style().update();
        cyRef.current.on("tap", "node", (evt) => {
          const node = evt.target;
          setSelected({
            id: node.data("id"),
            type: node.data("type"),
            label: node.data("label"),
            attrs: node.data("attrs") || {},
          });
        });
        cyRef.current.on("tap", (evt) => {
          if (evt.target === cyRef.current) setSelected(null);
        });
        setCyReady(true);
      } catch (e) {
        setGraph((s) => ({ ...s, error: e }));
      }
    })();
    return () => {
      destroyed = true;
      if (cyRef.current) {
        try { cyRef.current.destroy(); } catch (_) {}
        cyRef.current = null;
      }
    };
  }, [graph.data]);

  // Re-run layout when user picks one
  uE(() => {
    if (!cyRef.current) return;
    try {
      cyRef.current.layout(layoutFor(layout, !!window.dagre)).run();
    } catch (_) {}
  }, [layout]);

  const summary = graph.data?.summary || {};
  const nodeCount = graph.data?.nodes?.length || 0;
  const edgeCount = graph.data?.edges?.length || 0;

  return (
    <>
      <WSTitle
        eyebrow="Data · Master data graph"
        title="Master data graph"
        meta={`${nodeCount} nodes · ${edgeCount} edges`}
        right={<>
          <select className="select" value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Filter by customer" style={{ width: 220, height: 28 }}>
            <option value="">All customers</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.customer_key}</option>)}
          </select>
          <select className="select" value={layout} onChange={(e) => setLayout(e.target.value)} aria-label="Layout algorithm" style={{ width: 140, height: 28 }}>
            <option value="cose">Cose</option>
            <option value="breadthfirst">Breadth-first</option>
            <option value="concentric">Concentric</option>
            <option value="circle">Circle</option>
            <option value="grid">Grid</option>
            <option value="dagre">Dagre (hierarchical)</option>
          </select>
          <Btn sm kind="ghost" onClick={() => {
            if (!cyRef.current) return;
            cyRef.current.fit(undefined, 30);
          }}>{Icon.signal} Fit</Btn>
        </>}
      />

      {graph.error && (
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load graph">
            <span className="mono-sm">{String(graph.error.message || graph.error)}</span>
          </Banner>
        </div>
      )}

      <div className="ws-content" style={{ display: "grid", gridTemplateColumns: selected ? "1fr 320px" : "1fr", gap: 14 }}>
        <Card flush style={{ position: "relative", height: "calc(100vh - 200px)", minHeight: 480 }}>
          {graph.loading && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--ink-3)", zIndex: 1 }}>
              <span className="mono-sm">Loading graph…</span>
            </div>
          )}
          {!graph.loading && nodeCount === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--ink-3)", zIndex: 1 }}>
              <div style={{ textAlign: "center" }}>
                <div className="h2">No graph data</div>
                <div className="mono-sm">Pick a customer or seed data first.</div>
              </div>
            </div>
          )}
          <div ref={containerRef}
               className={cyReady ? "" : "dotgrid"}
               style={{ width: "100%", height: "100%" }} />
        </Card>

        {selected && (
          <Card title={selected.label || selected.id} eyebrow={selected.type}
                right={<Btn sm icon kind="ghost" onClick={() => setSelected(null)} aria-label="Close detail">{Icon.x}</Btn>}>
            <KV rows={Object.entries(selected.attrs || {}).map(([k, v]) => [k, String(v == null ? "—" : v)])} />
            <div className="divider" />
            <div className="row" style={{ gap: 6 }}>
              {selected.type === "customer" && <Btn sm onClick={() => window.location.hash = `#/customers?id=${selected.id.replace(/^customer:/, "")}`}>{Icon.arrowR} Open customer</Btn>}
              {selected.type === "order" && <Btn sm onClick={() => window.location.hash = `#/so?id=${selected.id.replace(/^order:/, "")}`}>{Icon.arrowR} Open order</Btn>}
              {selected.type === "part" && <Btn sm onClick={() => window.location.hash = `#/items?part=${encodeURIComponent(selected.id.replace(/^part:/, ""))}`}>{Icon.arrowR} Open item</Btn>}
              {selected.type === "source_po" && <Btn sm onClick={() => window.location.hash = `#/spo?id=${selected.id.replace(/^source_po:/, "")}`}>{Icon.arrowR} Open source PO</Btn>}
            </div>
          </Card>
        )}
      </div>

      {Object.keys(summary).length > 0 && (
        <div className="ws-content" style={{ paddingTop: 0 }}>
          <Card title="Summary" eyebrow="counts by type">
            <KV rows={Object.entries(summary).map(([k, v]) => [k, String(v)])} />
          </Card>
        </div>
      )}
    </>
  );
};


export default WiredGraphCytoscape;
