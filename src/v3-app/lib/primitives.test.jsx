// Behavior tests for the ESM design-system primitives. These do NOT
// snapshot the DOM (the v3 stylesheet would need to be loaded to make
// snapshots meaningful); they assert structural properties and prop
// behavior so a future tweak to a primitive is caught.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import {
  Btn, Chip, Dot, Sev, Prov,
  WSTitle, WSTabs, Card, KV, KPI, KPIRow, Steps, Banner, RailPanel, Stream,
  fmtINR, fmtUSD, fmtPct,
} from "./primitives.jsx";

describe("Btn", () => {
  it("renders the children inside a button", () => {
    const { getByRole } = render(<Btn>click me</Btn>);
    const btn = getByRole("button");
    expect(btn.textContent).toBe("click me");
    expect(btn.getAttribute("type")).toBe("button");
  });

  it("composes className from kind + size flags", () => {
    const { getByRole } = render(<Btn kind="primary" sm icon>x</Btn>);
    const btn = getByRole("button");
    const cls = btn.className.split(/\s+/);
    expect(cls).toContain("btn");
    expect(cls).toContain("primary");
    expect(cls).toContain("sm");
    expect(cls).toContain("icon");
  });

  it("disables when disabled prop is true", () => {
    const { getByRole } = render(<Btn disabled>x</Btn>);
    expect(getByRole("button").disabled).toBe(true);
  });
});

describe("Chip + Dot + Sev + Prov", () => {
  it("Chip applies kind class", () => {
    const { container } = render(<Chip k="warn">live</Chip>);
    expect(container.querySelector(".chip.warn")).toBeTruthy();
    expect(container.textContent).toBe("live");
  });
  it("Dot renders an empty span with kind class", () => {
    const { container } = render(<Dot k="live" />);
    expect(container.querySelector(".dot.live")).toBeTruthy();
  });
  it("Sev defaults to low", () => {
    const { container } = render(<Sev />);
    expect(container.querySelector(".sev.low")).toBeTruthy();
  });
  it("Prov wraps children", () => {
    const { container } = render(<Prov>SC1</Prov>);
    expect(container.querySelector(".prov").textContent).toBe("SC1");
  });
});

describe("WSTitle", () => {
  it("renders h1 with the title", () => {
    const { container } = render(<WSTitle title="Sales orders" />);
    expect(container.querySelector("h1").textContent).toBe("Sales orders");
  });
  it("shows eyebrow + meta + right content", () => {
    const { container, getByText } = render(
      <WSTitle eyebrow="Workflows" title="x" meta="3 active" right={<button>refresh</button>} />
    );
    expect(getByText("Workflows")).toBeTruthy();
    expect(container.textContent).toContain("3 active");
    expect(getByText("refresh")).toBeTruthy();
  });
});

describe("WSTabs", () => {
  it("highlights the active tab", () => {
    const tabs = [
      { id: "a", label: "Active", count: 2 },
      { id: "b", label: "Closed" },
    ];
    const { container } = render(<WSTabs tabs={tabs} active="a" />);
    const items = container.querySelectorAll(".ws-tab");
    expect(items.length).toBe(2);
    expect(items[0].className).toContain("active");
    expect(items[1].className).not.toContain("active");
    expect(container.querySelector(".tab-count").textContent).toBe("2");
  });
});

describe("Card", () => {
  it("renders flush + adds optional eyebrow + title + right", () => {
    const { container } = render(
      <Card title="t" eyebrow="eb" right={<span>R</span>} flush>
        <p>body</p>
      </Card>
    );
    const card = container.querySelector(".card.flush");
    expect(card).toBeTruthy();
    expect(card.querySelector(".card-h .eb").textContent).toBe("eb");
    expect(card.querySelector(".card-h .t").textContent).toBe("t");
    expect(card.querySelector("p").textContent).toBe("body");
  });
});

describe("KV", () => {
  it("renders dt/dd pairs", () => {
    const { container } = render(<KV rows={[["k1", "v1"], ["k2", "v2"]]} />);
    const dts = container.querySelectorAll("dt");
    const dds = container.querySelectorAll("dd");
    expect(dts.length).toBe(2);
    expect(dds.length).toBe(2);
    expect(dts[0].textContent).toBe("k1");
    expect(dds[0].textContent).toBe("v1");
  });
});

describe("KPI + KPIRow", () => {
  it("renders label + value + delta", () => {
    const { container } = render(<KPI lbl="Total" v="3" d="active" dKind="up" />);
    expect(container.querySelector(".lbl").textContent).toBe("Total");
    expect(container.querySelector(".v").textContent).toBe("3");
    expect(container.querySelector(".d.up").textContent).toBe("active");
  });
  it("KPIRow sets --cols from child count when no cols prop", () => {
    const { container } = render(
      <KPIRow><KPI lbl="a" v="1" /><KPI lbl="b" v="2" /></KPIRow>
    );
    const row = container.querySelector(".kpi-row");
    expect(row.style.getPropertyValue("--cols")).toBe("2");
  });
});

describe("Steps", () => {
  it("marks past + current correctly", () => {
    const { container } = render(<Steps items={["a", "b", "c"]} current={1} />);
    const steps = container.querySelectorAll(".step");
    expect(steps[0].className).toContain("done");
    expect(steps[1].className).toContain("cur");
    expect(steps[2].className).not.toMatch(/done|cur/);
  });
});

describe("Banner", () => {
  it("composes kind + renders title + body + action", () => {
    const { container, getByText } = render(
      <Banner kind="bad" title="Error" action={<button>retry</button>}>oops</Banner>
    );
    expect(container.querySelector(".banner.bad")).toBeTruthy();
    expect(getByText("Error")).toBeTruthy();
    expect(container.textContent).toContain("oops");
    expect(getByText("retry")).toBeTruthy();
  });
});

describe("RailPanel", () => {
  it("includes count when provided", () => {
    const { container } = render(<RailPanel title="Mine" count={5}>x</RailPanel>);
    expect(container.querySelector(".rail-panel-h .t").textContent).toBe("Mine");
    expect(container.querySelector(".rail-panel-h .c").textContent).toBe("5");
  });
});

describe("Stream", () => {
  it("renders one row per entry with t + a + m", () => {
    const rows = [
      { t: "1m", a: "ada", m: <em>did x</em> },
      { t: "5m", a: "bo", m: "did y" },
    ];
    const { container } = render(<Stream rows={rows} />);
    const rowEls = container.querySelectorAll(".stream-row");
    expect(rowEls.length).toBe(2);
    expect(rowEls[0].querySelector(".t").textContent).toBe("1m");
    expect(rowEls[0].querySelector(".a").textContent).toBe("ada");
    expect(rowEls[0].querySelector(".m").textContent).toBe("did x");
  });
  it("falls back to em-dash for empty actor", () => {
    const { container } = render(<Stream rows={[{ t: "1m", a: null, m: "" }]} />);
    expect(container.querySelector(".a").textContent).toBe("—");
  });
});

describe("formatters", () => {
  it("fmtINR uses en-IN grouping", () => {
    expect(fmtINR(1234567)).toBe("₹ 12,34,567");
  });
  it("fmtUSD uses en-US grouping with two decimals", () => {
    expect(fmtUSD(1234.5)).toBe("$ 1,234.50");
  });
  it("fmtPct converts to percent with one decimal", () => {
    expect(fmtPct(0.875)).toBe("87.5%");
  });
});
