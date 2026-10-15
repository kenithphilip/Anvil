import React from "react";
import { Btn } from "../lib/primitives";
import { Icon } from "../lib/icons";

// ============================================================
// ANVIL v3: the SO workspace's "More" menu (plan PR 12)
// The header held sixteen controls (audit F9). The secondary ones (quote PDF,
// Download SO, Excel, ERP voucher, new invoice, share link, audit pack, email
// customer) move here, each with its old handler, so the header keeps the
// controls that move the order forward.
// ============================================================

export type MoreMenuItem = {
  id: string;
  label: string;
  title?: string;
  icon?: React.ReactNode;
  onSelect: () => void;
};

export const SOWorkspaceMoreMenu: React.FC<{ items: MoreMenuItem[] }> = ({ items }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!items.length) return null;
  return (
    <div ref={ref} style={{ position: "relative" }} data-testid="so-more-menu">
      <Btn sm kind="ghost" onClick={() => setOpen((v) => !v)} title="Documents, exports and sharing for this order" aria-label="More actions">
        More {Icon.caret}
      </Btn>
      {open && (
        <div role="menu" aria-label="More actions" style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 220,
          background: "var(--paper)", border: "1px solid var(--hairline)", borderRadius: 6,
          boxShadow: "var(--shadow-2)", zIndex: 50, padding: 6, display: "flex", flexDirection: "column", gap: 2,
        }}>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              className="btn ghost sm full"
              title={it.title}
              style={{ justifyContent: "flex-start" }}
              onClick={() => { setOpen(false); it.onSelect(); }}
            >
              {it.icon} {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default SOWorkspaceMoreMenu;
