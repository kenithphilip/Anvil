// Operator-resizable table columns.
//
// The reconciliation grid is `width:100%` with auto table layout, and every
// editable cell is an `<input>` at `width:100%; min-width:0`. Auto layout hands
// width to whichever column has the longest content, so a short column loses —
// HSN/SAC gets squeezed to a couple of characters, and an `<input>` under
// pressure does not wrap or ellipsize, it just scrolls its own value out of
// sight. The digits are there; the column is too narrow to show them.
//
// Widths are per operator and per table, kept in localStorage: someone who
// works HSN codes all day should not re-drag the same column every morning.
// Nothing here throws if storage is unavailable (private windows, embedded
// webviews) — a failed read or write degrades to the default layout.

/** Narrower than this and the header label itself is unreadable. */
export const MIN_COL_PX = 44;
/** Wide enough for a long description; beyond this the row scrolls off-screen. */
export const MAX_COL_PX = 900;

export type ColumnWidths = Record<string, number>;

export const clampWidth = (px: number): number => {
  if (!Number.isFinite(px)) return MIN_COL_PX;
  return Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, Math.round(px)));
};

/** Apply a drag delta to a column's starting width. */
export const resizeColumn = (widths: ColumnWidths, id: string, startPx: number, deltaPx: number): ColumnWidths => {
  if (!id) return widths;
  const next = clampWidth((Number(startPx) || 0) + (Number(deltaPx) || 0));
  return { ...widths, [id]: next };
};

/** Drop one column back to automatic sizing. */
export const clearColumn = (widths: ColumnWidths, id: string): ColumnWidths => {
  if (!(id in widths)) return widths;
  const next = { ...widths };
  delete next[id];
  return next;
};

/**
 * Keep only entries this table actually renders, and only sane numbers.
 *
 * Stored widths outlive the code that made them: a column removed in a later
 * release would otherwise sit in localStorage forever, and a hand-edited or
 * corrupted value would reach `style.width` verbatim.
 */
export const sanitiseWidths = (raw: unknown, columnIds: readonly string[]): ColumnWidths => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const known = new Set(columnIds);
  const out: ColumnWidths = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(k)) continue;
    // typeof, not Number(): Number(null), Number("") and Number([]) are all 0 —
    // finite, so a coercion check would let a null width through and clamp it
    // into a real 44px column the operator never asked for. JSON.parse yields
    // real numbers for real numbers, so nothing legitimate is rejected here.
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out[k] = clampWidth(v);
  }
  return out;
};

const KEY_PREFIX = "anvil.colw.";

export const loadWidths = (tableKey: string, columnIds: readonly string[]): ColumnWidths => {
  try {
    const raw = globalThis.localStorage?.getItem(KEY_PREFIX + tableKey);
    if (!raw) return {};
    return sanitiseWidths(JSON.parse(raw), columnIds);
  } catch {
    // Unreadable or unparseable — fall back to the default layout rather than
    // taking the table down over a preference.
    return {};
  }
};

export const saveWidths = (tableKey: string, widths: ColumnWidths): void => {
  try {
    if (!widths || Object.keys(widths).length === 0) {
      globalThis.localStorage?.removeItem(KEY_PREFIX + tableKey);
      return;
    }
    globalThis.localStorage?.setItem(KEY_PREFIX + tableKey, JSON.stringify(widths));
  } catch {
    /* preference only; never surface a quota or private-mode failure */
  }
};

/**
 * `table-layout: fixed` only once a width has been set.
 *
 * Fixed layout is what makes an explicit width authoritative, but it also
 * freezes every UNSET column to an equal share — so switching it on
 * unconditionally would change the default appearance of a table nobody has
 * touched. Auto until the operator expresses a preference.
 */
export const tableLayoutFor = (widths: ColumnWidths): "auto" | "fixed" =>
  widths && Object.keys(widths).length > 0 ? "fixed" : "auto";

/** Inline style for a header cell — undefined leaves the column automatic. */
export const widthStyle = (widths: ColumnWidths, id: string): { width: number; minWidth: number } | undefined => {
  const w = widths?.[id];
  if (!Number.isFinite(w)) return undefined;
  // minWidth alongside width because a flex/grid ancestor can otherwise shrink
  // a fixed-layout column back below the value the operator dragged to.
  return { width: w as number, minWidth: w as number };
};
