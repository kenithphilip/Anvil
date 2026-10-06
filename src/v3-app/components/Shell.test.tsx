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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

/* Collapsed rail (56px) leaves ~28px of content width after padding. The
   avatar alone is 22px, so the name/role block and the settings gear
   overlapped — the reported layout break. jsdom does not apply styles.css,
   so these pin the two halves of the fix that are actually checkable: the
   identity block is a targetable element, and the stylesheet still carries
   the rule that hides it and stacks the footer. */
describe("sidebar footer survives the collapsed rail", () => {
  it("wraps the name/role in a targetable .side-foot-id block", () => {
    const { container } = render(<Wrap><Shell route="home" onRoute={() => {}}>x</Shell></Wrap>);
    const foot = container.querySelector(".side-foot");
    expect(foot).not.toBeNull();
    expect(foot!.querySelector(".side-foot-id")).not.toBeNull();
    // The avatar stays outside it, so hiding the text never hides identity.
    expect(foot!.querySelector(".av")).not.toBeNull();
  });

  it("puts the full name on the avatar title, so collapsing loses nothing", () => {
    const { container } = render(<Wrap><Shell route="home" onRoute={() => {}}>x</Shell></Wrap>);
    const av = container.querySelector(".side-foot .av") as HTMLElement;
    expect(av.getAttribute("title") || "").toMatch(/·/);
  });

  it("stylesheet hides the identity block and stacks the footer when collapsed", () => {
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    expect(css).toMatch(/\[data-rail="collapsed"\]\s*\.side-foot-id\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\[data-rail="collapsed"\]\s*\.side-foot\s*\{[^}]*flex-direction:\s*column/);
  });

  it("long names ellipsis rather than pushing the gear out of the rail", () => {
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    expect(css).toMatch(/\.side-foot-name,[\s\S]{0,80}text-overflow:\s*ellipsis/);
  });
});
