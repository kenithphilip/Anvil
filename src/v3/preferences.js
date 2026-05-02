// Anvil v3 — UI preferences (theme + density + rail) with persistence.
// Preferences are stored in localStorage and reflected as data-* attributes
// on <html> so the CSS in styles.css responds without a re-render.

(function () {
  const KEY_THEME = "obara:v3_theme";
  const KEY_DENSITY = "obara:v3_density";
  const KEY_RAIL = "obara:v3_rail";

  const ls = {
    get: (k, dflt) => { try { return localStorage.getItem(k) || dflt; } catch { return dflt; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
  };

  // Defaults: dark theme, normal density, expanded rail.
  // The user requested dark default; toggle still available.
  const apply = () => {
    const html = document.documentElement;
    html.setAttribute("data-theme", ls.get(KEY_THEME, "dark"));
    html.setAttribute("data-density", ls.get(KEY_DENSITY, "normal"));
    html.setAttribute("data-rail", ls.get(KEY_RAIL, "expanded"));
  };

  const Prefs = {
    theme: () => ls.get(KEY_THEME, "dark"),
    setTheme: (v) => { ls.set(KEY_THEME, v); apply(); window.dispatchEvent(new CustomEvent("prefs:change", { detail: { theme: v } })); },
    toggleTheme: () => Prefs.setTheme(Prefs.theme() === "dark" ? "light" : "dark"),

    density: () => ls.get(KEY_DENSITY, "normal"),
    setDensity: (v) => { ls.set(KEY_DENSITY, v); apply(); window.dispatchEvent(new CustomEvent("prefs:change", { detail: { density: v } })); },

    rail: () => ls.get(KEY_RAIL, "expanded"),
    setRail: (v) => { ls.set(KEY_RAIL, v); apply(); window.dispatchEvent(new CustomEvent("prefs:change", { detail: { rail: v } })); },
    toggleRail: () => Prefs.setRail(Prefs.rail() === "collapsed" ? "expanded" : "collapsed"),

    apply,
  };

  // Apply on load so the first paint already has the right theme.
  if (typeof document !== "undefined") {
    if (document.readyState !== "loading") apply();
    else document.addEventListener("DOMContentLoaded", apply);
  }

  if (typeof window !== "undefined") window.Prefs = Prefs;
})();
