// /api/customers/owner  - the account owner on customers (migration 227)
//
//   GET  ?suggest=1[&customer_id=]
//        For each UNOWNED customer of the tenant, the member who owns a strict
//        majority of its opportunities (opportunities.owner_id) and authored
//        quotes (quotes.created_by) over the last 365 days, else null. Read
//        only: a suggestion is never saved by being computed. Called with
//        customer_id by the detail panel, and without it by the Customers
//        screen's Unassigned view.
//
//   POST { customer_ids[], owner_user_id | null, move_open_opportunities }
//        Name (or clear) the owner of one or more customers. sales_manager and
//        admin only (action customer.assign_owner). Every id must be a customer
//        of this tenant and the owner must be an approved member, or nothing is
//        written. One audit row per customer that changed, and one per
//        opportunity moved. Optionally moves the customer's OPEN opportunities
//        that the previous owner held, or that nobody held, to the new owner.
//
// This is the ONLY writer of customers.owner_user_id. The POST /api/customers
// upsert deliberately does not write it, so an unrelated customer edit can
// never clear an owner. (Admin customer merge also carries an owner from a
// duplicate onto an unowned primary; see customers/merge.js.)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, requireAction } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudits } from "../_lib/audit.js";
import { resolveAssignee, userDisplayNames } from "../_lib/assignee.js";
import {
  OWNER_WINDOW_DAYS, TERMINAL_OPPORTUNITY_STAGES, OWNER_READ_PAGING,
  isMissingOwnerColumn, fetchAllRows, tallyOwners, strictMajorityOwner, chunk,
} from "../_lib/customer-owner.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === "string" && UUID_RE.test(s);
const MAX_BATCH = 500;

const MIGRATION_REQUIRED = {
  error: {
    code: "MIGRATION_REQUIRED",
    message: "Account owners need migration 227_customer_owner.sql applied to this database.",
    migration: "227_customer_owner.sql",
  },
};

const bad = (res, message, extra) => json(res, 400, { error: { message, ...(extra || {}) } });

// Suggestions for unowned customers. See the header for the rule.
//
// Opportunities count by updated_at (an opportunity being worked this year is
// this year's evidence, whenever it was opened); quotes count by created_at
// (authorship happens once). Every opportunity counts toward the total, owned
// or not, so a majority is a majority of the account's pipeline. A quote
// counts only when it has an author: quotes that arrive by upload
// (_lib/quote-ingest.js) carry no created_by, and an uploaded PDF is nobody's
// vote, so letting it into the total would bury a rep who wrote every in-app
// quote on the account under documents nobody in the team authored.
const loadSuggestions = async (svc, tenantId, customerId) => {
  const since = new Date(Date.now() - OWNER_WINDOW_DAYS * 86400 * 1000).toISOString();

  const unowned = await fetchAllRows(() => {
    let q = svc.from("customers").select("id").eq("tenant_id", tenantId).is("owner_user_id", null);
    if (customerId) q = q.eq("id", customerId);
    return q.order("id", { ascending: true });
  }, OWNER_READ_PAGING);
  if (unowned.error) {
    if (isMissingOwnerColumn(unowned.error)) return { migrationRequired: true };
    throw new Error(unowned.error.message);
  }
  const unownedIds = unowned.rows.map((c) => c.id);
  if (!unownedIds.length) return { suggestions: [], complete: unowned.complete };

  const opps = await fetchAllRows(() => {
    let q = svc.from("opportunities").select("id, customer_id, owner_id").eq("tenant_id", tenantId).gte("updated_at", since);
    if (customerId) q = q.eq("customer_id", customerId);
    return q.order("id", { ascending: true });
  }, OWNER_READ_PAGING);
  if (opps.error) throw new Error(opps.error.message);
  const quotes = await fetchAllRows(() => {
    let q = svc.from("quotes").select("id, customer_id, created_by").eq("tenant_id", tenantId)
      .gte("created_at", since).not("created_by", "is", null);
    if (customerId) q = q.eq("customer_id", customerId);
    return q.order("id", { ascending: true });
  }, OWNER_READ_PAGING);
  if (quotes.error) throw new Error(quotes.error.message);

  // A suggestion built from a truncated slice of the evidence is a guess about
  // the part we did not read. Refuse it: report incomplete, suggest nobody.
  const complete = unowned.complete && opps.complete && quotes.complete;

  const members = await svc.from("tenant_members").select("user_id").eq("tenant_id", tenantId).eq("status", "approved");
  if (members.error) throw new Error(members.error.message);
  const approved = new Set((members.data || []).map((m) => m.user_id));

  const tally = tallyOwners([
    ...opps.rows.map((o) => ({ customer_id: o.customer_id, owner: o.owner_id || null })),
    ...quotes.rows.map((q) => ({ customer_id: q.customer_id, owner: q.created_by || null })),
  ]);

  const suggestions = unownedIds.map((id) => {
    const t = tally.get(id);
    if (!complete) return { customer_id: id, owner_user_id: null, reason: "evidence_incomplete", votes: 0, total: t ? t.total : 0 };
    if (!t || !t.total) return { customer_id: id, owner_user_id: null, reason: "no_activity", votes: 0, total: 0 };
    const win = strictMajorityOwner(t);
    if (!win) return { customer_id: id, owner_user_id: null, reason: "no_majority", votes: 0, total: t.total };
    // The majority owner has left, or was never approved: they cannot be
    // given the account, so they are not offered as its owner.
    if (!approved.has(win.owner)) return { customer_id: id, owner_user_id: null, reason: "not_a_member", votes: win.votes, total: win.total };
    return { customer_id: id, owner_user_id: win.owner, reason: "majority", votes: win.votes, total: win.total };
  });

  const names = await userDisplayNames(svc, suggestions.map((s) => s.owner_user_id));
  for (const s of suggestions) s.owner_name = s.owner_user_id ? (names.get(s.owner_user_id) || null) : null;
  return { suggestions, complete };
};

