// The Terms tab (plan PR 13): the PO wording beside the quote wording with
// where each came from, the severity, the history, and the four decisions
// with a required reason. The buttons are the ones the server offers this
// caller (flag.allowed) and the role may use (order.terms_decide).
// Invented fixtures; no customer text.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { installBackend, installRbac } from "../test-utils";
import { TermsPane, termEvidence, termsStatusLine } from "./TermsPane";

const ALL = ["accept", "request_amendment", "reject_term", "not_a_deviation"];

const baseView = () => ({
  order_id: "o1", mode: "on", shadow: false, visible: true,
  policy: { version: 1, decide_at_or_above: "warn" },
  check: { id: "ck1", po_terms_status: "read", po_source: "terms_pass", clause_count: 3 },
  flags: [
    {
      id: "f-ld", clause: "ld_penalty", clause_label: "Liquidated damages", outcome: "po_only", direction: null,
      severity: "critical", method: "rule", needs_decision: true, state: "undecided",
      po: { clause: "ld_penalty", text: "Liquidated damages at 1% per day of delay.", label: "from PO, page 8", page: 8, bbox_norm: [0.1, 0.2, 0.6, 0.25] },
      quote: { quote_id: "q1", quote_number: "Q-1", primary: true, text: null, label: null },
      baseline: null, rationale: "Liquidated damages: the PO states it. Quote Q-1 is silent.",
      decision: null, decisions: [], allowed: ["request_amendment", "reject_term"],
    },
    {
      id: "f-pay", clause: "payment_terms", clause_label: "Payment terms", outcome: "deviates", direction: "against_us",
      severity: "high", method: "rule", needs_decision: true, state: "amendment_requested",
      po: { clause: "payment_terms", text: "Payment: 60 days from the date of GRN", label: "from PO, page 7", page: 7 },
      quote: { clause: "payment_terms", quote_id: "q1", quote_number: "Q-1", primary: true, side: "quote", text: "30 days from invoice", label: "from quote Q-1, as held today (not as sent)", printed_note: "on file, not printed on the quote PDF" },
      baseline: { text: "45 days credit", label: "from customer master" },
      rationale: "Payment terms: credit days: PO 60, quote 30 (against us).",
      decision: { id: "d2", decision: "request_amendment", reason: "Asked the buyer for 30 days from invoice.", decided_role: "sales_engineer", decided_at: "2026-10-10T02:00:00Z" },
      decisions: [
        { id: "d2", decision: "request_amendment", reason: "Asked the buyer for 30 days from invoice.", decided_role: "sales_engineer", decided_at: "2026-10-10T02:00:00Z" },
        { id: "d1", decision: "reject_term", reason: "First read: we cannot carry 60 days.", decided_role: "sales_engineer", decided_at: "2026-10-10T01:00:00Z", carried_from: null },
      ],
      allowed: ["request_amendment", "reject_term"],
    },
    {
      id: "f-war", clause: "warranty", clause_label: "Warranty", outcome: "po_only", direction: null,
      severity: "warn", method: "rule", needs_decision: true, state: "undecided",
      po: { clause: "warranty", text: "Warranty 18 months from dispatch.", label: "from PO, page 9", page: 9 },
      quote: { quote_id: "q1", quote_number: "Q-1", primary: true, text: null },
      baseline: null, rationale: "Warranty: the PO states it. Quote Q-1 is silent.",
      decision: null, decisions: [], allowed: ALL,
    },
  ],
  counts: { total: 3, undecided: 2, amendment_requested: 1, decided: 0 },
});

let decide: any;
let recheck: any;

const Harness: React.FC<{ initial: any; isAdmin?: boolean; canWrite?: boolean }> = ({ initial, isAdmin = false, canWrite = true }) => {
  const [view, setView] = React.useState(initial);
  return <TermsPane orderId="o1" sourceDocId={null} view={view} isAdmin={isAdmin} canWrite={canWrite} onView={setView} />;
};

