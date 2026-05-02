// ============================================================
// ANVIL v3 — global Toast queue
// Mirrors the legacy notify family (notifySuccess / notifyWarn /
// notifyError) with a stacking queue and auto-dismiss.
// Mounted by app.jsx; exposes window.notify, .notifySuccess,
// .notifyWarn, .notifyError so any screen can call them.
// ============================================================

(function () {
  if (typeof window === "undefined") return;

  // Internal store: { id, kind, title, body, ttlMs, createdAt }
  const listeners = new Set();
  let toasts = [];
  let nextId = 1;

  const emit = () => listeners.forEach((fn) => fn(toasts.slice()));

  const dismiss = (id) => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  };

  // kind: "good" | "warn" | "bad" | "info" | "live"
  const push = (kind, title, body, opts = {}) => {
    const t = {
      id: nextId++,
      kind: kind || "info",
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

  window.notify        = (title, body, opts) => push("info", title, body, opts);
  window.notifySuccess = (title, body, opts) => push("good", title, body, opts);
  window.notifyWarn    = (title, body, opts) => push("warn", title, body, opts);
  window.notifyError   = (title, body, opts) => push("bad", title, body, opts);
  window.notifyLive    = (title, body, opts) => push("live", title, body, opts);
  window.notifyDismiss = dismiss;
  window.__toastSubscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  window.__toastsCurrent = () => toasts.slice();
})();

const ToastStack = () => {
  const { useState: uS, useEffect: uE } = React;
  const [list, setList] = uS([]);
  uE(() => {
    const off = window.__toastSubscribe?.((next) => setList(next));
    setList(window.__toastsCurrent?.() || []);
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
          {window.Icon?.[t.kind === "bad" ? "alert" : t.kind === "warn" ? "alert" : t.kind === "good" ? "check" : "info"] && (
            <span className="ic">
              {window.Icon[t.kind === "bad" ? "alert" : t.kind === "warn" ? "alert" : t.kind === "good" ? "check" : "info"]}
            </span>
          )}
          <div style={{ flex: 1 }}>
            {t.title && <div className="ti">{t.title}</div>}
            {t.body && <div>{t.body}</div>}
          </div>
          <button
            onClick={() => window.notifyDismiss(t.id)}
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
            {window.Icon?.x}
          </button>
        </div>
      ))}
    </div>
  );
};

window.ToastStack = ToastStack;
