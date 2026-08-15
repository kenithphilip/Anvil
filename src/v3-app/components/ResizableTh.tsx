// A table header cell the operator can drag wider.
//
// See lib/column-widths.ts for why this exists: auto table layout starves short
// columns like HSN/SAC, and the `<input>` inside a starved cell scrolls its own
// value out of view rather than wrapping.
//
// Pointer events, not mouse events, so a stylus or touch drag works; capture so
// the drag survives the pointer leaving the 5px handle, which at speed it will.

import React, { useCallback, useRef } from "react";

export interface ResizableThProps {
  /** Stable id used as the storage key for this column's width. */
  colId: string;
  width?: { width: number; minWidth: number };
  onResize: (colId: string, startPx: number, deltaPx: number) => void;
  /** Double-click the handle to return this one column to automatic sizing. */
  onAutoFit: (colId: string) => void;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

export const ResizableTh: React.FC<ResizableThProps> = ({
  colId, width, onResize, onAutoFit, className, style, children,
}) => {
  const thRef = useRef<HTMLTableCellElement | null>(null);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // The handle sits inside the header; without this the click also sorts or
    // selects, depending on what the header does.
    e.preventDefault();
    e.stopPropagation();
    const startW = thRef.current?.getBoundingClientRect().width || 0;
    drag.current = { startX: e.clientX, startW };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    onResize(colId, d.startW, e.clientX - d.startX);
  }, [colId, onResize]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  // Keyboard parity: the handle is focusable, so a column can be widened
  // without a pointer at all.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      onResize(colId, thRef.current?.getBoundingClientRect().width || 0, step);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      onResize(colId, thRef.current?.getBoundingClientRect().width || 0, -step);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onAutoFit(colId);
    }
  }, [colId, onResize, onAutoFit]);

  return (
    <th ref={thRef} className={className} style={{ ...style, ...width, position: "relative" }}>
      {children}
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize column. Arrow keys adjust, Enter resets.`}
        tabIndex={0}
        className="col-resize-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); onAutoFit(colId); }}
        onKeyDown={onKeyDown}
      />
    </th>
  );
};
