// POST /api/tally/amend
// Body: { parentOrderId, revisedSalesOrder }
// Compares the revised SO against the original, persists an order_amendments row,
// and returns a Tally amendment voucher payload as XML/JSON.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";

const lineKey = (li) => String(li.tallyItemName || li.itemName || li.sellerPartNo || "").toUpperCase();

const diffLineItems = (originalLines, revisedLines) => {
  const origMap = new Map(); originalLines.forEach((li) => origMap.set(lineKey(li), li));
  const revMap = new Map(); revisedLines.forEach((li) => revMap.set(lineKey(li), li));
  const changes = [];
  for (const [k, rev] of revMap.entries()) {
    const orig = origMap.get(k);
    if (!orig) { changes.push({ kind: "line_added", line: rev }); continue; }
    const fields = [];
    if (Number(orig.qty) !== Number(rev.qty)) fields.push({ field: "qty", old: orig.qty, new: rev.qty });
    if (Number(orig.rate) !== Number(rev.rate)) fields.push({ field: "rate", old: orig.rate, new: rev.rate });
    if ((orig.dueDate || "") !== (rev.dueDate || "")) fields.push({ field: "dueDate", old: orig.dueDate, new: rev.dueDate });
    if (fields.length) changes.push({ kind: "modified", key: k, fields, line: rev });
  }
  for (const [k, orig] of origMap.entries()) {
    if (!revMap.has(k)) changes.push({ kind: "line_removed", line: orig });
  }
  return changes;
};

const classifyAmendment = (changes) => {
  const kinds = new Set();
  changes.forEach((c) => {
    if (c.kind === "line_added") kinds.add("line_added");
    else if (c.kind === "line_removed") kinds.add("line_removed");
    else if (c.fields) c.fields.forEach((f) => kinds.add(f.field === "qty" ? "qty" : f.field === "rate" ? "price" : "date"));
  });
  if (kinds.size > 1) return "mixed";
  return kinds.values().next().value || "mixed";
};

const buildTallyAmendXml = (revised, voucherId) => {
  const escape = (s) => String(s == null ? "" : s).replace(/[&<>\"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const items = (revised.lineItems || []).map((li) => "<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>" + escape(li.tallyItemName || li.itemName) + "</STOCKITEMNAME><RATE>" + escape(li.rate) + "/Nos.</RATE><AMOUNT>-" + escape(li.amount) + "</AMOUNT><ACTUALQTY>" + escape(li.qty) + " Nos.</ACTUALQTY><BILLEDQTY>" + escape(li.qty) + " Nos.</BILLEDQTY></ALLINVENTORYENTRIES.LIST>").join("");
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA><TALLYMESSAGE><VOUCHER" + (voucherId ? " REMOTEID=\"" + escape(voucherId) + "\"" : "") + " VCHTYPE=\"Sales Order\" ACTION=\"Alter\"><DATE>" + escape((revised.date || "").replace(/-/g, "")) + "</DATE><VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME><VOUCHERNUMBER>" + escape(revised.voucherNo) + "</VOUCHERNUMBER><PARTYLEDGERNAME>" + escape(revised.partyName) + "</PARTYLEDGERNAME>" + items + "</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>";
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body || !body.parentOrderId || !body.revisedSalesOrder) return json(res, 400, { error: { message: "parentOrderId and revisedSalesOrder required" } });
    const svc = serviceClient();
    const parent = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.parentOrderId).single();
    if (parent.error || !parent.data) return json(res, 404, { error: { message: "Parent order not found" } });
    const originalLines = (parent.data.result && parent.data.result.salesOrder && parent.data.result.salesOrder.lineItems) || [];
    const revisedLines = body.revisedSalesOrder.lineItems || [];
    const changes = diffLineItems(originalLines, revisedLines);
    const amendmentType = classifyAmendment(changes);
    const tallyVoucher = await svc.from("tally_voucher_records").select("tally_voucher_id").eq("tenant_id", ctx.tenantId).eq("order_id", parent.data.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const xml = buildTallyAmendXml(body.revisedSalesOrder, tallyVoucher && tallyVoucher.data && tallyVoucher.data.tally_voucher_id);
    const insert = await svc.from("order_amendments").insert({
      tenant_id: ctx.tenantId,
      parent_order_id: parent.data.id,
      diff: { changes, amendmentType },
      amendment_type: amendmentType,
      status: "detected",
    }).select("*").single();
    if (insert.error) throw new Error(insert.error.message);
    await recordAudit(ctx, { action: "amendment_detected", objectType: "order", objectId: parent.data.id, detail: amendmentType + " " + changes.length + " change(s)" });
    await recordEvent(ctx, { caseId: parent.data.id, eventType: "amendment_drafted", objectType: "order_amendment", objectId: insert.data.id });
    return json(res, 200, { amendment: insert.data, changes, amendmentType, tallyXml: xml });
  } catch (err) {
    sendError(res, err);
  }
}
