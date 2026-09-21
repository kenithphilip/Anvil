// The delivery_note kind: registered everywhere it has to be, and the two
// header spreads that were already broken.
//
// WHY THIS KIND EXISTS. PR #539 shipped a pre-send check asking whether the
// consignment behind an invoice can lawfully move. It reports `docket_missing`
// on every invoice, because the docket number is typed into Tally at despatch
// and Anvil never sees it. The challan is the only artefact that already exists
// on every consignment and carries the docket, the e-way bill reference and the
// quantity that actually left.
//
// THE DANGEROUS OMISSIONS ARE SILENT. Registering a kind in the obvious places
// (prompt, tool, gate) produces a run that returns status ok with correct lines
// and still does nothing useful, because two other registrations decide whether
// the header survives normalization and whether the only capable adapter ever
// runs. Both have already been missed once in this repository, which is why they
// are asserted generically below rather than one kind at a time.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KIND_GATES_TABLE } from "../api/_lib/docai/run.js";
import { KIND_CAPABLE_ADAPTERS } from "../api/_lib/docai/index.js";
import { DELIVERY_NOTE_TOOL, DELIVERY_NOTE_SYSTEM_PROMPT } from "../api/_lib/docai/claude.js";
import { profileFor } from "../api/eval/kind-profiles.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const claude = read("src/api/_lib/docai/claude.js");
const gemini = read("src/api/_lib/docai/gemini.js");

describe("delivery_note: the loud registrations", () => {
  it("has a gate entry that requires lines", () => {
    // A challan with no line items has not told us what moved, which is the
    // only reason it is read.
    expect(KIND_GATES_TABLE.delivery_note).toBeDefined();
    expect(KIND_GATES_TABLE.delivery_note.reject).toBe("non_delivery_note");
    expect(KIND_GATES_TABLE.delivery_note.requiresLines).toBe(true);
  });

  it("is permitted by the migration on runs AND jobs", () => {
    // A kind allowed on a run but refused at enqueue is a confusing way to
    // discover the two lists had drifted — which has happened.
    const mig = read("supabase/migrations/226_delivery_note_kind.sql");
    // Asserted per-constraint rather than by counting occurrences: a count
    // tells you the string is present N times, not that it is present in the
    // two places that matter.
    const runsBlock = mig.slice(mig.indexOf("extraction_runs_extraction_kind_check"), mig.indexOf("extraction_jobs"));
    const jobsBlock = mig.slice(mig.indexOf("extraction_jobs_extraction_kind_check"));
    expect(runsBlock, "delivery_note not permitted on extraction_runs").toMatch(/'delivery_note'/);
    expect(jobsBlock, "delivery_note not permitted on extraction_jobs").toMatch(/'delivery_note'/);
  });

  it("is a known kind at enqueue", () => {
    expect(read("src/api/orders/extraction_jobs.js")).toMatch(/"delivery_note"/);
  });

  it("has an eval profile that scores the docket and the despatched quantity", () => {
    const p = profileFor("delivery_note");
    expect(p).toBeTruthy();
    const headerKeys = p.header.map((h) => h.key);
    expect(headerKeys).toContain("docketNo");
    // Scored separately from invoiceNo because returning one document's number
    // for both is the most common error on a challan.
    expect(headerKeys).toContain("buyerPoNo");
    expect(p.line.map((l) => l.key)).toContain("qty");
  });

  it("has a golden fixture the profile can read", () => {
    const f = readdirSync(join(ROOT, "scripts/eval/fixtures"))
      .filter((n) => n.startsWith("delivery-note-"));
    expect(f.length).toBeGreaterThan(0);
    const fx = JSON.parse(read("scripts/eval/fixtures/" + f[0]));
    expect(fx.kind).toBe("delivery_note");
    // The fixture must exercise the two-quantity-column trap, or it is not
    // testing the thing most likely to go wrong.
    expect(fx.normalized.lines.some((l) => l.ordered_qty != null && l.ordered_qty !== l.quantity)).toBe(true);
  });

  it("is routed and reachable from the client", () => {
    expect(read("src/api/router.js")).toMatch(/"\/documents\/delivery_note_ingest"/);
    expect(read("src/client/anvil-client.js")).toMatch(/ingestDeliveryNote/);
  });
});

