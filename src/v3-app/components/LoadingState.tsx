import React, { useEffect, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * LOADING STATE — pixel-grid loader for long-running work
 *
 * Built for work measured in TENS of seconds, not hundreds of
 * milliseconds. An extraction run is budgeted at 45s inside a 60s
 * platform ceiling and routinely spends 9-30s inside a single model
 * call, so a static "extracting…" gives the operator no way to tell
 * a slow run from a wedged one. The elapsed timer is the point: it
 * turns an opaque wait into an observable one.
 *
 * Variants:
 *   drive  — square cells, chevron wavefront driving right; the
 *            650ms cycle is shorter than the sweep, so two fronts
 *            are always in flight
 *   dots   — same wavefront, circular cells
 *   orbit  — a comet lapping the grid perimeter
 *
 * Reduced motion: styles.css already carries a global
 * `@media (prefers-reduced-motion: reduce) { * { animation: none } }`,
 * which freezes the grid at its dim opacity and stops the shimmer.
 * The timer is JS, so it keeps ticking — the wait stays legible
 * without any motion at all. Nothing extra to do here.
 *
 * The grid is aria-hidden decoration; the label and timer carry the
 * meaning, and the wrapper is a live region so a screen reader
 * announces the label rather than silently spinning.
 * ───────────────────────────────────────────────────────── */

// Chevron wavefront: delay grows with column, and with distance from
// the middle row, so the leading edge reads as a ">" sweeping right.
const CHEVRON = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

// Perimeter walk (centre cell never lights).
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

type Pattern = { delays: (number | null)[]; dur: number; round: boolean };

const PATTERNS: Record<string, Pattern> = {
  drive: { delays: CHEVRON, dur: 650, round: false },
  dots: { delays: CHEVRON, dur: 650, round: true },
  orbit: { delays: ORBIT, dur: 950, round: false },
};

// Tenths of a second, so the readout moves visibly on a fast run and
// still reads sensibly on a 45s one.
export const formatElapsed = (deciseconds: number): string => {
  const total = deciseconds / 10;
  if (total < 60) return total.toFixed(1) + "s";
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + "m " + s.toFixed(1) + "s";
};

const useElapsed = (startedAt?: number) => {
  const [ds, setDs] = useState(0);
  useEffect(() => {
    // Derive from a wall-clock origin rather than incrementing a
    // counter: a background tab throttles timers, and an incrementing
    // counter would under-report a long run by however long the tab
    // slept — exactly the runs this component exists to make legible.
    const t0 = startedAt || Date.now();
    const tick = () => setDs(Math.max(0, Math.round((Date.now() - t0) / 100)));
    tick();
    const t = setInterval(tick, 100);
    return () => clearInterval(t);
  }, [startedAt]);
  return formatElapsed(ds);
};

export interface LoadingStateProps {
  label?: string;
  variant?: "drive" | "dots" | "orbit";
  /** Epoch ms the work began. Defaults to mount. Pass it when the work
   *  started before this component rendered, so the timer is honest. */
  startedAt?: number;
  /** Hide the elapsed readout for sub-second work where it is noise. */
  showElapsed?: boolean;
}

export const LoadingState: React.FC<LoadingStateProps> = ({
  label = "Working",
  variant = "drive",
  startedAt,
  showElapsed = true,
}) => {
  const elapsed = useElapsed(startedAt);
  const { delays, dur, round } = PATTERNS[variant] || PATTERNS.drive;

  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span aria-hidden="true" className={"px-grid" + (round ? " round" : "")}>
        {delays.map((d, i) => (
          <span
            key={i}
            className="px-cell"
            style={d === null
              ? { opacity: 0.07 }
              : { animation: "pixel-on " + dur + "ms ease-in-out " + d + "ms infinite" }}
          />
        ))}
      </span>
      <span className="loading-label">{label}</span>
      {showElapsed && <span className="loading-elapsed mono-sm">{elapsed}</span>}
    </div>
  );
};

export default LoadingState;
