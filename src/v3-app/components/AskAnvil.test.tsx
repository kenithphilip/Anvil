// The floating surface renders only for a tenant that asked for it.
//
// The most important assertion in this file is the boring one: with the flag
// off, NOTHING is in the DOM. Not a hidden button, not an aria-live region —
// nothing. A client who has not bought this feature should not be able to tell
// it exists.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { AskAnvil, __resetPersonaCache } from "./AskAnvil";

const personas = vi.fn();
const send = vi.fn();

beforeEach(() => {
  __resetPersonaCache();
  personas.mockReset();
  send.mockReset();
  (window as any).AnvilBackend = { agent: { personas }, erpChat: { send } };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const SO = { id: "so", label: "Sales order agent", routes: ["so"], placeholder: "Ask about this order…" };

const ctx = { anomalies: [{ code: "document_total_shortfall", severity: "warn", actual: 100, expected: 150 }], findings: [], lines: [], poNumber: "0066026562" };

describe("tenant gating", () => {
  it("renders nothing at all when the tenant has no personas", async () => {
    personas.mockResolvedValue({ personas: [] });
    render(<AskAnvil route="so" context={ctx} />);
    await waitFor(() => expect(personas).toHaveBeenCalled());
    expect(document.querySelector(".aa-fab")).toBeNull();
  });

  it("renders nothing when the endpoint fails — never fails open", async () => {
    personas.mockRejectedValue(new Error("403"));
    render(<AskAnvil route="so" context={ctx} />);
    await waitFor(() => expect(personas).toHaveBeenCalled());
    expect(document.querySelector(".aa-fab")).toBeNull();
  });

  it("renders nothing on a route the persona does not claim", async () => {
    personas.mockResolvedValue({ personas: [SO] });
    render(<AskAnvil route="spares" context={ctx} />);
    await waitFor(() => expect(personas).toHaveBeenCalled());
    expect(document.querySelector(".aa-fab")).toBeNull();
  });

  it("shows the button once the tenant has the persona on this route", async () => {
    personas.mockResolvedValue({ personas: [SO] });
    render(<AskAnvil route="so" context={ctx} />);
    expect(await screen.findByRole("button", { name: /ask anvil/i })).toBeTruthy();
  });
});

describe("escaping a transformed ancestor", () => {
  // THE BUG THIS FIXES. position:fixed resolves against the nearest ancestor
  // that establishes a containing block, and ANY non-`none` transform does —
  // including the identity matrix a finished animation leaves behind. The v3
  // screen wrapper `.route-enter` carries exactly that, which pinned the button
  // to the bottom of the screen CONTENT so it scrolled away instead of floating.
  it("renders into document.body, not into the transformed subtree", async () => {
    personas.mockResolvedValue({ personas: [SO] });
    const { container } = render(
      <div className="route-enter" style={{ transform: "translateZ(0)" }}>
        <AskAnvil route="so" context={ctx} />
      </div>,
    );
    await screen.findByRole("button", { name: /ask anvil/i });
    // Present in the document...
    expect(document.querySelector(".aa-fab")).toBeTruthy();
    // ...but NOT inside the transformed wrapper, which is the whole point.
    expect(container.querySelector(".aa-fab")).toBeNull();
    expect(document.querySelector(".route-enter .aa-fab")).toBeNull();
  });

  it("puts the open panel outside that subtree too", async () => {
    personas.mockResolvedValue({ personas: [SO] });
    const { container } = render(
      <div className="route-enter" style={{ transform: "translateZ(0)" }}>
        <AskAnvil route="so" context={ctx} />
      </div>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /ask anvil/i }));
    expect(document.querySelector(".aa-panel")).toBeTruthy();
    expect(container.querySelector(".aa-panel")).toBeNull();
  });
});

