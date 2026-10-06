# When one PO line is a whole quote

Scoping note. A customer orders a configured assembly as a single line; the
sales order has to carry the parts it is made of. Backlog; nothing built.

Grounded in one real project order supplied 2026-08-24 — a purchase order with
three lines against two multi-page quotations. Figures below are relationships,
not amounts.

---

## 1. What the documents actually say

**The quotes.** Two of them, one per gun variant, 17 and 23 lines each. Each
itemises a complete installation: the gun itself, then a timer, transformer,
teaching pendant, cable assemblies, six hose variants sold by the roll, spring
balances, control/power/earth cable by the metre, a composite
"miscellaneous items" row listing a dozen slings, clips and ties, and finally
an installation-labour line priced in man-days.

**The purchase order.** Three lines.

| PO line | what it is |
|---|---|
| 1 | one **SET**, "manual welding gun, C type", customer's own item code |
| 2 | one **SET**, "manual welding gun, X type", customer's own item code |
| 3 | installation cost, 6 **man-days** |

**And the arithmetic is exact, in both directions:**

```
quote A total  −  quote A installation line  =  PO line 1 ex-price   ✓
quote B total  −  quote B installation line  =  PO line 2 ex-price   ✓
quote A installation + quote B installation  =  PO line 3            ✓
                    (3 man-days + 3 man-days = 6)
```

Not approximately. To the rupee, on all three.

So the customer did something deliberate and reproducible: **took each quote,
lifted the labour out, and ordered the remaining goods as one priced SET** —
then combined the labour from both quotes into a third line.

That is not a mangled PO. It is a normal way to buy a project, and the
relationship is provable rather than inferred.

---

## 2. Why Anvil cannot handle it today

**The reconciler is one-to-one.** `reconcilePoAgainstQuotes` matches a PO line
to a quote LINE — by our part number, then the buyer's code, then the dual-code
map. Here a PO line corresponds to a quote's *total*. Every one of the three PO
lines comes back `unmatched`, and every one of the forty quoted lines comes
back quoted-but-never-ordered. A correct order reads as a total failure.

**And the sales order would carry three SETs.** That is the more expensive
half. Downstream, nothing can be done with a line called "one SET":

- no work order can be raised for the transformer, the pendant, the hoses
- `bill_of_materials` never sees the components, so nothing explodes
- inventory allocation has no parts to allocate
- the spares and installed-base machinery records a SET, so aftersales for this
  customer knows a gun was shipped and not what is in it
- the six hose variants have MOQs measured in 100-metre rolls, and nothing will
  ever notice

The customer's document is right. Anvil's model of it is what is missing.

---

## 3. The concept: a kit line

**A PO line can be a kit header — a commercial roll-up whose internal
composition is a quote — and the two must both be true at once.**

The critical constraint, and the thing that makes this more than a data
transform: **the customer-facing figure must not change.** They ordered one SET
at one price. The invoice has to say one SET at that price, or it will not
match their PO and will not be paid. Exploding the line and shipping thirty-nine
invoice lines would break the commercial document to satisfy an internal need.

So a kit line is *both*:

| | carries | used by |
|---|---|---|
| **the header** | one line, the customer's item code, the SET price | invoice, acknowledgement, the customer's PO match, AR |
| **the composition** | the quote's lines, at quote prices | work orders, BOM, inventory, spares, installed base |

The header's price is authoritative for money. The composition is
authoritative for everything physical. Neither derives from the other at
reporting time; both are recorded.

---

## 4. What to build

**PR 1 — recognise it.** A pure matcher: does this PO line's amount equal a
quote's total, or a quote's total minus an identifiable subset? Report the
match with its evidence — which quote, which lines were excluded, and the
arithmetic — rather than a boolean. A kit match asserted without showing the
sum is not checkable by the person who has to approve it.

Deliberately arithmetic-first rather than description-matching. On this order
the PO calls the item a manual welding gun of one type while the quote's first
line names the same thing by its product family and variant code — a weak
textual signal either way, where the monetary identity is exact.

**PR 2 — record it.** The composition belongs somewhere both halves can read.
`order_line_kit_lines` (order_id, po_line_index, quote_id, quote_line_id, qty,
unit_price) keeps the header untouched on `orders.result.salesOrder.lineItems`
and puts the explosion beside it. **Not** a rewrite of the order's lines: that
would change what the invoice says.

**PR 3 — teach the reconciler.** A kit line should reconcile as *matched, by
kit* — with its quote named — and the quote's constituent lines must stop being
reported as never-ordered. Today's output on this order is 3 unmatched and ~40
spurious gaps, which is worse than silence: it is forty invitations to add a
variance that should not exist.

**PR 4 — explode where it matters.** Work orders, BOM and allocation read the
composition; invoice, acknowledgement and AR read the header. Each consumer
picks a side deliberately, and which side it picked is visible.

**PR 5 — show it.** The kit line on the SO workspace, expandable to its
composition, with the arithmetic that proved the match.

---

## 5. The extraction gap, which is separate and fixable now

The quote lines were reported as not extracted at all. Two concrete causes,
both checkable in the repo rather than inferred:

**The quote prompt has none of the multi-row guidance the PO prompt has.**
`SYSTEM_PROMPT` carries a 34-line block on multi-row-per-item tables that calls
itself *"the single biggest cause of a shredded line count"*, added by #106
after a 32-line PO returned zero lines. `QUOTE_SYSTEM_PROMPT` has **zero**
occurrences of it — 100 lines against the PO prompt's 171.

This is the **third** instance of the same drift in this repo: the same block
was missing from `gemini.js` (found while building #491), the
`unsupported_kind` guard landed on one adapter and not the other (#485), and
now a prompt fix has landed on one document kind and not its sibling. The
pattern is not adapter-specific. It is that a fix lands where the bug was
reported and nowhere else.

**The layout has two price column GROUPS, not two adjacent columns.** These
quotes print a plain unit-price/amount pair, then a separately headed
special-price unit-price/amount pair, then a tax group — with empty
drawing-number and remark columns between them. `QUOTE_TOOL` has `unitPrice`
and `listUnitPrice`, designed in #462 for two adjacent columns. Nothing in the
prompt describes a second *group*, and the special price is the one that
governs: it is what the totals are struck from, and what the PO was priced
against.

A composite cell — one row holding a dozen sub-items with their own quantities
— sits in both quotes and is a third likely contributor.

**This is worth fixing before the kit work**, because a kit match is arithmetic
against a quote's lines and totals. Without the lines there is nothing to do
the arithmetic with.

---

## 6. Open questions

1. When a kit's composition changes after the PO is placed — a revised quote —
   does the header price move? Commercially it must not without an amended PO.
2. Is the exclusion always labour? Here it is, twice. Deciding it is *always*
   labour would be fitting a rule to two observations.
3. Does a partial dispatch of a kit invoice proportionally, or does the kit
   invoice only when complete?
4. When only *some* of a quote is ordered as a kit, is the remainder a genuine
   quoted-not-ordered gap, or a second kit waiting for a second PO?
5. Should the MOQ on a hose sold by the 100-metre roll surface at kit
   explosion, when the customer has bought one gun's worth?
