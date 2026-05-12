# Phase 11: Compliance Certifications

Repo head: `c4f946b` (main). Phase window: 12 weeks (T-12 to T+0). Runs alongside Phases 6 to 10.
Authoring date: 2026-05-12 (revision +1 day from initial brief).

Tag legend:
- `[verified]` = read from the file at the cited absolute path on `main`.
- `[inferred]` = reasonable conclusion grounded in verified facts.
- `[speculative]` = outside reference or industry estimate that cannot be checked in-repo.

---

## Section 1. Phase summary and certification timeline preview

Phase 11 is the meta-key to enterprise revenue. Anvil today has the working substrate for SOC 2 evidence (AES-256-GCM credential encryption at `/Users/kenith.philip/anvil/src/api/_lib/secrets.js` `[verified]`, role-gated context resolution at `/Users/kenith.philip/anvil/src/api/_lib/auth.js` `[verified]`, HMAC-signed audit export at `/Users/kenith.philip/anvil/src/api/audit/export.js` `[verified]`, and sentinel-fallback audit writes at `/Users/kenith.philip/anvil/src/api/_lib/audit.js` `[verified]`). What is missing is the formal frame: a SOC 2 Type II observation window with a named AICPA-licensed auditor, an ISO 27001:2022 Statement of Applicability ("SoA") covering the 93 Annex A controls, an EU AI Act Article 6 classification memo signed by counsel before the 2 Aug 2026 high-risk obligations live date (which is 12 weeks from today, hence the timeline pressure), customer-managed encryption keys (CMEK) for the paid enterprise tier, and DPDP Significant Data Fiduciary readiness shared with Phase 6 (DPIA, DPO, grievance officer, 72-hour breach drill).

The four P1 deliverables in this phase are:

1. SOC 2 Type II year-1 observation window (Security + Availability + Processing Integrity + Confidentiality; Privacy explicitly out of year-1 scope to keep auditor cost bounded and to avoid coupling SOC 2 to DPDP Privacy criteria which are still maturing).
2. ISO 27001:2022 SoA across the 93 controls in the four themes (Organizational 37, People 8, Physical 14, Technological 34). Year-2 audit; year-1 is SoA draft plus pre-cert internal audit.
3. EU AI Act Article 6 classification memo arguing that Anvil's extraction-plus-anomaly system plus its autonomous agents fall outside Annex III high-risk (or, if Annex III paragraphs 4, 5, or 8 apply, that Article 6(3) human-oversight exception is invocable via the approval-evaluator gate).
4. CMEK envelope encryption: per-tenant DEK wrapped by a customer-owned KEK in AWS KMS, GCP KMS, or Azure Key Vault, with org KEK rotation and per-rotation cost telemetry.

Shared with Phase 6 (and budgeted there, executed here for the certification artefacts): DPDP Significant Data Fiduciary criteria gate, DPIA template aligned to India's MeitY draft Rules, 72-hour breach notification operating procedure, DPO and grievance officer appointment (KPMG India, Deloitte India, or PWC India as outsourced DPO).

Certification timeline preview (T-12 weeks counting forward to T+0):

| Week | SOC 2 | ISO 27001 | EU AI Act | CMEK | DPDP shared |
|---|---|---|---|---|---|
| T-12 | GRC vendor selected; auditor shortlist | Gap-assessment kickoff | Counsel brief | Architecture spike | DPO engagement signed |
| T-10 | Observation window starts | Control owners assigned | Annex III scope matrix | AWS KMS integration | DPIA v1 drafted |
| T-8 | Continuous-controls monitoring live | SoA draft v1 | Article 6 memo signed by counsel | GCP + Azure adaptors | Grievance officer named |
| T-6 | Mid-window readiness review | Pre-cert internal audit | Conformity assessment skeleton | First pilot CMEK customer | Breach 72h tabletop |
| T-4 | Evidence freeze begins | SoA draft v2 (post-internal-audit) | Provider-vs-user role memo | DEK rotation v1 in prod | DPDP §10 register live |
| T-2 | Type II walk-through with auditor | SoA final | Customer-facing disclosure ready | Org KEK rotation runbook | Significant Data Fiduciary self-assessment |
| T+0 | Type II report drafted | SoA published; year-2 audit booked | AI Act conformance live | CMEK GA on enterprise tier | All four DPDP artefacts published |

The window math is tight. The minimum SOC 2 Type II observation window AICPA accepts is 3 months for a first-time engagement; for a credible report (one that enterprise buyers will accept without question) the typical first-time window is 6 to 9 months. We pursue the 3-month minimum because we need a Type II report in hand before the larger ClearTax and Cygnet competitive deals close in Q4 2026; the report can be refreshed at 6 and 12 months once we are inside the gate.

---

## Section 2. Deep-dive research findings

### Section 2.1. DD14: SOC 2 Type II observation window, GRC vendor comparison, India-specific challenges

**Observation window mechanics.** SOC 2 has two report types. Type I is a point-in-time attestation; Type II is over an observation window during which evidence is continuously sampled. AICPA SSAE 18 (the underlying standard for SOC 2) does not prescribe a minimum window length in months; in practice the audit profession converges on three months as the floor below which the sample size is too small for an unqualified opinion, six months as the median for first-time engagements, and twelve months as steady state for renewal cycles `[speculative]`. We target the 3-month floor for Year 1 (report issued Q3 2026) and the standard 12-month renewal cycle thereafter.

The four Trust Services Criteria in our Year-1 scope are: Security (mandatory in every SOC 2), Availability (uptime, capacity, redundancy), Processing Integrity (completeness, accuracy, timeliness of processing), Confidentiality (information designated as confidential is protected). Privacy is the fifth TSC and is deliberately excluded from Year-1. The reason: Privacy TSC mirrors GDPR-style data-subject-rights mechanics that we would rather discharge via DPDP §11 (correction and erasure) and §13 (grievance officer) in Phase 6 first, and only then layer SOC 2 Privacy on top in Year 2. Layering it now would (a) double-budget the discovery work and (b) force the SOC 2 auditor to opine on DPDP procedures that the DPB (Data Protection Board of India) has not yet ruled on.

**Continuous-controls monitoring substrate already in-repo.** The Anvil substrate has four artefacts that map directly to SOC 2 CC (Common Criteria) controls:

- CC6.1 Logical access security. Implemented at `/Users/kenith.philip/anvil/src/api/_lib/auth.js` `[verified]`. `resolveContext` validates the JWT, fetches `tenant_members`, checks the approval gate, returns a `(user, tenantId, role)` triple. `requirePermission` enforces the role-permission matrix. The `ALLOW_ANONYMOUS_TENANT` env var refuses to allow startup in `NODE_ENV=production`; this fail-closed guard is exactly the kind of deterministic CC6.1 evidence the auditor wants.
- CC6.6 Encryption of data in transit and at rest. Implemented at `/Users/kenith.philip/anvil/src/api/_lib/secrets.js` `[verified]` with AES-256-GCM, per-bundle IV, authenticated tag appended to ciphertext, master key sourced from `ANVIL_SECRETS_KEY` env (64 hex chars validated at runtime). The current model is single-tenant KEK held by Anvil; CMEK (F83 below) extends this with customer-owned KEK.
- CC7.2 / CC7.3 System monitoring and audit. Implemented at `/Users/kenith.philip/anvil/src/api/_lib/audit.js` `[verified]` with sentinel-fallback writes into `audit_failures` when the primary `audit_events` insert fails, plus HMAC-signed exports at `/Users/kenith.philip/anvil/src/api/audit/export.js` `[verified]`. The export endpoint hard-fails when `AUDIT_EXPORT_HMAC_SECRET` is unset, refuses to return unsigned audit data, and persists every export run into `audit_export_runs` with the signed-hash so the auditor sees who exported what.
- CC8.1 Change management. Partially implemented via the deploy log (`deploys/index.js` referenced in `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/14-final-roadmap.md` `[verified]`). To make this complete we need the GitHub PR-to-deploy mapping captured into the same table.

