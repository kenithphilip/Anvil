// The bell shows for every role on the desktop Shell (C-17). It used to
// render for admin and operator only. The server decides which rows each
// person sees; the Shell shows them and marks a clicked row read.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { Shell } from "./Shell";
import { Wrap, installBackend } from "../test-utils";

const notice = { id: "n-1", kind: "so_sent_for_approval", title: "Order sent for approval", body: "Order 81 needs a decision", read_by: [] };
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

const ROLES = [
  { id: "sales_engineer", label: "Sales Engineer", short: "ENG" },
  { id: "viewer", label: "Viewer", short: "VW" },
  { id: "finance", label: "Finance", short: "FIN" },
  { id: "customer_support", label: "Customer Support", short: "CS" },
];

describe("Shell bell for every role", () => {
  it.each(ROLES)("renders for $id with the unread count", async (role) => {
    const { findByRole } = render(<Wrap><Shell route="home" nav={[]} role={role as any}>x</Shell></Wrap>);
    const bell = await findByRole("button", { name: "1 unread notifications" });
    expect(bell).toBeTruthy();
  });

  it("opens the list and marks the clicked row read", async () => {
    const role = ROLES[0];
    const { findByRole, findByText } = render(<Wrap><Shell route="home" nav={[]} role={role as any}>x</Shell></Wrap>);
    fireEvent.click(await findByRole("button", { name: "1 unread notifications" }));
    fireEvent.click(await findByText(notice.title));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith("n-1"));
  });
});
