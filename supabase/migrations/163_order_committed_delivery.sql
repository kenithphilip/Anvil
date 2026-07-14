-- 163_order_committed_delivery.sql
--
-- Logistics Ops P3 (outbound OTD). Orders had no customer-facing delivery
-- commitment (only po_date/quote_date); every "OTD" in the codebase measured
-- on-time PAYMENT, not delivery. Add the date we promised the customer so the
-- outbound monitor can flag at-risk/overdue deliveries and OTD can be measured
-- as: the order's delivered shipment (shipments.customer_delivery_date) <=
-- committed_delivery_date. Additive + idempotent; nullable, so existing orders
-- are unaffected until a commitment is set.

alter table orders add column if not exists committed_delivery_date date;

-- Partial index: the outbound scan + OTD rollup only look at orders that carry a
-- commitment, so keep the index small.
create index if not exists orders_committed_delivery_idx
  on orders (tenant_id, committed_delivery_date)
  where committed_delivery_date is not null;
