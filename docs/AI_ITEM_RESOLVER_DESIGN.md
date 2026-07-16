# AI Item Resolver — design

**Status:** design for review. No implementation yet.
**Goal (Joel):** *"Use an AI layer to manage any situation. We are not trying to replicate an ERP — we want to be better and reduce clicks."*

The manufacturer's operators spend clicks reconciling every extracted PO line to the canonical `item_master`. Today the deterministic matcher handles the clean cases and the AI is a *suggestion* the operator must ask for and confirm — so every messy line is manual. This design makes the AI resolve **any** line and **auto-apply when confident**, so a clean PO opens already resolved and only the genuinely uncertain lines need a tap.

**Primary rule:** extend the existing matcher + AI infra; do not rebuild. Money-path safety is non-negotiable (a matched item drives HSN/GST → Tally).

---

## 1. What exists today (reuse, don't rebuild)

| Piece | File | Role |
|---|---|---|
| Deterministic ladder | `src/api/_lib/item-mapper.js` `mapLinesToItemMaster` | Tiers: customer_part → part_no → spec → alias → **fuzzy_blocked** → description_fuzzy. Free, instant. Stamps `_mapped_item`. |
| UOM resolve | `item-mapper.js` `resolveLineUom` | Canonical/base uom + `uom_mismatch` from `uom_aliases`. |
| LLM matcher | `src/api/_lib/item-mapper-llm.js` | Per-line: ~8 candidates → Claude returns top-3 with `confidence_pct`; must cite candidate IDs verbatim (anti-hallucination). Cap 10 lines. |
| Hybrid retrieval | `src/api/_lib/hybrid-item-search.js` `searchItemsHybrid` | BM25 + vector recall over item_master. |
| Rerank | `src/api/_lib/cross-encoder-rerank.js` `rerankCandidates` | Cross-encoder scoring of candidates. |
| Orchestrator | `src/api/mapping/resolve.js` (`POST /api/mapping/resolve`) | deterministic → hybrid → rerank → **top-3 suggestions** (never applies). |
| Learning loop | `item_customer_parts` + `orders/[id].js` `upsertCustomerPart` + `auto-promote-mappings.js` | Confirmed match → written back → free deterministic Tier-1 next time; N-of-M auto-consensus. |
| Review UI | `src/v3-app/screens/so-workspace.tsx` `mapAffordance` | Per-line chip + manual picker + per-line "suggest" (Layer C). |

**The gap vs the goal:** all AI output is *suggestion-only*, capped, and only runs on an operator click. It answers "which existing item" but not the hard situations (UOM, kit, new-part, ambiguity, obsolete). Result: every unmatched line = clicks.

---

## 2. The design

A single **AI Item Resolver** over the existing deterministic pass:

```
extracted lines
   │
   ▼
deterministic ladder (mapLinesToItemMaster)      ← free, resolves most lines
   │
   ├── resolved (high-trust tiers) ──────────────► done, no AI, no clicks
   │
   ▼ unresolved / low-trust lines
hybrid retrieval + rerank (candidates)           ← existing infra
   │
   ▼
AI DECISION (one structured verdict per line)    ← the new layer
   │
   ▼
confidence-gated AUTO-APPLY  ───► ≥threshold & tax-unchanged → applied (match_via "ai_auto")
   │                                └─ "AI" chip + one-click undo
   └── held: tax-changed / new_part / ambiguous / below-threshold
                                    └─ one-tap accept + bulk-accept-all
```

### 2.1 The unified verdict (handles any situation)
Per unresolved line the AI returns one structured decision — this is what replaces a dozen deterministic rules:

```
{
  action: "match" | "uom" | "kit" | "new_part" | "ambiguous" | "none",
  item_id,                     // for match/uom; must be a candidate id (verbatim)
  confidence,                  // 0-100
  reasoning,                   // short human-readable "why"
  tax_changed,                 // computed: matched HSN/GST differs from the extracted line
  uom: { base_qty, canonical_uom, factor } | null,   // for "uom" / "kit"
  kit_lines: [{ item_id, qty }] | null,              // for "kit" (one part -> many SKUs)
  new_part: { part_no?, description, hsn?, uom? } | null  // pre-filled create proposal
}
```

- **match** — the ordinary "this is item X" with confidence + why.
- **uom** — interprets "5 BOX = 50 NOS" against the item's stock unit (beyond the `uom_aliases` table — handles cases with no alias row).
- **kit** — one customer part → several SKUs with quantities.
- **new_part** — nothing fits → a pre-filled create proposal (never auto-created).
- **ambiguous** — several plausible; returns a ranked shortlist + why for a one-tap pick.

### 2.2 Confidence-gated auto-apply (the click-killer) — **Balanced posture**
A verdict is **auto-applied** (stamped `_mapped_item`, `match_via:"ai_auto"`, `ai_confidence`, `ai_reasoning`) only when **all** hold:
- `action === "match"` (or `"uom"`), and
- `confidence >= tenant_settings.ai_resolver_min_confidence` (default **90**), and
- **not `tax_changed`** (the matched item's HSN/GST equals the extracted line's) when `ai_resolver_hold_on_tax_change` (default true).

