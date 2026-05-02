import { describe, it, expect, beforeEach } from "vitest";
import { Prefs, theme, setTheme, density, setDensity, rail, setRail, toggleTheme, toggleRail, apply } from "./preferences";

beforeEach(() => {
  for (const k of ["obara:v3_theme", "obara:v3_density", "obara:v3_rail"]) {
    try { window.localStorage.removeItem(k); }
    catch (_) {}
  }
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-density");
  document.documentElement.removeAttribute("data-rail");
});

describe("preferences defaults", () => {
  it("theme defaults to dark", () => {
    expect(theme()).toBe("dark");
  });
  it("density defaults to normal", () => {
    expect(density()).toBe("normal");
  });
  it("rail defaults to expanded", () => {
    expect(rail()).toBe("expanded");
  });
});

describe("setters", () => {
  it("setTheme persists + applies + emits", () => {
    let captured = null;
    const handler = (e) => { captured = e.detail.theme; };
    window.addEventListener("prefs:change", handler);
    setTheme("light");
    expect(theme()).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(captured).toBe("light");
    window.removeEventListener("prefs:change", handler);
  });
  it("toggleTheme flips between dark and light", () => {
    setTheme("dark");
    toggleTheme();
    expect(theme()).toBe("light");
    toggleTheme();
    expect(theme()).toBe("dark");
  });
  it("setDensity + setRail update DOM attrs", () => {
    setDensity("compact");
    setRail("collapsed");
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
    expect(document.documentElement.getAttribute("data-rail")).toBe("collapsed");
  });
  it("toggleRail flips between expanded and collapsed", () => {
    setRail("expanded");
    toggleRail();
    expect(rail()).toBe("collapsed");
    toggleRail();
    expect(rail()).toBe("expanded");
  });
});

describe("Prefs aggregate", () => {
  it("exposes every helper", () => {
    expect(typeof Prefs.theme).toBe("function");
    expect(typeof Prefs.setTheme).toBe("function");
    expect(typeof Prefs.toggleTheme).toBe("function");
    expect(typeof Prefs.density).toBe("function");
    expect(typeof Prefs.setDensity).toBe("function");
    expect(typeof Prefs.rail).toBe("function");
    expect(typeof Prefs.setRail).toBe("function");
    expect(typeof Prefs.toggleRail).toBe("function");
    expect(typeof Prefs.apply).toBe("function");
  });
  it("apply() sets all three data-* attributes", () => {
    setTheme("light");
    setDensity("compact");
    setRail("collapsed");
    document.documentElement.removeAttribute("data-theme");
    apply();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
    expect(document.documentElement.getAttribute("data-rail")).toBe("collapsed");
  });
});
