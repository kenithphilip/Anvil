// ============================================================
// ANVIL v3 — wired Cmd+K palette
// Overrides shell.jsx's static demo palette with live backend
// search across orders, customers, items + RBAC-filtered nav jumps
// + per-route action shortcuts.
// ============================================================

const WiredCmdK = ({ open, onClose, onJump }) => {
  const { useState: uS, useEffect: uE, useRef: uR, useMemo: uM } = React;
  const [query, setQuery] = uS("");
  const [active, setActive] = uS(0);
  const [results, setResults] = uS({ orders: [], customers: [], items: [], loading: false });
  const inputRef = uR(null);

  // Focus the input when the palette opens
  uE(() => {
    if (open && inputRef.current) {
      const t = setTimeout(() => inputRef.current.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Reset on close
  uE(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  // Debounced backend search. We skip empty queries (show recent + nav).
  uE(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults({ orders: [], customers: [], items: [], loading: false });
      return;
    }
    let cancel = false;
    setResults((s) => ({ ...s, loading: true }));
    const t = setTimeout(async () => {
      try {
        const [orders, customers] = await Promise.all([
          window.ObaraBackend?.orders?.list?.({ limit: 8 }).catch(() => []) || Promise.resolve([]),
          window.ObaraBackend?.customers?.list?.().catch(() => []) || Promise.resolve([]),
        ]);
        if (cancel) return;
        const oList = Array.isArray(orders) ? orders : (orders?.rows || []);
        const cList = Array.isArray(customers) ? customers : (customers?.rows || []);
        const ql = q.toLowerCase();
        setResults({
          orders: oList.filter((o) =>
            (o.po_number || "").toLowerCase().includes(ql) ||
            (o.quote_number || "").toLowerCase().includes(ql) ||
            (o.customer?.customer_name || "").toLowerCase().includes(ql)
          ).slice(0, 6),
          customers: cList.filter((c) =>
            (c.customer_name || "").toLowerCase().includes(ql) ||
            (c.customer_key || "").toLowerCase().includes(ql) ||
            (c.gstin || "").toLowerCase().includes(ql)
          ).slice(0, 6),
          items: [], // item_master search would need a server-side endpoint
          loading: false,
        });
      } catch (err) {
        if (!cancel) setResults({ orders: [], customers: [], items: [], loading: false });
      }
    }, 180);
    return () => { cancel = true; clearTimeout(t); };
  }, [query, open]);

  // Build a flat list of rows that the user can navigate via arrows
  const groups = uM(() => {
    const q = query.trim();
    const out = [];

    // Search results (only when typing)
    if (q.length >= 2) {
      if (results.orders.length) {
        out.push({
          label: "Orders",
          items: results.orders.map((o) => ({
            ic: window.Icon?.layers,
            t: `${o.po_number || o.quote_number || "draft"} · ${o.customer?.customer_name || ""}`,
            m: o.status || "DRAFT",
            onPick: () => { window.location.hash = `#/so?id=${o.id}`; onJump?.("so"); onClose?.(); },
          })),
        });
      }
      if (results.customers.length) {
        out.push({
          label: "Customers",
          items: results.customers.map((c) => ({
            ic: window.Icon?.users,
            t: `${c.customer_name} · ${c.customer_key}`,
            m: c.gstin || c.state_code || "",
            onPick: () => { window.location.hash = `#/customers?id=${c.id}`; onJump?.("customers"); onClose?.(); },
          })),
        });
      }
      if (results.loading) out.push({ label: "Searching…", items: [] });
      if (!results.loading && !out.length) out.push({ label: "No results", items: [] });
    }

    // Jump to (always show, RBAC-filtered)
    const navTree = window.RBAC && window.NAV ? window.RBAC.filterNav(window.NAV) : (window.NAV || []);
    const jumpItems = [];
    navTree.forEach((g) => {
      g.items.forEach((it) => {
        if (q.length < 2 || it.label.toLowerCase().includes(q.toLowerCase())) {
          jumpItems.push({
            ic: it.icon,
            t: `${g.label} · ${it.label}`,
            m: it.id,
            onPick: () => { onJump?.(it.id); onClose?.(); },
          });
        }
      });
    });
    if (jumpItems.length) out.push({ label: "Jump to", items: jumpItems.slice(0, 12) });

    // Quick actions (only when not searching)
    if (q.length < 2) {
      out.push({
        label: "Actions",
        items: [
          { ic: window.Icon?.plus,    t: "Create Sales Order from PO upload", m: "C O", onPick: () => { onJump?.("intake"); onClose?.(); } },
          { ic: window.Icon?.plus,    t: "Create Lead",                       m: "C L", onPick: () => { onJump?.("leads"); onClose?.(); } },
          { ic: window.Icon?.plus,    t: "Log Service Visit",                 m: "C V", onPick: () => { onJump?.("svc-visits"); onClose?.(); } },
          { ic: window.Icon?.send,    t: "Send missing-doc nudge",            m: "C N", onPick: () => { onJump?.("comms"); onClose?.(); } },
          { ic: window.Icon?.history, t: "Open Audit Log",                    m: "G A", onPick: () => { onJump?.("audit"); onClose?.(); } },
        ].filter((a) => !window.RBAC || window.RBAC.canRead(a.t.toLowerCase().includes("audit") ? "audit" : a.t.toLowerCase().includes("lead") ? "leads" : a.t.toLowerCase().includes("service") ? "svc-visits" : a.t.toLowerCase().includes("comm") ? "comms" : "intake")),
      });
    }

    return out;
  }, [query, results]);

  // Flatten for keyboard nav
  const flat = groups.flatMap((g, gi) => g.items.map((it, ii) => ({ ...it, gi, ii })));

  // Keyboard handling
  uE(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, Math.max(0, flat.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        flat[active]?.onPick?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, flat.length, active]);

  if (!open) return null;

  let row = 0;
  return (
    <div className="cmdk-bg" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          {window.Icon?.search}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            placeholder="Search orders, customers, jump to module, run action…"
            aria-label="Search"
          />
          <kbd style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "2px 5px", border: "1px solid var(--hairline)", borderRadius: 2, color: "var(--ink-3)" }}>esc</kbd>
        </div>
        <div className="cmdk-list">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="cmdk-group">{g.label}</div>
              {g.items.length === 0 && (
                <div className="cmdk-row" style={{ color: "var(--ink-4)", cursor: "default" }}>
                  <span style={{ fontStyle: "italic" }}>—</span>
                </div>
              )}
              {g.items.map((it) => {
                const isActive = row === active;
                const myRow = row++;
                return (
                  <div
                    key={`${g.label}-${myRow}`}
                    className={`cmdk-row ${isActive ? "active" : ""}`}
                    onClick={it.onPick}
                    onMouseEnter={() => setActive(myRow)}
                  >
                    <span className="ic">{it.ic}</span>
                    <span>{it.t}</span>
                    <span className="meta">{it.m}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

window.CmdK = WiredCmdK;
