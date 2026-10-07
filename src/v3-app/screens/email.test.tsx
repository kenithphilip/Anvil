// Email Triage screen: a smoke render, plus the intent chips and the
// "Complaints and support" filter. Started as the generated smoke test for
// screens/email.tsx and extended by hand.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  // jsdom's confirm/alert/prompt are no-ops by default; stub them so
  // accidental click handlers can't pop dialogs during a smoke render.
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("Email", () => {
  it("renders without throwing", async () => {
    const mod = await import("./email");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});

// ── Intent chips and the support filter ───────────────────────────────────
// Rows arrive in the /api/inbound/email/threads shape: classified_intent and
// classification_confidence (migration 067). Invented fixtures.

const ROWS = [
  { id: "e-1", thread_id: "th-1", from_address: "buyer@acme.example", subject: "RFQ for nozzle tips",
    priority_score: 80, classified_intent: "rfq", classification_confidence: 0.92, received_at: "2026-10-01T09:00:00Z" },
  { id: "e-2", thread_id: "th-2", from_address: "qa@bolt.example", subject: "Gun tip cracked after a week",
    priority_score: 40, classified_intent: "complaint", classification_confidence: 0.88, received_at: "2026-10-01T08:00:00Z" },
  { id: "e-3", thread_id: "th-3", from_address: "ops@core.example", subject: "How do we reset the controller",
    priority_score: 30, classified_intent: "support_question", classification_confidence: 0.71, received_at: "2026-10-01T07:00:00Z" },
  { id: "e-4", thread_id: "th-4", from_address: "purchase@delta.example", subject: "PO 7781 attached",
    priority_score: 90, classified_intent: "purchase_order", classification_confidence: 0.97, received_at: "2026-10-01T06:00:00Z" },
  { id: "e-5", thread_id: "th-5", from_address: "new@echo.example", subject: "Not yet classified",
    priority_score: 10, classified_intent: null, classification_confidence: null, received_at: "2026-10-01T05:00:00Z" },
];

const mount = async () => {
  // Answers like the real endpoint: an `intent` param narrows the rows.
  const listThreads = vi.fn(async (q?: any) => {
    const wanted = q?.intent ? String(q.intent).split(",") : null;
    return { messages: wanted ? ROWS.filter((r) => wanted.includes(r.classified_intent as string)) : ROWS };
  });
  installBackend({ inbound: { listThreads } });
  const mod = await import("./email");
  const utils = renderScreen(mod.default);
  await waitFor(() => expect(rowFor(utils.container, "RFQ for nozzle tips")).toBeTruthy());
  return { ...utils, listThreads };
};

// The selected email's subject also titles the detail card, so find the
// inbox row by its table cell, not by text alone.
const rowFor = (container: HTMLElement, subject: string) =>
  Array.from(container.querySelectorAll("tbody tr")).find((tr) => (tr.textContent || "").includes(subject)) as HTMLElement | undefined;
const shownSubjects = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("tbody tr")).map((tr) => (tr.querySelectorAll("td")[1]?.textContent || ""));
const intentCell = (container: HTMLElement, subject: string) =>
  rowFor(container, subject)!.querySelectorAll("td")[2] as HTMLElement;

describe("Email Triage: intent", () => {
  it("labels each row from classified_intent", async () => {
    const { container } = await mount();
    expect(within(intentCell(container, "RFQ for nozzle tips")).getByText("RFQ")).toBeTruthy();
    expect(within(intentCell(container, "Gun tip cracked after a week")).getByText("Complaint")).toBeTruthy();
    expect(within(intentCell(container, "How do we reset the controller")).getByText("Support")).toBeTruthy();
    expect(within(intentCell(container, "PO 7781 attached")).getByText("Customer PO")).toBeTruthy();
  });

  it("does not call a complaint or an unclassified row a Customer PO", async () => {
    const { container } = await mount();
    expect(intentCell(container, "Gun tip cracked after a week").textContent).not.toMatch(/Customer PO/);
    expect(intentCell(container, "Not yet classified").textContent).not.toMatch(/Customer PO/);
  });

  it("shows the classifier's intent and confidence for the selected email", async () => {
    const { container } = await mount();
    fireEvent.click(rowFor(container, "Gun tip cracked after a week")!);
    await waitFor(() => expect(container.textContent).toContain("0.88"));
  });
});

describe("Email Triage: Complaints and support filter", () => {
  it("shows only complaint and support_question rows", async () => {
    const { getByRole, container } = await mount();
    fireEvent.click(getByRole("tab", { name: /Complaints and support/ }));
    await waitFor(() => expect(shownSubjects(container).sort()).toEqual(
      ["Gun tip cracked after a week", "How do we reset the controller"]));
  });

  it("asks the endpoint for those intents, so the limit cannot cut them off", async () => {
    const { getByRole, listThreads } = await mount();
    fireEvent.click(getByRole("tab", { name: /Complaints and support/ }));
    await waitFor(() => expect(listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "complaint,support_question" })));
  });

  it("still filters when the endpoint ignores the intent param", async () => {
    const listThreads = vi.fn(async () => ({ messages: ROWS }));
    installBackend({ inbound: { listThreads } });
    const mod = await import("./email");
    const { getByRole, container } = renderScreen(mod.default);
    await waitFor(() => expect(shownSubjects(container)).toHaveLength(5));
    fireEvent.click(getByRole("tab", { name: /Complaints and support/ }));
    await waitFor(() => expect(shownSubjects(container).sort()).toEqual(
      ["Gun tip cracked after a week", "How do we reset the controller"]));
  });

  it("goes back to every row on All", async () => {
    const { getByRole, container } = await mount();
    fireEvent.click(getByRole("tab", { name: /Complaints and support/ }));
    await waitFor(() => expect(shownSubjects(container)).toHaveLength(2));
    fireEvent.click(getByRole("tab", { name: /^All$/ }));
    await waitFor(() => expect(shownSubjects(container)).toHaveLength(5));
  });
});
