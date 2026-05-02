// Anvil v3 design-system primitives, ESM port of src/v3/primitives.jsx.
// Every primitive used by a wired screen lives here so screens can `import
// { Btn, Card, ... } from "@v3-lib/primitives"` instead of relying on the
// legacy globals.

import React from "react";

export const Btn = ({ children, kind, sm, lg, icon, full, onClick, disabled, type = "button", className = "", title, "aria-label": ariaLabel }) => {
  const cls = ["btn", kind, sm && "sm", lg && "lg", icon && "icon", full && "full", className].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled} title={title} aria-label={ariaLabel}>
      {children}
    </button>
  );
};

export const Chip = ({ children, k, lg }) => (
  <span className={["chip", k, lg && "lg"].filter(Boolean).join(" ")}>{children}</span>
);

export const Dot = ({ k }) => <span className={["dot", k].filter(Boolean).join(" ")} />;
export const Sev = ({ k = "low" }) => <span className={`sev ${k}`} />;
export const Prov = ({ children }) => <span className="prov">{children}</span>;

export const WSTitle = ({ eyebrow, title, meta, right }) => (
  <div className="ws-title">
    <div>
      {eyebrow && <div className="h-eyebrow" style={{ marginBottom: 2 }}>{eyebrow}</div>}
      <h1>{title}</h1>
    </div>
    {meta && <span className="h-meta">· {meta}</span>}
    <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>{right}</div>
  </div>
);

export const WSTabs = ({ tabs, active, onChange }) => (
  <div className="ws-tabs">
    {tabs.map((t) => (
      <div
        key={t.id}
        className={`ws-tab ${active === t.id ? "active" : ""}`}
        onClick={() => onChange?.(t.id)}
      >
        {t.label}
        {t.count != null && <span className="tab-count">{t.count}</span>}
      </div>
    ))}
  </div>
);

export const Card = ({ title, eyebrow, right, children, flush, className = "", style }) => (
  <div className={`card ${flush ? "flush" : ""} ${className}`} style={style}>
    {(title || eyebrow || right) && (
      <div className="card-h">
        {eyebrow && <span className="eb">{eyebrow}</span>}
        {title && <span className="t">{title}</span>}
        {right && <div className="right">{right}</div>}
      </div>
    )}
    {children}
  </div>
);

export const KV = ({ rows }) => (
  <dl className="kv">
    {rows.map(([k, v]) => (
      <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>
    ))}
  </dl>
);

export const KPI = ({ lbl, v, d, dKind, live }) => (
  <div className={`kpi ${live ? "live" : ""}`}>
    <div className="lbl">{lbl}</div>
    <div className="v">{v}</div>
    {d && <div className={`d ${dKind || ""}`}>{d}</div>}
  </div>
);

export const KPIRow = ({ children, cols }) => (
  <div className="kpi-row" style={{ "--cols": cols || React.Children.count(children) }}>{children}</div>
);

export const Steps = ({ items, current = 0 }) => (
  <div className="steps">
    {items.map((s, i) => (
      <div key={s} className={`step ${i < current ? "done" : i === current ? "cur" : ""}`}>
        <span className="n">{i < current ? "✓" : i + 1}</span>
        <span>{s}</span>
      </div>
    ))}
  </div>
);

export const Banner = ({ kind = "info", icon, title, children, action }) => (
  <div className={`banner ${kind}`}>
    {icon && <span className="ic">{icon}</span>}
    <div style={{ flex: 1 }}>
      {title && <div className="ti">{title}</div>}
      <div>{children}</div>
    </div>
    {action && <div style={{ display: "flex", gap: 8, marginLeft: 8 }}>{action}</div>}
  </div>
);

export const RailPanel = ({ title, count, children, action }) => (
  <div className="rail-panel">
    <div className="rail-panel-h">
      <span className="t">{title}</span>
      {count != null && <span className="c">{count}</span>}
      {action && <div style={{ marginLeft: "auto" }}>{action}</div>}
    </div>
    {children}
  </div>
);

// Activity stream row. The legacy primitive accepted an HTML string in `m`
// and used dangerouslySetInnerHTML. The ESM port takes a ReactNode instead
// so callers cannot accidentally inject untrusted HTML. Where the legacy
// code passed a formatted HTML string, the call site now passes equivalent
// JSX (e.g. <span>{a} <strong>{b}</strong></span>).
export const Stream = ({ rows }) => (
  <div className="stream">
    {rows.map((r, i) => (
      <div key={i} className="stream-row">
        <span className="t">{r.t}</span>
        <span className="a">{r.a || "—"}</span>
        <span className="m">{r.m}</span>
      </div>
    ))}
  </div>
);

// Long-form formatters not covered by lib/helpers.js
export const fmtINR = (n) => "₹ " + n.toLocaleString("en-IN");
export const fmtUSD = (n) => "$ " + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtPct = (n) => (n * 100).toFixed(1) + "%";
