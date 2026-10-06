// Navigating a long composition.
//
// The margin an operator is steering toward lives in a <tfoot>, and the column
// identities in a <thead>. On a quote with dozens of lines both scroll off the
// page, so pricing line 40 meant scrolling to the end of the screen to read the
// GP, back up to see which column was "Loaded" vs "Recommended", and down again.
//
// The table now owns a scroll box with the head and foot stuck to it. Sticking
// to the PAGE instead would need an offset for the app's sticky chrome, whose
// height this component neither knows nor should.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const tsx = readFileSync("src/v3-app/components/QuoteComposition.tsx", "utf8");
const css = readFileSync("src/v3-app/styles.css", "utf8");

// The .qc-scroll block, isolated so a rule elsewhere cannot satisfy these.
const block = (() => {
  const i = css.indexOf("/* === QUOTE COMPOSITION: long line lists ===");
  return i === -1 ? "" : css.slice(i);
})();

describe("the line table owns its scroll", () => {
  it("wraps the table in the scroll box", () => {
    expect(tsx).toContain('<div className="qc-scroll">');
  });

  it("closes it — an unbalanced div would swallow the totals banner below", () => {
    const open = (tsx.match(/<div className="qc-scroll">/g) || []).length;
    // The wrapper is the only div opened at that indent inside the Card; count
    // the close that follows </table>.
    expect(open).toBe(1);
    expect(tsx).toMatch(/<\/table>\s*\n\s*<\/div>/);
  });

  it("bounds the height and scrolls", () => {
    expect(block).toMatch(/\.qc-scroll\s*\{[^}]*max-height:[^}]*overflow:\s*auto/s);
  });
});

describe("head and foot stay visible", () => {
  it("pins the column headers to the top", () => {
    expect(block).toMatch(/\.qc-scroll thead th\s*\{[^}]*position:\s*sticky/s);
    expect(block).toMatch(/\.qc-scroll thead th\s*\{[^}]*top:\s*0/s);
  });

  it("pins the totals to the bottom", () => {
    // The whole point: the GP you are steering toward stays on screen while you
    // edit the prices that move it.
    expect(block).toMatch(/\.qc-scroll tfoot td[^{]*\{[^}]*position:\s*sticky/s);
    expect(block).toMatch(/\.qc-scroll tfoot td[^{]*\{[^}]*bottom:\s*0/s);
  });

  it("gives both an opaque background", () => {
    // Rows scroll UNDER them; a translucent header is unreadable over its own
    // data, which is worse than no sticky at all.
    const head = /\.qc-scroll thead th\s*\{([^}]*)\}/s.exec(block)?.[1] || "";
    const foot = /\.qc-scroll tfoot td[^{]*\{([^}]*)\}/s.exec(block)?.[1] || "";
    expect(head).toMatch(/background:/);
    expect(foot).toMatch(/background:/);
    for (const b of [head, foot]) expect(b).not.toMatch(/rgba\([^)]*,\s*0?\.\d+\s*\)/);
  });

  it("raises them above the rows", () => {
    expect(block).toMatch(/\.qc-scroll thead th\s*\{[^}]*z-index:/s);
    expect(block).toMatch(/\.qc-scroll tfoot td[^{]*\{[^}]*z-index:/s);
  });

  it("uses theme tokens, so it survives dark mode", () => {
    expect(block).toMatch(/background:\s*var\(--paper/);
    expect(block).not.toMatch(/background:\s*#(fff|ffffff)\b/i);
  });
});

describe("small viewports get the page scroll back", () => {
  it("drops the fixed height and the sticking below 900px", () => {
    // A 62vh box minus a stuck head and foot leaves almost no rows on a short
    // screen — worse than the problem it solves.
    const mq = /@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/.exec(block)?.[1] || "";
    expect(mq).toContain(".qc-scroll");
    expect(mq).toMatch(/max-height:\s*none/);
    expect(mq).toMatch(/position:\s*static/);
  });
});