What is *not* in-repo and needs Phase 11 to deliver:
- Continuous user-access-review evidence. Most GRC tools auto-generate this from the IdP; the Anvil model currently relies on `admin/access_review` which is mentioned in the roadmap but not yet a self-running monthly job.
- Vendor risk register. We have third-party processors (Supabase, Vercel, Anthropic, Razorpay, Resend, GSP); none of them are catalogued as sub-processors with their own SOC 2 reports referenced.
- BCP / DR runbook. Availability TSC requires a documented runbook plus at least one DR drill within the observation window.

**GRC vendor comparison.** The four candidates are Drata, Vanta, Secureframe, and Sprinto. The decision-relevant axes for an Indian SaaS targeting EU and US enterprise buyers are: integration breadth with our stack (Supabase, Vercel, Anthropic, GitHub, Cloudflare, Razorpay), India auditor pool support, time-to-audit-ready, cost band, and continuous-controls coverage depth.

| Vendor | Integration with our stack | India auditor pool | Time-to-audit-ready (first-time, Type II) | Cost band Year 1 | Notes |
|---|---|---|---|---|---|
| Drata | Native GitHub, AWS, GCP, Azure, Okta; Supabase via API-key custom integration `[speculative]`; Vercel via deploy webhooks | A2LA-accredited US firms via marketplace; growing India partner panel `[speculative]` | 8 to 12 weeks | USD 18k to 30k for the platform plus USD 12k to 25k auditor | Strong continuous-controls coverage; best-in-class evidence freshness scoring |
| Vanta | Same native depth; very polished UI; market leader | Largest auditor marketplace; many India-based and India-friendly firms `[speculative]` | 6 to 10 weeks | USD 14k to 24k for the platform plus USD 10k to 22k auditor | Most India SaaS pick this; risk is "everyone uses it" so report differentiation is low |
| Secureframe | Native depth slightly behind Drata/Vanta; good ISO 27001 coupling | Solid US auditor coverage; India panel limited `[speculative]` | 10 to 14 weeks | USD 16k to 26k platform plus USD 12k to 22k auditor | Best for shops that want SOC 2 plus ISO 27001 in a single workspace |
| Sprinto | Bengaluru-headquartered; deep India auditor relationships; native ZenGRC-style flows | India auditor pool is its core strength; faster regulator coordination | 6 to 9 weeks | INR 12L to 24L platform plus INR 8L to 15L auditor (roughly half the USD price) | The India-native pick; weaker on Anthropic-specific evidence templates |

The pick for Anvil is **Sprinto for Year 1**. Rationale: (a) India auditor pool depth matters because we need our auditor to be physically present in Bengaluru for at least one walk-through (Indian auditor firms have strict KYC-in-person rules), (b) Sprinto's INR-denominated pricing avoids USD/INR FX risk on a 12-month commit, (c) the time-to-audit-ready is shortest, which buys us the 3-month observation-window minimum without slipping. We can migrate to Vanta in Year 2 if the report needs to look more familiar to US buyers (Vanta logos are recognised in US procurement teams).

**India-specific SOC 2 challenges.**

1. *Indian auditor pool.* AICPA-licensed firms with a physical India presence are concentrated in the Big Four (KPMG, Deloitte, PWC, EY) and a handful of mid-tier specialists (BDO, Grant Thornton, Schellman India `[speculative]`). The Big Four list-price is INR 25L to 60L for a first-time SOC 2 Type II; the mid-tier specialists run INR 8L to 22L. Schellman is the most common pick for India SaaS targeting US buyers because the report is widely recognised in US procurement, but the lead time is 4 to 6 months for engagement letter execution.
2. *Time-zone friction.* The audit walk-throughs require synchronous time with the audit team. Schellman's audit team for India clients sits in the US Pacific zone; their preferred walk-through window is 21:00 to 23:00 IST. Sprinto's India audit partners overlap with IST business hours, which is a small but real saving in engineer fatigue.
3. *Regulator coordination.* Indian regulators (the DPB, RBI for any payment data, SEBI for any listed-issuer data) do not yet coordinate with US auditors. The SOC 2 report cannot be used as a substitute for any India-side filing; this matters only insofar as we avoid claiming the SOC 2 covers DPDP compliance (it does not). Year 2 will couple SOC 2 with the DPDP §10 Significant Data Fiduciary self-assessment as a paired pack.
4. *PAN, GSTIN, Aadhaar handling.* The auditor will probe our handling of these three identifiers. The redaction firewall and the `auth/passkey` tree should suffice, but we need an explicit memo (a one-pager) describing the canonical form of each identifier in our data model, the encryption posture, and the lifecycle (retention, erasure).

### Section 2.2. DD31: EU AI Act Article 6 classification of extraction systems

**Why this is urgent.** The EU AI Act entered into force on 1 Aug 2024. Article 6 (high-risk classification) and Annex III (the list of high-risk use cases) live obligations come into force on 2 Aug 2026. That is 12 weeks from today. Any EU buyer doing diligence on Anvil after that date will ask for our Article 6 classification memo before signing. If we cannot produce one, we lose the deal `[inferred from EU regulation 2024/1689 phasing schedule, speculative on exact buyer behaviour]`.

**Annex III scope matrix.** Annex III lists eight high-risk areas. The four that plausibly intersect with Anvil's extraction-plus-anomaly system plus its autonomous agents are paragraphs 4, 5, 8, and (with a stretch) 1. The matrix:

| Annex III paragraph | Topic | Anvil's exposure |
|---|---|---|
| 1 | Biometrics | No biometric processing. The voice recordings in `voice/` are speech-to-text only; no speaker identification. **Not applicable.** |
| 2 | Critical infrastructure | No. Anvil does not control utility, transport, or grid systems. **Not applicable.** |
| 3 | Education and vocational training | No. **Not applicable.** |
| 4 | Employment, workers management, access to self-employment | **Potentially applicable.** Anvil's approval-evaluator gate routes sales-engineer decisions; if a customer uses this to evaluate the work of their own sales staff, that could be construed as "evaluation of performance of workers". Mitigation: the gate is configurable per tenant; we ship a default that does *not* score worker performance, and the EULA prohibits configuration that does. |
| 5 | Access to essential private and public services | **Potentially applicable.** Anvil's anomaly engine flags purchase orders for review; if a customer routes credit decisions through this, that could be construed as "creditworthiness evaluation". Mitigation: explicit EULA prohibition; default config does not score customer creditworthiness. |
| 6 | Law enforcement | No. **Not applicable.** |
| 7 | Migration, asylum, border control | No. **Not applicable.** |
| 8 | Administration of justice and democratic processes | **Potentially applicable.** The autonomous-agent surfaces (the kb/ask and erp_chat paths) could, in principle, draft documents used in legal disputes. Mitigation: explicit EULA prohibition; output watermarked as AI-generated. |

**Anvil's classification argument.** The memo will argue that:

1. Anvil's *default-configured* deployment falls *outside* Annex III. The extraction is a clerical task (OCR plus structured extraction from purchase orders, e-invoices, RFQs); the anomaly engine is a statistical flag, not a decision; the autonomous agents draft recommendations that a human always reviews via the approval-evaluator gate.
2. Where a customer's *configuration* moves the system into Annex III paragraph 4, 5, or 8, the customer is the deployer-of-record under Article 26 and bears the high-risk obligations. Anvil is the provider under Article 16 and ships the documentation, conformity assessment, and post-market monitoring artefacts.
3. The Article 6(3) human-oversight exception applies. The approval-evaluator gate is the documented human-in-the-loop control: every AI-generated recommendation has a named human reviewer, the reviewer's identity is logged in `audit_events` (per `/Users/kenith.philip/anvil/src/api/_lib/audit.js` `[verified]`), the reviewer can override the AI output, and the override is preserved in `before_payload` / `after_payload` for the auditor.

