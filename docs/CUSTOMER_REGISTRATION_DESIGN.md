# Customer registration — ideal format + automated capture (PARKED, backlog)

Status: **Parked backlog item.** No code. Defines the ideal customer
registration field set (from comparing Obara India's customer form and
Pinnacle/EKa's vendor master form) and an automated capture flow: GST-fetch
auto-fill, customer self-service via email, and parallel team verification
against an existing PO / cancelled cheque / invoice, converging on the existing
approval flow. Builds on the GSTIN-fetch item (#186) and the zero-data-entry
roadmap. See [[backlog-parked-prs]].

## Source forms compared
- **Obara "Customer Registration Form" (64 fields):** right customer structure
  (identity, 3-line address, PAN, GST, role contacts Purchase/Finance/Project,
  full bank block incl. SWIFT/IE) but BLOATED with pre-GST taxes (LST, CST,
  Service Tax, VAT, ECC, Commissionerate, Collectorate, Form Type/No — all
  defunct since GST 2017) and low-value fields (fax, language, company size/
  type, type of management, CEO resident reg no).
- **Pinnacle/EKa "Vendor Master Form" (SAP):** leaner + GST-era-correct — GST,
  PAN, MSME/Udyam (Micro/Small/Medium), IRN applicability, TDS/withholding
  block, incoterm, currency, payment terms, bank (name/acct/IFSC/branch),
  country + region(state code), and a multi-signoff approval row (Buyer ·
  Materials Head · MD · Accounts · IT). Weakness: cluttered with SAP internals
  (schema groups, recon accounts, sort keys) a customer should never see.

Ideal = Obara's customer field structure, modernised to Pinnacle's GST-era tax
set, split into customer-facing vs internal sections, designed for auto-capture.

## Ideal field set

Legend — Source: **GST** = auto from GSTIN fetch (#186); **DOC** = OCR from an
uploaded artifact; **CUST** = customer self-fills; **INT** = internal/Obara-set.
Mandatory marked *.

### A. Statutory identity (GST-first; mostly auto + verified)
| Field | Source | Verify against |
|---|---|---|
| GSTIN * | CUST (entered) | GST registry (status Active) |
| Legal name * | GST | GST cert / PO / invoice |
| Trade name | GST | — |
| PAN * | GST (derived chars 3-12) | PAN card / GST |
| State + state code * | GST (digits 1-2) | GST |
| Principal address (building/street/city/district/pincode) * | GST | GST cert |
| Taxpayer type (Regular/Composition) | GST | — |
| Registration status + date | GST | — (block if Cancelled) |
| Constitution of business | GST | — |
| Country * | CUST (default India) | — |
| Foreign tax id + type (VAT/TIN/EIN) | CUST | — (only when no GSTIN) |

### B. Business profile
| Field | Source | Notes |
|---|---|---|
| Customer type * (OEM / Tier-1 / Distributor / Aftermarket) | INT | drives pricing/segment |
| Industry / segment (Automobile, EV…) | CUST/GST | GST nature-of-business hints |
| Customer category | INT | Obara-managed |
| Short name / abbreviation (<=10) | INT | for ERP/Tally |
| MSME / Udyam status (Micro/Small/Medium) + number | CUST/DOC | India MSME 45-day payment rule |
| Website | CUST | optional |

(Dropped vs Obara: fax, language, company size/type, type of management,
business opening date, CEO resident reg no — low value.)

### C. Contacts (role-based, trimmed)
| Field | Source |
|---|---|
| Purchase contact * (name, designation, email, mobile) | CUST/DOC (from PO) |
| Finance/AP contact (name, email, phone) | CUST | for invoicing + collections |
| Project/Quality contact (optional) | CUST |
| Escalation / key-account contact (optional) | CUST |

### D. Commercial terms
| Field | Source |
|---|---|
| Currency * (INR default) | INT |
| Payment terms * (Net 30/45/60) | INT (negotiated) |
| Credit limit | INT (finance) |
| Incoterms (exports) | INT |
| Customer reference for special rates (Obara subsidiary c2c) | INT |

### E. Banking (for refunds/credit notes; verified by cancelled cheque)
| Field | Source | Verify |
|---|---|---|
| Bank name, account no, IFSC, branch, account type | CUST/DOC | cancelled cheque |
| SWIFT / IBAN (foreign) | CUST | — |

### F. Internal / system (never shown to customer)
Customer code (ERP), assigned sales owner, requesting department,
registration date, approval status, verification evidence links.

## Automated capture flow

A new **customer_registration_requests** object (status: `draft` ->
`shared` -> `customer_submitted` -> `team_verifying` -> `amend_requested` ->
`approved` -> `created`). Three capture paths feed one approval:

1. **GST-first auto-fill (zero entry).** Operator (or customer) enters the
   GSTIN -> #186 fetch fills section A + hints B, with verification badges.
   Most of the form is now populated from one field.
2. **Customer self-service via email.** Generate a tokenized form link (reuse
   the quote-share portal-token pattern) and email it to the customer; they
   fill only the human bits (contacts, terms, bank) and upload a **cancelled
   cheque**, **GST certificate**, and optionally a **PO/invoice**; submit ->
   lands as `customer_submitted`. The same link lets them **amend** if the team
   flags a mismatch.
3. **Parallel team verification from documents.** A team member uploads/links
   an existing **PO, cancelled cheque, or invoice**; DocAI OCR extracts GSTIN,
   name, address, and bank details and **auto-cross-checks** them against the
   GST-fetch + customer submission, flagging mismatches. (Reuses the existing
   DocAI pipeline + validators.)

All paths converge on the existing **customer change-request approval flow**
(writer submits, approver approves) with the verification evidence attached.
On approve -> the customer master row is created/updated.

### Verification matrix (which artifact proves which field)
| Artifact | Verifies |
|---|---|
| GST certificate / GST fetch | GSTIN, legal name, address, PAN, state, status |
| Cancelled cheque | bank name, account no, IFSC, account-holder name |
| PO / Invoice | GSTIN, bill-to/ship-to address, confirms they transact |
| PAN card | PAN |
| MSME / Udyam certificate | MSME status + Udyam number |

## Phasing (each = shippable PR + migration + gates)
- **P1 — Ideal form + GST prefill:** the trimmed field set in the new-customer
  form, GST-fetch prefill (#186 P1), verification badges. Replaces the
  spreadsheet for internal entry.
- **P2 — Document verification:** upload PO/cheque/invoice -> OCR extract ->
  auto-cross-verify + mismatch flags (DocAI reuse).
- **P3 — Customer self-service link:** tokenized email form (portal-token
  reuse) for the customer to fill/amend + upload artifacts -> registration
  request.
- **P4 — Approval convergence:** route both customer submission + team
  verification through the change-request approval flow with evidence; create
  master on approve. Extend the same to **supplier/vendor** registration.

## Reuse map
| Need | Reuse |
|---|---|
| GSTIN fetch + format/checksum + state list | #186 + `_lib/docai/validators.js` |
| Doc OCR of PO/cheque/invoice | DocAI pipeline |
| Email form link + token | quote-share portal-token pattern |
| Approve-before-create | customer change-request flow |
| Encrypted provider creds | `inbound-chat.js` AES-256-GCM |

Related: #186 (GSTIN fetch), [[backlog-parked-prs]] zero-data-entry,
[[project-payment-reality]] (MSME/TDS relevance), DocAI extraction.
