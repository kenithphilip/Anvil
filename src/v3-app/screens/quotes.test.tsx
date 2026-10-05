// Smoke test for screens/quotes.tsx. Mirrors the pattern used by
// the other list screens (orders, recurring-invoices, etc.).
// Verifies the screen mounts, the tabs render, and the empty-state
// copy appears when the backend stub returns no rows.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend({
    quotes: {
      list: async () => ({ quotes: [] }),
    },
  });
  installRbac("admin");
});

describe("Quotes", () => {
  it("renders without throwing", async () => {
    const mod = await import("./quotes");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("renders the lifecycle tabs", async () => {
    const mod = await import("./quotes");
    const Screen = mod.default;
    const { findByText } = renderScreen(Screen);
    // The lifecycle tabs come from the screen's TABS array.
    expect(await findByText("All")).toBeTruthy();
    expect(await findByText("Draft")).toBeTruthy();
    expect(await findByText("Sent")).toBeTruthy();
    expect(await findByText("Won")).toBeTruthy();
  });

  it("shows the empty state when the backend returns no quotes", async () => {
    const mod = await import("./quotes");
    const Screen = mod.default;
    const { findByText } = renderScreen(Screen);
    expect(await findByText(/No quotes yet/i)).toBeTruthy();
  });

  it("exposes a New quote entry point", async () => {
    const mod = await import("./quotes");
    const Screen = mod.default;
    const { findByText } = renderScreen(Screen);
    // The create-from-scratch button lives in the title bar.
    expect(await findByText("New quote")).toBeTruthy();
  });
});

describe("Quotes drawer keyboard tab order", () => {
  it("steps from Terms to the Follow-up tab, then to History", async () => {
    const { fireEvent, waitFor } = await import("@testing-library/react");
    const listSpy = vi.fn(async () => ({ communications: [] }));
    installBackend({
      quotes: { list: async () => ({ quotes: [{ id: "q-1", quote_number: "Q-202610-0001", status: "SENT", version: 1, customer_id: "c-1" }] }) },
      communications: { list: listSpy, log: vi.fn() },
    });
    window.location.hash = "#/quotes?id=q-1&tab=terms";
    try {
      const { default: Screen } = await import("./quotes");
      const { findByText } = renderScreen(Screen);
      expect(await findByText("Ad-hoc terms")).toBeTruthy();
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(await findByText("Log a touch")).toBeTruthy();
      await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ object_type: "quote", object_id: "q-1", versions: "all" }));
      expect(window.location.hash).toBe("#/quotes?id=q-1&tab=followup");
      fireEvent.keyDown(window, { key: "ArrowRight" });
      await waitFor(() => expect(window.location.hash).toBe("#/quotes?id=q-1&tab=history"));
    } finally {
      window.location.hash = "";
    }
  });
});

describe("Quotes drawer Esc with an unsent touch note", () => {
  it("keeps the quote open while the note has text, and closes it once the note is empty", async () => {
    const { fireEvent, waitFor } = await import("@testing-library/react");
    installBackend({
      quotes: { list: async () => ({ quotes: [{ id: "q-1", quote_number: "Q-202610-0001", status: "SENT", version: 1, customer_id: "c-1" }] }) },
      communications: { list: vi.fn(async () => ({ communications: [] })), log: vi.fn() },
    });
    window.location.hash = "#/quotes?id=q-1&tab=followup";
    try {
      const { default: Screen } = await import("./quotes");
      const { findByLabelText } = renderScreen(Screen);
      const notes = await findByLabelText("Touch notes");
      fireEvent.change(notes, { target: { value: "Plant head wants a call Monday" } });
      fireEvent.keyDown(notes, { key: "Escape" });
      expect(window.location.hash).toBe("#/quotes?id=q-1&tab=followup");
      expect((notes as HTMLTextAreaElement).value).toBe("Plant head wants a call Monday");
      fireEvent.change(notes, { target: { value: "" } });
      fireEvent.keyDown(notes, { key: "Escape" });
      await waitFor(() => expect(window.location.hash).not.toContain("id=q-1"));
    } finally {
      window.location.hash = "";
    }
  });
});
