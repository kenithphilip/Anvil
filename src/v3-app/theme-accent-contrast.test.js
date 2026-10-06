// Nothing dark-mode-legible may sit on the chartreuse fill by accident.
//
// --accent (#C8FF2B) is the SAME value in both themes; --ink flips from
// near-black to near-cream. So `background: var(--accent); color: var(--ink)`
// is fine in light mode and, in dark mode, puts #ECECE6 on #C8FF2B — a
// measured contrast ratio of 1.00:1. Identical relative luminance. Invisible.
//
// A comment above --on-accent already explained this trap, and the Ask Anvil
// badge and avatar plus eleven landing-page rules fell into it anyway. A
// comment is not a guard; this is.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.join(process.cwd(), "src/v3-app/styles.css"), "utf8");

// Relative luminance + contrast ratio, per WCAG 2.1.
const lum = (hex) => {
  const h = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Every declaration block, so a pairing is judged within its OWN rule rather
// than by proximity to a neighbour's.
const rules = css.match(/\{[^{}]*\}/g) || [];

const tokenValues = (name) => {
  const re = new RegExp("\\s" + name + ":\\s*(#[0-9a-fA-F]{6})", "g");
  return [...css.matchAll(re)].map((m) => m[1].toUpperCase());
};

describe("the token contract", () => {
  it("--accent does not change between themes", () => {
    const v = tokenValues("--accent");
    expect(v.length).toBeGreaterThan(1);
    expect(new Set(v).size).toBe(1);
  });

  it("--on-accent does not change between themes either, because --accent does not", () => {
    const v = tokenValues("--on-accent");
    expect(v.length).toBe(2);
    expect(new Set(v).size).toBe(1);
  });

  it("--on-accent clears WCAG AA against the accent fill", () => {
    const [on] = tokenValues("--on-accent");
    const [accent] = tokenValues("--accent");
    expect(ratio(on, accent)).toBeGreaterThanOrEqual(4.5);
  });

  it("--ink DOES flip — which is why it must not be used on the accent", () => {
    // If this ever stops being true the rule below is moot, and someone should
    // find out from a failing test rather than by shipping it.
    expect(new Set(tokenValues("--ink")).size).toBeGreaterThan(1);
  });
});

describe("no rule pairs an accent fill with a flipping foreground", () => {
  const offenders = rules.filter(
    (r) => /background:\s*var\(--accent\)/.test(r) && /(?<!-)color:\s*var\(--ink\)/.test(r),
  );

  it("has none", () => {
    // Fourteen rules had this on 2026-08-20, including the Ask Anvil unread
    // badge the operator reported.
    expect(offenders.map((r) => r.trim().slice(0, 60))).toEqual([]);
  });
});

describe("the Ask Anvil pill", () => {
  const rule = (sel) => {
    const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*\\}"));
    return m ? m[0] : "";
  };

  it("its unread badge uses the non-flipping foreground", () => {
    expect(rule(".aa-count")).toMatch(/color:\s*var\(--on-accent\)/);
  });

  it("its avatar does too", () => {
    expect(rule(".aa-avatar")).toMatch(/color:\s*var\(--on-accent\)/);
  });

  it("its live dot flips WITH the pill, because the pill itself inverts", () => {
    // The pill's surface is var(--ink): near-black in light mode, near-cream
    // in dark. A fixed chartreuse dot measured 1.00:1 against the dark-mode
    // surface — the same invisible pairing, one layer out.
    expect(rule(".aa-dot")).toMatch(/background:\s*var\(--aa-dot\)/);
    const v = tokenValues("--aa-dot");
    expect(v.length).toBe(2);
    expect(new Set(v).size).toBe(2);
  });

  it("the dot clears the 3:1 bar for graphical objects in BOTH themes", () => {
    const [dotLight, dotDark] = tokenValues("--aa-dot");
    const [inkLight, inkDark] = tokenValues("--ink");
    expect(ratio(dotLight, inkLight)).toBeGreaterThanOrEqual(3);
    expect(ratio(dotDark, inkDark)).toBeGreaterThanOrEqual(3);
  });
});
