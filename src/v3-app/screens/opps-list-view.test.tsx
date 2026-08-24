// A list view for the opportunity pipeline.
//
// The board answers "what is in each stage". It cannot answer "what is the
// biggest thing in this pipeline", "what has not moved in a month", or "which
// of these is least likely to close" — questions ABOUT the pipeline rather
// than about a stage, each needing a comparison across all eleven columns at
// once. Eleven columns is also a lot of horizontal scrolling.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "opps.tsx"), "utf8");

describe("the view toggle", () => {
  it("offers both views", () => {
    expect(src).toMatch(/const \[view, setView\] = useState/);
    expect(src).toMatch(/view === "list" \? "List" : "Board"/);
  });

  it("keeps the choice in the hash, so it survives a refresh and can be linked", () => {
    // Matches the ?id= convention already on this screen.
    expect(src).toMatch(/window\.location\.hash\.includes\("view=list"\)/);
    expect(src).toMatch(/\?view=list/);
  });

  it("hides the probability sort in list view", () => {
    // It re-sorts WITHIN each column — a board affordance. In the list every
    // column sorts by its header, so both would fight over one ordering.
    expect(src).toMatch(/view === "board" && \(\s*<Btn sm kind=\{sortByProb/);
  });
});

describe("what the list adds over the board", () => {
  it("shows weighted value, which the board never computed per row", () => {
    // The board shows a stage weight in its header; the list applies it, which
    // is what makes rows comparable across stages.
    expect(src).toMatch(/\{ key: "weighted", label: "Weighted"/);
    expect(src).toMatch(/\(Number\(r\.value\) \|\| 0\) \* w/);
  });

  it("sorts stage by PIPELINE ORDER, not alphabetically", () => {
    // Alphabetical stage order is meaningless; pipeline order is the question.
    expect(src).toMatch(/OPP_STAGES\.findIndex\(\(s\) => s\.id === r\.stage\)/);
  });

  it("sorts an unscored probability apart from a zero one", () => {
    // Not the same thing. Sorting them together hides exactly the rows that
    // need attention.
    expect(src).toMatch(/Number\.isFinite\(Number\(r\.ai_probability\)\) \? Number\(r\.ai_probability\) : -1/);
  });

  it("starts a newly-chosen column descending", () => {
    // Every column here is one where biggest / newest / furthest along is the
    // question being asked.
    expect(src).toMatch(/else \{ setSortKey\(k\); setSortDir\("desc"\); \}/);
  });
});

describe("it behaves like a table people can use", () => {
  it("scrolls inside itself rather than making the page scroll sideways", () => {
    expect(src).toMatch(/overflowX: "auto"/);
  });

  it("lines the figures up", () => {
    expect(src).toMatch(/fontVariantNumeric: "tabular-nums"/);
  });

  it("announces the sort to a screen reader, not only with an arrow", () => {
    expect(src).toMatch(/aria-sort=\{active \? \(sortDir === "desc" \? "descending" : "ascending"\) : "none"\}/);
  });

  it("opens a row by keyboard as well as click", () => {
    const list = src.slice(src.indexOf("const OppList"));
    expect(list).toMatch(/onKeyDown/);
    expect(list).toMatch(/ev\.key === "Enter" \|\| ev\.key === " "/);
    expect(list).toMatch(/tabIndex=\{0\}/);
  });

  it("goes to the same place a card does", () => {
    // One opportunity, one destination — a list that opened something else
    // would be a second, quietly different app.
    const list = src.slice(src.indexOf("const OppList"));
    expect(list).toMatch(/#\/opps\?id=\$\{r\.id\}/);
  });
});

describe("the board is untouched", () => {
  it("still renders when the view is not list", () => {
    expect(src).toMatch(/<div className="kanban" role="list" aria-label="Opportunity pipeline">/);
  });

  it("still shows the empty state before either view", () => {
    // The "no opportunities yet" card must not be reachable only from one view.
    const emptyIdx = src.indexOf("No opportunities yet");
    const listIdx = src.indexOf('view === "list" ? (');
    expect(emptyIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeLessThan(listIdx);
  });
});
