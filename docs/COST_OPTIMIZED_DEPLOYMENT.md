# Zero-Budget Deployment Playbook

Status: living doc, May 2026.

The goal is to run Anvil end-to-end at $0/month while you have no
paying customers. No new infrastructure to deploy. All free tiers,
all hosted.

If you're past PoC and have real traffic, the **upgrade path**
section at the bottom shows what to swap in next.

---

## What you spend money on (and what you don't)

| Service | PoC tier | Card needed | What it covers |
|---------|----------|-------------|----------------|
| Vercel Hobby | free | no | API + frontend hosting (100 GB bandwidth, 1M function invocations, 4h Active CPU/mo) |
| Supabase Free | free | no | Postgres + storage + auth (500 MB DB, 1 GB storage, 50K MAU) |
| Gemini 2.5 Flash | free | no | Primary doc-AI extractor (1500 RPD, 1M TPM) |
| Anthropic Claude | pay-as-you-go | yes | Fallback only; rate-capped |
| Mistral OCR | "Experiment" tier | no | OCR fallback for image-only PDFs (daily quota) |
| Azure DI F0 | free forever | yes (no charges) | Backup structured extractor (500 pages/mo, 4 MB max file) |

For ≤50 extractions/day you stay at $0/month. The cost-guard infra
hard-stops paid adapters when their daily cap is hit.

---

## One-time setup

### 1. Vercel (frontend + API)

You're already here. Hobby plan is fine. **Note**: Vercel's Hobby
plan is "non-commercial, personal use only" per the ToS. If you
turn this into a real business, plan to upgrade to Pro ($20/mo).

### 2. Supabase (database)

- Run every migration up to `093_cost_optimized_adapters.sql` in
  the SQL editor. Newest first if your dev DB is new.
- Free tier projects pause after 7 days of inactivity. Visit the
  dashboard once a week or set up a tiny cron that pings
  `/api/health`.
- Two free projects per account. Use one for dev, one for prod.

### 3. Get a Gemini API key (free, no card)

1. Go to https://aistudio.google.com/apikey.
2. Sign in with a Google account.
3. Click "Create API key" -> select a Google Cloud project (or let
   it create one).
4. Copy the key.
5. In Vercel project settings, set env var:
   ```
   GEMINI_API_KEY=<your key>
   ```
6. Redeploy.

That's it. The dispatcher's default order now puts Gemini first;
PoC traffic naturally hits the free tier.

### 4. Get an Anthropic API key (paid, but rate-capped)

Optional - skip if you don't want any paid adapter at all.

1. Go to https://console.anthropic.com/.
2. Add $5 in credits (lasts months at PoC traffic).
3. Create a key.
4. In Vercel:
   ```
   ANTHROPIC_API_KEY=<your key>
   ANTHROPIC_MODEL_DEFAULT=claude-haiku-4-5-20251001
   ```
5. **Critical**: set a tenant-level cap so a runaway upload can't
   drain your $5. In your Supabase SQL editor:
   ```sql
   update tenant_settings
   set docai_daily_limits = '{"claude": 25}'::jsonb
   where tenant_id = '<your-tenant-id>';
   ```
   This stops Claude calls after 25/day. Adjust as needed.

### 5. Optional: Mistral OCR + Azure DI F0

Only worth wiring if you have image-only PDFs that Gemini can't
read directly:

#### Mistral OCR
1. Sign up at https://console.mistral.ai/.
2. Free "Experiment" tier covers PoC.
3. Set `MISTRAL_API_KEY` in Vercel.

#### Azure Document Intelligence F0
1. Create a free Azure account ($200 credit, doesn't expire on F0).
2. Create a Document Intelligence resource on **F0** tier.
3. Set in Vercel:
   ```
   AZURE_DI_ENDPOINT=https://<your-resource>.cognitiveservices.azure.com/
   AZURE_DI_KEY=<your key>
   ```

Both have free quotas; the dispatcher's normal `isConfigured` ->
attempt -> `recordCall` flow tracks usage in `docai_daily_usage`
regardless.

---

## Per-tenant cost guards

The Phase Cost-Opt migration adds two per-tenant levers:

### `docai_daily_limits`

Hard-stop adapter calls per day. Empty/null = unlimited (legacy).

```sql
update tenant_settings
set docai_daily_limits = '{
  "claude":   25,
  "reducto":  100,
  "azure_di": 200,
  "unstructured": 50
}'::jsonb
where tenant_id = '...';
```

The dispatcher logs a `skipped_over_budget` attempt when the cap
is hit and falls through to the next adapter.

### `docai_anthropic_model`

Pin the Claude model per tenant. Default = Sonnet 4 (best quality,
$3/M input, $15/M output). Haiku is ~4x cheaper:

```sql
update tenant_settings
set docai_anthropic_model = 'claude-haiku-4-5-20251001'
where tenant_id = '...';
```

For PoC + simple POs (clean PDFs, well-formatted): Haiku is plenty.
For complex tenders / handwritten / multi-currency: keep Sonnet.

### `docai_provider_order`

Override the global default if you want Claude first (e.g., you
explicitly want the highest-quality LLM and budget allows):

```sql
update tenant_settings
set docai_provider_order = array['claude', 'gemini', 'azure_di']
where tenant_id = '...';
```

Default cost-optimised order:
`['gemini', 'docling', 'marker', 'unstructured', 'azure_di', 'reducto', 'claude']`

---

## Live cost telemetry

```
GET /api/docai/usage
```

Response:

```json
{
  "date": "2026-05-10",
  "limits": { "claude": 25 },
  "usage": [
    { "adapter": "gemini",  "call_count": 42, "estimated_cost_usd": 0.025, "limit": null, "remaining": null },
    { "adapter": "claude",  "call_count": 5,  "estimated_cost_usd": 0.110, "limit": 25,   "remaining": 20 }
  ]
}
```

Per-call costs are estimates from `process.env.COST_USD_*` (see
`src/api/_lib/cost_guard.js` for defaults). Override via env var
to match your actual contract pricing.

### `GET /api/docai/cost_status?days=N`

Drives the **DocAI cost** panel on the admin screen. Aggregates
today's usage plus a configurable trend window (default 7 days,
clamped 1..90):

