// EA-7: the "My email actions" card on Home. A writer sees their open email
// actions (scope=mine); a viewer, who cannot open the screen, sees no card.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const list = vi.fn(async () => ({
  actions: [
    { id: "ea-1", title: "Reply: confirm the order", priority_label: "high", overdue: true },
    { id: "ea-2", title: "Send documents: test report", priority_label: "normal", overdue: false },
  ],
}));

beforeEach(() => {
  list.mockClear();
  installBackend({ emailActions: { list } });
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("prompt", () => null);
});

describe("Home: my email actions", () => {
  it("lists the caller's open email actions and opens one", async () => {
    installRbac("sales_engineer");
    const mod = await import("./home");
    const { findByText, getByText } = renderScreen(mod.default);
    expect(await findByText("My email actions")).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ scope: "mine" });
    expect(await findByText("2 open · 1 overdue")).toBeTruthy();
    fireEvent.click(getByText("Reply: confirm the order"));
    await waitFor(() => expect(window.location.hash).toBe("#/email-actions?sub=mine&id=ea-1"));
  });

  it("a viewer gets no card and no call", async () => {
    installRbac("viewer");
    const mod = await import("./home");
    const { queryByText, container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
    expect(queryByText("My email actions")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});
