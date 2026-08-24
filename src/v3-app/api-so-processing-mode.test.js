// Mode A / Mode B: whether Anvil writes to the customer's ledger.
//
// A  Anvil processes the sales order and pushes the voucher. System of action.
// B  A person processes it by hand; Anvil records its own proposal, pushes
//    NOTHING, and compares.
//
// Mode B is the on-ramp. Nobody hands sales-order processing to software on a
// promise, and a vendor accuracy figure is a claim about a benchmark, not about
// their POs. A month of their own orders with both answers side by side is what
// actually decides it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES } from "../api/admin/so_processing_mode.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

describe("the mode column preserves existing behaviour", () => {
  const sql = read("supabase/migrations/221_so_processing_mode.sql");

  it("defaults to A, because every tenant is already doing A", () => {
    // Defaulting to B would silently stop the pushes of anyone who has this
    // applied before choosing anything. A migration must not change behaviour
    // for a tenant who has not asked it to.
    expect(sql).toMatch(/default 'A'/);
  });

  it("constrains the value to the two real modes", () => {
    expect(sql).toMatch(/check \(so_processing_mode in \('A', 'B'\)\)/);
  });

  it("is idempotent, like every migration here", () => {
    expect(sql).toMatch(/add column if not exists/);
    expect(sql).toMatch(/drop constraint if exists|conname = 'tenant_settings_so_processing_mode_check'/);
  });
});

describe("Mode B does not write to the ledger", () => {
  const src = read("src/api/tally/push.js");

  it("refuses the push", () => {
    // The mode's entire promise is that their process is unchanged, and a
    // voucher nobody entered breaks it in the one way a settings toggle cannot
    // undo.
    expect(src).toMatch(/so_processing_mode === "B"/);
    expect(src).toMatch(/SO_PROCESSING_MODE_B/);
  });

  it("refuses LOUDLY rather than no-oping", () => {
    // A push that silently does nothing is how a tenant discovers their mode
    // by finding an empty ledger a week later.
    // Searched FORWARD from the mode check: tallyResolveCompany also appears
    // in the import at the top of the file, so a plain indexOf pointed
    // backwards and sliced an empty string — an assertion that passes on
    // nothing at all.
    const modeIdx = src.indexOf('so_processing_mode === "B"');
    const block = src.slice(modeIdx, src.indexOf("tallyResolveCompany(svc", modeIdx));
    expect(block.length).toBeGreaterThan(50);
    expect(block).toMatch(/return json\(res, 409/);
  });

  it("checks the mode BEFORE resolving the bridge", () => {
    const modeIdx = src.indexOf('so_processing_mode === "B"');
    const bridgeIdx = src.indexOf("tallyResolveCompany(svc");
    expect(modeIdx).toBeGreaterThan(-1);
    expect(modeIdx).toBeLessThan(bridgeIdx);
  });

  it("proceeds when the setting cannot be read", () => {
    // A database without migration 221, or a transient read error, leaves this
    // undefined — and that is Mode A, the behaviour every tenant already has.
    // Failing the other way would stop pushes on a blip.
    expect(src).toMatch(/An unreadable setting, or a database without migration 221/);
    expect(src).not.toMatch(/if \(modeQ\.error\) return/);
  });
});

describe("both paths are described where the choice is made", () => {
  it("says what Anvil does AND what you do, for each", () => {
    for (const key of ["A", "B"]) {
      expect(MODES[key].anvil_does.length).toBeGreaterThan(0);
      expect(MODES[key].you_do.length).toBeGreaterThan(0);
      expect(MODES[key].tradeoff.length).toBeGreaterThan(20);
    }
  });

  it("states Mode A's cost plainly, not only its benefit", () => {
    // The thing being weighed. A selector that only lists upsides is not a
    // choice, it is a recommendation wearing a toggle.
    expect(MODES.A.tradeoff).toMatch(/writes to your ledger/i);
  });

  it("states Mode B's promise in the customer's terms", () => {
    expect(MODES.B.tradeoff).toMatch(/[Nn]othing about your process changes/);
    expect(MODES.B.anvil_does.join(" ")).toMatch(/Writes NOTHING to your ERP/);
  });

  it("does not claim Mode B stops Anvil doing anything else", () => {
    // Reconciliation, extraction and the proposal all still run. A customer
    // reading "Anvil watches" should not conclude it has been switched off.
    expect(MODES.B.anvil_does.join(" ")).toMatch(/Reads the customer PO/);
    expect(MODES.B.anvil_does.join(" ")).toMatch(/Compares/);
  });
});

describe("the endpoint", () => {
  const src = read("src/api/admin/so_processing_mode.js");

  it("requires admin to CHANGE, not merely approve", () => {
    // This decides whether software writes to a financial ledger.
    const patch = src.slice(src.indexOf('req.method === "PATCH"'));
    expect(patch).toMatch(/requirePermission\(ctx, "admin"\)/);
  });

  it("names the migration when the column is missing", () => {
    // Rather than returning a Postgres error to somebody clicking a toggle.
    expect(src).toMatch(/so_processing_mode_column_missing/);
    expect(src).toMatch(/migration 221/);
  });

  it("reports A rather than 'unknown' on a database without the column", () => {
    // A question the operator cannot answer is worse than the true default.
    expect(src).toMatch(/let mode = "A"/);
  });

  it("audits the change", () => {
    expect(src).toMatch(/action: "so_processing_mode_changed"/);
  });

  it("serves the descriptions, so the screen keeps no second copy", () => {
    expect(src).toMatch(/modes: MODES/);
    expect(read("src/v3-app/components/SoProcessingModeEditor.tsx")).toMatch(/setModes\(r\?\.modes \|\| \{\}\)/);
  });
});

describe("the screen is reachable", () => {
  const admin = read("src/v3-app/screens/admin.tsx");

  it("has a tab", () => {
    expect(admin).toMatch(/id: "so_mode"/);
    expect(admin).toMatch(/active === "so_mode" && <SoProcessingModeEditor \/>/);
  });

  it("sits in a group, or the tab exists and cannot be found", () => {
    expect(admin).toMatch(/"settings", "so_mode"/);
  });
});
