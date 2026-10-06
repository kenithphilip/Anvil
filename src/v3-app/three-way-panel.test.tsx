// The comparison, where a person sees it.
//
// It exists to answer a question somebody asks once and then acts on: where do
// the three documents disagree, and who was right. So the disagreements come
// first and the agreements are collapsed — a table where every row is green
// teaches somebody to stop reading it, and then they miss the row that is not.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), "utf8");
const src = read("components/ThreeWayPanel.tsx");
const ws = read("screens/so-workspace.tsx");

describe("both rates, given equal weight", () => {
  it("shows Anvil's rate AND the process's", () => {
    // Reporting only Anvil's would bury the finding that makes this worth
    // running: on the first real pair, two fields departed from the PO and
    // neither was Anvil's doing.
    expect(src).toMatch(/Anvil differs from the PO/);
    expect(src).toMatch(/Your process differs from the PO/);
  });

  it("renders them the same size — the process rate is not a footnote", () => {
    const row = src.slice(src.indexOf("<KPIRow>"), src.indexOf("</KPIRow>"));
    expect((row.match(/<KPI /g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it("prints an em-dash, not 0%, when a rate is null", () => {
    // A rate over an empty denominator reads as a perfect score.
    expect(src).toMatch(/v == null \? "—"/);
  });

  it("says so when nothing could be decided", () => {
    expect(src).toMatch(/Nothing could be decided/);
    expect(src).toMatch(/a rate over nothing is not a perfect score/);
  });
});

describe("the findings a two-way comparison cannot make", () => {
  it("gives both_deviate its own banner", () => {
    // The one most likely to be acted on and the easiest to miss inside a
    // table of verdicts.
    expect(src).toMatch(/Anvil and the ERP agree — and the PO says otherwise/);
    expect(src).toMatch(/would have shown no problem at all/);
  });

  it("reports lines the ERP never recorded", () => {
    expect(src).toMatch(/not in the ERP/);
  });

  it("reports lines that exist only in the ERP", () => {
    // Added by hand and not on the PO Anvil read.
    expect(src).toMatch(/not on the order/);
    expect(src).toMatch(/added by\s*\n?\s*hand/);
  });
});

describe("it speaks the operator's language, not the API's", () => {
  it("translates every verdict", () => {
    for (const v of ["agree", "anvil_correct", "anvil_wrong", "both_deviate", "all_differ", "undecidable", "not_applicable"]) {
      expect(src).toMatch(new RegExp(`\\b${v}:`));
    }
    // "anvil_correct" is precise and tells an operator nothing.
    expect(src).toMatch(/label: "ERP differs"/);
  });

  it("explains WHO the disagreement is with, not just that there is one", () => {
    expect(src).toMatch(/Anvil matched the PO; the ERP does not/);
    expect(src).toMatch(/The ERP matched the PO; Anvil does not/);
  });

  it("shows the not-scored reason rather than a silent blank", () => {
    expect(src).toMatch(/f\.note \|\| c\.blame/);
  });
});

describe("disagreements first", () => {
  it("collapses the agreeing fields behind a toggle", () => {
    expect(src).toMatch(/showAgreed/);
    expect(src).toMatch(/fields that agree/);
  });

  it("says plainly when everything agrees", () => {
    // Rather than an empty table, which reads as a failure to load.
    expect(src).toMatch(/Every decidable field agrees/);
  });

  it("distinguishes 'nothing attached' from 'no differences'", () => {
    expect(src).toMatch(/no_sales_order_attached/);
    expect(src).toMatch(/!rep\.available/);
  });
});

describe("it is reachable", () => {
  it("has a tab on the SO workspace", () => {
    expect(ws).toMatch(/id: "threeway", label: "PO vs ERP"/);
    expect(ws).toMatch(/tab === "threeway" && <ThreeWayPanel orderId=\{o\.id\} \/>/);
  });

  it("sits next to Tally, which is the same subject", () => {
    const tally = ws.indexOf('{ id: "tally"');
    const three = ws.indexOf('{ id: "threeway"');
    expect(three).toBeGreaterThan(tally);
    expect(three - tally).toBeLessThan(400);
  });

  it("scrolls its table inside itself", () => {
    expect(src).toMatch(/overflowX: "auto"/);
  });
});