describe("delivery_note: the prompt earns its keep", () => {
  it("names the despatched-vs-ordered trap explicitly", () => {
    // The single most likely extraction error: a partial-shipment challan
    // prints both columns and the wrong one is returned.
    expect(DELIVERY_NOTE_SYSTEM_PROMPT).toMatch(/ordered/i);
    expect(DELIVERY_NOTE_SYSTEM_PROMPT).toMatch(/quantity is ALWAYS what is moving now/);
  });

  it("carries the multi-row guidance", () => {
    // Absent from the quote prompt for a year, which is how a 32-line document
    // returned zero lines. A challan is a line-item table like any other.
    expect(DELIVERY_NOTE_SYSTEM_PROMPT).toMatch(/MULTI-ROW-PER-ITEM/);
  });

  it("distinguishes the docket from the challan and the vehicle", () => {
    expect(DELIVERY_NOTE_SYSTEM_PROMPT).toMatch(/NOT the challan/);
  });

  it("declares quantity as this consignment, not the order", () => {
    const q = DELIVERY_NOTE_TOOL.input_schema.properties.lines.items.properties.quantity;
    expect(q.description).toMatch(/THIS consignment/);
  });
});

describe("gemini refuses the kind rather than silently mis-reading it", () => {
  it("has no delivery_note branch, by design", () => {
    // The house pattern since #485: the kind-specific schemas live in claude
    // and gemini REFUSES an unsupported kind. That is safe. What is NOT safe is
    // a kind missing from KIND_CAPABLE_ADAPTERS — see the next block.
    expect(gemini).not.toMatch(/delivery_note/);
  });
});

// ── The two silent registrations, asserted generically ──────────────────────
//
// Both of these have been missed once already in this repository. Asserting
// them per-kind is what allowed that; asserting them over the whole kind list
// is the actual fix.
describe("every kind with its own tool is fully wired", () => {
  // Kinds whose extraction uses a dedicated claude tool + prompt.
  const TOOLED_KINDS = ["quote", "sales_order", "packing_list", "invoice", "eway_bill", "delivery_note"];

  it.each(TOOLED_KINDS)("%s appears in KIND_CAPABLE_ADAPTERS", (kind) => {
    // Without this, claude — the only adapter that implements the schema — is
    // ordered LAST behind six adapters sharing one budget, and the deadline
    // allocator can skip it outright. The run then returns whatever the
    // deterministic parsers managed. sales_order shipped with exactly this
    // defect and nothing caught it.
    expect(KIND_CAPABLE_ADAPTERS[kind], `${kind} missing from KIND_CAPABLE_ADAPTERS`).toBeDefined();
    expect(KIND_CAPABLE_ADAPTERS[kind]).toContain("claude");
  });

  it.each(TOOLED_KINDS)("%s has a header spread in the normalizer", (kind) => {
    // Selecting a prompt and a tool does NOT carry header fields into
    // `normalized` — only the conditional spread does. Without one, every
    // header field the tool declares is extracted by the model and then
    // dropped. invoice and eway_bill BOTH shipped this way: the e-way bill
    // compose endpoint documents that it reads normalized_extract.eway_bill,
    // a key nothing wrote.
    const flag = "is" + kind.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
    expect(claude, `${flag} flag missing`).toMatch(new RegExp("const " + flag + " ="));
    expect(claude, `no header spread for ${kind} (fields would be dropped at normalization)`)
      .toMatch(new RegExp("\\.\\.\\.\\(" + flag + " \\? \\{"));
  });
});
