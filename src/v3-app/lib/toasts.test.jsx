// Behavior tests for the toast queue. Confirms:
// - notify* functions push entries with correct kind + ttl
// - subscribers fire on push + dismiss
// - the window.notify* compat surface is wired
// - <ToastStack /> renders one row per active toast and Dismiss removes it

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, act } from "@testing-library/react";
import {
  notify, notifySuccess, notifyWarn, notifyError, notifyLive,
  dismiss, subscribe, current, ToastStack,
} from "./toasts.jsx";

beforeEach(() => {
  // Drain the queue between tests.
  for (const t of current()) dismiss(t.id);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("notify family", () => {
  it("returns a numeric id and pushes onto the queue", () => {
    const id = notifySuccess("Saved", "ok");
    expect(typeof id).toBe("number");
    const list = current();
    expect(list.length).toBe(1);
    expect(list[0].kind).toBe("good");
    expect(list[0].title).toBe("Saved");
    expect(list[0].body).toBe("ok");
  });
  it("sets ttl 8000 for bad and 4500 for everything else by default", () => {
    notifyError("e");
    notifyWarn("w");
    notify("i");
    notifyLive("l");
    const list = current();
    const byKind = Object.fromEntries(list.map((t) => [t.kind, t.ttlMs]));
    expect(byKind.bad).toBe(8000);
    expect(byKind.warn).toBe(4500);
    expect(byKind.info).toBe(4500);
    expect(byKind.live).toBe(4500);
  });
  it("auto-dismisses after ttlMs", () => {
    notifySuccess("hello", "world", { ttlMs: 1000 });
    expect(current().length).toBe(1);
    vi.advanceTimersByTime(1100);
    expect(current().length).toBe(0);
  });
  it("ttlMs:0 keeps the toast indefinitely", () => {
    const id = notifyWarn("sticky", "", { ttlMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(current().some((t) => t.id === id)).toBe(true);
    dismiss(id);
  });
});

describe("subscribe", () => {
  it("fires the listener on push and on dismiss", () => {
    const calls = [];
    const off = subscribe((next) => calls.push(next.length));
    notify("a");
    notify("b");
    const ids = current().map((t) => t.id);
    dismiss(ids[0]);
    expect(calls).toEqual([1, 2, 1]);
    off();
  });
  it("unsubscribe stops further notifications", () => {
    const calls = [];
    const off = subscribe((next) => calls.push(next.length));
    notify("a");
    off();
    notify("b");
    expect(calls).toEqual([1]);
  });
});

describe("window compat surface", () => {
  it("attaches notify* helpers + dismiss + subscribe to window", () => {
    expect(typeof window.notifySuccess).toBe("function");
    expect(typeof window.notifyWarn).toBe("function");
    expect(typeof window.notifyError).toBe("function");
    expect(typeof window.notify).toBe("function");
    expect(typeof window.notifyLive).toBe("function");
    expect(typeof window.notifyDismiss).toBe("function");
    expect(typeof window.__toastSubscribe).toBe("function");
    expect(typeof window.__toastsCurrent).toBe("function");
  });
});

describe("ToastStack render", () => {
  it("renders nothing when the queue is empty", () => {
    const { container } = render(<ToastStack />);
    expect(container.querySelector('[role="status"]')).toBeFalsy();
  });
  it("renders one banner per toast and dismiss removes it", () => {
    const { container, queryAllByRole } = render(<ToastStack />);
    act(() => { notify("A", "alpha"); notify("B", "beta"); });
    let banners = container.querySelectorAll(".banner");
    expect(banners.length).toBe(2);

    const dismissBtn = queryAllByRole("button", { name: /Dismiss/i })[0];
    act(() => { fireEvent.click(dismissBtn); });
    banners = container.querySelectorAll(".banner");
    expect(banners.length).toBe(1);
  });
});
