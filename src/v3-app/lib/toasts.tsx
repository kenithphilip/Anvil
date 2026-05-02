// Global toast queue. ESM port of src/v3/screens-wired/wired-toasts.jsx.
//
// Wired screens still call `window.notifySuccess(...)` and friends, so the
// module attaches `notify*` to `window` for that compatibility surface
// while also exporting them as ESM. The `<ToastStack />` component
// subscribes to the queue and renders the active toasts.

import React, { useEffect, useState } from "react";
import { Icon } from "./icons";

export type ToastKind = "good" | "warn" | "bad" | "info" | "live";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body: string;
  ttlMs: number;
  createdAt: number;
}

export interface ToastOptions { ttlMs?: number; }

type Listener = (next: Toast[]) => void;

const listeners = new Set<Listener>();
let toasts: Toast[] = [];
let nextId = 1;

const emit = (): void => listeners.forEach((fn) => fn(toasts.slice()));

export const dismiss = (id: number): void => {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
};

const push = (kind: ToastKind, title: string, body?: string, opts: ToastOptions = {}): number => {
  const t: Toast = {
    id: nextId++,
    kind,
    title: title || "",
    body: body || "",
    ttlMs: typeof opts.ttlMs === "number" ? opts.ttlMs : (kind === "bad" ? 8000 : 4500),
    createdAt: Date.now(),
  };
  toasts = [...toasts, t];
  emit();
  if (t.ttlMs > 0) setTimeout(() => dismiss(t.id), t.ttlMs);
  return t.id;
};

export const notify        = (title: string, body?: string, opts?: ToastOptions): number => push("info", title, body, opts);
export const notifySuccess = (title: string, body?: string, opts?: ToastOptions): number => push("good", title, body, opts);
export const notifyWarn    = (title: string, body?: string, opts?: ToastOptions): number => push("warn", title, body, opts);
export const notifyError   = (title: string, body?: string, opts?: ToastOptions): number => push("bad", title, body, opts);
export const notifyLive    = (title: string, body?: string, opts?: ToastOptions): number => push("live", title, body, opts);

export const subscribe = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
export const current = (): Toast[] => toasts.slice();

// Compatibility surface so converted wired screens that still call
// `window.notifySuccess(...)` keep working without per-file rewrites.
if (typeof window !== "undefined") {
  window.notify        = notify;
  window.notifySuccess = notifySuccess;
  window.notifyWarn    = notifyWarn;
  window.notifyError   = notifyError;
  window.notifyLive    = notifyLive;
  window.notifyDismiss = dismiss;
  window.__toastSubscribe = subscribe;
  window.__toastsCurrent = current;
}

const iconFor = (kind: ToastKind) => {
  if (kind === "bad" || kind === "warn") return Icon.alert;
  if (kind === "good") return Icon.check;
  return Icon.info;
};

export const ToastStack: React.FC = () => {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    const off = subscribe((next) => setList(next));
    setList(current());
    return off;
  }, []);

  if (!list.length) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 56,
        right: 16,
        zIndex: 200,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 360,
      }}
    >
      {list.map((t) => (
        <div
          key={t.id}
          className={`banner ${t.kind === "good" ? "live" : t.kind === "warn" ? "warn" : t.kind === "bad" ? "bad" : t.kind === "live" ? "live" : "info"}`}
          style={{ minWidth: 280, boxShadow: "var(--shadow-2)", paddingRight: 36, position: "relative", animation: "fadeInRight 0.18s ease" }}
        >
          <span className="ic">{iconFor(t.kind)}</span>
          <div style={{ flex: 1 }}>
            {t.title && <div className="ti">{t.title}</div>}
            {t.body && <div>{t.body}</div>}
          </div>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            style={{
              position: "absolute", top: 6, right: 6,
              border: "none", background: "transparent", color: "inherit",
              cursor: "pointer", width: 24, height: 24,
              display: "grid", placeItems: "center",
              opacity: 0.6,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
          >
            {Icon.x}
          </button>
        </div>
      ))}
    </div>
  );
};