**Conformity assessment skeleton.** If a future enterprise customer's configuration triggers Annex III, the conformity assessment we ship them includes: (i) the risk management system per Article 9 (we run a quarterly LLM-risk-register update tied to the Phase 8 evaluation harness), (ii) the data governance per Article 10 (the redaction firewall plus the DPIA), (iii) the technical documentation per Article 11 (this memo plus the SoA), (iv) the record-keeping per Article 12 (the HMAC-signed audit export), (v) the transparency per Article 13 (every AI-generated output carries a `generated_by: anvil-llm-vN` watermark in the API response), (vi) the human oversight per Article 14 (the approval-evaluator gate), (vii) the accuracy and robustness per Article 15 (the evaluation harness shipped in Phase 4 and quantified in Phase 8), and (viii) the cybersecurity per Article 15 (the SOC 2 evidence).

**Memo cadence and ownership.** The memo is owned by Counsel (external Indian law firm with EU AI Act exposure; we are speaking with Khaitan and Co, AZB and Partners, and Cyril Amarchand Mangaldas; expected fee INR 8L to 18L for the year 1 memo `[speculative]`). The memo cadence is annual with quarterly delta reviews. The signed PDF is shipped in the Compliance Receipt Pack (see Section 3a below) every quarter.

### Section 2.3. DD32: CMEK envelope encryption (also Phase 5)

**Architecture.** Envelope encryption is a two-tier KMS pattern: a Data Encryption Key (DEK) encrypts the payload, a Key Encryption Key (KEK) encrypts the DEK. The KEK lives in a Key Management System (AWS KMS, GCP KMS, Azure Key Vault); the wrapped DEK lives next to the ciphertext in the application database.

The Anvil substrate at `/Users/kenith.philip/anvil/src/api/_lib/secrets.js` `[verified]` currently implements a single-tier model: the master key (`ANVIL_SECRETS_KEY`) is the only key, held by Anvil in env. CMEK extends this to:

