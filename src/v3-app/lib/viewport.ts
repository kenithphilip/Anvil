// useViewport: track whether the current viewport is below a mobile
// breakpoint. Returns { isMobile, width }. The Shell consumes this to
// flip from the desktop sidebar layout to a bottom-tab MobileTabBar.
//
// We use a real ResizeObserver on the documentElement so a desktop
// user dragging the window down through the breakpoint sees the
// shell switch live. SSR-safe: the initial value is `false`
// (desktop) until the first effect runs in the browser.

import { useEffect, useState } from "react";

const MOBILE_BREAKPOINT_PX = 768;

export interface Viewport {
  isMobile: boolean;
  width: number;
}

const initialWidth = (): number =>
  (typeof window !== "undefined" && window.innerWidth) || 1024;

export const useViewport = (): Viewport => {
  const [width, setWidth] = useState<number>(initialWidth);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return {
    width,
    isMobile: width > 0 && width < MOBILE_BREAKPOINT_PX,
  };
};

export const MOBILE_BREAKPOINT = MOBILE_BREAKPOINT_PX;
