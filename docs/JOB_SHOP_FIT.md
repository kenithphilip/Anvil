# Can Anvil serve a job shop?

Assessment from a real prospect profile: a Pune precision-machining and fixture
business — two plants, ~130 staff, 30+ CNC machines (5- and 7-axis mill-turn,
HMC, VMC, wire EDM, cylindrical and surface grinding, jig boring), CMM
inspection to 2 microns, ISO 9001:2015, exporting to Europe and the Americas.
Its customers are tier-1 automotive, aerospace, oil-and-gas and rail OEMs.

Backlog. Nothing built. The profile is on file; this describes the segment,
because the question worth answering is not "can we serve this one company" but
"can we serve job shops".

---

## 0. The short answer

**Useful today for the front half of their business. Absent for the back half.**

Anvil was built around a company that sells **its own products** — a catalogue,
a spare matrix, an installed base, aftersales. A job shop sells **capacity
against someone else's drawing**. Every part it makes is identified by the
customer's part number, priced from cycle time on a named machine, and routed
through a sequence of operations.

Anvil has an unusually strong answer to the first half of that and no model at
all of the second.

Saying so plainly matters more than the feature list. A job shop evaluating
Anvil as "an ERP" will find the thing it thinks it is buying is missing; the
same shop evaluating it as *"the system that reads our customers' POs and
tells us whether they match what we quoted"* will find something better than
what they have.

---

## 1. What already fits, and fits well

**Multi-format PO extraction.** They take orders from 25+ large OEMs, each with
its own PO layout, most sent as PDF. That is precisely the problem Anvil has
spent the most effort on — the extraction pipeline, per-kind schemas, prompt
versioning, the golden set, the corrected-run harvest.

**Matching on the customer's part number.** This is the one that matters most,
and it is recent. For a product company the buyer's code is a convenience; for
a job shop **it is the only identity a part has**. Every component in their
profile is labelled with the customer's part number and the customer's name.
`item_customer_parts`, and the reconciler's tiers added in #506 and #508 —
our code, then the buyer's code on a quote line, then the canonical dual-code
map — describe their world more accurately than they describe ours.

**Quote → PO reconciliation.** They quote per drawing and customers order
against those quotes, often months later and often partially. The reconciler,
the revision handling, and the quoted-but-not-ordered walk all apply unchanged.

**Mode A/B.** A shop this size runs Tally or similar and will not hand over
order processing on a promise. The shadow-comparison on-ramp is arguably a
better fit here than at a product company, because their order volume is higher
and more varied.

**Indian compliance.** GST, e-invoice, e-way bill, dispatch — same statutory
surface.

**Drawing extraction.** They work to customer drawings; `part_drawing` and
`assembly_bom` extraction exist, and raw-material inference from a drawing is
directly relevant to quoting.

---

## 2. What is missing, and it is the core of their business

**There is no operation, no work centre, no machine.** A job shop's central
object is a **routing**: op 10 turn, op 20 mill, op 30 wire-cut, op 40 grind,
op 50 CMM. Anvil has no such object anywhere. `bill_of_materials` is
parent→child parts — a structure, not a process. Nothing in the schema can
express "this part takes 40 minutes on the 5-axis and 20 on the grinder".

**There is no capacity, and no machine envelope.** Their machines have specific
limits — a 450mm × 1100mm turning envelope, a 3250 × 1500 table. Whether a job
can be quoted at all depends on which machine can hold it, and what that
machine costs per hour. Anvil models neither.

**Job costing does not exist.** A job-shop quote is material + setup + cycle
time × machine rate + tooling + inspection + margin. Anvil's quoting is
price-list and composition based. There is no rate, no cycle time, no setup.
This is the single biggest gap: **they cannot quote in Anvil**, and quoting is
where a job shop wins or loses money.

**No work order, no shop floor.** Releasing a job, tracking it through
operations, recording actual against planned — none of it. `docs/PENDING.md`
already carries a work-order entity as deferred; for this segment it is not
deferrable, it is the product.

