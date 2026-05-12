// POST /api/quotes/send
// Body: { id, to?, subject?, body?, share_link? }
//
// Audit P6.3. Sends a quote to a customer:
//
//   1. Validates the quote is in DRAFT or PENDING_INTERNAL_APPROVAL.
//   2. Resolves the recipient (body.to | quote.customer_contact_id |
//      customer.contact_email).
//   3. Renders the quote PDF and uploads it; signs a 7-day URL.
//   4. Issues a portal_tokens row with scopes=[quotes, accept_quote]
//      so the customer can click through to portal/accept_quote.
//   5. Drafts a `communications` row at status=queued. The reaper
//      fires it via SendGrid on the next agent tick.
//   6. Flips the quote to SENT, sets expires_at from validity_days,
//      sent_at, sent_via='email'.
//
// Reuses the same portal-token + signed-URL machinery that
// invoices/send (Phase 2 P2.7) shipped, plus the same pattern
// for queueing the comm row.

import crypto from "node:crypto";
import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { renderQuote } from "../_lib/pdf-renderer.js";
import { documentsBucket, ensureDocumentsBucket, friendlyStorageError } from "../_lib/storage.js";
import { upsertCustomerPart } from "../_lib/item-customer-parts.js";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PORTAL_TOKEN_TTL_DAYS = 30;
const QUOTE_NUDGE_DAYS = 14;
const QUOTE_NUDGE_COOLDOWN_HOURS = 72;
const QUOTE_GOAL_TYPES = ["quote_accept_within_14d", "expiring_quote_nudge"];

// Arm the two quote-targeted autonomous-agent goals when a quote
// is sent. Cancels any prior active/paused goals against the same
// quote first so a resend produces fresh cooldowns + due_at.
//
// Exported for unit testing via the __test bundle below; the live
// handler call sees identical behaviour.
export const armQuoteAgentGoals = async (svc, { tenantId, quote, expiresAt, ownerUserId }) => {
  const sentAt = quote.sent_at || new Date().toISOString();
  const dueAt = new Date(new Date(sentAt).getTime() + QUOTE_NUDGE_DAYS * 86400 * 1000).toISOString();
  const cancel = await svc.from("agent_goals")
    .update({ status: "cancelled" })
    .eq("tenant_id", tenantId)
    .eq("object_type", "quote")
    .eq("object_id", quote.id)
    .in("goal_type", QUOTE_GOAL_TYPES)
    .in("status", ["active", "paused"]);
  if (cancel.error) {
    return { error: "cancel prior goals: " + cancel.error.message };
  }
  const rows = [
    {
      tenant_id: tenantId,
      goal_type: "quote_accept_within_14d",
      object_type: "quote",
      object_id: quote.id,
      due_at: dueAt,
      config: { cooldown_hours: QUOTE_NUDGE_COOLDOWN_HOURS, sent_at: sentAt, version: quote.version },
      created_by: ownerUserId,
      owner_user_id: ownerUserId,
    },
    {
      tenant_id: tenantId,
      goal_type: "expiring_quote_nudge",
      object_type: "quote",
      object_id: quote.id,
      due_at: expiresAt,
      config: { sent_at: sentAt, expires_at: expiresAt, version: quote.version },
      created_by: ownerUserId,
      owner_user_id: ownerUserId,
    },
  ];
  const ins = await svc.from("agent_goals").insert(rows).select("id, goal_type");
  if (ins.error) {
    // P1 from May 2026 critic: a concurrent send (double-click,
    // retry) racing with this one can interleave cancel + insert,
    // and migration 082's partial unique index will refuse the
    // duplicate insert with code 23505. That is the desired
    // behaviour, treat as success: the sibling caller has already
    // armed the goals we wanted.
    if (/unique|duplicate|23505|agent_goals_active_target_uniq/i.test(ins.error.message)) {
      return { goals: [], dedup: true };
    }
    return { error: "insert goals: " + ins.error.message };
  }
  return { goals: ins.data || [] };
};

