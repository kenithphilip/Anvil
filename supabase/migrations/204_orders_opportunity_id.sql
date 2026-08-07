-- 204_orders_opportunity_id.sql
--
-- P2b bridge for the pipeline-conversion report: a denormalised link from a
-- sales order back to the opportunity it was raised for, so quotes-sent ->
-- orders-processed -> paid can be attributed precisely and a direct-PO order
-- (no generated quote) can be attributed manually in future.
--
-- NOTE: the P2b report does NOT depend on this column — it attributes via the
-- already-present orders.quote_id -> quotes.opportunity_id join, so the endpoint
-- keeps working whether or not this migration has been applied. This column is
-- the forward-looking denormalisation for (a) manual attribution of direct-PO /
-- voice / whatsapp orders that have no quote, and (b) the optional
-- analytics_pipeline_daily rollup.
--
-- Additive + idempotent. Applied MANUALLY like the rest (live DB lags the repo).

alter table orders add column if not exists opportunity_id uuid
  references opportunities(id) on delete set null;

create index if not exists orders_opportunity_idx
  on orders (tenant_id, opportunity_id);

-- Backfill from the generated-quote path where present. Direct-PO / voice /
-- whatsapp orders (quote_id null, or a quote with no opportunity) stay NULL and
-- surface as "unattributed" in the report rather than being mis-attributed.
update orders o
   set opportunity_id = q.opportunity_id
  from quotes q
 where o.quote_id = q.id
   and o.opportunity_id is null
   and q.opportunity_id is not null;

comment on column orders.opportunity_id is
  'Opportunity this SO was raised for (P2b pipeline attribution). Backfilled from quote_id->quotes.opportunity_id; NULL for direct-PO/voice/whatsapp orders. The report attributes via the quote_id join and does not require this column. See src/api/_lib/pipeline-conversion.js.';