**No traceability chain.** Aerospace and oil-and-gas customers require material
certificates, heat-number traceability and inspection reports tied to a
despatch. They have the CMM to produce the measurements and no system to bind
them to a job. This is also what stands between their ISO 9001 and the AS9100
their aerospace customers will eventually ask for.

**No inbound RFQ workflow.** Their sales motion starts with a customer sending
a drawing and asking for a price. Anvil's quoting assumes the part is already
known. The `rfq` extraction kind exists and `supplier_rfq` is outbound —
neither is "a customer sent us a drawing to quote".

---

## 3. What would have to be built

In dependency order. The first two are the ones that change the answer.

**A — Routing and work centres.** `work_centres` (machine, envelope, hourly
rate, setup rate) and `part_routings` (part → ordered operations, each with a
work centre, setup time, cycle time). Everything else depends on this existing.

**B — Quote from a routing.** Material + Σ(setup + cycle × qty) × rate +
tooling + inspection + margin. This is what makes Anvil usable at the moment a
job shop is deciding whether to bid, which is the moment that matters.

**C — Inbound RFQ.** A customer sends a drawing; extract it, propose a routing
from the geometry and the material, produce a quote. This is where Anvil's
extraction investment compounds into something a competitor cannot copy
quickly — and it is the natural extension of the drawing work already shipped.

**D — Work orders and shop-floor confirmation.** Release, operation
completion, actual vs planned. Also the thing that turns B's estimates into
learned rates rather than guesses.

**E — Certificates and traceability.** Material cert, heat number, CMM report,
bound to a job and reproducible at despatch.

**F — Capacity and promising.** Given the load on 30 machines, when can this
job actually ship? Only meaningful once A and D exist.

---

## 4. The strategic question, which is not a technical one

Anvil is currently a **product company's** system: catalogue, configuration,
spares, installed base, aftersales. A job shop needs a **capacity company's**
system: routings, machines, costing, shop floor.

These overlap in the commercial layer — quote, PO, reconcile, dispatch, invoice
— and Anvil's work there is genuinely strong and unusually transferable. They
diverge completely below it.

Three honest options:

1. **Stay a product-company system.** Sell the commercial layer to job shops as
   a front end alongside whatever they use for the floor. Real, smaller, and
   deliverable now.
2. **Add the job-shop spine (A–D).** Substantial — routing, costing, work
   orders — and it competes with entrenched, unloved incumbents in a segment
   that buys on price.
3. **Take the inbound-RFQ wedge (C) only.** Drawing in, quote out, using the
   extraction machinery already built. Narrow, defensible, and it does not
   require becoming an ERP. It is also the thing they would notice most,
   because estimating is the bottleneck in every job shop.

Option 3 is the one that uses what Anvil already has rather than what it would
have to become.

---

## 5. What to say to a shop like this today

Without overclaiming, and each of these is true now:

- We read your customers' purchase orders whatever format they arrive in, and
  match them on **your customer's part number**, which is the only number on
  the document.
- We tell you where a PO disagrees with what you quoted — price, quantity,
  terms — before you accept it.
- We can run alongside your existing system without writing to it, and show you
  where our answer and your clerk's answer differ, and which the PO supports.

And what not to say: that we plan the shop, cost a job, or schedule a machine.
We do not, and a shop will discover that in the first hour.

---

## 6. Open questions

1. Is the job-shop segment a target at all, or is this one prospect? A/B/C
   above are very different amounts of company.
2. If C (inbound RFQ), does a proposed routing need to be *right*, or only a
   starting point an estimator corrects? The second is achievable now; the
   first needs D's learned rates.
3. Would a shop pay for the commercial layer alone, knowing it does not touch
   the floor?
4. AS9100 traceability: an unlock for their aerospace growth, or a compliance
   project we do not want to own?
