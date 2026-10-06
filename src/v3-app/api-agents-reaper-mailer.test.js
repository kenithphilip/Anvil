// The queued-communications reaper (agents/run.js reapQueuedCommsForTenant) must
// fire rows through the shared switchable-mailer core (comms-send.js
// `sendCommunication`), NOT a private inline SendGrid path — otherwise cc/bcc +
// attachments are silently dropped (dispatch-register CC to purchase/accounts,
// quote PDFs) and the #380 switchable mailer (Brevo/Resend/SendGrid) is
// bypassed. Asserted as source properties because reapQueuedCommsForTenant is
// module-private (same approach as api-marketing-path.test.js).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const readApi = (rel) => readFileSync(join(HERE, "..", "api", rel), "utf8");

describe("queued-comms reaper routes through the switchable mailer", () => {
  const src = readApi("agents/run.js");

  it("imports and calls sendCommunication from the shared comms-send core", () => {
    expect(src).toMatch(/import\s*\{[^}]*sendCommunication[^}]*\}\s*from\s*["']\.\.\/_lib\/comms-send\.js["']/);
    expect(src).toMatch(/sendCommunication\(svc,\s*ctx,\s*row\.id\)/);
  });

  it("no longer carries the inline SendGrid path that dropped cc/bcc + attachments", () => {
    expect(src).not.toMatch(/SENDGRID_API_KEY/);
    expect(src).not.toMatch(/sendViaSendGrid/);
    expect(src).not.toMatch(/api\.sendgrid\.com/);
  });

  it("keeps the transactional guarantees (skip marketing, fail a no-recipient row)", () => {
    expect(src).toMatch(/document_type === "marketing"/);
    expect(src).toMatch(/error: "no recipient"/);
  });
});
