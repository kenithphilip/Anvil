// GET /api/portal/view?kind=<summary|quotes|orders|invoices|spares|spare_matrix>
//
// Read-only, customer-scoped portal data. DUAL-AUTH: a per-user SESSION (Bearer
// header — the token is NOT in the URL) is preferred; a legacy ?token=... shared
// link is still accepted during the migration. resolvePortalAccess resolves
// either into a token-shaped object (tenant_id / customer_id / scopes).
//
// `summary` powers the portal landing page ("you have N open quotes / orders /
// invoices").

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { resolvePortalAccess } from "../_lib/portal-auth.js";

// The order statuses a CUSTOMER may see, in one place.
//
// This list was inline on the `orders` branch and simply absent from `quotes`,
// so the same table was filtered on one path and served whole on the other.
// The unfiltered path returned DRAFT, PENDING_REVIEW, BLOCKED, DUPLICATE,
// FAILED_TALLY_IMPORT and CANCELLED rows — internal working states — each
// carrying `result`, which holds the extracted salesOrder line items and their
// prices. An extraction nobody has reviewed yet is exactly the thing a
// customer must not read a price off.
//
// Naming it once is the point: two copies of an access rule is one copy and
// one oversight.
const CUSTOMER_VISIBLE_ORDER_STATUSES = [
  "APPROVED", "EXPORTED_TO_TALLY", "SCHEDULED", "DISPATCHED", "RECONCILED",
];

const logAccess = async (svc, t, req, status, path) => {
  await svc.from("portal_access_log").insert({
    tenant_id: t.tenant_id,
    token_id: t.id || null,
    portal_user_id: t.portal_user_id || null,
    ip: req.headers["x-forwarded-for"]?.split(",")[0] || null,
    user_agent: req.headers["user-agent"] || null,
    path,
    status,
  });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
    const url = new URL(req.url, "http://x");
    const kind = url.searchParams.get("kind") || "summary";
    const svc = serviceClient();
    const t = await resolvePortalAccess(req, svc);   // throws 401/403/404 on bad auth
    // 'spare_matrix' (single-matrix detail) is gated by the 'spares' scope too.
    const requiredScope = kind === "summary" ? "quotes" : (kind === "spare_matrix" ? "spares" : kind);
    if (!t.scopes.includes(requiredScope)) {
      await logAccess(svc, t, req, 403, kind);
      return json(res, 403, { error: { message: "scope not allowed" } });
    }

    let payload = null;
    if (kind === "summary") {
      const [q, o, i] = await Promise.all([
        // Both counted over the same allow-list the list endpoints use.
        // Unfiltered, the first told the customer "you have N quotes" counting
        // drafts and cancellations they can neither see nor act on.
        //
        // They are now necessarily EQUAL, and that is a symptom worth stating
        // rather than hiding: `quotes` and `orders` are the same query against
        // the same table, distinguished only by a filter that one of them was
        // missing. Anvil has a real `quotes` table this endpoint never touches.
        // Pointing it there is a product decision, not a security fix, so it is
        // deliberately not made here — but nothing should read these two counts
        // as measuring different things, because they do not.
        svc.from("orders").select("id", { count: "exact", head: true }).eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id).in("status", CUSTOMER_VISIBLE_ORDER_STATUSES),
        svc.from("orders").select("id", { count: "exact", head: true }).eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id).in("status", CUSTOMER_VISIBLE_ORDER_STATUSES),
        svc.from("invoices").select("id", { count: "exact", head: true }).eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id).in("status", ["sent", "partial", "overdue"]),
      ]);
      const cust = t.customer_id ? await svc.from("customers").select("customer_name, contact_email").eq("id", t.customer_id).maybeSingle() : { data: null };
      payload = {
        customer: cust.data || null,
        scopes: t.scopes,
        counts: { quotes: q.count || 0, orders: o.count || 0, open_invoices: i.count || 0 },
      };
    } else if (kind === "quotes") {
      const r = await svc.from("orders")
        .select("id, quote_number, po_number, status, payload_hash, result, created_at")
        .eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id)
        .in("status", CUSTOMER_VISIBLE_ORDER_STATUSES)
        .order("created_at", { ascending: false }).limit(50);
      payload = { quotes: r.data || [] };
    } else if (kind === "orders") {
      const r = await svc.from("orders")
        .select("id, quote_number, po_number, status, tally_status, result, created_at")
        .eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id)
        .in("status", CUSTOMER_VISIBLE_ORDER_STATUSES)
        .order("created_at", { ascending: false }).limit(50);
      payload = { orders: r.data || [] };
    } else if (kind === "invoices") {
      const r = await svc.from("invoices")
        .select("id, invoice_number, issue_date, due_date, currency, grand_total, paid_amount, status")
        .eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id)
        .order("issue_date", { ascending: false }).limit(50);
      payload = { invoices: r.data || [] };
    } else if (kind === "spares") {
      // List the customer's spare matrices (headers only). Detail via kind=spare_matrix.
      const r = await svc.from("spare_matrix")
        .select("id, name, project_name, updated_at")
        .eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id)
        .order("updated_at", { ascending: false }).limit(50);
      payload = { spare_matrices: r.data || [] };
    } else if (kind === "spare_matrix") {
      // One matrix in full (read-only), ONLY if it belongs to this token's
      // customer. Returns the spare-category columns, the per-gun rows, and the
      // committed drawings (link + filename). Internal ids are not exposed.
      const matrixId = url.searchParams.get("matrix_id");
      if (!matrixId) return json(res, 400, { error: { message: "matrix_id required" } });
      const m = await svc.from("spare_matrix")
        .select("id, name, project_name, updated_at")
        .eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id).eq("id", matrixId).maybeSingle();
      if (m.error) throw new Error(m.error.message);
      if (!m.data) { await logAccess(svc, t, req, 404, kind); return json(res, 404, { error: { message: "matrix not found" } }); }
      const [cols, rows, draw] = await Promise.all([
        svc.from("spare_matrix_columns").select("col_name, category, position").eq("tenant_id", t.tenant_id).eq("matrix_id", matrixId).order("position", { ascending: true }),
        svc.from("spare_matrix_rows").select("sr_no, line, station_no, robot_no, gun_no, gun_type, l_qty, r_qty, timer, atd, qty, spare_values, position").eq("tenant_id", t.tenant_id).eq("matrix_id", matrixId).order("position", { ascending: true }),
        svc.from("gun_drawings").select("gun_no, kind, format, original_filename, link_url").eq("tenant_id", t.tenant_id).eq("matrix_id", matrixId).eq("status", "committed"),
      ]);
      payload = { matrix: m.data, columns: cols.data || [], rows: rows.data || [], drawings: draw.data || [] };
    } else {
      return json(res, 400, { error: { message: "unknown kind" } });
    }

    // Legacy-token bookkeeping only; a session (t.id === null) has no token row.
    if (t.id) {
      await svc.from("portal_tokens").update({
        last_used_at: new Date().toISOString(),
        use_count: (t.use_count || 0) + 1,
      }).eq("id", t.id);
    }
    await logAccess(svc, t, req, 200, kind);
    return json(res, 200, payload);
  } catch (err) { sendError(res, err); }
}
