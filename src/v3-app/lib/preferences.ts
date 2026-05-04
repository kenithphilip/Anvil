// Anvil v3 — UI preferences (theme + density + rail) with persistence.
//
// Keys are stored under the `anvil:` prefix; the helper reads
// `obara:`-prefixed values one last time and migrates them forward
// so the rebrand does not nuke an existing user's saved theme.

import { lsGet, lsSet } from "./storage-keys";

export type Theme = "dark" | "light";
export type Density = "compact" | "normal" | "comfortable";
export type Rail = "expanded" | "collapsed";

const KEY_THEME = "v3_theme";
const KEY_DENSITY = "v3_density";
const KEY_RAIL = "v3_rail";

const ls = {
  get: <T extends string>(k: string, dflt: T): T => (lsGet(k) as T) || dflt,
  set: (k: string, v: string): void => { lsSet(k, v); },
};

export const apply = (): void => {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  html.setAttribute("data-theme", ls.get(KEY_THEME, "dark"));
  html.setAttribute("data-density", ls.get(KEY_DENSITY, "normal"));
  html.setAttribute("data-rail", ls.get(KEY_RAIL, "expanded"));
};

const fire = (detail: Record<string, unknown>): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("prefs:change", { detail }));
  }
};

export const theme = (): Theme => ls.get<Theme>(KEY_THEME, "dark");
export const setTheme = (v: Theme): void => { ls.set(KEY_THEME, v); apply(); fire({ theme: v }); };
export const toggleTheme = (): void => setTheme(theme() === "dark" ? "light" : "dark");

export const density = (): Density => ls.get<Density>(KEY_DENSITY, "normal");
export const setDensity = (v: Density): void => { ls.set(KEY_DENSITY, v); apply(); fire({ density: v }); };

export const rail = (): Rail => ls.get<Rail>(KEY_RAIL, "expanded");
export const setRail = (v: Rail): void => { ls.set(KEY_RAIL, v); apply(); fire({ rail: v }); };
export const toggleRail = (): void => setRail(rail() === "collapsed" ? "expanded" : "collapsed");

export const Prefs = {
  theme, setTheme, toggleTheme,
  density, setDensity,
  rail, setRail, toggleRail,
  apply,
};
