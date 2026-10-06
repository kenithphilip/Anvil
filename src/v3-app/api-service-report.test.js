// Customer-facing service report — TEMPLATE-DRIVEN.
//
// The attached Obara form was a reference, not a spec: the report must adapt to
// the seller (the Anvil tenant) AND to their customers, so layout / labels /
// customer-vs-internal visibility come from a template, not fixed columns.
//
// The load-bearing properties, all asserted here:
//   * ADAPTS — a tenant/customer template drives what appears; zero config
//     still yields a sensible report (the built-in default).
//   * NO INTERNAL LEAK — a field is sent only if its template marks it
//     visibility:'customer'; anything else (incl. an unmarked field) is withheld.
//   * DEGRADES GRACEFULLY — an empty field/section is omitted, never a skeleton.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildServiceReport, renderServiceReportText, isReportEmpty, resolveTemplate, DEFAULT_TEMPLATE,
} from "../api/_lib/service-report.js";

// The attached TI-India report, transcribed. Note the tenant-specific fields
// (warranty_status, serial_no, robot_make) now live in report_fields.
const VISIT = {
  id: "v1", report_number: "OI/F/CS/12/R-00/020226", visit_date: "2026-06-06",
  customer_id: "c1", customer_contact_id: "ct1",
  line_or_station: "AR-12", support_type: "chargeable",
  check_in_at: "2026-06-06T14:00:00Z", check_out_at: "2026-06-07T04:00:00Z",
  purpose: "Auto Gun transformer installation, Timer installation & spot trial",
  observation: "SIV-21 Timer installation done. Power cable connection done.",
  action_taken: "Auto-Gun busbar & jumper cable connections verified.",
  followup_action: "Weld controller (old) faulty. Water flow low.",
  notes: "INTERNAL: quote spare timer at cost + 22%, chase PO before dispatch",
  report_fields: {
    equipment_name: "Weld controller", serial_no: "SIV-21N-E01-S113",
    model_name: "D00-6M", warranty_status: "Out of warranty (old transformer)",
  },
};
const PARTS = [
  { seq: 1, part_name: "Timer", part_number: "SIV-21N", action_details: "Installed", remarks: "New" },
  { seq: 0, part_name: "Transformer", part_number: "-", action_details: "Reinstalled", remarks: "Old" },
];
const CUSTOMER = { id: "c1", customer_name: "TI INDIA — SHIKARAPUR PUNE" };
const CONTACT = { id: "ct1", name: "Mr. Namdev Rathod", role: "Maintenance" };

describe("buildServiceReport with the built-in default template", () => {
  const r = buildServiceReport({ visit: VISIT, parts: PARTS, customer: CUSTOMER, contact: CONTACT });

  it("pulls tenant-specific fields out of report_fields", () => {
    const visitSec = r.sections.find((s) => s.key === "visit");
    const byLabel = Object.fromEntries(visitSec.rows.map((x) => [x.label, x.value]));
    expect(byLabel["Serial No"]).toBe("SIV-21N-E01-S113");
    expect(byLabel["Warranty"]).toMatch(/Out of warranty/);
    expect(byLabel["Support"]).toBe("Chargeable");     // label-mapped from 'chargeable'
  });

  it("carries the narrative + parts", () => {
    const work = r.sections.find((s) => s.key === "work");
    expect(work.rows.map((x) => x.label)).toContain("Observation");
    expect(r.parts).toHaveLength(2);
    expect(r.parts.map((p) => p.part_name)).toEqual(["Transformer", "Timer"]);  // seq order
  });

  it("NEVER includes the internal note (default marks it visibility:internal)", () => {
    expect(JSON.stringify(r)).not.toMatch(/INTERNAL|22%/);
    const work = r.sections.find((s) => s.key === "work");
    expect(work.rows.find((x) => x.key === "notes")).toBeUndefined();
  });
});