const card = (container: HTMLElement, id: string) => container.querySelector(`[data-testid="term-flag-${id}"]`) as HTMLElement;

beforeEach(() => {
  decide = vi.fn(async (_o: string, flagId: string, decision: string, reason: string) => {
    const f = baseView().flags.find((x) => x.id === flagId)!;
    const row = { id: "d-new", decision, reason, decided_role: "sales_engineer", decided_at: "2026-10-12T09:00:00Z" };
    return { flag: { ...f, state: decision === "request_amendment" ? "amendment_requested" : "decided", decision: row, decisions: [row, ...f.decisions] } };
  });
  recheck = vi.fn(async () => ({ ...baseView(), flags: [], check: { ...baseView().check, clause_count: 2 } }));
  installBackend({ orders: { termsDecide: decide, termsCheck: recheck } });
  installRbac("sales_engineer");
});

describe("Terms tab: side by side, with provenance", () => {
  it("shows the PO wording beside the quote wording, each labelled, with severity and why", () => {
    const { container } = render(<Harness initial={baseView()} />);
    const pay = card(container, "f-pay");
    for (const text of [
      "Payment terms", "high", "differs, against us",
      "Payment: 60 days from the date of GRN", "from PO, page 7",
      "30 days from invoice", "Quote wording · Q-1 (primary)", "from quote Q-1, as held today (not as sent)", "on file, not printed on the quote PDF",
      "Baseline: 45 days credit", "from customer master",
      "Why flagged (rule): Payment terms: credit days: PO 60, quote 30 (against us).",
    ]) expect(pay.textContent).toContain(text);
    expect(card(container, "f-ld").textContent).toContain("the quote is silent");
    expect(container.querySelector('[data-testid="terms-status"]')!.textContent).toBe("Terms read: 3 clauses, 3 flags, 2 to decide.");
  });

  it("shows the whole decision history, newest first", () => {
    const { container } = render(<Harness initial={baseView()} />);
    const items = Array.from(card(container, "f-pay").querySelectorAll(".terms-history li")).map((li) => li.textContent || "");
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("amendment requested by sales_engineer");
    expect(items[0]).toContain("Asked the buyer for 30 days from invoice.");
    expect(items[1]).toContain("term rejected");
    expect(items[1]).toContain("First read: we cannot carry 60 days.");
  });

  it("builds the PO highlight from each flag's box, keyed to the flag", () => {
    expect(termEvidence(baseView().flags)).toEqual([{
      id: "term-f-ld", page_number: 8, field_path: "terms.f-ld", value: "Liquidated damages", confidence: null,
      bbox: { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.25, page_width: 1, page_height: 1 },
    }]);
  });

  it("says when the PO terms were not read, and when only header terms were", () => {
    expect(termsStatusLine({ check: { po_terms_status: "not_read" }, flags: [{ outcome: "not_read", rationale: "PO terms not read: image only" }] }))
      .toBe("PO terms not read. PO terms not read: image only");
    expect(termsStatusLine({ check: { po_terms_status: "partial", po_source: "extraction", clause_count: 1 }, flags: [] }))
      .toBe("Header terms only: the PO's terms and conditions were not read. 1 clause from the order header, No flags.");
    expect(termsStatusLine({ check: null })).toBe("Terms not checked yet.");
  });
});