```json
{
  "date": "2026-05-10",
  "window_days": 7,
  "today_usage": [{ "adapter": "gemini", "call_count": 42, "estimated_cost_usd": 0.025, "last_called_at": "2026-05-10T15:42:01Z" }],
  "trend_window": { "calls": 312, "cost": 0.184 },
  "trend_series": {
    "dates": ["2026-05-04", "...", "2026-05-10"],
    "adapters": ["claude", "gemini"],
    "series": {
      "gemini": { "calls": [40, 38, 47, ...], "cost": [0.024, 0.023, 0.028, ...] },
      "claude": { "calls": [3,  4,  5,  ...], "cost": [0.066, 0.088, 0.110, ...] }
    }
  },
  "burn":    { "gemini": { "today_calls": 42, "median_n_calls": 40, "ratio": 1.05, "window_days": 7 } },
  "anomalies": [{ "adapter": "claude", "date": "2026-05-08", "calls": 24, "median": 4, "multiplier": 6.0 }],
  "forecast": { "claude": { "cap": 100, "used": 50, "remaining": 50, "rate_per_hour": 4.2, "hours_to_cap": 11.9, "will_hit_cap_today": true } },
  "recommendations": [/* … */],
  "summary": { "anomalies_count": 1, "forecast_caps_at_risk_today": 1 }
}
```

`trend_series` is the dense per-day per-adapter buckets the admin
panel uses to draw the stacked-area chart (with a CSV export of
the same data). `burn` ratios `today / window-median` per
adapter; ratios `>= 2.0` are highlighted in the UI. `anomalies`
flags days where calls hit `>= 2x` median **and** `>= 5` calls
(the 5-call floor suppresses noise on low-volume tenants).
`forecast` projects per-cap exhaust hours from today's rate;
`will_hit_cap_today` is the boolean the UI binds on for the "at
risk" badge.

---

## What this saves you vs. naive deployment

For 50 extractions/day on Anthropic Sonnet:
- Naive: 50 × $0.022 = $1.10/day = ~$33/month.
- Cost-optimised (Gemini Flash free tier): $0/month.

For 500 extractions/day after free tier (Gemini paid):
- Sonnet: $11/day = $330/month.
- Gemini Flash paid: $0.30/day = $9/month.
- **97% reduction.**

For repeat-customer extractions where a Phase D template fires:
- Pre-template: 1 LLM call/extraction.
- Post-template (3+ POs from the same customer with same layout):
  0 LLM calls. Zero. The deterministic regex anchor pulls every
  field directly from the body text.

---

## When to upgrade infra

Triggers + recommended next move:

| Trigger | What changes |
|---------|--------------|
| Vercel Hobby caps hit (4h CPU or 1M invocations) | Pro plan ($20/mo) or move to DO App Platform ($12/mo basic) |
| Supabase project paused too often | Pro plan ($25/mo) or self-host Postgres on a $4/mo Droplet |
| Gemini free tier exhausted | Add Anthropic Haiku as second-rank with `docai_provider_order` and a 100/day cap |
| Need offline / on-prem extraction | Deploy `docling-serve` on a $12/mo DO Basic Droplet (settings.docai_docling_endpoint already supports it; PR #86) |
| Image-heavy POs, Mistral OCR daily quota hit | Add Azure DI F0 as fallback, or self-host Marker on a $24/mo DO CPU Droplet |

The HTTP-mode adapters from PR #86 (Docling, Marker, Unstructured-OSS)
are already wired. When you're ready to self-host, deploy the
container and point `docai_*_endpoint` at the URL. Zero code change.

---

## Anti-footguns

- **Never** set `docai_provider_order = ['claude']` on prod tenants
  without a `docai_daily_limits.claude` cap. A single corrupt PDF
  stuck in a retry loop can drain $50 of credits in an hour.
- **Always** keep `ANTHROPIC_MODEL_DEFAULT` pointing at Haiku
  unless you've verified Sonnet adds real accuracy on your traffic.
- **Don't** wire Reducto / paid Unstructured at PoC stage. Their
  free tiers are too small to be useful; their paid pricing is
  worse than Gemini paid.
- The `docai_daily_usage` table grows ~7 rows/day in the worst
  case. Even at 365 days × 7 adapters × 100 bytes = 250 KB; well
  under Supabase free-tier limits. No archive job needed for years.