// Move the OPEN opportunities of these customers to `owner`: on each account,
// the ones its previous owner held, or nobody held. Another rep's opportunity
// on the same account is theirs and is left alone. Runs for unchanged
// customers too: re-assigning the same owner with the box ticked is how a
// manager sweeps unowned opportunities onto the account owner.
//
// The customers are grouped by previous owner, so the work is a read and an
// update per (previous owner, 100 customers), not per customer: a 500-account
// reassignment is a handful of round trips. Each opportunity's owner is read
// before it is moved, so the audit can say who held it.
//
// The move does not touch updated_at. A manager reassigning an account is not
// activity on a deal, and the win predictor reads "days since last update"
// (sales/predict_opportunity.js), so a stale deal must not read as fresh
// because it changed hands.
//
// Returns movedByCustomer: Map(customer_id -> [{ id, before_owner_id }]).
const moveOpenOpportunities = async (svc, tenantId, ids, byId, owner) => {
  const groups = new Map();   // previous owner whose deals move (or "") -> customer ids
  for (const id of ids) {
    const prev = byId.get(id).owner_user_id || null;
    const key = prev && prev !== owner ? prev : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }
  const openOnly = "(" + TERMINAL_OPPORTUNITY_STAGES.join(",") + ")";
  // Tenant, open stage, and held by the previous owner or by nobody.
  const scoped = (q, prev) => {
    q = q.eq("tenant_id", tenantId).not("stage", "in", openOnly);
    return prev ? q.or("owner_id.is.null,owner_id.eq." + prev) : q.is("owner_id", null);
  };
  const jobs = [];
  for (const [prev, customerIds] of groups) {
    for (const part of chunk(customerIds)) jobs.push({ prev, part });
  }
  const movedByCustomer = new Map();
  const warnings = [];
  await Promise.all(jobs.map(async ({ prev, part }) => {
    const fail = (err) => warnings.push({
      customer_ids: part,
      message: "owner saved; open opportunities on " + part.length + " account" + (part.length === 1 ? "" : "s") + " not moved: " + err.message,
    });
    // Paged: PostgREST would otherwise stop at its max-rows without saying so,
    // and the deals past the cap would silently stay where they were.
    const read = await fetchAllRows(() => scoped(svc.from("opportunities").select("id, customer_id, owner_id"), prev)
      .in("customer_id", part).order("id", { ascending: true }), OWNER_READ_PAGING);
    if (read.error) return fail(read.error);
    if (!read.complete) return fail(new Error("too many open opportunities to read in one request"));
    const found = read.rows;
    const beforeById = new Map(found.map((o) => [o.id, o]));
    for (const oppIds of chunk(found.map((o) => o.id))) {
      // The same filters again on the write, so a deal another rep claimed
      // between the read and this update stays theirs.
      const r = await scoped(svc.from("opportunities").update({ owner_id: owner }), prev).in("id", oppIds).select("id");
      if (r.error) return fail(r.error);
      for (const { id } of r.data || []) {
        const o = beforeById.get(id);
        if (!o) continue;
        if (!movedByCustomer.has(o.customer_id)) movedByCustomer.set(o.customer_id, []);
        movedByCustomer.get(o.customer_id).push({ id, before_owner_id: o.owner_id || null });
      }
    }
  }));
  return { movedByCustomer, warnings };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      if (String((req.query && req.query.suggest) || "") !== "1") {
        return bad(res, "GET /api/customers/owner needs suggest=1");
      }
      const customerId = (req.query && req.query.customer_id) || null;
      if (customerId && !isUuid(customerId)) return bad(res, "customer_id must be a customer id");
      const out = await loadSuggestions(svc, ctx.tenantId, customerId);
      if (out.migrationRequired) return json(res, 409, MIGRATION_REQUIRED);
      return json(res, 200, { suggestions: out.suggestions, complete: out.complete, window_days: OWNER_WINDOW_DAYS });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      // The coarse write verb admits eight roles; naming whose account this is
      // is a manager's decision.
      requireAction(ctx, "customer.assign_owner");
      const body = await readBody(req);

      const ids = Array.isArray(body.customer_ids) ? [...new Set(body.customer_ids)] : [];
      if (!ids.length) return bad(res, "customer_ids must be a non-empty array");
      if (ids.length > MAX_BATCH) return bad(res, "at most " + MAX_BATCH + " customers per request");
      if (!ids.every(isUuid)) return bad(res, "customer_ids must be customer ids");

      // Absent is not the same as null. null clears the owner on purpose; a
      // body that forgot the field must not unassign a whole selection.
      if (!Object.prototype.hasOwnProperty.call(body, "owner_user_id")) {
        return bad(res, "owner_user_id is required (null to unassign)");
      }
      let owner = null;
      if (body.owner_user_id !== null) {
        const assignable = isUuid(body.owner_user_id)
          ? await resolveAssignee(svc, ctx.tenantId, body.owner_user_id)
          : null;
        if (!assignable) return bad(res, "owner_user_id must be an approved member of this tenant");
        owner = assignable;
      }
      const move = body.move_open_opportunities === true;
      if (move && !owner) {
        return bad(res, "move_open_opportunities needs an owner to move them to");
      }

      // Every id must be a customer of THIS tenant, or nothing is written. A
      // partial apply would leave the caller guessing which half landed.
      const reads = await Promise.all(chunk(ids).map((part) => svc.from("customers")
        .select("id, customer_name, owner_user_id")
        .eq("tenant_id", ctx.tenantId)
        .in("id", part)));
      const readError = reads.map((r) => r.error).find(Boolean);
      if (readError) {
        if (isMissingOwnerColumn(readError)) return json(res, 409, MIGRATION_REQUIRED);
        throw new Error(readError.message);
      }
      const byId = new Map(reads.flatMap((r) => r.data || []).map((c) => [c.id, c]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) {
        return json(res, 404, { error: { code: "CUSTOMER_NOT_FOUND", message: "Not customers of this tenant: " + missing.join(", "), customer_ids: missing } });
      }

      const changed = ids.filter((id) => (byId.get(id).owner_user_id || null) !== owner);
      for (const part of chunk(changed)) {
        const upd = await svc.from("customers")
          .update({ owner_user_id: owner })
          .eq("tenant_id", ctx.tenantId)
          .in("id", part)
          .select("id");
        if (upd.error) {
          if (isMissingOwnerColumn(upd.error)) return json(res, 409, MIGRATION_REQUIRED);
          throw new Error(upd.error.message);
        }
      }

      const { movedByCustomer, warnings } = move
        ? await moveOpenOpportunities(svc, ctx.tenantId, ids, byId, owner)
        : { movedByCustomer: new Map(), warnings: [] };

      // One audit row per customer where something happened, and one per
      // opportunity that moved (so the opportunity's own history shows who held
      // it before, and a move can be undone), written together in one insert.
      // Awaiting one insert per row here used to cost a round trip per row
      // after the owner write had committed.
      const audits = [];
      for (const id of ids) {
        const before = byId.get(id).owner_user_id || null;
        const moved = movedByCustomer.get(id) || [];
        if (before === owner && !moved.length) continue;
        audits.push({
          action: "customer_owner_change",
          objectType: "customer",
          objectId: id,
          before: { owner_user_id: before },
          after: { owner_user_id: owner, moved_opportunity_ids: moved.map((o) => o.id) },
        });
        for (const o of moved) {
          audits.push({
            action: "opp_owner_change",
            objectType: "opportunity",
            objectId: o.id,
            before: { owner_id: o.before_owner_id },
            after: { owner_id: owner },
            reason: "moved with the account owner of customer " + id,
          });
        }
      }
      await recordAudits(ctx, audits);

      let movedCount = 0;
      for (const list of movedByCustomer.values()) movedCount += list.length;
      return json(res, 200, {
        owner_user_id: owner,
        updated: changed,
        unchanged: ids.filter((id) => !changed.includes(id)),
        moved_opportunities: movedCount,
        warnings,
      });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