describe("adapts to a tenant/customer template", () => {
  it("a custom template controls which fields appear and their labels", () => {
    const template = {
      name: "HVAC service", include_parts: false,
      sections: [{ key: "s1", title: "Job", fields: [
        { key: "observation", label: "Findings", visibility: "customer" },
        { key: "serial_no", label: "Unit S/N", visibility: "customer" },
        { key: "action_taken", label: "Fix", visibility: "internal" },   // hidden by THIS tenant
      ] }],
    };
    const r = buildServiceReport({ visit: VISIT, parts: PARTS, customer: CUSTOMER, contact: CONTACT, template });
    expect(r.sections).toHaveLength(1);
    const rows = Object.fromEntries(r.sections[0].rows.map((x) => [x.label, x.value]));
    expect(rows["Findings"]).toMatch(/Timer installation/);
    expect(rows["Unit S/N"]).toBe("SIV-21N-E01-S113");
    expect(r.sections[0].rows.find((x) => x.key === "action_taken")).toBeUndefined();  // internal here
    expect(r.parts).toHaveLength(0);   // include_parts:false honoured
  });

  it("a field is customer-facing ONLY when explicitly marked — fail safe", () => {
    const template = { name: "x", sections: [{ key: "s", fields: [
      { key: "observation" },                                    // no visibility -> withheld
      { key: "action_taken", visibility: "customer" },
    ] }] };
    const r = buildServiceReport({ visit: VISIT, template });
    const keys = r.sections.flatMap((s) => s.rows.map((x) => x.key));
    expect(keys).toContain("action_taken");
    expect(keys).not.toContain("observation");
  });
});

describe("resolveTemplate precedence", () => {
  const tenantDefault = { customer_id: null, name: "tenant", sections: [{ key: "a", fields: [] }], is_active: true };
  const custom = { customer_id: "c1", name: "acme", sections: [{ key: "b", fields: [] }], is_active: true };

  it("customer override wins over tenant default", () => {
    expect(resolveTemplate([tenantDefault, custom], "c1").name).toBe("acme");
  });
  it("tenant default when no customer override", () => {
    expect(resolveTemplate([tenantDefault, custom], "c2").name).toBe("tenant");
  });
  it("built-in default when the tenant has authored none", () => {
    expect(resolveTemplate([], "c1")).toBe(DEFAULT_TEMPLATE);
  });
  it("ignores inactive templates", () => {
    expect(resolveTemplate([{ ...custom, is_active: false }], "c1")).toBe(DEFAULT_TEMPLATE);
  });
});

describe("degrades gracefully", () => {
  it("omits empty sections instead of printing a skeleton", () => {
    const thin = { id: "v2", visit_date: "2026-06-10", action_taken: "Replaced fuse.", support_type: "free" };
    const body = renderServiceReportText(buildServiceReport({ visit: thin }));
    expect(body).toMatch(/Action taken: Replaced fuse\.|Action taken:\n {2}Replaced fuse\./);
    expect(body).not.toMatch(/Observation/);
    expect(body).not.toMatch(/Parts & action summary/);
    expect(body).toMatch(/Free of charge/);
  });

  it("a visit with no visible content is 'empty' for sending", () => {
    expect(isReportEmpty(buildServiceReport({ visit: { id: "v3" }, parts: [] }))).toBe(true);
  });

  it("any visible row or part makes it non-empty", () => {
    expect(isReportEmpty(buildServiceReport({ visit: { action_taken: "x" } }))).toBe(false);
    expect(isReportEmpty(buildServiceReport({ visit: {}, parts: [{ seq: 0, part_name: "P" }] }))).toBe(false);
  });
});

describe("renderServiceReportText never emits an internal field", () => {
  it("the body has the narrative + parts but not the internal note", () => {
    const body = renderServiceReportText(buildServiceReport({ visit: VISIT, parts: PARTS, customer: CUSTOMER, contact: CONTACT }));
    expect(body).toMatch(/Observation/);
    expect(body).toMatch(/Parts & action summary/);
    expect(body).not.toMatch(/INTERNAL|22%/);
  });
});

describe("the endpoint drafts via commsRow (the #334 guard covers it)", () => {
  it("uses commsRow + document_type service_report + a resolved template", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "api", "comms", "service_report.js"), "utf8");
    expect(src).toMatch(/insert\(commsRow\(draft\)\)/);
    expect(src).toMatch(/document_type: "service_report"/);
    expect(src).toMatch(/resolveTemplate\(/);
  });
});
