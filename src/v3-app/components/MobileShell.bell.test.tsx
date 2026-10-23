// The phone has a bell too (C-17). MobileShell had none, so a person away
// from a desktop never saw a notice. It shows for every role.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { MobileShell } from "./MobileShell";
import { Wrap, installBackend } from "../test-utils";

const notice = { id: "n-7", kind: "so_returned", title: "Order returned for correction", body: "Order 81 needs a fix", read_by: [] };
let markRead: ReturnType<typeof vi.fn>;

beforeEach(() => {
  markRead = vi.fn(async () => ({ ok: true }));
  installBackend({
    notifications: {
      list: async () => ({ notifications: [notice], unread_count: 1 }),
      markRead,
      markAllRead: async () => ({ ok: true }),
    },
  });
});

describe("MobileShell bell", () => {
  it.each(["sales_engineer", "viewer", "admin"])("renders in the header for %s", async (id) => {
    const { findByRole, container } = render(
      <Wrap><MobileShell route="home" nav={[]} role={{ id, label: id, short: id } as any}>x</MobileShell></Wrap>,
    );
    const bell = await findByRole("button", { name: "1 unread notifications" });
    expect(container.querySelector(".app-mobile-head")?.contains(bell)).toBe(true);
  });

  it("opens the list and marks the tapped row read", async () => {
    const { findByRole, findByText } = render(
      <Wrap><MobileShell route="home" nav={[]} role={{ id: "sales_engineer", label: "Sales Engineer", short: "ENG" } as any}>x</MobileShell></Wrap>,
    );
    fireEvent.click(await findByRole("button", { name: "1 unread notifications" }));
    fireEvent.click(await findByText(notice.title));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith("n-7"));
  });
});
