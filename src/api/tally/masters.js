import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { canonicaliseCustomer } from "../_lib/customer-canonicalizer.js";

const ALLOWED_TYPES = new Set(["stock_item", "ledger", "gst_ledger", "uom", "voucher_type"]);

// Audit P8.2. Tally treats customers as ledgers under the
// "Sundry Debtors" parent group. When a ledger import covers
// debtors, promote each row to the canonical customers table so
// multi-ERP tenants stay deduped.
const isCustomerLedger = (record) => {
  const parent = String(record?.payload?.parent || "").toLowerCase();
  return parent.includes("debtor") || parent === "sundry debtors";
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const masterType = req.query.type;
      let query = svc.from("tally_masters").select("*").eq("tenant_id", ctx.tenantId).order("name").limit(2000);
      if (masterType && ALLOWED_TYPES.has(masterType)) query = query.eq("master_type", masterType);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return json(res, 200, { masters: data });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const records = body.records || [];
      const replace = !!body.replace;
      const masterType = body.master_type;
      if (!ALLOWED_TYPES.has(masterType)) return json(res, 400, { error: { message: "master_type must be one of " + Array.from(ALLOWED_TYPES).join(", ") } });
      if (replace) {
        const del = await svc.from("tally_masters").delete().eq("tenant_id", ctx.tenantId).eq("master_type", masterType);
        if (del.error) throw new Error(del.error.message);
      }
      if (!records.length) return json(res, 200, { ok: true, count: 0 });
      const rows = records.map((r) => ({
        tenant_id: ctx.tenantId,
        master_type: masterType,
        name: String(r.name || "").trim(),
        payload: r.payload || {},
        source_imported_at: new Date().toISOString(),
      })).filter((r) => r.name);
      const upsert = await svc.from("tally_masters").upsert(rows, { onConflict: "tenant_id,master_type,name" });
      if (upsert.error) throw new Error(upsert.error.message);
      // Audit P8.2: canonicalise customer ledgers into the customers
      // table so dunning + e-invoice + portal flows can address them
      // by canonical id rather than by raw ledger name.
      let canonicalised = 0;
      if (masterType === "ledger") {
        for (const r of records) {
          if (!isCustomerLedger(r)) continue;
          const name = String(r.name || "").trim();
          if (!name) continue;
          await canonicaliseCustomer(svc, ctx.tenantId, {
            vendor: "tally",
            vendorIdField: "tally_ledger_name",
            externalId: name,
            name,
            email: r.payload?.email || null,
            gstin: r.payload?.gstin || r.payload?.party_gstin || null,
            currency: r.payload?.currency || null,
            ref: { parent: r.payload?.parent || null, opening_balance: r.payload?.opening_balance },
          });
          canonicalised += 1;
        }
      }
      await recordAudit(ctx, { action: "tally_masters_sync", objectType: "tally_masters", objectId: masterType, detail: "rows=" + rows.length + " replace=" + replace + " canonicalised=" + canonicalised });
      return json(res, 200, { ok: true, count: rows.length, canonicalised });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
