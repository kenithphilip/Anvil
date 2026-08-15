// Ask Anvil module personas.
//
// A persona is three things and nothing else:
//   - a system prompt
//   - a set of TOOL SCOPES
//   - a tenant flag that must be on
//
// THE PROMPT NEVER COMES FROM THE CLIENT. The browser sends a persona NAME;
// the server looks the rest up here. Accepting a caller-supplied system prompt
// would hand every authenticated user a prompt-injection lever over an
// assistant that can read the tenant's orders, invoices and customers.
//
// READ-ONLY BY CONSTRUCTION. The `so` persona's scope list contains no `write.`
// scope, so the write tools (create_lead, post_tally_voucher,
// acknowledge_inventory_exception) are never even offered to the model. That is
// a stronger guarantee than rejecting a write at execution time: the model
// cannot propose what it cannot see. assertReadOnly below is enforced by test,
// so adding a write scope to a read-only persona fails CI rather than shipping.
//
// Anvil's write path is unchanged and still exists: a write tool returns a
// preview plus a single-use confirm_token, and the mutation happens at
// /api/copilot/confirm behind `approve`. When a persona eventually needs to
// propose, it opts in by naming a write scope — deliberately, with the
// approval card already built.

// Tool scope tags, as declared on each tool in erp-chat-tools.js.
const READ_SCOPES = [
  "read.orders", "read.customers", "read.invoices",
  "read.pipeline", "read.inventory", "read.misc",
];

export const PERSONAS = Object.freeze({
  so: {
    id: "so",
    label: "Sales order agent",
    // Route ids this persona answers on (v3-app route ids).
    routes: ["so"],
    // tenant_settings column that must be true. Migration 210.
    flag: "so_agent_enabled",
    placeholder: "Ask about this order…",
    scopes: READ_SCOPES,
    system: `You are the Anvil Sales Order agent, embedded in the sales-order
workspace. The operator is a sales engineer looking at ONE order.

You can READ. You cannot change anything — you have no write tools, so never
imply you have acted, queued, or fixed something. If the operator asks you to
change data, say plainly that you can't, and tell them which control on the
screen does it.

Rules:
- Use tools whenever a question needs real data. Never guess at a number.
- Cite the tools you used at the end ("Source: search_orders, last_purchase_price").
- COUNTING: tools return total_count alongside a capped rows sample. Answer
  "how many" from total_count; counting the rows array under-reports.
- A zero result is a claim about the DATA, not proof. Say what you filtered on
  so the operator can tell whether the query or reality produced the zero.
- When the operator asks about a discrepancy, quote both numbers and their
  difference. "44 of 45 lines" and "short by Rs 36,745.20" are useful; "some
  lines appear to be missing" is not.
- Extraction is imperfect and the operator is the check on it. If the document
  and the extracted data disagree, say so and trust neither by default.
- Keep answers under 200 words unless asked for detail. Never invent IDs.`,
  },
});

// Personas available to this tenant. The flag is the whole gate: a persona
// whose flag is not explicitly true is simply not returned, so the UI has
// nothing to render.
export const enabledPersonas = (settings) =>
  Object.values(PERSONAS).filter((p) => settings?.[p.flag] === true);

// Resolve a client-supplied persona id. Returns null for unknown ids and for
// personas the tenant has not enabled — the caller turns that into a 403 rather
// than silently falling back, because falling back would WIDEN the tool set the
// caller asked to be narrowed to.
export const resolvePersona = (id, settings) => {
  if (!id || typeof id !== "string") return null;
  const p = PERSONAS[id.trim().toLowerCase()];
  if (!p) return null;
  if (settings?.[p.flag] !== true) return null;
  return p;
};

// Public shape for /api/agent/personas — prompt deliberately excluded. The
// browser has no use for it, and shipping it invites someone to edit and
// return it.
export const publicPersona = (p) => ({
  id: p.id, label: p.label, routes: p.routes, placeholder: p.placeholder, scopes: p.scopes,
});

export const isReadOnly = (p) => Array.isArray(p?.scopes) && p.scopes.every((s) => s.startsWith("read."));

export const __test = { READ_SCOPES };
