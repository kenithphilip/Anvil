// /api/admin/so_processing_mode
//
//   GET    the tenant's current mode + what each one means.
//   PATCH  { mode: 'A' | 'B' }  switch it.
//
// MODE A  Anvil processes the sales order and pushes the voucher to the ERP.
//         Anvil is the system of action.
// MODE B  A person processes it by hand in the ERP. Anvil computes what it
//         WOULD have done, records that, pushes NOTHING, and compares.
//
// Mode B is the on-ramp. Nobody hands sales-order processing to software on a
// promise, and a vendor's accuracy figure is a claim about a benchmark, not
// about their POs. A month of their own orders with both answers side by side
// is what actually decides it.
//
// The endpoint returns the explanation alongside the value, so the screen does
// not have to keep its own copy of what the modes mean — two descriptions of
// the same switch drift, and the one on the screen is the one a customer reads
// before making the decision.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export const MODES = Object.freeze({
  A: {
    mode: "A",
    label: "Anvil processes sales orders",
    summary: "Anvil turns each purchase order into a sales order and pushes the voucher to your ERP.",
    anvil_does: [
      "Reads the customer PO and reconciles it against your quotes",
      "Produces the sales order",
      "Pushes the voucher to the ERP once approved",
    ],
    you_do: ["Review and approve what Anvil produced"],
    // Said plainly, because it is the thing a customer is actually weighing.
    tradeoff: "Fastest, and the one that removes manual work — but Anvil writes to your ledger.",
  },
  B: {
    mode: "B",
    label: "Your team processes them; Anvil watches",
    summary: "Your team raises sales orders in the ERP exactly as they do today. Anvil records what it would have done and shows you where the two differ.",
    anvil_does: [
      "Reads the customer PO and reconciles it against your quotes",
      "Records the sales order it would have produced",
      "Compares that against the sales order your team actually raised",
      "Writes NOTHING to your ERP",
    ],
    you_do: ["Carry on exactly as you do today", "Upload the sales order your ERP produced"],
    tradeoff: "Nothing about your process changes, and nothing reaches your ledger. You get a scored comparison over your own orders before deciding whether to switch to Mode A.",
  },
});

const VALID = new Set(Object.keys(MODES));

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let mode = "A";
      const r = await svc.from("tenant_settings")
        .select("so_processing_mode").eq("tenant_id", ctx.tenantId).maybeSingle();
      // A database without migration 221 reports A — which is what every
      // tenant is doing today. Reporting "unknown" would put a question on the
      // screen that the operator cannot answer.
      if (!r.error && r.data?.so_processing_mode) mode = r.data.so_processing_mode;
      return json(res, 200, { mode, modes: MODES, applied: !r.error });
    }

    if (req.method === "PATCH") {
      // Not "approve": this decides whether software writes to the customer's
      // financial ledger. That is an admin decision.
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const mode = String(body?.mode || "").toUpperCase();
      if (!VALID.has(mode)) {
        return json(res, 400, { error: { message: "mode must be one of " + [...VALID].join(", ") } });
      }
      const up = await svc.from("tenant_settings")
        .upsert({ tenant_id: ctx.tenantId, so_processing_mode: mode }, { onConflict: "tenant_id" })
        .select("so_processing_mode").single();
      if (up.error) {
        // 42703 = the column is not there. Say which migration, rather than
        // returning a Postgres error to somebody clicking a toggle.
        if (up.error.code === "42703" || /so_processing_mode/.test(up.error.message || "")) {
          return json(res, 503, {
            error: {
              code: "so_processing_mode_column_missing",
              message: "This database has not had migration 221 applied, so the mode cannot be stored. Until it is, every tenant behaves as Mode A.",
            },
          });
        }
        throw new Error(up.error.message);
      }
      await recordAudit(ctx, {
        action: "so_processing_mode_changed", objectType: "tenant_settings", objectId: ctx.tenantId,
        detail: "mode=" + mode,
      });
      return json(res, 200, { mode: up.data.so_processing_mode, modes: MODES });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
