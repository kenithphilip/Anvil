// Tests for the pricing-profiles admin panel: lists global + tenant
// profiles, "Customize" opens a clone editor, and saving posts the
// component list back through the facade.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { PricingProfilesAdmin } from "./PricingProfilesAdmin";

const PROFILES = [
  {
    id: "g1", tenant_id: null, code: "granular", label: "Granular", margin_floor_pct: 0.05,
    components: [
      { seq: 1, code: "fx", label: "Supplier price in INR", kind: "fx_convert" },
      { seq: 2, code: "customs_duty", label: "Basic customs duty", kind: "pct_of", base_ref: "running", rate: 0.1 },
    ],
  },
  {
    id: "o1", tenant_id: "t-1", code: "house", label: "House profile", margin_floor_pct: 0.12,
    components: [{ seq: 1, code: "fx", label: "FX", kind: "fx_convert" }],
  },
];

describe("PricingProfilesAdmin", () => {
  let upsert: any;
  beforeEach(() => {
    upsert = vi.fn(async (p: any) => ({ profile: { id: "o2", tenant_id: "t-1", ...p } }));
    installBackend({
      admin: {
        listPricingProfiles: vi.fn(async () => ({ profiles: PROFILES })),
        upsertPricingProfile: upsert,
        deletePricingProfile: vi.fn(async () => ({ ok: true })),
      },
    });
  });

  it("lists global and tenant profiles with scope chips", async () => {
    const { findByText, getByText } = render(<PricingProfilesAdmin />);
    expect(await findByText("granular")).toBeTruthy();
    expect(getByText("house")).toBeTruthy();
    expect(getByText("Global default")).toBeTruthy();
    expect(getByText("Tenant")).toBeTruthy();
  });

  it("Customize opens the editor seeded with the global's components", async () => {
    const { findByText, getByLabelText, getByText } = render(<PricingProfilesAdmin />);
    await findByText("granular");
    // The global row's action is "Customize".
    fireEvent.click(getByText("Customize"));
    await waitFor(() => expect(getByLabelText("Profile code")).toBeTruthy());
    expect((getByLabelText("Profile code") as HTMLInputElement).value).toBe("granular");
    // The cloned components carry over (customs duty present).
    expect((getByLabelText("kind customs_duty") as HTMLSelectElement).value).toBe("pct_of");
  });

  it("saving posts the edited component list through the facade", async () => {
    const { findByText, getByText } = render(<PricingProfilesAdmin />);
    await findByText("granular");
    fireEvent.click(getByText("Customize"));
    await findByText("Save profile");
    fireEvent.click(getByText("Save profile"));
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    const payload = upsert.mock.calls[0][0];
    expect(payload.code).toBe("granular");
    expect(payload.components).toHaveLength(2);
    expect(payload.components.map((c: any) => c.code)).toContain("customs_duty");
  });
});
