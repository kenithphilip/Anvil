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
  style?: CSSProperties;
  "aria-label"?: string;
}

export const Btn: React.FC<BtnProps> = ({
  children, kind, sm, lg, icon, full, onClick, disabled, type = "button", className = "", title, style, "aria-label": ariaLabel,
}) => {
  const cls = ["btn", kind, sm && "sm", lg && "lg", icon && "icon", full && "full", className].filter(Boolean).join(" ");
  // For icon-only buttons (no visible text), fall back to `title` as
  // the accessible name so screen readers announce something
  // meaningful. Without this, a `<Btn icon>{Icon.cycle}</Btn>` was
  // unreadable to assistive tech. Visible-text buttons keep their
  // text as the accessible name and only use `aria-label` if
  // explicitly overridden.
  const accessibleName = ariaLabel ?? (icon ? title : undefined);
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled} title={title} aria-label={accessibleName} style={style}>
      {children}
    </button>
  );
};

export interface ChipProps { children?: ReactNode; k?: Kind; lg?: boolean; }
export const Chip: React.FC<ChipProps> = ({ children, k, lg }) => (
  <span className={["chip", k, lg && "lg"].filter(Boolean).join(" ")}>{children}</span>
);

/*
 * Dot and Sev are color-coded glyphs. Their meaning ("live",
 * "warn", "high severity") is communicated only by colour, which
 * fails WCAG 1.4.1 (Use of Color) for screen-reader and color-
 * blind users. Both now accept an optional `label` that becomes
 * the accessible name; without one, the element is marked
 * `aria-hidden` so assistive tech ignores it (the surrounding
 * text usually carries the meaning).
 */