- One DEK per tenant (`tenants.dek_wrapped` bytea column; the DEK itself is never stored in plaintext anywhere).
- One KEK per customer's KMS, identified by ARN / Resource ID, stored in `tenants.kek_provider`, `tenants.kek_resource_id`, `tenants.kek_provider_region`.
- An org KEK held by Anvil for the default-no-CMEK tier (functionally identical to today's `ANVIL_SECRETS_KEY` but moved into the same envelope abstraction so the code path is uniform).
- Per-rotation cost telemetry recorded into a `kek_rotation_events` table (when, who triggered, AWS/GCP/Azure API cost, DEK re-wrap time).

**KMS adaptors and cost model.**

- AWS KMS. CMK pricing: USD 1.00 per CMK per month, USD 0.03 per 10,000 API calls. A tenant with 1M document encryptions per month and one DEK rotation per quarter pays USD 1.00 (CMK) plus USD 3.00 (encryption API calls) plus near-zero (the wrap/unwrap is per-DEK-rotation, not per-document, since the DEK is reused within its lifetime). Total: USD 4 per tenant per month. `[speculative]`
- GCP KMS. Same structural pricing: USD 0.06 per active key version per month, USD 0.03 per 10,000 cryptographic operations. Cost roughly identical to AWS at our scale.
- Azure Key Vault. Tier difference: Standard at USD 0.03 per 10,000 operations, Premium (HSM-backed) at USD 1 per key per month plus USD 0.15 per 10,000 operations. Enterprise customers typically demand Premium for FIPS 140-2 Level 2 compliance.

**Rotation model.** The KEK rotation cadence is customer-controlled (their KMS, their policy). Anvil's role is to handle the rotation event: when a customer rotates their KEK, the wrapped-DEK ciphertext is no longer decryptable with the old KEK; we re-wrap the DEK with the new KEK in a single transaction. The DEK itself does not rotate on KEK rotation (re-encrypting every document with a new DEK would be prohibitively expensive); a separate annual DEK rotation cycle re-encrypts the corpus in the background.

**Industry patterns to learn from.**

- *Stripe* implements per-merchant DEKs wrapped by a Stripe-held KEK plus an optional customer-controlled KEK. They publish the rotation cadence and the cryptographic agility story publicly. `[speculative]`
- *Snowflake* offers Tri-Secret Secure: customer KEK plus Snowflake KEK plus the data key, requiring all three to decrypt. This is over-engineering for Anvil's tier; we implement the standard two-tier envelope.
- *Databricks* offers customer-managed keys for managed-services data and for workspace storage as two separately configurable KEKs. We follow the same separation: a tenant can supply a KEK for `obara-documents` storage objects independently of a KEK for `tenant_settings` credential bundles.

**Pricing the CMEK tier.** The Anvil enterprise tier already commands a price premium. CMEK is the gating feature that unlocks the Tier-1 enterprise bracket. Our CMEK price model: included in enterprise tier at INR 1L+ per month base; the customer pays their own KMS bill directly. We do not mark up the KMS calls.

**First-pilot customer.** We pick a regulated-industry pilot for the CMEK launch: ideally a financial-services or pharma customer whose own procurement requires customer-controlled keys. The pilot's KMS choice (AWS, GCP, Azure) drives which adaptor we ship first. The XL effort estimate (15 engineering days for the first pilot per the roadmap at `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/14-final-roadmap.md` line 1101 `[verified]`) is for AWS KMS only; GCP and Azure adaptors are an additional 8 days each, ideally executed in parallel by separate engineers.

**Cost recovery analysis.** At INR 1L per month enterprise base price and KMS cost of USD 4 per tenant per month (approximately INR 340), the CMEK feature contributes a gross margin of approximately 99.7% on the KMS line. The economic case is overwhelming; the engineering case is the gating constraint.

### Section 2.4. DD33: ISO 27001:2022 Statement of Applicability

**The 93 controls.** ISO 27001:2022 (the October 2022 revision) collapses the 114 controls of the 2013 version into 93 controls grouped under four themes:

- *Organizational controls* (37 controls). Policies, roles, supplier relationships, access management policy, threat intelligence, identity management lifecycle, cloud services usage, secure development policy.
- *People controls* (8 controls). Screening, terms of employment, awareness training, disciplinary process, post-employment, confidentiality agreements, remote working, information security event reporting.
- *Physical controls* (14 controls). Physical security perimeters, entry controls, securing offices, protecting against physical and environmental threats, working in secure areas, clear desk and clear screen, equipment siting.
- *Technological controls* (34 controls). User endpoint devices, privileged access rights, information access restriction, cryptography, secure development lifecycle, secure system architecture, web filtering, change management, monitoring activities, vulnerability management.

**SaaS-scale applicability at Anvil's scale.** A pure-SaaS company with no physical office (or a minimal Bengaluru office shared via WeWork) marks the Physical controls largely as "not applicable, see datacenter SOC reports from sub-processors". The serviceable SoA shape is:

- Organizational: 30 of 37 applicable; 7 marked NA with rationale (e.g., classified information handling not applicable).
- People: all 8 applicable.
- Physical: 4 of 14 applicable (entry controls and clear-desk for the office; the other 10 are discharged via Supabase, Vercel, and Anthropic sub-processor SOC reports).
- Technological: all 34 applicable.

Total: approximately 76 of 93 controls in-scope.

**Year-2 audit shape.** The roadmap states Year-1 is SoA draft, Year-2 is the audit `[verified at /Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/14-final-roadmap.md line 1079]`. The reason for the year split: (a) ISO 27001 requires evidence of "operation" of the controls, which the SoA itself does not produce; we need a year of evidence to attach to each in-scope control before the certification audit (Stage 2) can produce an unqualified opinion, (b) the cost is lower (the Stage 1 audit is approximately one-third the cost of the Stage 2), (c) we sequence ISO 27001 *after* SOC 2 so the SOC 2 controls library auto-populates many of the ISO 27001 evidence cells (Sprinto, Drata, and Vanta all have SOC 2 to ISO 27001 control crosswalks).

**Pre-cert internal audit cost.** Internal audit (a paid third-party who is not the certification body) runs INR 4L to 8L for a first-time engagement. The internal audit produces a punch-list of nonconformities which we close before the certification audit. We budget INR 6L for this in Phase 11 plus INR 12L to 18L for the Stage 1 audit (Year 1) and INR 18L to 30L for the Stage 2 audit (Year 2) `[speculative]`.

**Mapping from in-repo substrate to ISO 27001:2022 controls.**

| Control ID | Title | In-repo evidence |
|---|---|---|
| A.5.15 | Access control | `/Users/kenith.philip/anvil/src/api/_lib/auth.js` (resolveContext, requirePermission) `[verified]` |
| A.5.16 | Identity management | `/Users/kenith.philip/anvil/src/api/auth/passkey/*` tree `[verified, referenced in 10-security.md]` |
| A.5.17 | Authentication information | `/Users/kenith.philip/anvil/src/api/auth/mfa.js` `[verified, referenced in 10-security.md]` |
| A.5.18 | Access rights | `tenant_members` table plus `admin/access_review` `[verified, referenced in 14-final-roadmap.md]` |
| A.8.5 | Secure authentication | Passkey + MFA tree `[verified]` |
| A.8.15 | Logging | `/Users/kenith.philip/anvil/src/api/_lib/audit.js` `[verified]` |
| A.8.16 | Monitoring activities | `audit_failures` sentinel `[verified at /Users/kenith.philip/anvil/src/api/_lib/audit.js]` |
| A.8.24 | Use of cryptography | `/Users/kenith.philip/anvil/src/api/_lib/secrets.js` (AES-256-GCM) `[verified]` |
| A.8.32 | Change management | Deploy log via `deploys/index.js` `[referenced in roadmap]` |
| A.8.34 | Protection of information systems during audit testing | The injection_test bench at `/Users/kenith.philip/anvil/src/api/security/inject_test.js` `[verified per 10-security.md]` |

**SoA assembly schedule.** Week 8 produces SoA v1 (controls list, applicability marker, current evidence pointer, gap pointer). Week 10 produces SoA v2 (after pre-cert internal audit punch-list closure). Week 12 produces SoA final, published to the customer trust center.

### Section 2.5. DD34: DPDP Significant Data Fiduciary readiness

**Significant Data Fiduciary criteria.** Section 10 of the DPDP Act 2023 empowers the Central Government to notify Significant Data Fiduciaries (SDFs) based on volume of personal data processed, sensitivity, risk to data principal rights, risk to electoral democracy, and risk to security of state. The Draft DPDP Rules 2025 (MeitY, January 2025) propose volume thresholds but have not been finalised `[speculative]`.

Anvil's plausible trajectory: at scale (year 2 to 3, 1000+ paying customers, each with 10 to 50 employee data principals), we process between 10,000 and 50,000 data principals. That is below the rumoured 1L (100,000) threshold for SDF notification, but our processing of sensitive personal data (financial transactional data via the e-invoice and ERP integration paths) and our processing of children-adjacent data (no, we do not have any) likely keeps us below SDF status in Year 1. However, three of our larger pilot customers will themselves be SDFs, and they will demand that we operate to SDF standards as their processor.

Therefore we self-classify as SDF-ready in Phase 11, even though the formal notification will not arrive in Year 1. The four artefacts SDF status requires are:

1. *DPIA (Data Protection Impact Assessment).* Per India's MeitY Draft Rules, the DPIA covers: purpose of processing, categories of data, retention period, security measures, risks to data principals, mitigations. The template we use is adapted from the CNIL (French DPA) DPIA template plus the MeitY draft annex. The DPIA is reviewed annually and on every material change.
2. *DPO (Data Protection Officer).* Per Section 10(2)(a), the DPO must be a person based in India, reporting to the board. We outsource the DPO function to KPMG India (or Deloitte India or PWC India) for the first 18 months; the engagement fee is INR 25L to 40L per year `[speculative]`. The outsourced DPO is named in customer-facing privacy notices and in the data processing addendum.
3. *Grievance officer.* Per Section 13, the grievance officer is the data-principal-facing contact for complaints. This is typically an in-house role; we appoint our Head of Customer Success as the named grievance officer with a published email and a 7-day acknowledgement SLA, 30-day resolution SLA per the Act.
4. *72-hour breach notification.* Per Section 8(6), every personal data breach must be notified to the Data Protection Board and to affected data principals "in such form and manner as may be prescribed". The Draft Rules propose 72 hours from awareness, mirroring GDPR Article 33. We operationalise this via a runbook (Phase 6) that walks the on-call from "data breach suspected" to "DPB notification submitted" with templated email drafts, evidence-capture checklist, and counsel-loop.

**DPIA template (one-page summary).** The template has nine sections: (1) processing description, (2) lawful basis, (3) data categories with sensitive flags, (4) data principal rights and exercise channels, (5) retention period and erasure mechanism, (6) third-party recipients including sub-processors, (7) technical and organisational measures with control IDs, (8) risk register with likelihood, severity, residual rating, (9) sign-off by the DPO and the data fiduciary's accountable officer.

**Outsourced DPO selection.** The Big Four (KPMG India, Deloitte India, PWC India, EY India) all offer outsourced DPO services. The decision-relevant axes: cost, response SLA, sector expertise (SaaS / B2B), familiarity with DPDP and GDPR, willingness to be named in customer-facing privacy notices. KPMG and Deloitte are most active in the India SaaS market; PWC tends to be more litigation-defensive (slower turnaround, larger fee); EY is mid-pack. The recommendation is **KPMG India** for the 18-month engagement with a Year 2 review.

**72-hour breach drill.** The drill is a tabletop exercise run quarterly during the observation window. The scenario: an `audit_failures` table spike correlates with a forgotten `.eq("tenant_id")` filter shipping in a deploy (the F10.1 risk pattern at `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/10-security.md` `[verified]`). The drill steps: (i) on-call detects the spike, (ii) on-call invokes the DPO escalation playbook, (iii) DPO and counsel jointly draft the DPB notification, (iv) DPO emails the affected data principals using the templated form, (v) post-mortem and remediation written into the audit trail. The drill is scored on time-to-DPB-draft (target: 4 hours), time-to-data-principal-notification (target: 24 hours), accuracy of the notification (counsel review).

### Section 2.6. DD58: EU residency cost and buyer-pipeline for Indian mid-market SaaS

**Why EU residency matters.** GDPR Article 44 to 49 restricts the transfer of personal data outside the EU/EEA unless the destination has an adequacy decision (India does not) or one of the safeguards in Article 46 applies (Standard Contractual Clauses, Binding Corporate Rules). The Schrems II judgement (CJEU C-311/18, 2020) requires Transfer Impact Assessments. Many EU enterprise buyers, especially in financial services and public sector, refuse to engage with non-EU-resident SaaS providers regardless of SCCs.

**EU residency architecture.** Two-region split deployment:

- *EU primary region*: AWS Frankfurt (eu-central-1) for the application substrate; Supabase eu-west-2 (London) or eu-central-1 (Frankfurt) for the database `[Supabase regions roughly map to AWS regions; speculative on exact 2026 footprint]`; Anthropic EU-residency offering (if available; Anthropic's residency offerings are evolving `[speculative]`). All customer data, audit logs, and derived ML artefacts stored in EU only.
- *India primary region*: AWS Mumbai (ap-south-1) plus Supabase ap-southeast-1 (Singapore) or a dedicated Indian Supabase region if available. This is the default for India customers; EU customers can opt into Mumbai if they have an India subsidiary that owns the data.

**Cost model.**

- AWS Frankfurt compute is approximately 12% more expensive than AWS Mumbai for the same EC2/Lambda mix `[speculative based on 2024 pricing]`.
- Supabase EU regions are price-parity with non-EU regions; this is a relief.
- Anthropic API latency from Frankfurt to the nearest Anthropic POP (Dublin or Frankfurt) is approximately 20 to 40ms, comparable to Mumbai to the nearest POP (Singapore or Mumbai); no material latency penalty `[speculative]`.
- Operational overhead: maintaining two regions adds approximately 15% to platform engineering effort `[speculative]`.

Total cost increment for the EU-Sovereign tier: approximately 25% on top of the base infrastructure cost. We price this at 2.5x the base tier price, yielding a 90+% incremental margin on the EU tier.

**EU buyer cohort size and ARPU.** The serviceable EU buyer cohort for an Indian SaaS targeting the procurement-automation niche: mid-market manufacturing, mid-market services-procurement, mid-market financial services. Rough TAM estimate: 8,000 to 15,000 EU mid-market accounts that could plausibly buy `[speculative]`. ARPU for the EU tier: 2.5x the India base tier, plus the customer is more likely to consume the higher-margin add-ons (CMEK, Compliance Receipt Pack, Trust Center as a Service). Aggregate EU TAM at our serviceable share (1%): 80 to 150 accounts at INR 5L+ per year, contributing INR 4Cr to INR 7.5Cr annual recurring revenue.

**The EU tier as a gating feature for the four innovative ideas in Section 3.** EU-Sovereign is the package that converts "Anvil is an Indian SaaS" from a procurement objection into a procurement choice. Without it, the EU buyer cohort is unreachable; with it, every EU buyer-side compliance question (GDPR Article 28 processor obligations, Schrems II TIA, AI Act Article 26 deployer obligations) has a documented answer.

---

## Section 3. Game-changing innovative ideas

### Section 3.1. Idea A: Compliance Receipt Pack

**What it is.** Every Anvil tenant receives a quarterly auditor-ready PDF bundle that we call the Compliance Receipt Pack. The pack contains:

- The current SOC 2 Type II report excerpt (or a Type II progress letter during the observation window).
- The current ISO 27001:2022 Statement of Applicability extract.
- The customer-specific DPDP DPIA, populated with the customer's own tenant ID, data categories, retention period, and named DPO and grievance officer.
- The current EU AI Act Article 6 classification memo, with a tenant-specific configuration appendix that lists which Anvil features the tenant has enabled and which of those features triggers any Annex III consideration.
- The CMEK key-use trail for the quarter (which DEKs were rotated, which KEK ARNs were referenced, how many wrap/unwrap operations).
- A cover letter signed by the Anvil DPO (KPMG outsourced) attesting that the pack is current and that no material breach occurred in the quarter (or, if one did, that it was notified to the DPB).

**Why customers want it.** Every Anvil customer is itself a data fiduciary under DPDP and a controller under GDPR. When the customer's own auditor asks "show me evidence that your sub-processors are compliant", the customer either (a) chases the sub-processor for evidence, or (b) hands over the receipt pack. Option (b) compresses the customer's own audit prep from 80 to 120 hours of work into approximately 4 hours of review.

**Revenue model.** Enterprise compliance add-on at INR 25,000 per month per tenant. Bundled into the Enterprise tier; available as an add-on for the Pro tier. The pack is generated automatically by the Compliance Receipt Pack generator (a CRON job that runs the day after quarter-end, pulls evidence from the Sprinto / Vanta / Drata workspace, the Anvil audit trail, the KMS event log, and the DPO sign-off queue, renders the PDF, signs it with the DPO's PGP key, and delivers it to the tenant's primary admin and to the tenant's compliance contact-of-record).

**Cost to the customer.** Customers report that their own SOC 2 / ISO 27001 / DPDP audit prep cycle costs INR 8L to 25L per year, of which approximately 60% is sub-processor evidence chasing. The Receipt Pack reduces this to approximately INR 3L per year. The customer's net saving: INR 5L to 22L per year. The Receipt Pack costs INR 3L per year. The customer's ROI is 1.7x to 7x.

**Why it is defensible.** The receipt pack is hard to replicate. Competitors who do not have SOC 2 or ISO 27001 cannot produce one. Competitors who have one but who do not have the per-tenant DPIA generator and the KMS event log integration cannot produce one with the same depth. ClearTax and Cygnet, the two most-likely India competitors with SOC 2 and ISO 27001 in hand, do not (as of 2026-05-12) ship per-tenant DPIAs or per-tenant CMEK key-use trails `[speculative]`.

**Engineering effort.** 12 to 18 engineering days for the generator plus 4 days for the DPO sign-off queue plus 2 days for the PGP signing infrastructure. Total: 22 engineering days; one engineer for one month, ideally the engineer who built the audit export.

### Section 3.2. Idea B: Trust Center as a Service

**What it is.** Anvil hosts a per-tenant Trust Center modeled on SafeBase, Conveyor, or Whistic. Each tenant gets a vanity URL at `trust.<tenantSubdomain>.anvil.example` (or the tenant's own domain via CNAME) that presents:

- The tenant's security posture (their roles, their MFA enforcement, their RBAC policy, their data residency choice, their CMEK posture).
- The tenant's sub-processor list (Anvil and Anvil's sub-processors).
- Anvil's certifications (SOC 2, ISO 27001) embedded as evidence cells the tenant can show to their own buyers.
- The tenant's DPIA and breach history.
- A questionnaire-response NDA gate: when an end-buyer wants to download the evidence pack, they click through an NDA hosted on the trust center.

**Why customers want it.** Every Anvil customer is selling something. When their own customer asks for security evidence, the Anvil customer must (a) hand over a generic Anvil receipt pack and hope the buyer is satisfied, or (b) build their own trust center from scratch (which Tugboat Logic, SafeBase, Whistic, and Conveyor all charge USD 12k to 60k per year for). Option (c) is what we offer: a turn-key trust center bundled into the Anvil enterprise subscription.

**Revenue model.** Enterprise tier add-on at INR 50,000 per month per tenant. The Trust Center substrate is generic; the per-tenant content auto-populates from the Anvil control plane plus the tenant's own configuration. The marginal engineering cost per tenant is approximately INR 0; the marginal customer-success cost is approximately INR 2,000 per month (one customer-success person can support 25 trust-center tenants).

**Engineering effort.** 25 to 40 engineering days for the substrate (vanity-URL routing, CNAME validation, the rendering layer, the NDA gate, the audit trail of who viewed what). One engineer for two months.

**Strategic moat.** The Trust Center as a Service makes Anvil sticky in a way no other feature does. Once a customer publishes a trust center URL to *their* end-buyers, switching off Anvil means migrating the trust center to a competitor or building from scratch; both options have a 4 to 8 week procurement-disruption cost for the customer.

### Section 3.3. Idea C: Audit Co-pilot

**What it is.** Anvil's LLM stack auto-fills the customer's security questionnaires. SIG Lite (Shared Assessments) and CAIQ v4 (Cloud Security Alliance) are the two dominant questionnaires; together they cover 95% of mid-market and 80% of enterprise security questionnaires `[speculative]`. The Audit Co-pilot reads the questionnaire (PDF, Excel, or vendor portal), maps each question to an Anvil control, pulls the latest evidence from the Sprinto / Vanta / Drata workspace plus the in-repo audit trail, drafts an answer, and presents it for the customer's review.

**Why customers want it.** A SIG Lite questionnaire has approximately 350 questions; CAIQ v4 has approximately 260. The customer's security analyst takes 8 to 16 hours per questionnaire to fill out. The Audit Co-pilot reduces this to approximately 30 to 90 minutes (the analyst is reviewing and approving the AI draft, not writing from scratch). At a procurement cycle of one questionnaire per deal and a procurement velocity of 4 to 12 deals per quarter, the time saving is 30 to 200 hours per quarter.

**Revenue model.** Enterprise close-acceleration tier at INR 75,000 per month. Targeted at customers whose own sales cycle is gated on security questionnaires (the SaaS-selling-to-enterprises segment). The pricing is anchored on the value to the customer: a 5x procurement cycle acceleration is worth approximately INR 8L per quarter in faster cash conversion; we capture INR 2.25L of that.

**Engineering effort.** 40 to 60 engineering days. The bulk of the effort is the question-to-control mapping (a Retrieval-Augmented Generation layer over the Anvil evidence corpus). The smaller part is the questionnaire ingestion (PDF parsers, Excel parsers, the dozen most-common vendor-portal API integrations).

**Why it is defensible.** The Audit Co-pilot accuracy is proportional to the evidence corpus depth. Anvil's evidence corpus is unique because it spans SOC 2 + ISO 27001 + DPDP + EU AI Act + CMEK + the in-repo audit trail. Competitors who have only SOC 2 evidence cannot answer DPDP-specific questions. Competitors who have evidence but no LLM stack cannot draft answers.

### Section 3.4. Idea D: EU-Sovereign Anvil tier

**What it is.** A full EU-residency deployment of Anvil with EU-jurisdiction data processing agreement, EU-resident DPO, EU-only sub-processors, and EU-only LLM inference. Per DD58 above, the architecture is AWS Frankfurt plus Supabase EU plus Anthropic EU plus an EU-resident outsourced DPO (we shortlist Hogan Lovells Frankfurt, Bird and Bird Brussels, Linklaters Brussels).

**Why customers want it.** EU buyers (financial services, public sector, healthcare, EU subsidiaries of global enterprises) have hard-line policies against non-EU SaaS. Many will not even take a sales meeting without an EU-residency commitment. The EU-Sovereign tier converts these objections into a price negotiation.

**Revenue model.** 2.5x the base tier price for EU customers. The cost increment is approximately 25% (per DD58); the price increment is 150%; the gross margin uplift is approximately 100 percentage points on the marginal EU revenue.

**Engineering effort.** 60 to 90 engineering days. The bulk is in the deployment automation (a parallel CI/CD pipeline for the EU stack, region-aware secrets management, EU-only LLM routing). The smaller parts are the data residency assertions in the API responses (every response includes a `data_residency: eu-central-1` header that the customer can audit), the EU-specific DPA template, the EU-resident DPO engagement.

**Strategic value.** EU residency unlocks a TAM of 8,000 to 15,000 EU mid-market accounts (per DD58). At our serviceable share, the EU tier contributes INR 4Cr to INR 7.5Cr ARR by Year 3. The 2.5x pricing premium means each EU customer is worth approximately 1.4 India customers in absolute revenue. The EU tier also makes the Compliance Receipt Pack and Trust Center as a Service more valuable; the bundle is a strategic moat.

### Section 3.5. Idea E: AI Act Sentinel

**What it is.** Every Anvil tenant gets a continuous EU AI Act Article 6 conformance score. The score is computed nightly from a 30-point control checklist:

- Risk management system (Article 9): 3 controls.
- Data governance (Article 10): 4 controls.
- Technical documentation (Article 11): 2 controls.
- Record-keeping (Article 12): 3 controls (auto-checked against the audit trail at `/Users/kenith.philip/anvil/src/api/_lib/audit.js` `[verified]`).
- Transparency (Article 13): 4 controls.
- Human oversight (Article 14): 5 controls (auto-checked against the approval-evaluator gate's coverage).
- Accuracy, robustness, cybersecurity (Article 15): 6 controls (auto-checked against the evaluation harness from Phase 8 and the SOC 2 controls from Phase 11).
- Post-market monitoring (Article 72): 3 controls.

When a control regresses (e.g., the customer disables the approval-evaluator gate for a sub-flow, dropping their Article 14 score from 5/5 to 3/5), the Sentinel auto-generates a remediation playbook: the specific config change to revert, the specific evidence to capture, the specific DPO notification to send.

**Why customers want it.** EU enterprise customers face Article 26 deployer obligations under the AI Act. The penalty for non-compliance is up to 3% of global annual turnover (Article 99). The Sentinel makes Article 26 compliance a reportable metric, the same way SOC 2 makes information-security compliance reportable.

**Revenue model.** EU-tier add-on at INR 35,000 per month. Bundled into the EU-Sovereign tier; available as a standalone add-on for non-EU enterprise tenants who want the same conformance visibility.

**Engineering effort.** 20 to 30 engineering days. The 30-control checklist is the main scope; the auto-remediation playbooks reuse the runbooks from the SOC 2 evidence library.

**Defensible moat.** AI Act compliance is currently a manual process. The Sentinel automates 80% of it. Competitors who do not run a per-tenant control plane cannot replicate this. Competitors who run a control plane but who do not couple it to the LLM stack (so they cannot detect when a customer's prompt change disables human oversight) cannot replicate this either.

---

## Section 4. Sub-phases breakdown

The 12-week phase is split into six 2-week observation-and-audit sub-sprints. Each sub-sprint has a primary deliverable, a secondary deliverable, and a customer-facing milestone.

### Sub-sprint 1 (weeks T-12 to T-10): Foundations

**Primary.** GRC vendor selection and contract execution. Sprinto is the pick; the workspace is provisioned, the integrations are wired (GitHub, Supabase, Vercel, Anthropic, Cloudflare, AWS Mumbai), the controls library is bootstrapped, the evidence-collection bots are switched on. Auditor selection: Schellman India or BDO India shortlisted; engagement letter circulated.

**Secondary.** DPO engagement signed with KPMG India. The KPMG team is named in the privacy notice and the customer DPA template. The DPO has read-access to the Anvil control plane (a least-privilege role bound to the `audit_events` table at `/Users/kenith.philip/anvil/src/api/_lib/audit.js` `[verified]`).

**Customer-facing milestone.** Internal announcement: "Anvil is starting its SOC 2 Type II Year-1 observation window on $DATE." The announcement is shared with the top 20 enterprise pilots; their procurement teams will track our progress.

### Sub-sprint 2 (weeks T-10 to T-8): Observation window starts

**Primary.** The SOC 2 Type II observation window starts. The clock begins. Every continuous-controls monitoring datum from this point is in-scope for the auditor's sample. The team practices the discipline: every access grant goes through the GRC tool; every code change goes through the deploy log; every audit event lands in `audit_events` with the sentinel-fallback to `audit_failures`. The on-call team is trained on the audit_failures growth alarm.

**Secondary.** DPIA v1 drafted. The DPIA template (per DD34 above) is filled out for Anvil's core processing operations (extraction, anomaly detection, ERP integrations, e-invoice flow, voice transcription). The DPIA is reviewed by the KPMG DPO and signed.

**Customer-facing milestone.** Trust center placeholder shipped at `trust.anvil.example`. Static content for now; the per-tenant Trust Center as a Service builds on top in Sub-sprint 4.

### Sub-sprint 3 (weeks T-8 to T-6): EU AI Act memo, SoA v1, CMEK pilot architecture

**Primary.** EU AI Act Article 6 classification memo signed by external counsel (Khaitan and Co or AZB and Partners). The memo is published to the trust center placeholder. The classification argument (default deployment outside Annex III; configurable triggers covered by EULA; Article 6(3) human-oversight exception invocable) is the spine.

**Secondary.** ISO 27001:2022 SoA v1 drafted. 76 of 93 controls marked in-scope; the gap matrix is created (which controls have evidence today, which need new evidence, which need new substrate). The CMEK pilot architecture is reviewed and signed off; the AWS KMS adaptor design is finalised; the first pilot customer is named.

**Customer-facing milestone.** The EU AI Act memo is shipped to the EU pilot customers; one of them confirms that the memo unblocks their procurement.

### Sub-sprint 4 (weeks T-6 to T-4): Mid-window readiness, pre-cert internal audit, CMEK pilot live

**Primary.** Mid-window readiness review with the auditor. The auditor walks through a sample of evidence cells from the Sprinto workspace; gaps are surfaced; remediation tickets are filed. The pre-cert ISO 27001 internal audit kicks off; the internal auditor (Schellman India for the Stage 1 dual-engagement) produces a punch-list of nonconformities.

**Secondary.** CMEK pilot live. The first pilot customer's AWS KMS key is integrated; their DEK is generated and wrapped; their first encrypted document is written. The `kek_rotation_events` table is populated with the first wrap event. The 72-hour breach drill is run (tabletop with the KPMG DPO playing the regulator role).

**Customer-facing milestone.** Trust Center as a Service substrate is shipped; the first three pilot tenants get vanity URLs. The Compliance Receipt Pack generator is in beta; the first pack is produced for the pilot tenants.

### Sub-sprint 5 (weeks T-4 to T-2): Evidence freeze, SoA v2, Audit Co-pilot beta

**Primary.** Evidence freeze begins. The auditor draws the final sample; no new evidence is added to the sample after this point. Any open audit findings are remediated and re-sampled. The SoA v2 is produced after the internal audit punch-list is closed.

**Secondary.** Audit Co-pilot beta. The questionnaire ingestion is working for SIG Lite and CAIQ v4 PDFs. The question-to-control mapping is at approximately 70% accuracy (the LLM draft is correct for 70% of questions; the analyst edits the rest). The DPDP Significant Data Fiduciary self-assessment is completed and signed by the DPO.

**Customer-facing milestone.** AI Act Sentinel beta is shipped to the EU pilot tenants. The first conformance score is published; one of the tenants surfaces a gap (their config disabled human oversight for a sub-flow); the auto-remediation playbook is run.

### Sub-sprint 6 (weeks T-2 to T+0): Type II walk-through, GA, customer-facing rollout

**Primary.** Type II walk-through with the auditor. The auditor reviews the full sample, the evidence cells, the remediation history, the management response. The Type II report is drafted.

**Secondary.** SoA final published. The CMEK substrate is generally available on the enterprise tier; the org KEK rotation runbook is published; the DEK rotation cadence is set at quarterly for paid tenants and annually for the org KEK.

**Customer-facing milestone.** All four DPDP artefacts (DPIA, DPO appointment, grievance officer appointment, 72-hour breach playbook) are published. The Compliance Receipt Pack is generally available; the first quarterly pack is produced for every enterprise tenant. The Trust Center as a Service is GA; the EU-Sovereign tier is in customer preview with the first two paying customers signed.

---

## Section 5. Customer value and revenue impact

Certifications are not a feature; they are a meta-feature that unlocks the enterprise procurement gate. The economics of Phase 11 are not "this feature drives X revenue"; they are "without this, none of the other features drive enterprise revenue".

**Win-rate uplift versus ClearTax and Cygnet.** Both ClearTax (the GST automation incumbent) and Cygnet (the broader compliance and tax-tech vendor) ship SOC 2 Type II reports and ISO 27001 certificates today `[speculative based on 2025 procurement disclosures]`. In the head-to-head enterprise deals where Anvil competes on capability (extraction quality, anomaly engine, autonomous agents), the procurement gate has been the blocker; the buyer's CISO refuses to approve a vendor without SOC 2. Phase 11 closes this gap. Estimated win-rate uplift: from approximately 25% today (capability wins offset by procurement losses) to approximately 50% post-Phase-11 (capability wins amplified by procurement parity). Each percentage point of win rate translates to approximately INR 3Cr to INR 6Cr ARR over the next 18 months at our deal-pipeline volume `[speculative]`.

**EU buyer cohort unlock.** Per DD58, the EU buyer cohort is 8,000 to 15,000 mid-market accounts. Anvil cannot meaningfully engage this cohort without the EU-Sovereign tier; we cannot ship the EU-Sovereign tier without the SOC 2 + ISO 27001 + EU AI Act memo + CMEK substrate. Phase 11 is the gating step. Year 3 EU ARR projection: INR 4Cr to INR 7.5Cr.

**DPDP-driven India market unlock.** As DPDP enforcement ramps in 2026 and 2027, every Indian enterprise will require its sub-processors to be DPDP-aligned. Anvil customers who themselves become Significant Data Fiduciaries will demand DPIA, DPO, and 72-hour breach drills from us as their processor. Phase 11 makes these table-stakes; Phase 11 plus the Compliance Receipt Pack makes them a competitive moat. Estimated India SDF-tier customer count by Year 3: 30 to 60 accounts at INR 8L+ per year, contributing INR 2.4Cr to INR 4.8Cr ARR.

**Compliance Receipt Pack revenue (Idea A).** INR 25,000 per month per enterprise tenant. At 200 enterprise tenants by Year 3, ARR contribution: INR 6Cr. The pack is a high-margin product; the marginal cost per pack is approximately INR 0 (the generator is fully automated; the DPO sign-off is bundled into the KPMG engagement).

**Trust Center as a Service revenue (Idea B).** INR 50,000 per month. At 80 enterprise tenants who opt in (40% attach rate to the Compliance Receipt Pack), ARR contribution: INR 4.8Cr by Year 3.

**Audit Co-pilot revenue (Idea C).** INR 75,000 per month. At 50 enterprise tenants in the SaaS-selling-to-enterprises segment, ARR contribution: INR 4.5Cr.

**AI Act Sentinel revenue (Idea E).** INR 35,000 per month. At 30 EU-tier tenants, ARR contribution: INR 1.26Cr.

**Total Phase 11 revenue impact by Year 3.** Conservative estimate: INR 23Cr. Aggressive estimate: INR 32Cr. This is incremental to the base SaaS revenue; it does not double-count.

**Cost of inaction.** Without Phase 11, Anvil cannot compete in enterprise. The capability lead over ClearTax and Cygnet is meaningful but procurement-gated; the EU market is unreachable; the DPDP SDF-customer-cohort is unreachable; the four product ideas (Compliance Receipt Pack, Trust Center as a Service, Audit Co-pilot, AI Act Sentinel) are unbuildable. The opportunity cost: INR 23Cr to INR 32Cr ARR by Year 3, plus a permanent positioning disadvantage.

**Cost of execution.** Year 1 Phase 11 budget:
- Sprinto platform: INR 18L.
- Auditor (Schellman India or BDO): INR 15L.
- KPMG DPO engagement: INR 30L for 18 months.
- External counsel (EU AI Act memo): INR 12L.
- ISO 27001 pre-cert internal audit: INR 6L.
- Engineering effort: 60 engineer-days across 4 to 6 engineers (CMEK substrate 15 days plus Receipt Pack 22 days plus Trust Center 30 days plus Sentinel 25 days, partially parallelizable).
- Total cash spend: approximately INR 1.1Cr.
- Engineering allocation: approximately 0.5 of total Phase 6 to 11 engineering capacity for 12 weeks.

Return on Phase 11 spend at Year 3 conservative scenario: INR 23Cr ARR on INR 1.1Cr spend equals 20x return. At Year 5 with the renewal cycle and the EU TAM penetration, return is approximately 60x.

---

## Section 6. Risk register

**Risk R1: Audit fails at Type II walk-through.** Likelihood: medium. Impact: high (slips the report to Q1 2027, missing the Q4 2026 procurement window). Mitigation: the pre-cert internal audit at Sub-sprint 4 surfaces gaps with two months of runway; the mid-window readiness review with the auditor at the same sub-sprint is a forcing function. Rollback: if the report is qualified (i.e., the auditor issues exceptions), we accept the qualified report and target an unqualified report at the 6-month re-issue; qualified reports are still accepted by most procurement teams for first-time engagements.

**Risk R2: EU AI Act memo is rejected by counsel as too aggressive.** Likelihood: medium. Impact: medium (slips the EU rollout but does not block India). Mitigation: counsel engagement at Sub-sprint 1, not Sub-sprint 3, so counsel and engineering iterate on the argument; the fallback position (Anvil is the provider, the customer is the deployer, the customer bears Annex III obligations) is defensible even in the most conservative reading. Rollback: if counsel insists on Annex III classification, we ship the full conformity assessment (which is largely written by Sub-sprint 4 anyway via the AI Act Sentinel skeleton) and accept the cost.

**Risk R3: CMEK pilot customer pulls out.** Likelihood: low. Impact: medium (we have an unproven CMEK substrate). Mitigation: shortlist two pilot customers, not one; pre-commit the AWS KMS adaptor work which is the longest-pole regardless of which customer is first; ship the substrate with our own AWS KMS as the trial customer so the code path is proven even without a paying tenant. Rollback: announce CMEK as "available on request" rather than "GA" if the pilot slips; the substrate is shipped, the customer-facing announcement is gated.

**Risk R4: DPDP Significant Data Fiduciary thresholds are notified at a lower volume than expected.** Likelihood: medium. Impact: high (we become an SDF earlier than planned, accelerating obligations). Mitigation: Phase 11 already targets SDF-readiness, not SDF-actuality, so the obligations are pre-loaded. Rollback: none needed; this is mitigated by design.

**Risk R5: GRC vendor outage during evidence freeze.** Likelihood: low. Impact: high (evidence cells are unreviewable during the freeze). Mitigation: nightly export of the Sprinto workspace to a customer-controlled S3 bucket; the export is part of our standard incident playbook. Rollback: extend the evidence freeze by 5 business days while the export is reconstituted.

**Risk R6: Outsourced DPO conflict of interest.** Likelihood: low. Impact: medium (a customer demands an independent DPO). Mitigation: the KPMG engagement is structured with explicit Chinese-wall provisions; the DPO is named in customer DPAs with the conflict-of-interest disclosure. Rollback: name a secondary outsourced DPO (Deloitte India) as a fallback; pre-negotiated.

**Risk R7: EU-Sovereign tier customer requires Anthropic EU residency before Anthropic ships it.** Likelihood: medium. Impact: medium (we cannot deliver the tier to the strictest buyers). Mitigation: stage the EU-Sovereign tier in two waves: Wave 1 (AWS Frankfurt plus Supabase EU plus Anthropic with SCC-only) ships at T+0; Wave 2 (full Anthropic EU residency) ships when Anthropic does. Disclose the staging in the customer DPA. Rollback: offer a self-hosted LLM (Llama 3 via Hugging Face Inference Endpoints) as a fallback for the strictest buyers; quality is lower but residency is guaranteed.

**Risk R8: ISO 27001 internal audit punch-list is too long to close in 4 weeks.** Likelihood: medium. Impact: medium (slips the SoA v2 milestone). Mitigation: the internal audit runs in Sub-sprint 4 with 8 weeks of runway to SoA v2; the SoA v1 is independently usable for customer disclosures. Rollback: ship the SoA v2 with open punch-list items disclosed as remediation roadmap; the SoA is informational at this stage, not auditor-attested.

---

## Section 7. Success metrics

**Hard exit criteria (binary, week-stamped).**

- **Week 4:** SOC 2 Type II observation window has started. Sprinto workspace is live, all in-scope integrations (GitHub, Supabase, Vercel, Anthropic, Cloudflare, AWS Mumbai) are wired, evidence-collection bots are running.
- **Week 4:** AICPA auditor engagement letter is executed (Schellman India, BDO India, or equivalent). The auditor is named on the project tracker.
- **Week 8:** EU AI Act Article 6 classification memo is signed by external counsel and published to the trust center. The memo argues default-outside-Annex-III with the Article 6(3) human-oversight exception as fallback.
- **Week 8:** ISO 27001:2022 SoA v1 is drafted. Approximately 76 of 93 controls are marked in-scope; the evidence-pointer column is populated for at least 60 of those.
- **Week 10:** CMEK substrate is live with the first pilot customer. AWS KMS adaptor is in production; the first wrapped-DEK is operational; the `kek_rotation_events` table has its first row.
- **Week 12:** ISO 27001:2022 SoA final is published. The pre-cert internal audit punch-list is closed; the SoA is signed by the DPO and the Head of Engineering.
- **Week 12:** SOC 2 Type II walk-through is complete. The auditor is drafting the report; an unqualified opinion is the target.
- **Week 12:** All four DPDP artefacts (DPIA, DPO, grievance officer, 72-hour breach playbook) are published.

**Soft success metrics (continuous, trend-tracked).**

- Evidence freshness in Sprinto: >95% of evidence cells are auto-collected and dated within the last 30 days at all times during the observation window.
- `audit_failures` table growth: <5 rows per day on average; any week with >50 rows triggers an on-call review.
- HMAC-export verification rate: 100% of audit exports are downloaded with an HMAC-verifiable signature (zero unsigned exports).
- DPO response SLA: 100% of customer DPA queries answered within 5 business days during the phase.
- Trust center adoption: at least 5 enterprise tenants opt into the Trust Center as a Service by Week 12.
- Compliance Receipt Pack beta: at least 10 enterprise tenants receive a beta pack by Week 12; their feedback scores the pack at 4 of 5 or better on auditor-readiness.
- EU pilot count: at least 3 EU mid-market accounts in active procurement evaluation by Week 12, gated on the EU-Sovereign tier preview.

**Lagging metrics (Q3 to Q4 2026, post-phase).**

- SOC 2 Type II report issued by 30 September 2026.
- First EU-Sovereign tier customer signed and live by 31 December 2026.
- ISO 27001:2022 Stage 1 audit booked for Q2 2027.
- CMEK enterprise tier with at least 5 paying customers by 31 March 2027.
- Compliance Receipt Pack revenue: INR 1Cr ARR by 31 December 2026, scaling to INR 6Cr by Year 3.

**Failure metrics (any one triggers an executive review).**

- SOC 2 observation window does not start by Week 6 (target Week 4; 2-week buffer).
- EU AI Act memo is unsigned by Week 10 (target Week 8).
- CMEK substrate is not live by Week 12 (target Week 10).
- Any DPDP §8(6) reportable breach during the phase (the 72-hour clock starts; the on-call playbook must execute).

---

End of Phase 11 deep-dive plan.

Tags: [verified] = file at cited path read on main `c4f946b`; [inferred] = grounded conclusion; [speculative] = outside reference not checked in-repo.

Cross-references:
- `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/14-final-roadmap.md` lines 1061 to 1107 (Phase 11 source).
- `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/10-security.md` (F10.1 through F10.5 prior findings).
- `/Users/kenith.philip/anvil/src/api/_lib/secrets.js` (AES-256-GCM substrate; CMEK extension point).
- `/Users/kenith.philip/anvil/src/api/_lib/auth.js` (SOC 2 CC6.1 access-control evidence).
- `/Users/kenith.philip/anvil/src/api/_lib/audit.js` (SOC 2 CC7.2 monitoring evidence; sentinel-fallback writes).
- `/Users/kenith.philip/anvil/src/api/audit/export.js` (SOC 2 CC7.3 evidence export; HMAC-signed trail).