Everything else is **held** — attached as an `_ai_suggestion` for a one-tap accept: `new_part`, `kit`, `ambiguous`, tax-changed matches, and anything below threshold. **New-part is never auto-created.** Every auto-apply is **reversible** (one-click undo) and **audited**.

### 2.3 Frictionless trigger + learning
- Runs **automatically when the SO workspace opens** (enabled tenants), cached per order, so the sheet is pre-resolved — no "suggest" button. (Optionally later: inline on order-create.)
- Auto-applied and left uncorrected → `item_customer_parts` via the existing write-back, so the same line is **free deterministic Tier-1** next time. The AI cost is paid once per novel line, then never again.

---

## 3. Money-path guardrails (non-negotiable)
1. **Never auto-apply** `new_part`, `kit`, `ambiguous`, `tax_changed`, or below-threshold.
2. **Reversible + audited** — every `ai_auto` stamp records confidence + reasoning + `recordAudit`; one-click undo reverts to unmapped.
3. **Anti-hallucination** — the AI must return an `item_id` that appears verbatim in the candidate set (already enforced in `item-mapper-llm.js`); ids not in the set are dropped.
4. **Tax never changes silently** — a match that would change HSN/GST from the extracted line is always held for review.
5. **Feature-flagged + per-tenant dial** — `ai_resolver_enabled` off by default; threshold + hold-on-tax configurable.
6. **Cost bounded** — deterministic tiers resolve most lines for free; AI only runs on the remainder; batch, cap, and cache (learned → free). `ctx.user.id`, tenant-scoped, best-effort (a resolver failure never blocks the order).

---

## 4. Data model + API + UI changes

**DB — migration 164 (additive):**
- `tenant_settings.ai_resolver_enabled boolean default false`
- `tenant_settings.ai_resolver_min_confidence int default 90`
- `tenant_settings.ai_resolver_hold_on_tax_change boolean default true`
- (P5) `ai_resolution_log` — per-line verdict + outcome (applied/undone/rejected) for audit + negative-learning. Optional in P1.

**API:**
- `POST /api/mapping/ai_resolve` — `{ order_id | lines, customer_id }` → runs deterministic → retrieval → AI decision → returns lines with `_mapped_item` (auto-applied) or `_ai_suggestion` (held). Reuses `resolve.js` retrieval/rerank + `item-mapper-llm`. Pure decision/gate logic in `_lib/ai-item-resolver.js` (tested); I/O in the endpoint.

**UI (`so-workspace.tsx`):** auto-call `ai_resolve` on open for enabled tenants; render `ai_auto` with an "AI" chip (+ confidence tooltip) + one-click undo; held suggestions get one-tap accept + **bulk-accept-all**.

**`_mapped_item` additions:** `ai_confidence`, `ai_reasoning`; new `match_via` value `"ai_auto"`. Downstream consumers read `_mapped_item.id/hsn_sac/uom` as today — additive keys only.

---

## 5. Phasing
- **P1 — AI auto-resolve + inline + one-click review** (the keystone): resolver lib + confidence-gated auto-apply (Balanced) + `/api/mapping/ai_resolve` + settings (mig 164) + reduced-click UI + audit + tests. Delivers the core click reduction.
- **P2 — UOM as an AI decision** — pack/box interpretation with no alias row.
- **P3 — Kit / one-part→many-SKU** — line-expansion representation + downstream handling.
- **P4 — New-part create proposal** — `new_part` → pre-filled inline create (subsumes the "no create-item in the SO flow" gap).
- **P5 — Negative learning + ambiguity UX + `ai_resolution_log`** — rejected matches stop re-appearing; ranked shortlist UX.

## 6. How this subsumes the deterministic gaps
| Deterministic gap (audit) | Handled by |
|---|---|
| Ambiguous / duplicate master rows | AI `ambiguous` verdict (ranked + why) + held for a tap |
| Unscored Tier-5 wrong bind | AI decision with confidence, not arbitrary first-match |
| Obsolete/supersession | AI prefers active + reasons about it; held if unsure |
| UOM / pack / kit | AI `uom` / `kit` verdicts (P2/P3) |
| New part not in master | AI `new_part` proposal (P4) |
| Weak normalization (THB-001 vs THB001) | AI matches semantically; no global `norm()` risk |
| Every unmatched line = clicks | Confidence-gated auto-apply (P1) |

## 7. Open decisions (for review)
- **Trigger:** on SO-open (recommended — no cost on every PO import) vs inline on order-create (fewest clicks, cost on every create). P1 does on-open; create-time is a later toggle.
- **Model tier / cost ceiling:** fast model per line + batch; a per-tenant monthly cap? (reuse the DocAI cost-guard pattern).
- **Threshold default:** 90 (Balanced). Per-tenant adjustable.
- **`ai_resolution_log` in P1 or P5:** P5 unless we want the audit trail from day one.

## 8. Invariants (every PR here)
Never silently change HSN/GST; `ctx.user.id` not `ctx.userId`; `.eq("tenant_id", ctx.tenantId)`; `recordAudit` on every auto-apply; best-effort (never block the order); additive migrations applied manually; reuse the design-system primitives; no CDN scripts.