describe("Terms tab: decisions", () => {
  it("a decision without a reason is refused: the record button stays off until the reason says why", async () => {
    const { container } = render(<Harness initial={baseView()} />);
    const war = within(card(container, "f-war"));
    fireEvent.click(war.getByText("Accept"));
    const record = war.getByText("Record: Accept").closest("button") as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(war.getByLabelText("Reason for Accept"), { target: { value: "  ok fine " } });
    expect(record.disabled).toBe(true);
    fireEvent.click(record);
    expect(decide).not.toHaveBeenCalled();
    expect(war.getByText(/A reason of at least 10 characters is required/)).toBeTruthy();

    fireEvent.change(war.getByLabelText("Reason for Accept"), { target: { value: "  Standard warranty for this buyer.  " } });
    expect(record.disabled).toBe(false);
    await act(async () => { fireEvent.click(record); });
    expect(decide).toHaveBeenCalledWith("o1", "f-war", "accept", "Standard warranty for this buyer.");
    await waitFor(() => expect(card(container, "f-war").textContent).toContain("accepted"));
    expect(card(container, "f-war").querySelectorAll(".terms-history li")).toHaveLength(1);
  });

  it("an engineer is not offered accept on a critical flag, and may request an amendment", async () => {
    const { container } = render(<Harness initial={baseView()} />);
    const ld = within(card(container, "f-ld"));
    expect(ld.queryByText("Accept")).toBeNull();
    expect(ld.queryByText("Not a deviation")).toBeNull();
    expect(ld.getByText("Accepting a critical flag needs a sales manager or an admin.")).toBeTruthy();
    fireEvent.click(ld.getByText("Request amendment"));
    fireEvent.change(ld.getByLabelText("Reason for Request amendment"), { target: { value: "Ask the buyer to cap LD at 5%." } });
    await act(async () => { fireEvent.click(ld.getByText("Record: Request amendment")); });
    expect(decide).toHaveBeenCalledWith("o1", "f-ld", "request_amendment", "Ask the buyer to cap LD at 5%.");
  });

  it("a manager is offered every decision the server allows", () => {
    installRbac("sales_manager");
    const v = baseView();
    v.flags[0].allowed = ALL;
    const { container } = render(<Harness initial={v} />);
    const ld = within(card(container, "f-ld"));
    for (const label of ["Accept", "Request amendment", "Reject term", "Not a deviation"]) expect(ld.getByText(label)).toBeTruthy();
  });

  it("shows the server's refusal", async () => {
    decide = vi.fn(async () => { throw new Error("Accepting a high flag needs a sales manager or an admin (order.terms_accept_high)."); });
    installBackend({ orders: { termsDecide: decide } });
    const { container } = render(<Harness initial={baseView()} />);
    const war = within(card(container, "f-war"));
    fireEvent.click(war.getByText("Accept"));
    fireEvent.change(war.getByLabelText("Reason for Accept"), { target: { value: "Standard warranty for this buyer." } });
    await act(async () => { fireEvent.click(war.getByText("Record: Accept")); });
    expect(war.getByRole("alert").textContent).toContain("order.terms_accept_high");
  });

  it("a role without the decide action sees the flags and no decision buttons", () => {
    installRbac("viewer");
    const { container } = render(<Harness initial={baseView()} canWrite={false} />);
    expect(container.textContent).toContain("Payment: 60 days from the date of GRN");
    expect(container.querySelector(".terms-decide")).toBeNull();
    expect(container.textContent).not.toContain("Re-check terms");
  });

  it("re-checks the terms and shows the new result", async () => {
    const { container, getByText } = render(<Harness initial={baseView()} />);
    await act(async () => { fireEvent.click(getByText("Re-check terms")); });
    expect(recheck).toHaveBeenCalledWith("o1", { includeShadow: false });
    await waitFor(() => expect(container.querySelector('[data-testid="terms-status"]')!.textContent).toBe("Terms read: 2 clauses, No flags."));
  });
});

describe("Terms tab: shadow mode", () => {
  it("an admin sees a shadow badge and re-checks with include_shadow", async () => {
    installRbac("admin");
    const { container, getByText } = render(<Harness initial={{ ...baseView(), mode: "shadow", shadow: true }} isAdmin />);
    expect(container.textContent).toContain("shadow");
    expect(container.textContent).toContain("Engineers do not see these flags.");
    await act(async () => { fireEvent.click(getByText("Re-check terms")); });
    expect(recheck).toHaveBeenCalledWith("o1", { includeShadow: true });
  });
});
