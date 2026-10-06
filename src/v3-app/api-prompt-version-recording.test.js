// "If someone changed a prompt today, what would tell them whether accuracy
// improved?" — nothing did.
//
// prompt-versions.js is a complete A/B registry: named versions, traffic
// weights, deterministic hashing, canaries, pinning. It was imported by
// nothing except its own test. Its header told adapters to import
// getPromptVersion(); NO SUCH EXPORT EXISTED, which is how we know nobody
// ever attempted the integration. Migration 124 added
// extraction_runs.prompt_version so accuracy could be charted per version,
// and none of the pipeline's writes ever set it.
//
// Without a version on the run, no before/after can be ATTRIBUTED — so the
// experiment the registry was built for could never have been read.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  getPromptVersion, resolvePromptVersion, promptNameForKind, PROMPT_NAME_BY_KIND,
} from "../api/_lib/docai/prompt-versions.js";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

describe("the entry point the header always named", () => {
  it("getPromptVersion now exists", () => {
    expect(typeof getPromptVersion).toBe("function");
  });

  it("resolves a known prompt", () => {
    const r = getPromptVersion("po_extractor", { tenantId: "t1" });
    expect(r).toBeTruthy();
    expect(r.name).toBe("po_extractor");
    expect(r.version).toMatch(/^v\d+$/);
  });

  it("returns null for a prompt the registry does not define", () => {
    // A fabricated label is worse than none: it makes a comparison look
    // attributable when it is not.
    expect(getPromptVersion("no_such_prompt", {})).toBeNull();
  });

  it("says whether the version actually supplies prompt text", () => {
    // Recording "v2" while running the default prompt is attribution, not an
    // experiment, and a caller must be able to tell the difference.
    const r = getPromptVersion("po_extractor", { tenantId: "t1" });
    expect(r).toHaveProperty("is_variant");
    // No registry row carries system/tools today, so nothing is a variant yet.
    expect(r.is_variant).toBe(false);
  });

  it("is deterministic for the same tenant", () => {
    const a = getPromptVersion("po_extractor", { tenantId: "t1", customerId: "c1" });
    const b = getPromptVersion("po_extractor", { tenantId: "t1", customerId: "c1" });
    expect(a.version).toBe(b.version);
  });

  it("honours a pin and a force", () => {
    expect(getPromptVersion("po_extractor", { tenantId: "t1", pin: "v3" }).version).toBe("v3");
    expect(getPromptVersion("po_extractor", { tenantId: "t1", forceVersion: "v1" }).version).toBe("v1");
  });

  it("refuses to pin a RETIRED version", () => {
    // Retiring a version is how it leaves the split; honouring a pin to it
    // would be a way back in. v2 is retired precisely because its label is
    // contaminated — ~30% of runs carry it from before variants could change
    // the request — so a tenant pinned there would pollute the comparison it
    // was pinned to avoid.
    expect(getPromptVersion("po_extractor", { tenantId: "t1", pin: "v2" }).version).not.toBe("v2");
  });
});

describe("kind to prompt", () => {
  it("maps the kinds the registry actually covers", () => {
    expect(promptNameForKind("po")).toBe("po_extractor");
    expect(promptNameForKind("supplier_ack")).toBe("supplier_ack_extractor");
  });

  it("returns null for a kind with no registry entry", () => {
    // quote, packing_list, invoice etc have no registry prompt yet — their
    // runs must record NULL rather than borrow po_extractor's version.
    expect(promptNameForKind("quote")).toBeNull();
    expect(promptNameForKind("packing_list")).toBeNull();
  });

  it("never maps a kind to a prompt the registry does not define", () => {
    const src = read("src/api/_lib/docai/prompt-versions.js");
    for (const name of Object.values(PROMPT_NAME_BY_KIND)) {
      expect(src).toMatch(new RegExp("^\\s+" + name + ":", "m"));
    }
  });
});

describe("the run records it", () => {
  const src = read("src/api/_lib/docai/run.js");

  it("resolves a version before opening the run row", () => {
    expect(src).toMatch(/promptNameForKind\(kind\)/);
    expect(src).toMatch(/getPromptVersion\(promptName/);
  });

  it("writes prompt_version on the insert", () => {
    expect(src).toMatch(/prompt_version: promptVersionLabel/);
  });

  it("labels it prompt@version, not a bare version", () => {
    // po_extractor@v2 and supplier_ack_extractor@v2 are different
    // experiments and must not aggregate together.
    expect(src).toMatch(/\$\{promptChoice\.name\}@\$\{promptChoice\.version\}/);
  });

  it("passes the tenant and customer, or the split is not deterministic per tenant", () => {
    expect(src).toMatch(/tenantId: ctx\.tenantId/);
    expect(src).toMatch(/customerId,/);
  });

  it("honours a tenant pin", () => {
    expect(src).toMatch(/docai_prompt_pins/);
  });

  it("survives a database without migration 124", () => {
    // Applied by hand. An attribution label must never be the reason an
    // extraction cannot start.
    expect(src).toMatch(/42703/);
    expect(src).toMatch(/delete retry\.prompt_version/);
  });
});

describe("the replay scorer is reachable and its verdict is heard", () => {
  const client = read("src/client/anvil-client.js");
  const replay = read("src/api/eval/replay.js");

  it("has a client method — it was routed and unreachable", () => {
    expect(client).toMatch(/replay: async \(opts\) => apiFetch\("\/api\/eval\/replay"/);
  });

  it("raises an alert when accuracy falls", () => {
    // It always computed `regression` and returned it to a cron loop reading
    // only r.ok. A quality signal nobody is told about is not one.
    expect(replay).toMatch(/notifyAdmins\(svc, tenantId/);
    expect(replay).toMatch(/kind: "eval_replay_regression"/);
  });

  it("dedups so a standing regression alerts once, not every run", () => {
    expect(replay).toMatch(/dedupKey: "eval_replay_regression:" \+ suite/);
  });

  it("never lets the alert fail the replay", () => {
    expect(replay).toMatch(/regression alert failed/);
  });

  it("still returns the flag for programmatic callers", () => {
    expect(replay).toMatch(/^\s+regression,$/m);
  });
});
