// Identifiers render VERBATIM in the recon grid.
//
// Regression, Aug 2026: a PO whose "Item No" column printed the buyer's
// material code in upper case was reported as "it added characters in the
// customer part number and didn't consider case sensitivity" — the chip on
// screen read `sap gd5442…` against `GD5442…` on the PDF. Nothing was
// corrupted: `.chip` carries `text-transform: lowercase` (right for status
// words like "explicit", wrong for a code), and the caption ran into
// the value inside one monospace pill so it read as extra characters.
//
// jsdom does not apply styles.css, so a render assertion cannot observe the
// transform. These tests pin the two things that actually prevent the
// recurrence: the DOM text stays byte-identical to what was extracted, the
// chip carries the `code` opt-out class, and styles.css still defines that
// opt-out. Fixtures are tenant-neutral — no real buyer, seller or part code.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-case-1";
const SOURCE_ID = "doc-case-1";

// Mixed case on purpose: an upper-case code (the reported shape) and a
// genuinely mixed-case one, so a "just uppercase everything" fix fails too.
const BUYER_CODE = "AB123456789012345";
const MIXED_CODE = "Zq7-Kd0091x";
const OUR_PART = "XX375SQ-1200L";

const order = {
  id: ORDER_ID,
  status: "PENDING_REVIEW",
  po_number: "PO-6001",
  customer_id: "cust-1",
  customer_name: "Fixture Customer",
  result: {
    salesOrder: {
      customer: { name: "Fixture Customer" },
      lineItems: [
        {
          partNumber: OUR_PART,
          description: "Jumper cable",
          customerItemCode: BUYER_CODE,
          qty: 2,
          rate: 1000,
          uom: "NOS",
        },
        {
          partNumber: "YY-9",
          description: "Contact tip",
          customer_item_code: MIXED_CODE,
          qty: 50,
          rate: 20,
          uom: "NOS",
        },
      ],
    },
  },
  preflight_payload: { source_document_id: SOURCE_ID, extraction_run_id: "run-1" },
  documents: [{ id: SOURCE_ID }],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

beforeEach(() => {
  installBackend({
    orders: { get: vi.fn(async () => ({ order })), update: vi.fn(async () => ({})) },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
  });
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
  window.location.hash = "#/so?id=" + ORDER_ID;
});

// Select by the CODE, not by the caption wording — the caption is copy and
// may be reworded; the invariant under test is the code itself. A chip that
// lowercased its content stops matching here, which is the failure we want.
const buyerCodeChips = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("span.chip")).filter((el) => {
    const t = el.textContent || "";
    return t.includes(BUYER_CODE) || t.includes(MIXED_CODE);
  });

describe("recon grid renders buyer item codes verbatim", () => {
  it("keeps the extracted case in the DOM, both camel and snake shapes", async () => {
    const mod = await import("./so-workspace");
    const { container } = renderScreen(mod.default);
    await waitFor(() => expect(container.innerHTML).toContain("Line reconciliation"));

    const chips = buyerCodeChips(container);
    expect(chips.length).toBe(2);

    const texts = chips.map((el) => el.textContent || "");
    // Byte-identical to the extraction. Not uppercased, not lowercased.
    expect(texts.some((t) => t.includes(BUYER_CODE))).toBe(true);
    expect(texts.some((t) => t.includes(MIXED_CODE))).toBe(true);
    expect(texts.join(" ")).not.toContain(BUYER_CODE.toLowerCase());
    expect(texts.join(" ")).not.toContain(MIXED_CODE.toUpperCase());
  });

  it("marks every identifier chip with the `code` transform opt-out", async () => {
    const mod = await import("./so-workspace");
    const { container } = renderScreen(mod.default);
    await waitFor(() => expect(container.innerHTML).toContain("Line reconciliation"));

    const chips = buyerCodeChips(container);
    // Guard the guard: an empty list would make the loop vacuously pass.
    expect(chips.length).toBe(2);
    for (const chip of chips) {
      expect(chip.classList.contains("code")).toBe(true);
    }
  });

  it("keeps the caption in its own element so it cannot read as extra characters", async () => {
    const mod = await import("./so-workspace");
    const { container } = renderScreen(mod.default);
    await waitFor(() => expect(container.innerHTML).toContain("Line reconciliation"));

    const chip = buyerCodeChips(container).find((el) => (el.textContent || "").includes(BUYER_CODE))!;
    const lbl = chip.querySelector<HTMLElement>(".lbl");
    // The caption is a separate element (dimmer + letter-spaced in CSS), and
    // the code is NOT inside it. Wording is deliberately not asserted.
    expect(lbl).toBeTruthy();
    expect(lbl!.textContent).not.toContain(BUYER_CODE);
    // Whatever remains after the caption is the code, byte for byte.
    const rest = (chip.textContent || "").replace(lbl!.textContent || "", "").trim();
    expect(rest).toBe(BUYER_CODE);
  });
});

describe("Chip primitive + stylesheet contract", () => {
  it("Chip maps the `code` prop onto the opt-out class", async () => {
    const { Chip } = await import("../lib/primitives");
    const { container } = renderScreen(() => <Chip k="ghost" code>{BUYER_CODE}</Chip>);
    const el = container.querySelector("span.chip")!;
    expect(el.classList.contains("code")).toBe(true);
    expect(el.textContent).toBe(BUYER_CODE);

    const plain = renderScreen(() => <Chip k="ghost">draft</Chip>);
    expect(plain.container.querySelector("span.chip")!.classList.contains("code")).toBe(false);
  });

  it("styles.css still defines the .chip.code opt-out", () => {
    // vitest runs in a jsdom env, where import.meta.url is an http URL —
    // resolve from the repo root like the other source-reading tests do.
    const css = readFileSync(resolve(process.cwd(), "src/v3-app/styles.css"), "utf8");
    // .chip lowercases by design (status words). Deleting the opt-out
    // re-introduces the bug silently, so pin both halves.
    expect(css).toMatch(/\.chip\s*\{[^}]*text-transform:\s*lowercase/);
    expect(css).toMatch(/\.chip\.code\s*\{[^}]*text-transform:\s*none/);
  });
});
