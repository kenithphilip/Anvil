// Behaviour test for the Shell's settings popover. Verifies:
//   * No floating ThemeBar elements are rendered (regression: the
//     previous fix-themebar branch added a fixed-position bar that
//     overlapped page content; that bar must stay gone).
//   * The gear button in the sidebar footer toggles a settings
//     popover with theme/density/sidebar/settings/sign-out rows.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { Shell } from "./Shell";
import { Wrap, installBackend, installRbac } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
});

const renderShell = () => render(
  <Wrap>
    <Shell route="home" nav={[]}>
      <div>page content</div>
    </Shell>
  </Wrap>,
);

describe("Shell settings popover", () => {
  it("does not render the floating ThemeBar that obscured content", () => {
    const { container } = renderShell();
    // Old offender: a fixed-position bar with these literal styles.
    const oldBar = container.querySelector('[style*="position: fixed"][style*="bottom: 36"]');
    expect(oldBar).toBeNull();
    expect(container.querySelector(".theme-bar")).toBeNull();
  });

  it("gear button opens a popover with theme/density/sidebar/settings/sign-out rows", async () => {
    const { container } = renderShell();
    // Closed by default.
    expect(container.querySelector(".settings-menu")).toBeNull();

    const gear = container.querySelector('button[aria-label="Settings"]') as HTMLElement | null;
    expect(gear).not.toBeNull();
    fireEvent.click(gear!);

    const menu = container.querySelector(".settings-menu");
    expect(menu).not.toBeNull();

    // Five rows expected (theme, density, sidebar, settings, sign out).
    const rows = container.querySelectorAll(".settings-menu-row");
    expect(rows.length).toBe(5);

    // Last row is the destructive sign-out row.
    const last = rows[rows.length - 1] as HTMLElement;
    expect(last.classList.contains("settings-menu-danger")).toBe(true);
    expect(last.textContent || "").toMatch(/sign out/i);
  });
});
