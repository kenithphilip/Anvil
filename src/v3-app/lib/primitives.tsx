// Anvil v3 design-system primitives, ESM port of src/v3/primitives.jsx.
// Every primitive used by a wired screen lives here.

import React, { CSSProperties, ReactNode } from "react";

type Kind = "info" | "warn" | "bad" | "good" | "live" | "ghost" | "plum" | string;

export interface BtnProps {
  children?: ReactNode;
  kind?: Kind;
  sm?: boolean;
  lg?: boolean;
  icon?: boolean;
  full?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  className?: string;
  title?: string;
  "aria-label"?: string;
}

export const Btn: React.FC<BtnProps> = ({
  children, kind, sm, lg, icon, full, onClick, disabled, type = "button", className = "", title, "aria-label": ariaLabel,
}) => {
  const cls = ["btn", kind, sm && "sm", lg && "lg", icon && "icon", full && "full", className].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled} title={title} aria-label={ariaLabel}>
      {children}
    </button>
  );
};

export interface ChipProps { children?: ReactNode; k?: Kind; lg?: boolean; }
export const Chip: React.FC<ChipProps> = ({ children, k, lg }) => (
  <span className={["chip", k, lg && "lg"].filter(Boolean).join(" ")}>{children}</span>
);

export const Dot: React.FC<{ k?: Kind }> = ({ k }) => (
  <span className={["dot", k].filter(Boolean).join(" ")} />
);
export const Sev: React.FC<{ k?: "low" | "med" | "high" | string }> = ({ k = "low" }) => (
  <span className={`sev ${k}`} />
);
export const Prov: React.FC<{ children?: ReactNode }> = ({ children }) => (
  <span className="prov">{children}</span>
);

export interface WSTitleProps { eyebrow?: ReactNode; title?: ReactNode; meta?: ReactNode; right?: ReactNode; }
export const WSTitle: React.FC<WSTitleProps> = ({ eyebrow, title, meta, right }) => (
  <div className="ws-title">
    <div>
      {eyebrow && <div className="h-eyebrow" style={{ marginBottom: 2 }}>{eyebrow}</div>}
      <h1>{title}</h1>
    </div>
    {meta && <span className="h-meta">· {meta}</span>}
    <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>{right}</div>
  </div>
);

export interface WSTab { id: string; label: ReactNode; count?: number; }
export interface WSTabsProps { tabs: WSTab[]; active?: string; onChange?: (id: string) => void; }
export const WSTabs: React.FC<WSTabsProps> = ({ tabs, active, onChange }) => (
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

export interface CardProps {
  title?: ReactNode;
  eyebrow?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
}
export const Card: React.FC<CardProps> = ({ title, eyebrow, right, children, flush, className = "", style }) => (
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

export type KVRow = [ReactNode, ReactNode];
export const KV: React.FC<{ rows: KVRow[] }> = ({ rows }) => (
  <dl className="kv">
    {rows.map(([k, v], i) => (
      <React.Fragment key={i}><dt>{k}</dt><dd>{v}</dd></React.Fragment>
    ))}
  </dl>
);

export interface KPIProps {
  lbl?: ReactNode;
  v?: ReactNode;
  d?: ReactNode;
  dKind?: "up" | "down" | "" | string;
  live?: boolean;
}
export const KPI: React.FC<KPIProps> = ({ lbl, v, d, dKind, live }) => (
  <div className={`kpi ${live ? "live" : ""}`}>
    <div className="lbl">{lbl}</div>
    <div className="v">{v}</div>
    {d && <div className={`d ${dKind || ""}`}>{d}</div>}
  </div>
);

export const KPIRow: React.FC<{ children?: ReactNode; cols?: number }> = ({ children, cols }) => (
  <div
    className="kpi-row"
    style={{ ["--cols" as any]: cols || React.Children.count(children) } as CSSProperties}
  >
    {children}
  </div>
);

export const Steps: React.FC<{ items: string[]; current?: number }> = ({ items, current = 0 }) => (
  <div className="steps">
    {items.map((s, i) => (
      <div key={s} className={`step ${i < current ? "done" : i === current ? "cur" : ""}`}>
        <span className="n">{i < current ? "✓" : i + 1}</span>
        <span>{s}</span>
      </div>
    ))}
  </div>
);

export interface BannerProps {
  kind?: Kind;
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}
export const Banner: React.FC<BannerProps> = ({ kind = "info", icon, title, children, action }) => (
  <div className={`banner ${kind}`}>
    {icon && <span className="ic">{icon}</span>}
    <div style={{ flex: 1 }}>
      {title && <div className="ti">{title}</div>}
      <div>{children}</div>
    </div>
    {action && <div style={{ display: "flex", gap: 8, marginLeft: 8 }}>{action}</div>}
  </div>
);

export interface RailPanelProps { title?: ReactNode; count?: number; children?: ReactNode; action?: ReactNode; }
export const RailPanel: React.FC<RailPanelProps> = ({ title, count, children, action }) => (
  <div className="rail-panel">
    <div className="rail-panel-h">
      <span className="t">{title}</span>
      {count != null && <span className="c">{count}</span>}
      {action && <div style={{ marginLeft: "auto" }}>{action}</div>}
    </div>
    {children}
  </div>
);

export interface StreamRow { t: ReactNode; a?: ReactNode; m?: ReactNode; }
export const Stream: React.FC<{ rows: StreamRow[] }> = ({ rows }) => (
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

export const fmtINR = (n: number): string => "₹ " + n.toLocaleString("en-IN");
export const fmtUSD = (n: number): string => "$ " + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtPct = (n: number): string => (n * 100).toFixed(1) + "%";