export const __test = { armQuoteAgentGoals, QUOTE_NUDGE_DAYS, QUOTE_NUDGE_COOLDOWN_HOURS, QUOTE_GOAL_TYPES };

const portalBaseUrl = () => {
  const base = process.env.PORTAL_BASE_URL || process.env.PUBLIC_APP_URL || "";
  return base ? base.replace(/\/+$/, "") : "";
};

const issuePortalTokenForQuote = async (svc, ctx, quote, customer) => {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + PORTAL_TOKEN_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const ins = await svc.from("portal_tokens").insert({
    tenant_id: ctx.tenantId,
    customer_id: quote.customer_id || customer?.id || null,
    email: customer?.contact_email || null,
    token,
    scopes: ["quotes", "accept_quote"],
    expires_at: expiresAt,
    created_by: ctx.user?.id || null,
  }).select("id, token, expires_at").single();
  if (ins.error) {
    // Bug fix May 2026: previously a portal-token insert failure
    // returned null and the quote-send proceeded with no Accept
    // link in the email. Customer received a quote they could view
    // but not click "Accept" on. Now we surface the failure to the
    // caller so it can land on the response body + audit log.
    // eslint-disable-next-line no-console
    console.warn("[quotes/send] portal token insert failed: " + ins.error.message);
    return { error: ins.error.message };
  }
  const base = portalBaseUrl();
  const url = base ? base + "/portal/" + ins.data.token + "?quote=" + quote.id : null;
  return { id: ins.data.id, token: ins.data.token, expires_at: ins.data.expires_at, url };
};

