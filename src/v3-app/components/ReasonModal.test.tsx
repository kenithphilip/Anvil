// The shared reason dialog: a reason is required (trimmed, at least
// REASON_MIN_LENGTH characters), and the confirm callback gets the trimmed
// text. Invented text only.

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { ReasonModal, REASON_MIN_LENGTH, cleanReason } from "./ReasonModal";

const confirmButton = () =>
  Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "Do it") as HTMLButtonElement;
const box = () => document.querySelector("[data-testid='reason-input']") as HTMLTextAreaElement;

const mount = (props: Partial<React.ComponentProps<typeof ReasonModal>> = {}) => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <ReasonModal open title="Decide this" confirmLabel="Do it" onConfirm={onConfirm} onClose={onClose} {...props} />,
  );
  return { ...view, onConfirm, onClose };
};

describe("ReasonModal", () => {
  it("needs a reason of the minimum length before it confirms", async () => {
    const { onConfirm } = mount();
    expect(REASON_MIN_LENGTH).toBe(10);
    expect(confirmButton().disabled).toBe(true);
    await act(async () => { fireEvent.change(box(), { target: { value: "too short" } }); });
    expect(confirmButton().disabled).toBe(true);
    expect(document.querySelector("[data-testid='reason-hint']")!.textContent).toBe("Type 1 more character.");
    await act(async () => { fireEvent.click(confirmButton()); });
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { fireEvent.change(box(), { target: { value: "Long enough now" } }); });
    expect(confirmButton().disabled).toBe(false);
    await act(async () => { fireEvent.click(confirmButton()); });
    expect(onConfirm).toHaveBeenCalledWith("Long enough now");
  });

  it("trims the reason, and spaces do not count toward the minimum", async () => {
    const { onConfirm } = mount();
    await act(async () => { fireEvent.change(box(), { target: { value: "      abc       " } }); });
    expect(confirmButton().disabled).toBe(true);
    await act(async () => { fireEvent.change(box(), { target: { value: "   Wrong ship-to   " } }); });
    await act(async () => { fireEvent.click(confirmButton()); });
    expect(onConfirm).toHaveBeenCalledWith("Wrong ship-to");
  });

  it("stays disabled while the decision is saving", async () => {
    const { onConfirm } = mount({ busy: true });
    await act(async () => { fireEvent.change(box(), { target: { value: "A valid reason" } }); });
    expect(confirmButton().disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("starts empty each time it opens", async () => {
    const onConfirm = vi.fn();
    const props = { title: "Decide this", confirmLabel: "Do it", onConfirm, onClose: vi.fn() };
    const { rerender } = render(<ReasonModal open {...props} />);
    await act(async () => { fireEvent.change(box(), { target: { value: "A reason typed once" } }); });
    rerender(<ReasonModal open={false} {...props} />);
    rerender(<ReasonModal open {...props} />);
    expect(box().value).toBe("");
  });

  it("cleanReason returns the trimmed text or null", () => {
    expect(cleanReason("  ten chars!  ")).toBe("ten chars!");
    expect(cleanReason("nine char")).toBe(null);
    expect(cleanReason(null)).toBe(null);
    expect(cleanReason("abc", 3)).toBe("abc");
  });
});