export const Dot: React.FC<{ k?: Kind; label?: string }> = ({ k, label }) => (
  <span
    className={["dot", k].filter(Boolean).join(" ")}
    role={label ? "img" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
  />
);
export const Sev: React.FC<{ k?: "low" | "med" | "high" | string; label?: string }> = ({ k = "low", label }) => (
  <span
    className={`sev ${k}`}
    role={label ? "img" : undefined}
    aria-label={label || `severity ${k}`}
  />
);
export const Prov: React.FC<{ children?: ReactNode }> = ({ children }) => (
  <span className="prov">{children}</span>
);

export interface WSTitleProps { eyebrow?: ReactNode; title?: ReactNode; meta?: ReactNode; right?: ReactNode; }
/*
 * Title-bar primitive used by every workflow screen.
 * The left block (eyebrow + h1) gets `min-width: 0` so the h1 can
 * ellipsize; the right block (action buttons / search bar / etc.)
 * keeps its natural width with `flex-shrink: 0`. The whole row
 * inherits `flex-wrap: wrap` from `.ws-title` so action bars drop
 * to a second line on narrow viewports instead of pushing the
 * title off-screen (the bug that produced the "NANCE SPARES-REV-1"
 * clipping in SO Workspace).
 */
export const WSTitle: React.FC<WSTitleProps> = ({ eyebrow, title, meta, right }) => (
  <div className="ws-title">
    <div style={{ minWidth: 0, flex: "1 1 auto", overflow: "hidden" }}>
      {eyebrow && <div className="h-eyebrow" style={{ marginBottom: 2 }}>{eyebrow}</div>}
      <h1>{title}</h1>
    </div>
    {meta && <span className="h-meta" style={{ flexShrink: 0 }}>· {meta}</span>}
    <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>{right}</div>
  </div>
);

export interface WSTab { id: string; label: ReactNode; count?: number; }
export interface WSTabsProps { tabs: WSTab[]; active?: string; onChange?: (id: string) => void; }
/*
 * WSTabs implements the WAI-ARIA Authoring Practices "Tabs"
 * pattern: a tablist of buttons with arrow-key navigation, Home /
 * End jumps, and roving tabindex (only the active tab is in the
 * Tab order; arrow keys move within the tablist). The tab strip
 * was previously a row of <div onClick> with no keyboard support
 * at all, so screen-reader and keyboard users could not switch
 * tabs.
 */
export const WSTabs: React.FC<WSTabsProps> = ({ tabs, active, onChange }) => {
  const onKey = (ev: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (!tabs.length) return;
    let next: number | null = null;
    if (ev.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (ev.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = tabs.length - 1;
    if (next == null) return;
    ev.preventDefault();
    onChange?.(tabs[next].id);
    // Focus the now-active tab so the user sees the focus ring move.
    const target = (ev.currentTarget.parentElement?.children?.[next] as HTMLElement | undefined);
    target?.focus?.();
  };
  return (
    <div className="ws-tabs" role="tablist">
      {tabs.map((t, i) => {
        const isActive = active === t.id;
        return (
          <button
            type="button"
            key={t.id}
            role="tab"
            id={`ws-tab-${t.id}`}
            aria-selected={isActive}
            aria-controls={`ws-tabpanel-${t.id}`}
            tabIndex={isActive ? 0 : -1}
            className={`ws-tab ${isActive ? "active" : ""}`}
            onClick={() => onChange?.(t.id)}
            onKeyDown={(ev) => onKey(ev, i)}
          >
            {t.label}
            {t.count != null && <span className="tab-count">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
};

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

/*
 * Keyboard-activatable wrapper for clickable rows / tiles. The
 * v3 list views often use `<tr onClick>` to navigate into a detail
 * view; that pattern is invisible to keyboard and screen-reader
 * users. Spreading the props returned here onto an element
 * (typically a `<tr>`) makes it focusable, gives it a button role,
 * and triggers the click on Enter or Space.
 *
 * Usage:
 *   <tr {...rowActivateProps(() => goTo(o.id))} key={o.id}>...</tr>
 */
export const rowActivateProps = (onActivate: () => void, label?: string) => ({
  role: "button",
  tabIndex: 0,
  "aria-label": label,
  onClick: onActivate,
  onKeyDown: (ev: React.KeyboardEvent<HTMLElement>) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onActivate();
    }
  },
  style: { cursor: "pointer" } as CSSProperties,
});

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
export const Banner: React.FC<BannerProps> = ({ kind = "info", icon, title, children, action }) => {
  // Bad / warn banners get role="alert" so screen readers announce
  // them when they appear. Info / good get role="status" with
  // aria-live="polite" (announced when the user is idle, never
  // interrupting). Without this banners that flash up after a
  // failed fetch are silent for assistive-tech users.
  const isAlert = kind === "bad" || kind === "warn";
  return (
    <div
      className={`banner ${kind}`}
      role={isAlert ? "alert" : "status"}
      aria-live={isAlert ? "assertive" : "polite"}
    >
      {icon && <span className="ic" aria-hidden="true">{icon}</span>}
      <div style={{ flex: 1 }}>
        {title && <div className="ti">{title}</div>}
        <div>{children}</div>
      </div>
      {action && <div style={{ display: "flex", gap: 8, marginLeft: 8 }}>{action}</div>}
    </div>
  );
};

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

// ─────────────────────────────────────────────────────────────────────
// Modal primitive: backdrop + dialog. Bakes in:
//   - role="dialog" + aria-modal="true" so screen readers announce it.
//   - Escape closes (callable from any caller without per-modal wiring).
//   - Click-outside closes.
//   - Initial focus moves into the dialog so keyboard users land inside.
//   - aria-labelledby points at the title element.
//   - Body scroll lock while open so the page underneath does not jump.
//
// Usage:
//   <Modal open={open} onClose={close} title="Edit threshold">
//     <Modal.Body> ... </Modal.Body>
//     <Modal.Footer>
//       <Btn kind="ghost" onClick={close}>Cancel</Btn>
//       <Btn kind="primary" onClick={save}>Save</Btn>
//     </Modal.Footer>
//   </Modal>
//
// Existing screens still use the raw `.modal-backdrop` / `.modal`
// classNames. This primitive emits the same DOM structure so the v3
// stylesheet keeps working unchanged.
// ─────────────────────────────────────────────────────────────────────

import { useEffect, useId, useRef } from "react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  maxWidth?: number | string;
  className?: string;
  ariaLabel?: string;
}

interface ModalSubcomponents {
  Body: React.FC<{ children?: ReactNode; className?: string }>;
  Footer: React.FC<{ children?: ReactNode; className?: string }>;
  Header: React.FC<{ children?: ReactNode; onClose?: () => void }>;
}

const ModalImpl: React.FC<ModalProps> = ({ open, onClose, title, children, maxWidth, className = "", ariaLabel }) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Move focus into the dialog so a keyboard user lands inside.
    const focusTimer = window.setTimeout(() => {
      const node = dialogRef.current;
      if (!node) return;
      const focusable = node.querySelector<HTMLElement>(
        'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
      );
      (focusable || node).focus();
    }, 0);
    // Prevent body scroll while the dialog is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(focusTimer);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`modal ${className}`}
        onClick={(ev) => ev.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? ariaLabel : undefined}
        tabIndex={-1}
        style={maxWidth ? { maxWidth } : undefined}
      >
        {title != null && (
          <div className="modal-h">
            <span className="ti" id={titleId}>{title}</span>
            <button
              type="button"
              className="btn ghost icon sm"
              onClick={onClose}
              aria-label="Close dialog"
              title="Close (Esc)"
            >
              ×
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
};

const ModalBody: React.FC<{ children?: ReactNode; className?: string }> = ({ children, className = "" }) => (
  <div className={`modal-body ${className}`} style={{ display: "grid", gap: 10 }}>{children}</div>
);

const ModalFooter: React.FC<{ children?: ReactNode; className?: string }> = ({ children, className = "" }) => (
  <div className={`modal-f ${className}`}>{children}</div>
);

const ModalHeader: React.FC<{ children?: ReactNode; onClose?: () => void }> = ({ children, onClose }) => (
  <div className="modal-h">
    <span className="ti">{children}</span>
    {onClose && (
      <button type="button" className="btn ghost icon sm" onClick={onClose} aria-label="Close dialog" title="Close (Esc)">
        ×
      </button>
    )}
  </div>
);

export const Modal: React.FC<ModalProps> & ModalSubcomponents = Object.assign(ModalImpl, {
  Body: ModalBody,
  Footer: ModalFooter,
  Header: ModalHeader,
});

// Loading placeholder using the existing `.skel` shimmer (styles.css). Replaces
// bare "Loading…" text so a list feels like it is filling in, not stalling.
// `rows` renders a small stack of bars; `width` sizes a single bar.
export const Skeleton: React.FC<{ rows?: number; width?: number | string; tall?: boolean; style?: CSSProperties }> = ({ rows = 1, width, tall, style }) => {
  if (rows <= 1) {
    return <div className={["skel", tall && "tall"].filter(Boolean).join(" ")} style={{ width, ...style }} aria-hidden="true" />;
  }
  return (
    <div aria-hidden="true" style={style}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel row" style={{ width: i === rows - 1 ? "70%" : "100%" }} />
      ))}
    </div>
  );
};

// Lightweight overflow / kebab menu: a trigger button + a click-outside dropdown
// (mirrors the Shell popover pattern). Used to fold secondary actions or tabs
// behind a single control so the default view shows only the primary ones.
export interface MenuItem { label: ReactNode; onClick?: () => void; disabled?: boolean; active?: boolean; danger?: boolean; }
export const Menu: React.FC<{
  label: ReactNode; items: MenuItem[]; align?: "left" | "right";
  kind?: Kind; sm?: boolean; disabled?: boolean; title?: string;
}> = ({ label, items, align = "right", kind = "ghost", sm, disabled, title }) => {
  const [open, setOpen] = React.useState(false);
  const wrap = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEsc); };
  }, [open]);
  return (
    <div ref={wrap} style={{ position: "relative", display: "inline-block" }}>
      <Btn kind={kind} sm={sm} disabled={disabled} title={title}
           onClick={() => setOpen((o) => !o)} aria-label={typeof label === "string" ? label : title}>
        {label}
      </Btn>
      {open && (
        <div role="menu" style={{
          position: "absolute", top: "calc(100% + 4px)", zIndex: 400, minWidth: 190,
          ...(align === "right" ? { right: 0 } : { left: 0 }),
          background: "var(--paper)", border: "1px solid var(--hairline)", borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)", padding: 4, maxHeight: "70vh", overflowY: "auto",
        }}>
          {items.map((it, i) => (
            <button key={i} type="button" role="menuitem" disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick?.(); }}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "6px 10px", border: "none",
                background: it.active ? "var(--hairline)" : "transparent",
                color: it.danger ? "var(--rust)" : "var(--ink-1)", borderRadius: 6,
                cursor: it.disabled ? "default" : "pointer", fontSize: 13, opacity: it.disabled ? 0.5 : 1,
              }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