const resolveRecipient = async (svc, tenantId, quote, override) => {
  if (override) {
    return { email: override, name: null, customer_name: null };
  }
  let customerName = null;
  if (quote.customer_id) {
    const c = await svc.from("customers").select("customer_name, contact_email")
      .eq("tenant_id", tenantId).eq("id", quote.customer_id).maybeSingle();
    if (c.data) customerName = c.data.customer_name;
    if (quote.customer_contact_id) {
      const ct = await svc.from("customer_contacts").select("name, email")
        .eq("tenant_id", tenantId).eq("id", quote.customer_contact_id).maybeSingle();
      if (ct.data?.email) {
        return { email: ct.data.email, name: ct.data.name, customer_name: customerName };
      }
    }
    if (c.data?.contact_email) {
      return { email: c.data.contact_email, name: null, customer_name: customerName };
    }
  }
  return { email: null, name: null, customer_name: customerName };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.id) return json(res, 400, { error: { message: "id required" } });

    const svc = serviceClient();
    const qQ = await svc.from("quotes").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
    if (qQ.error) throw new Error("quotes read: " + qQ.error.message);
    if (!qQ.data) return json(res, 404, { error: { message: "Quote not found" } });
    const quote = qQ.data;
    if (!["DRAFT", "PENDING_INTERNAL_APPROVAL"].includes(quote.status)) {
      return json(res, 409, { error: { message: "Cannot send a quote in status " + quote.status } });
    }

    const recipient = await resolveRecipient(svc, ctx.tenantId, quote, body.to);
    if (!recipient.email) {
      return json(res, 400, { error: { message: "No recipient email; pass `to` or set customer.contact_email / customer_contact_id." } });
    }

    let customer = null;
    if (quote.customer_id) {
      const c = await svc.from("customers").select("*").eq("tenant_id", ctx.tenantId).eq("id", quote.customer_id).maybeSingle();
      customer = c.data || null;
    }

    // Audit fix May 2026: read line rows from quote_lines (the
    // canonical post-108 source) so a quote edited via the
    // drawer is sent / hashed with the right data. Falls back to
    // the legacy JSONB when no rows exist (pre-108 quote that
    // missed the 109 backfill).
    const linesRes = await svc.from("quote_lines")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .eq("quote_id", quote.id)
      .order("line_index", { ascending: true });
    const canonicalLines = (linesRes && !linesRes.error && Array.isArray(linesRes.data) && linesRes.data.length)
      ? linesRes.data
      : (Array.isArray(quote.line_items) ? quote.line_items : []);

    // Audit fix May 2026: load the customer's active terms pack
    // so the emailed PDF + share link include the negotiated
    // boilerplate (orders POST auto-attaches them; quote send was
    // missing the read path).
    let customerTermsClauses = [];
    let customerTermsPack = null;
    if (quote.customer_id) {
      try {
        const packs = await svc.from("customer_terms_packs")
          .select("id, pack_name, version")
          .eq("tenant_id", ctx.tenantId)
          .eq("customer_id", quote.customer_id)
          .eq("is_active", true)
          .order("version", { ascending: false })
          .limit(1);
        const pack = packs.data && packs.data[0];
        if (pack) {
          customerTermsPack = pack;
          const clauses = await svc.from("customer_terms_clauses")
            .select("clause_index, heading, body, is_blocking")
            .eq("tenant_id", ctx.tenantId)
            .eq("pack_id", pack.id)
            .order("clause_index", { ascending: true });
          customerTermsClauses = clauses.data || [];
        }
      } catch (_) { /* pre-106: tables do not exist */ }
    }

    // Render + upload PDF.
    let shareUrl = null;
    let pdfError = null;
    if (body.share_link !== false) {
      const tQ = await svc.from("tenants").select("display_name").eq("id", ctx.tenantId).maybeSingle();
      const pdf = await renderQuote({
        kind: "Quotation",
        number: quote.quote_number + " v" + quote.version,
        date: new Date(quote.created_at).toLocaleDateString("en-US"),
        brand: { name: tQ.data?.display_name || "Anvil" },
        from: { name: tQ.data?.display_name || "Anvil" },
        to: {
          name: customer?.customer_name || recipient.name || "Customer",
          email: recipient.email,
          gstin: customer?.gstin,
        },
        items: canonicalLines,
        customerTermsPack: customerTermsPack
          ? { name: customerTermsPack.pack_name, version: customerTermsPack.version }
          : null,
        customerTermsClauses: customerTermsClauses.map((c) => ({
          heading: c.heading || null,
          body: c.body || "",
          blocking: !!c.is_blocking,
        })),
        subtotal: quote.subtotal,
        tax: quote.tax_total,
        total: quote.grand_total,
        currency: quote.currency || "INR",
        notes: quote.notes,
      }).catch((err) => {
        // Bug fix May 2026: previously the render error was
        // swallowed entirely (.catch(() => null)). The send
        // proceeded with no PDF + no share_url and the customer
        // received a bare email. Now we capture the error so it
        // lands on the response + recordAudit so ops can debug.
        pdfError = err?.message || String(err);
        // eslint-disable-next-line no-console
        console.warn("[quotes/send] renderQuote: " + pdfError);
        return null;
      });
      if (pdf) {
        let bucket;
        try { bucket = await ensureDocumentsBucket(svc); }
        catch (e) {
          bucket = documentsBucket();
          // eslint-disable-next-line no-console
          console.warn("[quotes/send] ensureDocumentsBucket: " + e.message);
        }
        const path = ctx.tenantId + "/quotes/" + quote.id + "_v" + quote.version + ".pdf";
        const up = await svc.storage.from(bucket).upload(path, pdf, { contentType: "application/pdf", upsert: true });
        if (up.error) {
          // eslint-disable-next-line no-console
          console.warn("[quotes/send] storage upload: " + friendlyStorageError(up.error.message, bucket));
        } else {
          const signed = await svc.storage.from(bucket).createSignedUrl(path, SHARE_TTL_SECONDS);
          if (!signed.error) shareUrl = signed.data.signedUrl;
        }
      }
    }

    const portal = await issuePortalTokenForQuote(svc, ctx, quote, customer);

    const greeting = "Hello" + (recipient.name ? " " + recipient.name : (recipient.customer_name ? " " + recipient.customer_name : "")) + ",";
    const subject = body.subject || ("Quotation " + quote.quote_number + " v" + quote.version);
    const lines = [
      greeting,
      "",
      "Please find quotation " + quote.quote_number + " (version " + quote.version + ") for "
        + (quote.currency || "INR") + " " + (Number(quote.grand_total) || 0).toFixed(2) + ".",
    ];
    if (quote.validity_days) {
      lines.push("Validity: " + quote.validity_days + " days from today.");
    }
    if (shareUrl) {
      lines.push("");
      lines.push("View quotation: " + shareUrl);
    }
    if (portal?.url) {
      lines.push("");
      lines.push("Accept this quotation: " + portal.url);
    }
    lines.push("");
    lines.push("Reply to this email if you'd like changes; happy to revise.");
    const text = body.body || lines.join("\n");

    // Compute payload_hash for the audit trail. The customer's
    // accept-click can verify they accepted exactly this version.
    // Audit fix May 2026: hash the canonical quote_lines source
    // (or the JSONB fallback) so a drawer-edited quote produces
    // a hash that matches what was actually rendered and sent.
    const payloadHash = crypto.createHash("sha256")
      .update(JSON.stringify({
        id: quote.id,
        version: quote.version,
        line_items: canonicalLines,
        currency: quote.currency,
        grand_total: quote.grand_total,
      }))
      .digest("hex");

    // Flip the quote to SENT, populate sent_at + expires_at +
    // sent_via, persist the payload_hash so portal/accept_quote
    // can verify on click.
    const validityDays = quote.validity_days || 30;
    const expiresAt = new Date(Date.now() + validityDays * 86400 * 1000).toISOString();
    const upd = await svc.from("quotes").update({
      status: "SENT",
      sent_at: new Date().toISOString(),
      sent_via: "email",
      expires_at: expiresAt,
      payload_hash: payloadHash,
      updated_at: new Date().toISOString(),
    }).eq("tenant_id", ctx.tenantId).eq("id", quote.id).select("*").single();
    if (upd.error) throw new Error("quote SENT update: " + upd.error.message);

    // Layer B (item-mapping automation): learn from quote SENT.
    // The operator has vetted every line in the recon-table step
    // before sending, so the (customer_part_number, item_id) pair
    // on each line is a confidence-95 signal we want to remember.
    // Future POs from the same customer carrying the same
    // customer code will resolve via the customer_part tier in
    // src/api/_lib/item-mapper.js without any operator action.
    //
    // Best-effort: per-line failures log but never abort the
    // send. The shared upsert helper's preserve-manual rule means
    // we never downgrade a manual / bulk_import row, so this hook
    // is safe to fire on every send even after the same line was
    // hand-confirmed by an operator on the SO recon table.
    try {
      if (quote.customer_id && Array.isArray(canonicalLines) && canonicalLines.length) {
        // Distinct part_no -> item_master.id lookup. One query
        // across all lines so a 30-line quote runs at most one
        // round-trip.
        const partNos = [...new Set(
          canonicalLines
            .map((l) => l && l.part_no)
            .filter((s) => s && String(s).trim().length)
            .map((s) => String(s).trim())
        )];
        const partIdByPartNo = new Map();
        if (partNos.length) {
          const imRes = await svc.from("item_master")
            .select("id, part_no")
            .eq("tenant_id", ctx.tenantId)
            .in("part_no", partNos);
          if (imRes && !imRes.error && Array.isArray(imRes.data)) {
            for (const row of imRes.data) {
              if (row.part_no) partIdByPartNo.set(String(row.part_no), row.id);
            }
          }
        }
        const nowIso = new Date().toISOString();
        const actor = ctx.user && ctx.user.id ? ctx.user.id : null;
        let writes = 0;
        for (const line of canonicalLines) {
          if (!line || !line.customer_part_number) continue;
          // Two ways to resolve item_id: either the JSONB fallback
          // line carries _mapped_item.id from the originating
          // order, or we look up item_master by part_no for the
          // canonical quote_lines path.
          let itemId = null;
          if (line._mapped_item && line._mapped_item.id) itemId = line._mapped_item.id;
          if (!itemId && line.part_no) itemId = partIdByPartNo.get(String(line.part_no).trim()) || null;
          if (!itemId) continue;
          // Skip uncertain LLM suggestions; we never want to
          // launder a low-confidence guess through quote send.
          const mi = line._mapped_item;
          if (mi && mi.match_via === "llm_suggest" && mi.confidence_pct != null
              && Number(mi.confidence_pct) < 80) {
            continue;
          }
          try {
            await upsertCustomerPart(svc, {
              tenantId: ctx.tenantId,
              itemId,
              customerId: quote.customer_id,
              customerPartNumber: String(line.customer_part_number).trim(),
              customerPartDescription: line.description || null,
              createdVia: "quote_sent",
              createdBy: actor,
              confidencePct: 95,
              confirmedAt: nowIso,
              confirmedBy: actor,
            });
            writes++;
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[quotes/send Layer B] line write-back failed: " + (e && e.message));
          }
        }
        if (writes > 0) {
          await recordEvent(ctx, {
            caseId: quote.id,
            eventType: "item_customer_part_confirmed",
            objectType: "quote",
            objectId: quote.id,
            detail: { writes, source: "quote_sent", customer_id: quote.customer_id },
          });
        }
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[quotes/send Layer B] write-back batch failed: " + (e && e.message));
    }

    // Queue the email.
    const draft = await svc.from("communications").insert({
      tenant_id: ctx.tenantId,
      object_type: "quote",
      object_id: quote.id,
      kind: "quote_email",
      to_addr: recipient.email,
      subject,
      body: text,
      status: "queued",
      sent_by: ctx.user?.id || null,
      metadata: {
        quote_id: quote.id,
        version: quote.version,
        share_url: shareUrl,
        portal_token_id: portal?.id || null,
        portal_url: portal?.url || null,
        payload_hash: payloadHash,
      },
    }).select("*").single();
    if (draft.error) throw new Error("comm draft: " + draft.error.message);

    await recordAudit(ctx, {
      action: "quote_send",
      objectType: "quote",
      objectId: quote.id,
      detail: recipient.email + " :: v" + quote.version,
      payloadHash,
    });

    // Audit P10 follow-up: arm the autonomous-agent goals that
    // nudge this quote toward acceptance and warn before expiry.
    // The handlers themselves shipped in Phase 6 (P6.x); the goals
    // were never created because no caller upstream persisted an
    // agent_goals row.
    const armed = await armQuoteAgentGoals(svc, {
      tenantId: ctx.tenantId,
      quote: upd.data,
      expiresAt,
      ownerUserId: ctx.user?.id || null,
    });
    if (armed.error) {
      // Non-fatal: the send already happened. Surface in audit so
      // ops can see which arming path failed without blocking the
      // operator's flow.
      await recordAudit(ctx, {
        action: "quote_goal_arm_failed",
        objectType: "quote",
        objectId: quote.id,
        detail: armed.error,
      });
    }

    // Bug fix May 2026: surface portal-token + pdf-render failures
    // on the response so the operator UI can flag a degraded send
    // (quote went out but accept link / attached PDF missing).
    if (portal?.error) {
      await recordAudit(ctx, {
        action: "quote_send_portal_token_failed",
        objectType: "quote",
        objectId: quote.id,
        detail: portal.error,
      });
    }
    if (pdfError) {
      await recordAudit(ctx, {
        action: "quote_send_pdf_render_failed",
        objectType: "quote",
        objectId: quote.id,
        detail: pdfError,
      });
    }

    return json(res, 200, {
      ok: true,
      communication_id: draft.data.id,
      share_url: shareUrl,
      portal_url: portal?.url || null,
      portal_token_id: portal?.id || null,
      portal_token_error: portal?.error || null,
      pdf_error: pdfError,
      quote: upd.data,
      armed_goals: armed.error ? [] : armed.goals,
      status: "queued",
    });
  } catch (err) { sendError(res, err); }
}
