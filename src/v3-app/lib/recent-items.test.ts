import { describe, it, expect, beforeEach } from "vitest";
import { pushRecent, getRecent, clearRecent } from "./recent-items";

describe("recent-items", () => {
  beforeEach(() => clearRecent());

  it("pushes newest-first and returns items", () => {
    pushRecent({ type: "quote", id: "q1", label: "Q-1", href: "#/quotes?id=q1" });
    pushRecent({ type: "lead", id: "l1", label: "Acme", href: "#/leads" });
    const r = getRecent();
    expect(r.map((x) => x.key)).toEqual(["lead:l1", "quote:q1"]);
    expect(r[0].label).toBe("Acme");
  });

  it("dedups by type:id and moves the repeat to the front", () => {
    pushRecent({ type: "quote", id: "q1", label: "Q-1", href: "#/quotes?id=q1" });
    pushRecent({ type: "quote", id: "q2", label: "Q-2", href: "#/quotes?id=q2" });
    pushRecent({ type: "quote", id: "q1", label: "Q-1 updated", href: "#/quotes?id=q1&tab=lines" });
    const r = getRecent();
    expect(r.map((x) => x.key)).toEqual(["quote:q1", "quote:q2"]);
    expect(r[0].label).toBe("Q-1 updated");
  });

  it("ignores entries without id/href", () => {
    pushRecent({ type: "quote", id: "", label: "x", href: "#/x" } as any);
    pushRecent({ type: "quote", id: "q9", label: "x", href: "" } as any);
    expect(getRecent().length).toBe(0);
  });

  it("clearRecent empties the list", () => {
    pushRecent({ type: "quote", id: "q1", label: "Q-1", href: "#/quotes?id=q1" });
    clearRecent();
    expect(getRecent()).toEqual([]);
  });
});
