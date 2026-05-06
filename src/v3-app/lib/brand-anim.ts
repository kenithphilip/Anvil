// Brand animation hooks. Pure CSS animation lives in styles.css; this
// file carries the small JS hooks that need state (scroll progress,
// count-up tweens, reveal-on-scroll). Every hook respects
// `prefers-reduced-motion: reduce` and degrades to the static end
// state immediately.
//
// Keeping these in one place means the brand voice (timing curves,
// reveal delay, count-up easing) lives in a single tunable surface.

import { useEffect, useRef, useState, useCallback } from "react";

const isReduceMotion = (): boolean => {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

// Page scroll progress 0..1. Used by the slim accent bar at the top of
// the landing page so the visitor always sees how far through they are.
export function useScrollProgress(): number {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        const doc = document.documentElement;
        const max = Math.max(1, doc.scrollHeight - window.innerHeight);
        const next = Math.min(1, Math.max(0, window.scrollY / max));
        setPct(next);
        raf = 0;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);
  return pct;
}

// IntersectionObserver-backed reveal flag. Returns [ref, visible].
// `once: true` (default) means it stays visible after first reveal so
// re-scrolling doesn't re-trigger.
export function useReveal<T extends Element = HTMLElement>(opts: { once?: boolean; threshold?: number } = {}) {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (isReduceMotion()) { setVisible(true); return; }
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          setVisible(true);
          if (opts.once !== false) obs.disconnect();
        } else if (opts.once === false) {
          setVisible(false);
        }
      }
    }, { threshold: opts.threshold ?? 0.18 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [opts.once, opts.threshold]);
  return [ref, visible] as const;
}

// Count-up tween. Pass the final number and a duration; returns the
// animated current value. Skips the tween entirely under reduced-
// motion. `decimals` controls how many fractional digits the
// returned value carries (used for "8.4 min", "94.2%", "₹4.20"
// counters on the landing page); when omitted, the value is rounded
// to an integer (the historical behaviour).
//
// The hook returns a `number`. When `decimals > 0`, callers should
// render with `.toFixed(decimals)` themselves. To make rendering
// trivial for the landing-spec strip we expose a string alias via
// `useCountUpFormatted` below.
export function useCountUp(
  target: number,
  opts: { durationMs?: number; start?: boolean; decimals?: number } = {},
): string {
  const start = opts.start !== false;
  const duration = opts.durationMs ?? 1200;
  const decimals = Math.max(0, opts.decimals ?? 0);
  const fmt = (v: number) => decimals === 0 ? String(Math.round(v)) : v.toFixed(decimals);
  const [val, setVal] = useState(start ? fmt(0) : fmt(target));
  const rafRef = useRef<number>(0);
  const startedAtRef = useRef<number>(0);
  useEffect(() => {
    if (!start) { setVal(fmt(target)); return; }
    if (isReduceMotion()) { setVal(fmt(target)); return; }
    if (typeof window === "undefined") { setVal(fmt(target)); return; }
    startedAtRef.current = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAtRef.current) / duration);
      // ease-out-cubic, gives a satisfying "settle" near the end.
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(fmt(target * eased));
      if (t < 1) rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => { if (rafRef.current) window.cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration, start, decimals]);
  return val;
}

// Pointer-tilt hook. Rotates an element a few degrees in 3D following
// the cursor. Subtle by default (8° max). Disabled under reduced
// motion or coarse pointer (touch).
export function useTilt(maxDeg = 8) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onMove = useCallback((ev: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    if (isReduceMotion()) return;
    const r = el.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    const rx = (0.5 - y) * maxDeg;
    const ry = (x - 0.5) * maxDeg;
    el.style.transform = `perspective(800px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
  }, [maxDeg]);
  const onLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = "perspective(800px) rotateX(0) rotateY(0)";
  }, []);
  return { ref, onPointerMove: onMove, onPointerLeave: onLeave } as const;
}

// Tour frame scroll-sync. Returns the index of the frame currently
// closest to the viewport center, so the right-side pin can update
// its preview text.
export function useScrollSpy(itemSelector: string, container?: Element | null): number {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = container || null;
    const els = Array.from((root || document).querySelectorAll<HTMLElement>(itemSelector));
    if (!els.length) return;
    const compute = () => {
      const target = window.innerHeight * 0.35;
      let closest = 0;
      let bestDist = Infinity;
      els.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const center = r.top + r.height / 2;
        const d = Math.abs(center - target);
        if (d < bestDist) { bestDist = d; closest = i; }
      });
      setIdx(closest);
    };
    compute();
    window.addEventListener("scroll", compute, { passive: true });
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
    };
  }, [itemSelector, container]);
  return idx;
}

// Tiny pseudo-random walker for the "live activity" ticker.
// Each tick, advances the message; loops cyclically.
export function useTicker<T>(items: readonly T[], intervalMs = 3000): T {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!items.length) return;
    if (isReduceMotion()) return;
    if (typeof window === "undefined") return;
    const id = window.setInterval(() => setI((n) => (n + 1) % items.length), intervalMs);
    return () => window.clearInterval(id);
  }, [items, intervalMs]);
  return items[i] || items[0];
}
