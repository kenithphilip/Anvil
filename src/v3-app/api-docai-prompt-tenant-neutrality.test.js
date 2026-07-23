// The extraction prompts must be ENTITY-AGNOSTIC.
//
// Anvil is multi-tenant, so a worked example naming a real seller or buyer is
// not cosmetic: the prompt is the model's only prior, and concrete literals
// bias extraction toward one tenant's part formats and one buyer's layout.
// A tenant whose codes look nothing like the example gets measurably worse
// results from a prompt that keeps insisting on someone else's.
//
// Identity belongs in per-tenant data (customer_format_profiles, the tenant
// record, docai_part_split_* settings), never in a shared prompt string.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DOCAI = join(dirname(fileURLToPath(import.meta.url)), "..", "api", "_lib", "docai");
const read = (f) => readFileSync(join(DOCAI, f), "utf8");

// Real sellers/buyers that have appeared in these prompts. Third-party
// COMPONENT brands used to teach "the brand on the part is not the customer"
// (SKF, Schneider) are deliberately allowed — they are illustrative, not
// tenant or customer identity.
const FORBIDDEN = [
  "OBARA", "MAHINDRA", "MMIL", "HYUNDAI", "KIA",
  "TWS-092", "X-HD0420", "TNA-16-04", "4-ET31062", "403A7K",
];

describe.each(["claude.js", "gemini.js"])("%s prompt is entity-agnostic", (file) => {
  const src = read(file);

  it.each(FORBIDDEN)("contains no reference to %s", (needle) => {
    expect(src.toUpperCase()).not.toContain(needle.toUpperCase());
  });

  it("still teaches the part-from-description rule with a synthetic example", () => {
    // Removing the identity must NOT remove the instruction.
    expect(src).toMatch(/AB-1042-7/);
    expect(src.toLowerCase()).toContain("prefix");
  });
});
