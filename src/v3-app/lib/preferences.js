// Anvil v3 — UI preferences (theme + density + rail) with persistence.
// ESM port of src/v3/preferences.js. Preferences are stored in
// localStorage and reflected as data-* attributes on <html> so styles.css
// can respond without a re-render.

const KEY_THEME = "obara:v3_theme";
const KEY_DENSITY = "obara:v3_density";
const KEY_RAIL = "obara:v3_rail";

const ls = {
  get: (k, dflt) => { try { return localStorage.getItem(k) || dflt; } catch (_) { return dflt; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
};

export const apply = () => {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  html.setAttribute("data-theme", ls.get(KEY_THEME, "dark"));
  html.setAttribute("data-density", ls.get(KEY_DENSITY, "normal"));
  html.setAttribute("data-rail", ls.get(KEY_RAIL, "expanded"));
};

const fire = (detail) => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("prefs:change", { detail }));
  }
};

export const theme = () => ls.get(KEY_THEME, "dark");
export const setTheme = (v) => { ls.set(KEY_THEME, v); apply(); fire({ theme: v }); };
export const toggleTheme = () => setTheme(theme() === "dark" ? "light" : "dark");

export const density = () => ls.get(KEY_DENSITY, "normal");
export const setDensity = (v) => { ls.set(KEY_DENSITY, v); apply(); fire({ density: v }); };

export const rail = () => ls.get(KEY_RAIL, "expanded");
export const setRail = (v) => { ls.set(KEY_RAIL, v); apply(); fire({ rail: v }); };
export const toggleRail = () => setRail(rail() === "collapsed" ? "expanded" : "collapsed");

export const Prefs = {
  theme, setTheme, toggleTheme,
  density, setDensity,
  rail, setRail, toggleRail,
  apply,
};