describe("one fetch for many mounts", () => {
  it("does not re-request personas when the screen remounts it", async () => {
    personas.mockResolvedValue({ personas: [SO] });
    const { unmount } = render(<AskAnvil route="so" context={ctx} />);
    await screen.findByRole("button", { name: /ask anvil/i });
    unmount();
    render(<AskAnvil route="so" context={ctx} />);
    await screen.findByRole("button", { name: /ask anvil/i });
    expect(personas).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failure — a 401 mid-refresh must not disable the surface", async () => {
    personas.mockRejectedValueOnce(new Error("401"));
    const { unmount } = render(<AskAnvil route="so" context={ctx} />);
    await waitFor(() => expect(personas).toHaveBeenCalledTimes(1));
    unmount();
    personas.mockResolvedValue({ personas: [SO] });
    render(<AskAnvil route="so" context={ctx} />);
    expect(await screen.findByRole("button", { name: /ask anvil/i })).toBeTruthy();
  });
});

describe("the panel", () => {
  const open = async () => {
    personas.mockResolvedValue({ personas: [SO] });
    render(<AskAnvil route="so" context={ctx} />);
    fireEvent.click(await screen.findByRole("button", { name: /ask anvil/i }));
  };

  it("states plainly that it cannot change the order", async () => {
    await open();
    expect(screen.getByText(/cannot change this order/i)).toBeTruthy();
  });

  it("offers suggestions derived from the order's own checks", async () => {
    await open();
    expect(screen.getByText(/document_total_shortfall/)).toBeTruthy();
  });

  it("seeds the composer from a suggestion WITHOUT sending it", async () => {
    await open();
    fireEvent.click(screen.getByText(/document_total_shortfall/).closest("button")!);
    const input = screen.getByLabelText("Ask Anvil") as HTMLInputElement;
    expect(input.value).toMatch(/gap/i);
    expect(send).not.toHaveBeenCalled();      // clicking a chip is not a send
  });

  it("sends with the persona id so the server can re-check the flag", async () => {
    send.mockResolvedValue({ content: "Here is the answer.", session_id: "s1" });
    await open();
    const input = screen.getByLabelText("Ask Anvil");
    fireEvent.change(input, { target: { value: "why is it short?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toMatchObject({ persona: "so" });
  });

  it("identifies the record with a STRUCTURED id, never inside the message text", async () => {
    // The bug this replaces: a PO number written into the message was matched
    // by a redaction rule and reached the model as "[redacted-phone]", so the
    // agent could not tell which order it was looking at.
    send.mockResolvedValue({ content: "ok", session_id: "s1" });
    personas.mockResolvedValue({ personas: [SO] });
    render(<AskAnvil route="so" context={ctx} recordId="d4227d84-2fd8-4d5b-b3b7-4041cc81799f" />);
    fireEvent.click(await screen.findByRole("button", { name: /ask anvil/i }));

    fireEvent.change(screen.getByLabelText("Ask Anvil"), { target: { value: "what is the total?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const first = send.mock.calls[0][0];
    expect(first.record_id).toBe("d4227d84-2fd8-4d5b-b3b7-4041cc81799f");
    // The message carries ONLY what the operator typed.
    expect(first.content).toBe("what is the total?");
    expect(first.content).not.toMatch(/Context:/);

    fireEvent.change(screen.getByLabelText("Ask Anvil"), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    // The session carries it from here; re-reading the order every turn is waste.
    expect(send.mock.calls[1][0].record_id).toBeUndefined();
    expect(send.mock.calls[1][0].session_id).toBe("s1");
  });

  it("surfaces the real error rather than a shrug", async () => {
    send.mockRejectedValue(new Error("persona not available for this tenant"));
    await open();
    fireEvent.change(screen.getByLabelText("Ask Anvil"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "persona not available for this tenant");
  });

  it("closes back to the button", async () => {
    await open();
    fireEvent.click(screen.getByLabelText("Close Ask Anvil"));
    expect(screen.getByRole("button", { name: /ask anvil/i })).toBeTruthy();
  });
});
