// Selection context for the Review pane (Phase B).
//
// Lets the right-pane field list and the left-pane bbox overlay
// communicate without prop drilling. Either side can flip the
// `hoveredField` or `selectedField`; the other side renders the
// matching highlight on the next render.
//
// Kept deliberately small (two strings, two setters) so a future
// Phase C per-field confirm/flag state machine can layer on top
// without rewriting the context contract.

import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface ReviewPaneSelection {
  hoveredField: string | null;
  selectedField: string | null;
  setHoveredField: (path: string | null) => void;
  setSelectedField: (path: string | null) => void;
  /**
   * Returns true when this field should render its "active" highlight:
   * either it's the hover target, or it's the click-selected one.
   */
  isActive: (path: string) => boolean;
}

const Ctx = createContext<ReviewPaneSelection>({
  hoveredField: null,
  selectedField: null,
  setHoveredField: () => undefined,
  setSelectedField: () => undefined,
  isActive: () => false,
});

export const ReviewPaneSelectionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [hoveredField, setHoveredField] = useState<string | null>(null);
  const [selectedField, setSelectedField] = useState<string | null>(null);

  const isActive = useCallback(
    (path: string) => path === hoveredField || path === selectedField,
    [hoveredField, selectedField],
  );

  const value = useMemo<ReviewPaneSelection>(() => ({
    hoveredField, selectedField,
    setHoveredField, setSelectedField,
    isActive,
  }), [hoveredField, selectedField, isActive]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useReviewPaneSelection = (): ReviewPaneSelection => useContext(Ctx);
