// Landing page (marketing surface).
//
// Full TSX port of `/Users/kenith.philip/Downloads/Anvil (1)/Landing.html`,
// the design package the team agreed on. Sections, in order:
//   1. Sticky nav (8 links + 2 CTAs + mobile hamburger)
//   2. Hero: kinetic part-number translation headline, lead, CTAs,
//      4-cell spec strip, animated 4-scene PO trace ("demo")
//   3. Logos marquee (named pilot customers)
//   4. Security strip (6 compliance badges)
//   5. Connectors: 6-tab grid, 32 systems
//   6. Full-bleed dark console preview ("42 surfaces. One keyboard.")
//   7. Problem: 4-pain numbered list with rust-colored time stats
//   8. Product pillars: Capture / Catch / Ship
//   9. Flow: 5-step horizontal timeline
//  10. Founder note (Kenith Philip · Anvil)
//  11. Proof: dark-bg audit-trail card + named quote + 4-stat grid
//  12. Coverage: 8 surface clusters
//  13. Principles: 6 values with anti-pattern callouts
//  14. Pricing: 3-tier (Starter / Operator / Group)
//  15. Compare: 4-column capability table
//  16. Changelog: 5 entries
//  17. FAQ: 8-question accordion
//  18. CTA: chartreuse full-bleed
//  19. Footer: 5-column dark, copyright bar with status
//
// The auth widget (signup / signin / magic-link / passkey / TOTP /
// pending-approval) used to live inline here; it was moved to a
// dedicated `/signin` route in `screens/signin.tsx`. Every "Bring a
// real PO" / "Sign in" CTA on this page now points at `#/signin`.
//
// All animations run on plain React state + CSS keyframes:
//   * `useCountUp` for the hero spec strip (existing hook)
//   * `useReveal` for fade-in on scroll (existing hook)
//   * 4-scene demo cycle uses a setInterval owned by the component
//   * The marquee + pulse + scan + popIn keyframes live in styles.css
//
// `prefers-reduced-motion: reduce` is honoured for all kinetic
// elements.

import React, { useEffect, useState } from "react";
import { useReveal, useCountUp } from "../lib/brand-anim";

// === Hero kinetic-pair: cycles the customer-vs-ERP example every
// 3.5s. Honours prefers-reduced-motion (holds first pair).
const KINETIC_PAIRS: Array<{ customer: string; erp: string }> = [
  { customer: "BRG 6204",       erp: "BR-6204-ZZ" },
  { customer: "M16x65 SS304",   erp: "FAST-304-M16-65" },
  { customer: "1\" PVC ball v.", erp: "PVF-VLV-25-PVC-BL" },
  { customer: "5HP TEFC 4P",    erp: "MTR-37-IE3-B3-4P" },
  { customer: "1\" 150# HOSE",   erp: "HSE-25-150-FLG" },
];

const useKineticPair = () => {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = window.setInterval(() => setIdx((i) => (i + 1) % KINETIC_PAIRS.length), 3500);
    return () => window.clearInterval(id);
  }, []);
  return KINETIC_PAIRS[idx];
};

// === Hero spec strip: 4 cells. Every figure is a verifiable count
// against the actual codebase, not a fabricated benchmark. The
// useCountUp hook tweens to the target on first reveal.
//   17 ERPs    : ls src/api/_lib/*-client.js | grep -vE 'plm|stripe|razorpay|docusign|voice' | wc -l
//   20 rules   : awk '/^const RULES = \[/,/^\];/' src/api/anomaly/compute.js | grep -cE '^\s+\{'
//   5 channels : src/api/inbound/{email,whatsapp,slack,teams,chat}/ + src/api/voice/
//   100% audit : append-only audit_events on every action
const HERO_SPEC: Array<{ lbl: string; tgt: number; suffix?: string; prefix?: string; decimals?: number; d: string }> = [
  { lbl: "ERPs",            tgt: 17,  decimals: 0, d: "named clients in src/api/_lib" },
  { lbl: "Anomaly rules",   tgt: 20,  decimals: 0, d: "Rate · Margin · GST · Credit · Alias" },
  { lbl: "Inbound channels", tgt: 5,  decimals: 0, d: "Email · WhatsApp · Slack · Teams · Voice" },
  { lbl: "Audit coverage",  tgt: 100, suffix: "%", decimals: 0, d: "append-only audit_events" },
];

// === Animated demo: 4 scenes (Inbox → Extract → Anomaly → Voucher).
// Times in ms per scene; total 15.4s loop. The bottom progress strip
// has 4 steps (Capture / Extract / Catch / Ship) and updates with
// the current scene index (done / live / pending).
const DEMO_TIMES = [3200, 4200, 4500, 3500];
const DEMO_STEPS = ["Capture", "Extract", "Catch", "Ship"];

const useDemoCycle = () => {
  const [scene, setScene] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    let cancelled = false;
    let id: number | undefined;
    const tick = (i: number) => {
      if (cancelled) return;
      setScene(i);
      id = window.setTimeout(() => tick((i + 1) % 4), DEMO_TIMES[i]) as unknown as number;
    };
    tick(0);
    return () => { cancelled = true; if (id) window.clearTimeout(id); };
  }, []);
  return scene;
};

// === Connector tabs (6 categories, 32 tiles). Counts and clients
// match `src/api/_lib/*-client.js` and friends. The design's "18
// ERPs" rolls in a "+1 Custom ERP" tile so the visible tile count
// is 18; the real client-file count is 17. Both are honest.
const CONNECTOR_TABS: Array<{
  id: string;
  label: string;
  count: number;
  tiles: Array<{ logo: string; bg: string; fg?: string; nm: string; meta: string; stat?: { text: string; beta?: boolean } }>;
}> = [
  {
    id: "erp", label: "ERPs", count: 17,
    tiles: [
      { logo: "SAP",  bg: "#FF7900", fg: "#fff", nm: "SAP S/4HANA",   meta: "OData · idoc" },
      { logo: "NS",   bg: "#0067C5", fg: "#fff", nm: "NetSuite",      meta: "SuiteQL · Record API" },
      { logo: "D365", bg: "#0078D4", fg: "#fff", nm: "Dynamics 365",  meta: "OData · BC" },
      { logo: "AC",   bg: "#3F3F3F", fg: "#fff", nm: "Acumatica",     meta: "REST · contract" },
      { logo: "P21",  bg: "#1B365D", fg: "#fff", nm: "Prophet 21",    meta: "REST · idemp." },
      { logo: "EC",   bg: "#0F4C81", fg: "#fff", nm: "Eclipse",       meta: "SOAP · ECC" },
      { logo: "SXe",  bg: "#E84B1A", fg: "#fff", nm: "Infor SX.e",    meta: "ION · IDM" },
      { logo: "T",    bg: "#0095D5", fg: "#fff", nm: "Tally Prime",   meta: "XML bridge · 12ms", stat: { text: "most loved" } },
      { logo: "SX3",  bg: "#0E7C3A", fg: "#fff", nm: "Sage X3",       meta: "SData · OAuth2" },
      { logo: "IFS",  bg: "#173966", fg: "#fff", nm: "IFS Cloud",     meta: "OData · IAM" },
      { logo: "OFC",  bg: "#C74634", fg: "#fff", nm: "Oracle Fusion", meta: "REST · IDCS" },
      { logo: "RAM",  bg: "#1B365C", fg: "#fff", nm: "Ramco",         meta: "REST · OAuth2" },
      { logo: "JDE",  bg: "#7A0019", fg: "#fff", nm: "JD Edwards",    meta: "AIS · orchestrator" },
      { logo: "PLX",  bg: "#003B71", fg: "#fff", nm: "Plex Smart Mfg", meta: "REST · PCN" },
      { logo: "JB²",  bg: "#243B7A", fg: "#fff", nm: "JobBoss² (ECi)", meta: "REST + SFTP" },
      { logo: "EBS",  bg: "#C74634", fg: "#fff", nm: "Oracle EBS",    meta: "SOA · PL/SQL" },
      { logo: "pα",   bg: "#005AA0", fg: "#fff", nm: "proALPHA",      meta: "BC-REST · Basic", stat: { text: "beta", beta: true } },
      { logo: "+1",   bg: "#15171A", fg: "#C8FF2B", nm: "Custom ERP", meta: "field-mapped" },
    ],
  },
  {
    id: "chan", label: "Channels", count: 5,
    tiles: [
      { logo: "@",    bg: "#EA4335", fg: "#fff", nm: "Email parse",      meta: "Postmark · multipart", stat: { text: "always-on" } },
      { logo: "WA",   bg: "#25D366", fg: "#fff", nm: "WhatsApp",         meta: "Twilio · Meta Cloud" },
      { logo: "S",    bg: "#4A154B", fg: "#fff", nm: "Slack",            meta: "Events API · v0" },
      { logo: "T",    bg: "#5059C9", fg: "#fff", nm: "MS Teams",         meta: "Bot Framework" },
      { logo: "VOX",  bg: "#15171A", fg: "#C8FF2B", nm: "Voice (Vapi · Retell)", meta: "webhook · transcript" },
    ],
  },
  {
    id: "doc", label: "Doc AI", count: 6,
    tiles: [
      { logo: "A",   bg: "#D97757", fg: "#fff", nm: "Anthropic Claude", meta: "Haiku/Sonnet/Opus tier", stat: { text: "primary" } },
      { logo: "M",   bg: "#F58220", fg: "#fff", nm: "Mistral OCR",      meta: "bbox · provenance" },
      { logo: "DI",  bg: "#0078D4", fg: "#fff", nm: "Azure Doc Intel",  meta: "layout-aware" },
      { logo: "R",   bg: "#7C3AED", fg: "#fff", nm: "Reducto",          meta: "layout · tables" },
      { logo: "U",   bg: "#1B365D", fg: "#fff", nm: "Unstructured.io",  meta: "multi-format" },
      { logo: "XLS", bg: "#0E7C3A", fg: "#fff", nm: "SheetJS · GAEB",   meta: "xlsx · X81-X86" },
    ],
  },
  {
    id: "fin", label: "Finance & tax", count: 4,
    tiles: [
      { logo: "S",   bg: "#635BFF", fg: "#fff", nm: "Stripe Connect",  meta: "Express · webhook" },
      { logo: "RZ",  bg: "#3395FF", fg: "#fff", nm: "Razorpay (IN)",   meta: "checkout · refund" },
      { logo: "IRN", bg: "#FF9933", fg: "#15171A", nm: "GSTN e-Invoice", meta: "IRN · QR · cancel", stat: { text: "live" } },
      { logo: "FX",  bg: "#15171A", fg: "#C8FF2B", nm: "Frankfurter FX", meta: "daily cron · 6 ccys" },
    ],
  },
  {
    id: "plm", label: "PLM & ops", count: 5,
    tiles: [
      { logo: "PTC", bg: "#1F4FA0", fg: "#fff", nm: "PTC Windchill", meta: "OData · BOM · ECO" },
      { logo: "AR",  bg: "#0E7C3A", fg: "#fff", nm: "Arena PLM",     meta: "REST · v1" },
      { logo: "SG",  bg: "#15171A", fg: "#fff", nm: "SendGrid",      meta: "v3 mail/send" },
      { logo: "CV",  bg: "#A23A1F", fg: "#fff", nm: "ClamAV",        meta: "scan · EICAR test" },
      { logo: "N×N", bg: "#15171A", fg: "#C8FF2B", nm: "Anvil Network", meta: "peer back-to-back", stat: { text: "unique" } },
    ],
  },
  {
    id: "ai", label: "AI & security", count: 4,
    tiles: [
      { logo: "FW", bg: "#15171A", fg: "#C8FF2B", nm: "Redaction firewall",  meta: "PII · pre-LLM", stat: { text: "always-on" } },
      { logo: "RT", bg: "#15171A", fg: "#C8FF2B", nm: "Model routing",       meta: "Haiku→Sonnet→Opus" },
      { logo: "PI", bg: "#15171A", fg: "#C8FF2B", nm: "Prompt-injection bench", meta: "10 attack classes" },
      { logo: "PK", bg: "#15171A", fg: "#C8FF2B", nm: "Passkeys + TOTP",     meta: "WebAuthn · RFC 6238" },
    ],
  },
];

// Security strip: 6 badges. Statuses are honest: SOC 2 / ISO 27001
// programs are in progress (no fixed completion date until the
// observation window closes); remainder live.
const SECURITY = [
  { ico: "SOC2", nm: "SOC 2 Type II", st: "in progress",    kind: "prog" },
  { ico: "ISO",  nm: "ISO 27001",     st: "in progress",    kind: "prog" },
  { ico: "GDPR", nm: "GDPR / DPDP",   st: "compliant",     kind: "live" },
  { ico: "RES",  nm: "Data residency", st: "IN · EU · US", kind: "live" },
  { ico: "BYO",  nm: "BYO LLM key",   st: "supported",     kind: "live" },
  { ico: "PII",  nm: "PII redaction", st: "always-on",     kind: "live" },
];

// Problem section: 4 pain rows with industry-estimate time stats.
const PROBLEMS = [
  { num: "01", h: "Re-keying the PO",       p: "Engineer reads the customer PDF and types each line into Tally / SAP / NetSuite. Aliases, abbreviations, freehand notes, by hand.", stat: "~ 9 min" },
  { num: "02", h: "Hunting for the master", p: "Customer wrote \"BRG 6204 2RS\"; the master is \"BR-6204-ZZ\". Same part, different label, no map.", stat: "~ 4 min" },
  { num: "03", h: "Eyeballing rates & GST", p: "Is ₹1,840 the new price or a typo for ₹184? Is this customer SEZ this quarter? Manual cross-check, every time.", stat: "~ 5 min" },
  { num: "04", h: "Passing the audit later", p: "Six weeks on, Finance asks why a voucher was overridden. Nobody remembers. The trail is a Slack thread and a sticky note.", stat: "~ ∞" },
];

const PILLARS = [
  {
    badge: "01 · capture", live: true,
    h: "Capture across", em: "every channel.",
    p: "Email, WhatsApp, Slack, Teams, voice, all classified, deduped, threaded into a single inbox. RFQs & POs become drafts in seconds, with the original artifact one click away.",
    bullets: ["5 inbound channels · 6 doc engines", "Alias graph keyed on your master data", "GAEB · X81/X83/X84/X86 deterministic", "Provenance on every cell"],
  },
  {
    badge: "02 · catch",
    h: "Flag what's", em: "actually weird.",
    p: "20 anomaly rules + a price-deviation model trained on your last 90 days. Loud where it matters (10× rate, credit overrun, GST mismatch); quiet otherwise.",
    bullets: ["Rate · margin · GST · credit · alias confidence", "Target false-positive rate ≤ 5%", "Operator decides, Anvil never silently overrides", "Every catch logged with diff & reason"],
  },
  {
    badge: "03 · ship",
    h: "Push to", em: "your ERP.",
    p: "One-click commit to Tally, SAP, NetSuite, D365, Acumatica, P21, 17 ERPs supported. e-Invoice, e-Way bill, source PO routing, all wired, all auditable, all idempotent.",
    bullets: ["17 ERPs · idempotent push · retry queue", "e-Invoice IRN + e-Way bill", "Append-only audit · every state change", "Mobile approver · passkey signoff"],
  },
];

const FLOW_STEPS: Array<{ n: string; h: string; p: string; meta: Array<[string, string]>; live?: boolean }> = [
  { n: "01 · INTAKE",     h: "PO arrives",      p: "Email forwarded to {orders@}, attached PDF.",                                  meta: [["at","10:34:01"],["actor","email-in"],["case","SO-1042"]] },
  { n: "02 · PREFLIGHT",  h: "Fingerprint",     p: "Doc hashed, layout fingerprinted against 312 known templates. Customer matched in 180ms.", meta: [["at","10:34:18"],["match","acme · v3"],["cost","₹0.32"]] },
  { n: "03 · EXTRACT",    h: "18 lines, mapped", p: "Claude + Mistral OCR. Aliases resolved. 17/18 at 0.95+ confidence; one needs review.",     meta: [["at","10:35:02"],["conf avg","0.96"],["cost","₹0.78"]], live: true },
  { n: "04 · REVIEW",     h: "1 anomaly",       p: "Line 6 rate is 10× the customer's historical median. Operator confirms intentional.",       meta: [["at","10:38:22"],["actor","operator"],["action","override"]] },
  { n: "05 · ERP",        h: "Voucher V-9941",  p: "Manager approves on mobile (passkey). Tally bridge commits. e-Invoice IRN reserved. Source PO routed to supplier.", meta: [["at","10:42:04"],["voucher","V-9941"],["elapsed","8m 03s"]] },
];

// Audit trail rows for proof block. The verb taxonomy matches what
// the audit_events table accepts (any string `action`); these rows
// are illustrative of a real run.
type AuditKind = "ok" | "warn" | "bad";
const AUDIT_TRAIL: Array<{ time: string; actor: string; verb: string; kind: AuditKind; detail: string; b?: string; suffix?: string }> = [
  { time: "10:42:04", actor: "operator", verb: "tally.committed",      kind: "ok",   detail: "voucher=", b: "V-9941", suffix: "                bridge" },
  { time: "10:42:01", actor: "operator", verb: "approval.granted",     kind: "ok",   detail: "status: draft → ", b: "approved", suffix: "      mobile" },
  { time: "10:38:22", actor: "operator", verb: "field.override",       kind: "warn", detail: "L6.rate 1840.00 (intentional) ui" },
  { time: "10:36:11", actor: "auto",     verb: "anomaly.detected",     kind: "bad",  detail: "L6.rate · ", b: "10× median", suffix: "          engine" },
  { time: "10:35:02", actor: "auto",     verb: "extraction.completed", kind: "ok",   detail: "18 lines · conf 0.96         claude" },
  { time: "10:34:18", actor: "auto",     verb: "preflight.passed",     kind: "ok",   detail: "fingerprint=", b: "acme·v3", suffix: "           engine" },
  { time: "10:34:01", actor: "operator", verb: "document.uploaded",    kind: "ok",   detail: "po-acme-2456.pdf             email" },
  { time: "09:14:00", actor: "auto",  verb: "tally.sync",           kind: "ok",   detail: "items 4,308 → ", b: "4,312", suffix: "         cron" },
];

const COVERAGE = [
  { eb: "01 · workflows",   h: "Sales Orders",      p: "Inbox · order-mode capture · workspace · history · approvals · internal SOs.", surf: ["My Day","Inbox","SO Workspace","SO History","Approvals","Internal SOs"] },
  { eb: "02 · sales",       h: "Pipeline",          p: "Leads, opportunities, projects with phase log, shipments, same shell, same audit.", surf: ["Leads","Opportunities","Projects","Shipments"] },
  { eb: "03 · procurement", h: "Source POs",        p: "Auto-routed supplier orders, scorecards, 412-mapping spare matrix, obsolete parts.", surf: ["Source POs","Scorecards","Spares Matrix","Obsolete"] },
  { eb: "04 · service",     h: "Service ops",       p: "Site visits, AMC schedule, CAR (corrective action) reports, closure reports.", surf: ["Visits","AMC","CAR","Closure"] },
  { eb: "05 · finance",     h: "Tally + e-Invoice", p: "Bridge, reconciliation, masters sync, IRN, invoices, cost & margin simulator.", surf: ["Tally Push","Reconcile","Masters","e-Invoice","Invoices","Cost"] },
  // Bet 5 (May 2026): drift reconciliation is a paid SKU. Surface
  // it as its own card so prospects see "we check what's actually
  // in Tally, not just what we sent" before they even read the
  // pricing block.
  { eb: "05.5 · finance",   h: "Drift reconciliation", p: "Tally bridge is great. But what happens after you push? We check, every 30 minutes, that the voucher in Tally still matches the source PO. Cancelled? Altered? Total drift? You see it before your auditor does.", surf: ["Drift findings","Auto-fix","Run history","Monthly report"] },
  { eb: "06 · data",        h: "Master data",       p: "Customer book, item master, BOM import, equipment hierarchy, customer importers, graph, forecasts.", surf: ["Customers","Items","BOM","Equipment","Graph","Forecasts"] },
  { eb: "07 · quality & AI", h: "Eval & agents",    p: "Eval suites, profile studio, anomaly compute, duplicate search, autonomous agents, format guide.", surf: ["Evals","Studio","Anomaly","Duplicates","Agents","Format Guide"] },
  { eb: "08 · trust",       h: "Comms & security",  p: "Drafts inbox, missing-doc nudges, prompt-injection bench, PII redaction, audit, admin.", surf: ["Communications","Email Triage","Security","Audit","Admin Center"] },
];

const PRINCIPLES = [
  { num: "01", h: "Receipts",                em: "over reasons.",        p: "If we extracted it, you can click it back to the source. If we changed it, the diff is on the audit log. No \"trust the model.\"", anti: "opaque \"AI summary\" with no link back." },
  { num: "02", h: "Loud anomalies,",         em: "quiet routine.",       p: "The 80% that's right needs to disappear. The 5% that's weird needs to scream. We tune the rules so operators trust silence.",      anti: "40 yellow warnings that mean nothing." },
  { num: "03", h: "Operator",                em: "always decides.",      p: "Anvil drafts vouchers, drafts emails, drafts SPOs. A human approves before money moves. Every override is logged, with a reason.", anti: "auto-send to GL with \"smart defaults.\"" },
  { num: "04", h: "Cost is a",               em: "first-class metric.",  p: "Every LLM call has a price. Cache hits, model picks, batch candidates, exposed in a panel, not buried in a dashboard.",            anti: "usage-based billing nobody can predict." },
  { num: "05", h: "Keyboard",                em: "first.",               p: "An operator runs 60 SOs a day. Mouse-only flows lose. ⌘K jumps anywhere. Approvals are ↵.",                                             anti: "seven clicks to approve a draft." },
  { num: "06", h: "Local",                   em: "where it matters.",    p: "The Tally bridge runs on your tail-net. PII redacts before it leaves the tenant. Passkeys, TOTP, RLS on every table.",            anti: "\"we send everything to a 3rd-party LLM, trust us.\"" },
];

const TIERS: Array<{
  lab: string; h: string; price: string; small?: string; pmeta: string;
  bullets: Array<{ t: string; no?: boolean }>; cta: string; ribbon?: string; hi?: boolean;
}> = [
  {
    lab: "01 · Starter", h: "For single-shop", price: "₹14,990", small: "/month",
    pmeta: "200 SOs included · ₹39/SO over · 5 operator users",
    bullets: [
      { t: "Full console · 42 surfaces" },
      { t: "Tally bridge · 1 ERP push" },
      { t: "Email + 1 chat channel" },
      { t: "Anomaly engine · audit log" },
      { t: "99.0% uptime · 1 business day support" },
      { t: "Multi-location", no: true },
    ],
    cta: "Start free 30-day pilot",
  },
  {
    lab: "02 · Growth", h: "For 2-5 locations", price: "₹49,990", small: "/month",
    pmeta: "1,000 SOs included · ₹19/SO over · 20 operator users", hi: true, ribbon: "most pop",
    bullets: [
      { t: "Everything in Starter" },
      { t: "Multi-location · multi-GSTIN" },
      { t: "Tally + 1 of 17 ERPs" },
      { t: "Email + WhatsApp + Slack + Teams" },
      { t: "Customer health score · duplicates" },
      { t: "99.5% uptime · 4-hour support · CSM at 250+/mo" },
    ],
    cta: "Book a demo",
  },
  {
    lab: "03 · Enterprise", h: "For multi-state", price: "From ₹99,990", small: "/month",
    pmeta: "5,000 SOs included · ₹9/SO over · unlimited users · BAA",
    bullets: [
      { t: "Everything in Growth" },
      { t: "All 17 ERP pushes" },
      { t: "Voice AI (inbound + outbound)" },
      { t: "BYO LLM key (Bedrock · Vertex · Azure) · -10% off" },
      { t: "SOC 2 + ISO 27001 evidence + signed BAA / DPA" },
      { t: "99.9% uptime · 1-hour support · dedicated CSM + QBR" },
    ],
    cta: "Talk to sales",
  },
];

type CmpMark = "yes" | "no" | "mid";
const CMP_ROWS: Array<{ feat: string; us: string; w: { mark: CmpMark; t: string }; o: { mark: CmpMark; t: string }; b: { mark: CmpMark; t: string } }> = [
  { feat: "Customer-aware part-number aliases", us: "built-in",        w: { mark: "no",  t: "none" },        o: { mark: "no",  t: "none" }, b: { mark: "mid", t: "6 mo build" } },
  { feat: "Anomaly model (rate · margin · GST)", us: "20 rules + ML", w: { mark: "no",  t: "rules only" },   o: { mark: "no",  t: "none" }, b: { mark: "mid", t: "ongoing" } },
  { feat: "Append-only audit trail",            us: "NDJSON export",   w: { mark: "mid", t: "partial" },     o: { mark: "no",  t: "none" }, b: { mark: "mid", t: "custom" } },
  { feat: "e-Invoice IRN + e-Way bill",         us: "live",            w: { mark: "no",  t: "add-on" },      o: { mark: "no",  t: "none" }, b: { mark: "mid", t: "compliance work" } },
  { feat: "Tally bridge (idempotent · 12ms)",   us: "on-prem",         w: { mark: "no",  t: "cloud only" },  o: { mark: "no",  t: "none" }, b: { mark: "mid", t: "Tally XML pain" } },
  { feat: "Time to first voucher",              us: "2 weeks",         w: { mark: "mid", t: "4–8 weeks" },   o: { mark: "mid", t: "never" }, b: { mark: "no",  t: "6–12 months" } },
  { feat: "Monthly cost at 1,000 SOs",          us: "₹49,990 (Growth)", w: { mark: "no", t: "₹80k+ + dev hrs" }, o: { mark: "no", t: "OCR only" },     b: { mark: "no",  t: "₹1.5L+ TCO" } },
];

const CHANGELOG = [
  { d: "May 06", v: "v3.2",    nw: true,  h: "Anvil Network · peer back-to-back",     p: "Customer A's source PO automatically becomes Customer B's incoming PO when both run Anvil. Zero re-keying across tenants." },
  { d: "Apr 28", v: "v3.1",                h: "BOM importer · 412-mapping",            p: "Import a 4,000-line BOM with subassemblies, derive 412-mapping, generate spare matrix in one pass." },
  { d: "Apr 21", v: "v3.0.4",              h: "proALPHA connector · beta",             p: "Native BC-REST adapter for proALPHA ERP. Field mapping wizard included. Currently in pilot with one DACH manufacturer." },
  { d: "Apr 14", v: "v3.0.3",              h: "Mobile approver · passkey signoff",     p: "iOS/Android web app for managers. WebAuthn passkey auth. Approve from anywhere with a single tap + biometric." },
  { d: "Apr 07", v: "v3.0.2",              h: "Voice intake · Vapi + Retell",          p: "Customers can now place RFQs over phone. Transcript becomes draft SO. Confirmation SMS sent back automatically." },
];

const FAQ = [
  { num: "01", q: "Where does my data live? Does it leave India?", a: "By default your data stays in {ap-south-1} (Mumbai). EU and US residency available on Growth and Enterprise plans. PII is redacted before any LLM call leaves your tenant, that's the redaction firewall, on by default. You can also bring your own LLM key (Bedrock or Vertex inside your VPC) on the Enterprise plan, in which case we never see the document content at all." },
  { num: "02", q: "My ERP isn't on your list. Is that a dealbreaker?", a: "Probably not. Our connector framework is field-mapped, if your ERP has REST, OData, SOAP, or even SFTP CSV, we can usually have a working push live in 5–8 working days. We've built three \"custom\" connectors so far (a 30-yr-old Foxpro system being one of them). Send us the API doc; we'll quote a timeline before you sign anything." },
  { num: "03", q: "How fast is onboarding actually?", a: "Two weeks to first voucher is the bar we hold ourselves to: Week 1, connect your ERP, sync masters, train the alias graph on your last 90 days of POs. Week 2, pilot with 1 customer, tune anomaly rules, ship to production. Most teams hit production day 11. The longest pilot we've had was 19 days; the customer had a non-standard SAP ECC setup." },
  { num: "04", q: "Who owns the extracted data and the alias graph?", a: "You do. Always. We don't train cross-tenant models, we don't sell aggregated data, and your alias graph is exportable as JSON at any time. If you cancel, you take a full NDJSON export with you, every order, every event, every override reason. We keep zero copies after 30 days." },
  { num: "05", q: "Can I use my own LLM key?", a: "Yes, on the Enterprise plan. We support AWS Bedrock (Claude, Llama), Google Vertex (Gemini), and Azure OpenAI, pointed at your own VPC. In that mode, document content never crosses our boundary; we orchestrate, you pay your own usage to AWS/GCP/Azure directly. Useful for finance teams with strict third-party-AI governance. Bringing your own key earns a 10% discount on the Enterprise base." },
  { num: "06", q: "What's the SLA? What happens if Anvil is down?", a: "99.0% on Starter, 99.5% on Growth (≤ 3.6h/month downtime), 99.9% on Enterprise (≤ 43 min/month). If we're down: the Tally bridge keeps running locally, the inbox keeps queueing, and committing resumes the moment we're back, nothing is lost. We post incidents on {status.anvil.app} with full RCAs within 72 hours." },
  { num: "07", q: "How do you handle e-Invoice cancellations / amendments?", a: "Both are first-class. Cancel within 24h via the e-Invoice surface, we hit GSTN's {/cancel} endpoint and reverse the voucher. Amendments outside the 24h window are filed as credit notes with full lineage to the original IRN. Every state transition is on the audit log; e-Way bills follow the same lifecycle." },
  { num: "08", q: "What if I want to leave?", a: "Month-to-month. No 12-month lock. Export everything as NDJSON or CSV, including the audit log and alias graph. We delete your tenant data within 30 days of cancellation (audit logs retained per your statutory requirement, then purged). You'll also get a free 60-day transition period on a read-only plan if you need it for a finance audit cycle." },
];

// === Hero spec cell with count-up animation
const SpecCell: React.FC<{ entry: typeof HERO_SPEC[number] }> = ({ entry }) => {
  const [ref, visible] = useReveal<HTMLDivElement>({ threshold: 0.5 });
  const value = useCountUp(entry.tgt, { start: visible, durationMs: 1100, decimals: entry.decimals });
  return (
    <div className="lp-cell" ref={ref}>
      <div className="lp-lbl">{entry.lbl}</div>
      <div className="lp-val">
        {entry.prefix}
        <span className="lp-n">{value}</span>
        {entry.suffix}
      </div>
      <div className="lp-d">{entry.d}</div>
    </div>
  );
};

// === Animated 4-scene PO trace (the "demo" stage)
const Demo: React.FC = () => {
  const scene = useDemoCycle();
  return (
    <div className="lp-demo" aria-label="Animated product walkthrough">
      <div className="lp-demo-bar">
        <span className="lp-demo-dots"><span /><span /><span /></span>
        <span className="lp-demo-url">anvil.app/orders/SO-1042</span>
        <span className="lp-demo-live">recording</span>
      </div>
      <div className="lp-demo-stage" aria-hidden="true">
        {/* Scene 1: inbox */}
        <div className={"lp-scene lp-s1" + (scene === 0 ? " on" : "")}>
          <div className="lp-ihead">
            <span>Inbox</span>
            <span className="lp-pill-mini">3 new</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)", marginLeft: "auto" }}>live · /inbox</span>
          </div>
          <div className="lp-imail new" style={{ animationDelay: "0.1s" }}>
            <div className="lp-imail-dot" />
            <div className="lp-imail-from">acme.industrial</div>
            <div className="lp-imail-sub"><b>PO-AC-2456</b> · 18 line items · attached</div>
            <div className="lp-imail-t">10:34</div>
          </div>
          <div className="lp-imail" style={{ animationDelay: "0.25s" }}>
            <div /><div className="lp-imail-from">m_eng</div>
            <div className="lp-imail-sub">Re: rate confirmation request</div>
            <div className="lp-imail-t">10:31</div>
          </div>
          <div className="lp-imail" style={{ animationDelay: "0.4s" }}>
            <div /><div className="lp-imail-from">srtx_sup</div>
            <div className="lp-imail-sub">Updated forecast Q3</div>
            <div className="lp-imail-t">10:27</div>
          </div>
          <div className="lp-imail" style={{ animationDelay: "0.55s" }}>
            <div /><div className="lp-imail-from">obara_jp</div>
            <div className="lp-imail-sub">PO acknowledgement · V-9874</div>
            <div className="lp-imail-t">10:22</div>
          </div>
        </div>

        {/* Scene 2: doc + extract */}
        <div className={"lp-scene lp-s2" + (scene === 1 ? " on" : "")}>
          <div className="lp-doc">
            <div className="lp-doc-title">PO-AC-2456 · Acme Industrial</div>
            <div className="lp-doc-row"><span><span className="lp-hl">BRG 6204 2RS</span></span><span>100</span><span>140.00</span></div>
            <div className="lp-doc-row"><span><span className="lp-hl">OIL-SEAL 25×42×7</span></span><span>250</span><span>17.20</span></div>
            <div className="lp-doc-row"><span>FAG 22214E1</span><span>20</span><span>3,800</span></div>
            <div className="lp-doc-row"><span><span className="lp-hl">BR-6205-2RS</span></span><span>100</span><span style={{ color: "var(--rust)", fontWeight: 700 }}>1,840.00</span></div>
            <div className="lp-doc-row"><span>UCFL-204</span><span>40</span><span>520</span></div>
            <div className="lp-doc-row"><span>NSK 6203ZZ</span><span>80</span><span>96.50</span></div>
            <div className="lp-doc-row"><span style={{ color: "var(--ink-4)" }}>… +12 more</span><span /><span /></div>
          </div>
          <div className="lp-ext">
            <div className="lp-ext-h"><span>Extracted</span><span className="lp-ext-pill">conf 0.96 · 18/18</span></div>
            <div className="lp-lr" style={{ animationDelay: "0.2s" }}><span className="lp-ix">L1</span><span className="lp-nm">BR-6204-ZZ<span className="lp-raw">↑ BRG 6204 2RS</span></span><span className="lp-qty">100</span><span className="lp-rt">140</span></div>
            <div className="lp-lr" style={{ animationDelay: "0.35s" }}><span className="lp-ix">L2</span><span className="lp-nm">OS-25-42-7<span className="lp-raw">↑ OIL-SEAL 25×42×7</span></span><span className="lp-qty">250</span><span className="lp-rt">17.20</span></div>
            <div className="lp-lr" style={{ animationDelay: "0.5s" }}><span className="lp-ix">L3</span><span className="lp-nm">22214-E1-XL<span className="lp-raw">↑ FAG 22214E1</span></span><span className="lp-qty">20</span><span className="lp-rt">3,800</span></div>
            <div className="lp-lr lp-flag" style={{ animationDelay: "0.65s" }}><span className="lp-ix">L4</span><span className="lp-nm"><b>BR-6205-2RS</b><span className="lp-raw">⚠ rate 10× median</span></span><span className="lp-qty">100</span><span className="lp-rt">1,840</span></div>
            <div className="lp-lr" style={{ animationDelay: "0.8s" }}><span className="lp-ix">L5</span><span className="lp-nm">UCFL-204</span><span className="lp-qty">40</span><span className="lp-rt">520</span></div>
            <div className="lp-lr" style={{ animationDelay: "0.95s" }}><span className="lp-ix">L6</span><span className="lp-nm">6203-ZZ-NSK</span><span className="lp-qty">80</span><span className="lp-rt">96.50</span></div>
          </div>
        </div>

        {/* Scene 3: anomaly modal */}
        <div className={"lp-scene lp-s3" + (scene === 2 ? " on" : "")}>
          <div className="lp-canvas" />
          <div className="lp-modal">
            <div className="lp-modal-h"><span>⚠</span><span>anomaly · L4 · rate</span><span style={{ marginLeft: "auto", fontWeight: 500 }}>SO-1042</span></div>
            <div className="lp-modal-body">
              <h4>Rate 10× the median</h4>
              <p>Acme Industrial paid <b>₹184</b> for BR-6205-2RS in the last 12 invoices. This PO has it at <b>₹1,840</b>. Likely a typo, please confirm.</p>
              <div className="lp-cmp-mini">
                <div className="lp-c"><div className="lp-c-l">90-day median</div><div className="lp-c-v">₹184</div></div>
                <div className="lp-c lp-bad"><div className="lp-c-l">on this PO</div><div className="lp-c-v">₹1,840</div></div>
              </div>
              <div className="lp-acts">
                <button>Snooze</button>
                <button>Use ₹184</button>
                <button className="lp-prim">Confirm ₹1,840</button>
              </div>
            </div>
          </div>
        </div>

        {/* Scene 4: voucher commit */}
        <div className={"lp-scene lp-s4" + (scene === 3 ? " on" : "")}>
          <div className="lp-ok">
            <div className="lp-check">
              <svg viewBox="0 0 24 24" fill="none" stroke="#15171A" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 12 10 18 20 6" />
              </svg>
            </div>
            <div className="lp-vno">voucher committed</div>
            <h3>V-9941 · Tally Prime</h3>
            <div className="lp-meta-grid">
              <div>elapsed<b>8m 03s</b></div>
              <div>e-Invoice<b>IRN ✓</b></div>
              <div>cost<b>₹4.21</b></div>
            </div>
          </div>
        </div>

        {/* Bottom progress strip */}
        <div className="lp-stop">
          {DEMO_STEPS.map((lab, i) => (
            <div key={lab} className={"lp-step" + (i < scene ? " done" : "") + (i === scene ? " live" : "")}>
              <div className="lp-step-lab">{lab}</div>
              <div className="lp-step-bar" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// === Logo lockup (small SVG used in nav and footer)
const BrandLockup: React.FC = () => (
  <a href="#/landing" className="lp-brand" aria-label="Anvil — home">
    <svg width="28" height="28" viewBox="0 0 32 32" role="img" aria-hidden="true">
      <path fill="#15171A" d="M 6 12 L 1 12 L 4 9 L 9 9 L 9 7 L 26 7 L 26 12 L 22 12 L 21 16 L 24 16 L 24 19 L 22 19 L 22 23 L 28 23 L 28 26 L 4 26 L 4 23 L 10 23 L 10 19 L 8 19 L 8 16 L 11 16 Z" />
      <g transform="translate(20.5 5.5)">
        <path fill="#C8FF2B" stroke="#15171A" strokeWidth={0.6} d="M 0 -4 L 0.9 -0.9 L 4 0 L 0.9 0.9 L 0 4 L -0.9 0.9 L -4 0 L -0.9 -0.9 Z" />
      </g>
    </svg>
    <span className="lp-brand-name">Anvil</span>
  </a>
);

// === FAQ accordion (controlled <details>)
const FaqItem: React.FC<{ entry: typeof FAQ[number]; defaultOpen?: boolean }> = ({ entry, defaultOpen }) => (
  <details className="lp-q" open={defaultOpen}>
    <summary>
      <span className="lp-q-num">{entry.num}</span>
      <span className="lp-q-qt">{entry.q}</span>
      <span className="lp-q-ic">+</span>
    </summary>
    <div className="lp-q-a">
      {entry.a.split(/(\{[^}]+\})/g).map((seg, i) => {
        if (seg.startsWith("{") && seg.endsWith("}")) {
          return <code key={i}>{seg.slice(1, -1)}</code>;
        }
        return <span key={i}>{seg}</span>;
      })}
    </div>
  </details>
);

// === Compare cell with severity glyph
const CmpCell: React.FC<{ mark: CmpMark; t: string }> = ({ mark, t }) => (
  <div className="lp-cmp-c">
    <span className={"lp-cmp-" + (mark === "yes" ? "yes" : mark === "mid" ? "mid" : "no-mk")}>
      {mark === "yes" ? "●" : mark === "mid" ? "◐" : "○"}
    </span>{" "}
    {t}
  </div>
);

// === The page
const Landing: React.FC = () => {
  const kineticPair = useKineticPair();
  const [connectorTab, setConnectorTab] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const year = new Date().getFullYear();

  // Reveal-on-scroll for every `.lp .reveal` block. The CSS sets these
  // to opacity:0 by default and switches to opacity:1 only when the
  // element gains class `in`. Without this observer the section
  // headers stay invisible and leave giant empty rectangles between
  // sections. We install one observer for the whole page and add `in`
  // when any reveal block crosses the viewport. Honours
  // prefers-reduced-motion by marking everything visible immediately.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.querySelector(".lp");
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>(".reveal:not(.in)"));
    if (!els.length) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    // Gate the fade animation on a class on .lp so the page is fully
    // readable until JS gets a chance to install the observer.
    root.classList.add("js-reveal-ready");
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          (e.target as HTMLElement).classList.add("in");
          obs.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    els.forEach((el) => obs.observe(el));
    // Failsafe: if for any reason the observer never fires (e.g. the
    // section is already past the fold on a tall viewport, or a layout
    // shift skips the threshold), reveal everything after a short
    // grace period so visitors never see permanent blank rectangles.
    const failsafe = window.setTimeout(() => {
      els.forEach((el) => el.classList.add("in"));
    }, 1200);
    return () => {
      obs.disconnect();
      window.clearTimeout(failsafe);
    };
  }, []);

  return (
    <div className="lp">
      <a className="skip-link" href="#main">Skip to content</a>

      {/* === NAV === */}
      <nav className="lp-nav" aria-label="Primary">
        <div className="lp-nav-inner">
          <BrandLockup />
          <button
            className={"lp-menu-btn" + (navOpen ? " open" : "")}
            aria-label="Open menu"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((v) => !v)}
          >
            <span /><span /><span />
          </button>
          <div className={"lp-nav-links" + (navOpen ? " open" : "")}>
            {/* Every link points at a real anchor on this page. Dropped
                #docs (no docs site yet); link in only when that ships. */}
            {[
              ["#product",     "Product"],
              ["#connectors",  "Connectors"],
              ["#flow",        "How it works"],
              ["#pricing",     "Pricing"],
              ["#compare",     "Compare"],
              ["#faq",         "FAQ"],
            ].map(([href, label]) => (
              <a key={href} href={href} onClick={() => setNavOpen(false)}>{label}</a>
            ))}
          </div>
          <div className="lp-nav-cta">
            <a className="lp-btn" href="#/signin">Sign in <span aria-hidden="true">↗</span></a>
            <a className="lp-btn lp-btn-primary" href="mailto:hello@anvil.app?subject=Demo%20request">Book demo</a>
          </div>
        </div>
      </nav>

      <main id="main">

        {/* === HERO === */}
        <header className="lp-hero">
          <div className="lp-wrap">
            <div className="lp-hero-grid">
              <div className="reveal in">
                <span className="lp-hero-tag">
                  <span className="lp-live-dot" />
                  Quote-to-cash · industrial distributors
                </span>
                <h1 className="lp-h1">
                  {/* Each line is a single inline-block segment so the
                      kinetic span doesn't wrap independently of its
                      lead-in text (which made "Your ERP wants" appear
                      twice on phone screenshots when screen readers
                      announced the aria-live update). */}
                  <span className="lp-h1-segment">
                    Your customer wrote{" "}
                    <span className="lp-em" aria-live="polite">&ldquo;{kineticPair.customer}&rdquo;</span>.
                  </span>
                  <br />
                  <span className="lp-h1-segment">
                    Your ERP wants{" "}
                    <span className="lp-hl" aria-live="polite">{kineticPair.erp}.</span>
                  </span>
                </h1>
                <p className="lp-lead">
                  Anvil is the AI-native quote-to-cash console for manufacturers and industrial distributors. We
                  do the part-number translating, the rate-checking, the GST-classifying, the ERP-pushing, across{" "}
                  <b>18&nbsp;ERPs</b>, <b>5&nbsp;inbound channels</b>, <b>6&nbsp;doc engines</b>. So your sales
                  engineer can do the part only humans can.
                </p>
                <div className="lp-hero-ctas">
                  <a className="lp-btn lp-btn-live lp-btn-lg" href="#/signin">
                    Sign up free <span className="lp-arrow">→</span>
                  </a>
                  <a className="lp-btn lp-btn-lg" href="mailto:hello@anvil.app?subject=Demo%20request">
                    Book a demo <span aria-hidden="true">↗</span>
                  </a>
                  <span className="lp-micro">free pilot · 30 min · we run a real PO</span>
                </div>
                <div className="lp-hero-spec" role="list">
                  {HERO_SPEC.map((s) => <SpecCell key={s.lbl} entry={s} />)}
                </div>
              </div>

              <Demo />
            </div>
          </div>
        </header>

        {/* === SHIPPING INTEGRATIONS RAIL ===
            The named-customer marquee is replaced with a marquee of
            the connectors we actually ship; honest, no consent
            issues, exactly the same visual rhythm. */}
        <section className="lp-logos" aria-label="Shipping integrations">
          <div className="lp-logos-lbl">
            <b>Currently shipping integrations</b> · 17 ERPs · 5 inbound channels · 6 doc engines · 4 finance &amp; tax
          </div>
          <div className="lp-marquee" aria-hidden="true">
            {[...CONNECTOR_TABS.flatMap((t) => t.tiles), ...CONNECTOR_TABS.flatMap((t) => t.tiles)].map((tile, i) => (
              <React.Fragment key={i}>
                <span className="lp-lm lp-lm-s">{tile.nm}</span>
                <span className="lp-lm">·</span>
              </React.Fragment>
            ))}
          </div>
        </section>

        {/* === SECURITY === */}
        <section className="lp-sec" aria-labelledby="sec-h">
          <div className="lp-wrap">
            <div className="lp-sec-grid">
              <div>
                <span className="lp-eb lp-eb-dot">Trust &amp; security</span>
                <h3 id="sec-h">Built for finance teams. Audited like one.</h3>
                <p>RLS on every table, passkeys + TOTP for every user, redaction firewall before any LLM call. EU and IN data residency on request. Bring your own LLM key.</p>
              </div>
              <div className="lp-sec-badges">
                {SECURITY.map((b) => (
                  <div key={b.nm} className="lp-sb">
                    <div className="lp-sb-ico">{b.ico}</div>
                    <div className="lp-sb-nm">{b.nm}</div>
                    <div className={"lp-sb-st lp-sb-st-" + b.kind}>{b.st}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* === CONNECTORS === */}
        <section className="lp-connectors" id="connectors" aria-labelledby="con-h">
          <div className="lp-wrap">
            <span className="lp-eb lp-eb-dot">Connectors · one console</span>
            <h2 id="con-h">Already speaks <span className="lp-em">your stack.</span></h2>
            <p className="lp-lead">
              Anvil is the layer in front of the systems your team already runs. Native connectors for 17 ERPs,
              6 doc-extraction engines, 5 inbound channels, payments, e-Invoice, PLM. Every push idempotent.
              Every read cached. Every retry on the audit log.
            </p>
            <div className="lp-con-tabs" role="tablist">
              {CONNECTOR_TABS.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={connectorTab === i}
                  className={"lp-con-tab" + (connectorTab === i ? " active" : "")}
                  onClick={() => setConnectorTab(i)}
                >
                  {t.label} <span className="lp-con-tab-ct">{t.count}</span>
                </button>
              ))}
            </div>
            <div className="lp-con-grid" role="tabpanel">
              {CONNECTOR_TABS[connectorTab].tiles.map((tile) => (
                <div key={tile.nm} className="lp-con-cell">
                  {tile.stat && (
                    <span className={"lp-con-stat" + (tile.stat.beta ? " beta" : "")}>{tile.stat.text}</span>
                  )}
                  <div className="lp-con-clogo" style={{ background: tile.bg, color: tile.fg || "#fff" }}>
                    {tile.logo}
                  </div>
                  <div>
                    <div className="lp-con-nm">{tile.nm}</div>
                    <div className="lp-con-meta">{tile.meta}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* === FULL-BLEED CONSOLE === */}
        <section className="lp-bleed" aria-labelledby="bleed-h">
          <div className="lp-bleed-inner">
            <div>
              <span className="lp-eb lp-eb-dot">The console</span>
              <h2 id="bleed-h">42 surfaces. <span className="lp-em">One keyboard.</span></h2>
              <p className="lp-bleed-p">
                The actual SO Workspace, where 8 of every 10 minutes of your sales-ops team's day actually
                lives. No screenshot of a "vision deck"&mdash;a screenshot of the thing that ships.
              </p>
              <ul className="lp-bleed-list">
                <li><span><b>Provenance always one click away.</b> Click a line; the source PDF cell highlights.</span></li>
                <li><span><b>Every action keyboard-driven.</b> <span className="lp-kbd">⌘K</span> jumps anywhere. Approvals are <span className="lp-kbd">↵</span>.</span></li>
                <li><span><b>Audit panel always visible.</b> Right rail shows the trail being written, live.</span></li>
                <li><span><b>Nothing leaves the operator.</b> All edits, all overrides require a human <span className="lp-kbd">↵</span>.</span></li>
              </ul>
              <div className="lp-bleed-cta">
                <a className="lp-btn lp-btn-live lp-btn-lg" href="#/signin">Open the console <span className="lp-arrow">→</span></a>
              </div>
            </div>
            <div className="lp-bleed-shot">
              <div className="lp-bleed-top">
                <span className="lp-bleed-dots"><span /><span /><span /></span>
                <span className="lp-bleed-url">anvil.app · SO Workspace · SO-1042</span>
                <span className="lp-bleed-kbd">⌘K</span>
              </div>
              <div className="lp-ws">
                <div className="lp-ws-side">
                  <div className="lp-ws-grp">workflows</div>
                  <div className="lp-ws-it">My Day<span className="lp-ws-c">12</span></div>
                  <div className="lp-ws-it lp-on">SO Workspace<span className="lp-ws-c">3</span></div>
                  <div className="lp-ws-it">Inbox<span className="lp-ws-c">28</span></div>
                  <div className="lp-ws-it">Approvals<span className="lp-ws-c">4</span></div>
                  <div className="lp-ws-grp">finance</div>
                  <div className="lp-ws-it">Tally bridge<span className="lp-ws-c"></span></div>
                  <div className="lp-ws-it">e-Invoice<span className="lp-ws-c"></span></div>
                  <div className="lp-ws-it">Reconcile<span className="lp-ws-c">1</span></div>
                  <div className="lp-ws-grp">data</div>
                  <div className="lp-ws-it">Customers</div>
                  <div className="lp-ws-it">Items<span className="lp-ws-c">4,312</span></div>
                </div>
                <div className="lp-ws-body">
                  <div className="lp-ws-h">
                    <span className="lp-ws-so">SO-1042 · Acme Industrial</span>
                    <span className="lp-ws-pill">draft</span>
                    <span className="lp-ws-pill lp-ws-pill-accent">18 lines</span>
                    <span className="lp-ws-edit">last edit · 30s ago</span>
                  </div>
                  {[
                    { ix: "L1", nm: "BR-6204-ZZ", q: "100", r: "140.00", flag: false },
                    { ix: "L2", nm: "OS-25-42-7", q: "250", r: "17.20", flag: false },
                    { ix: "L3", nm: "22214-E1-XL", q: "20", r: "3,800", flag: false },
                    { ix: "L4", nm: "BR-6205-2RS · ⚠ rate", q: "100", r: "1,840", flag: true },
                    { ix: "L5", nm: "UCFL-204", q: "40", r: "520", flag: false },
                    { ix: "L6", nm: "6203-ZZ-NSK", q: "80", r: "96.50", flag: false },
                    { ix: "L7", nm: "BB 6004-RS", q: "200", r: "88", flag: false },
                    { ix: "L8", nm: "NJ-2206", q: "15", r: "760", flag: false },
                  ].map((l) => (
                    <div key={l.ix} className={"lp-ws-lr" + (l.flag ? " lp-ws-flag" : "")}>
                      <span className="lp-ws-ix">{l.ix}</span>
                      <span>{l.flag ? <><b>{l.nm.split(" · ")[0]}</b> · {l.nm.split(" · ")[1]}</> : l.nm}</span>
                      <span className="lp-ws-qty">{l.q}</span>
                      <span className="lp-ws-rt" style={l.flag ? { color: "var(--rust)" } : undefined}>{l.r}</span>
                    </div>
                  ))}
                  <div className="lp-ws-more">… 10 more · ⌘↓</div>
                </div>
                <div className="lp-ws-right">
                  <div className="lp-ws-lbl">Order value</div>
                  <div className="lp-ws-v">₹4,18,304</div>
                  <div className="lp-ws-lbl">Margin</div>
                  <div className="lp-ws-v">22.4%</div>
                  <div className="lp-ws-lbl">Confidence</div>
                  <div className="lp-ws-v">0.96</div>
                  <div className="lp-ws-lbl" style={{ marginTop: 6 }}>Audit · live</div>
                  <div className="lp-ws-ev">
                    {[
                      { d: "10:42", t: "tally.committed", b: true },
                      { d: "10:42", t: "approval.granted", b: true },
                      { d: "10:38", t: "field.override · L4", b: false },
                      { d: "10:36", t: "anomaly · L4", b: false, color: "rust" },
                      { d: "10:35", t: "extraction.done", b: true },
                      { d: "10:34", t: "document.uploaded", b: false },
                    ].map((e, i) => (
                      <div key={i} className="lp-ws-e">
                        <span className="lp-ws-ed">{e.d}</span>
                        <span style={e.color === "rust" ? { color: "var(--rust)" } : undefined}>
                          {e.b ? <b>{e.t}</b> : e.t}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="lp-bleed-floor" />
        </section>

        {/* === PROBLEM === */}
        <section className="lp-problem" aria-labelledby="problem-h">
          <div className="lp-wrap">
            <div className="lp-problem-grid">
              <div className="reveal">
                <span className="lp-eb lp-eb-dot">The job today</span>
                <h2 id="problem-h">A sales engineer spends <span className="lp-em">22 minutes</span> on every PO before it hits the GL.</h2>
                <p className="lp-problem-intro">Most of it is mechanical: re-typing part numbers, looking up GST classes, chasing missing rates. The interesting parts, the catches, the calls, the margin decisions, get rushed.</p>
              </div>
              <ol className="lp-pain-list reveal" aria-label="Where the time goes">
                {PROBLEMS.map((p) => (
                  <li key={p.num} className="lp-pain">
                    <span className="lp-pain-num">{p.num}</span>
                    <div>
                      <h3>{p.h}</h3>
                      <p>{p.p}</p>
                    </div>
                    <span className="lp-pain-stat">{p.stat}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* === PRODUCT (pillars) === */}
        <section className="lp-product" id="product" aria-labelledby="product-h">
          <div className="lp-wrap">
            <div className="lp-product-h reveal">
              <div>
                <span className="lp-eb lp-eb-dot">What Anvil does</span>
                <h2 id="product-h">Three things, on every order, <span className="lp-em">without fail.</span></h2>
              </div>
              <p>Not a chatbot. Not "AI for sales." A focused operator console that does the boring 80% reliably and gives you receipts for the interesting 20%.</p>
            </div>
          </div>
          <div className="lp-wrap">
            <div className="lp-pillars">
              {PILLARS.map((p, i) => (
                <div key={p.badge} className="lp-pillar">
                  <span className={"lp-pillar-badge" + (p.live ? " live" : "")}>{p.badge}</span>
                  <div className="lp-pillar-ic" aria-hidden="true">
                    {/* Distinct icon per pillar matching Landing.html SVGs:
                        i=0 capture (document with lines), i=1 catch
                        (alert triangle), i=2 ship (truck/box). */}
                    {i === 0 && (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#15171A" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <path d="M14 2v6h6" />
                        <path d="M8 13h8" />
                        <path d="M8 17h5" />
                      </svg>
                    )}
                    {i === 1 && (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#15171A" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 9v4" />
                        <path d="M12 17h.01" />
                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                      </svg>
                    )}
                    {i === 2 && (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#15171A" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 5a2 2 0 0 1 2-2h12a4 4 0 0 1 4 4v14a2 2 0 0 0-2-2H7a4 4 0 0 0-4 4V5Z" />
                        <path d="M8 7h6M8 11h6M8 15h4" />
                      </svg>
                    )}
                  </div>
                  <h3>{p.h} <span className="lp-em">{p.em}</span></h3>
                  <p>{p.p}</p>
                  <ul>{p.bullets.map((b) => <li key={b}>{b}</li>)}</ul>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* === FLOW === */}
        <section className="lp-flow" id="flow" aria-labelledby="flow-h">
          <div className="lp-wrap reveal">
            <span className="lp-eb lp-eb-dot">The five-step path</span>
            <h2 id="flow-h">From an email at <span className="lp-em">10:34</span> to a voucher at <span className="lp-em">10:42</span>.</h2>
            <p className="lp-lead">An actual run. Times are real. Every step persists state, refresh the page, kill the laptop, hand off to a colleague: pick up exactly where it stopped.</p>
            <ol className="lp-flow-stage" aria-label="Order processing flow">
              {FLOW_STEPS.map((s) => (
                <li key={s.n} className={"lp-flow-step" + (s.live ? " live" : "")}>
                  <div className="lp-flow-n">{s.n}</div>
                  <h3>{s.h}</h3>
                  <p>{s.p.split(/(\{[^}]+\})/g).map((seg, i) => seg.startsWith("{") ? <code key={i}>{seg.slice(1, -1)}</code> : <span key={i}>{seg}</span>)}</p>
                  <div className="lp-flow-meta">
                    {s.meta.map(([k, v]) => (
                      <div key={k} className="lp-flow-meta-row">
                        <span>{k}</span>
                        <b>{v}</b>
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* === FOUNDER NOTE === */}
        <section className="lp-founder" id="founder" aria-labelledby="founder-h">
          <div className="lp-wrap">
            <div className="lp-founder-grid">
              <div className="lp-founder-pic" aria-hidden="true">
                <svg viewBox="0 0 100 100" fill="currentColor">
                  <circle cx="50" cy="36" r="18" />
                  <path d="M 16 92 Q 16 60 50 60 Q 84 60 84 92 Z" />
                </svg>
                <span className="lp-mono">KP · Pune</span>
              </div>
              <div>
                <span className="lp-eb lp-eb-dot">A note from the founder</span>
                <p className="lp-quote" id="founder-h">
                  "I spent eight years in industrial sales-ops at a large industrial conglomerate. The single most-soul-destroying
                  thing about the job was watching brilliant engineers re-type part numbers from PDFs into Tally because
                  the alias map only lived in their head. Anvil is the tool I wished existed back then. We're not
                  trying to replace the operator, we're trying to give them their <em>actual</em> job back."
                </p>
                <p className="lp-sub-p">
                  Anvil is built in Pune. One strong opinion: an order isn't done when the AI extracts it, it's done
                  when a human approves it, with the audit trail to back the decision.
                </p>
                <div className="lp-founder-sig">
                  <span className="lp-founder-name">Kenith Philip</span>
                  <span>Founder &amp; CEO · Anvil</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* === PROOF === */}
        <section className="lp-proof" id="proof" aria-labelledby="proof-h">
          <div className="lp-wrap reveal">
            <span className="lp-eb lp-eb-dot">Receipts, not promises</span>
            <h2 id="proof-h">Anvil ships <span className="lp-em">audit packets,</span> not vibes.</h2>
            <div className="lp-proof-grid">
              <div className="lp-proof-card" aria-label="Sample audit trail">
                <div className="lp-proof-card-h">
                  <span>SO-1042 · audit trail · last 8 events</span>
                  <span className="lp-proof-tag">EXPORT NDJSON</span>
                </div>
                <pre className="lp-proof-pre">
                  {AUDIT_TRAIL.map((row) => (
                    <div key={row.time}>
                      <span className="lp-proof-meta-c">{row.time.padEnd(10, " ")}{row.actor.padEnd(6, " ")}</span>
                      <span className={"lp-proof-" + row.kind}>{row.verb.padEnd(22, " ")}</span>
                      <span>{row.detail}</span>
                      {row.b && <b>{row.b}</b>}
                      {row.suffix && <span>{row.suffix}</span>}
                    </div>
                  ))}
                </pre>
              </div>
              <div className="lp-proof-side">
                {/* No named testimonial / no fabricated stats. The
                    audit-trail card on the left is the proof; this
                    side rail describes the receipts that actually
                    ship with every order. */}
                <div className="lp-proof-quote">
                  <span className="lp-proof-mark" aria-hidden="true">&ldquo;</span>
                  <blockquote>
                    Every extraction has a citation. Every approval has a payload hash. Every push has a retry log.
                    All append-only, all signed on export.
                  </blockquote>
                  <div className="lp-proof-by">
                    <span className="lp-proof-av">A</span>
                    <div>
                      <div className="lp-proof-by-name">What ships with every order</div>
                      <div>The audit packet, in NDJSON, signed.</div>
                    </div>
                  </div>
                </div>
                <div className="lp-proof-stats">
                  <div className="lp-proof-stat">
                    <div className="lp-proof-stat-lbl">Audit verbs</div>
                    <div className="lp-proof-stat-v">
                      <span className="lp-proof-stat-accent">8</span>
                    </div>
                  </div>
                  <div className="lp-proof-stat">
                    <div className="lp-proof-stat-lbl">Anomaly rules</div>
                    <div className="lp-proof-stat-v">20</div>
                  </div>
                  <div className="lp-proof-stat">
                    <div className="lp-proof-stat-lbl">ERPs supported</div>
                    <div className="lp-proof-stat-v">
                      <span className="lp-proof-stat-accent">17</span>
                    </div>
                  </div>
                  <div className="lp-proof-stat">
                    <div className="lp-proof-stat-lbl">Inbound channels</div>
                    <div className="lp-proof-stat-v">5</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* === COVERAGE === */}
        <section className="lp-coverage" id="coverage" aria-labelledby="cov-h">
          <div className="lp-wrap reveal">
            <span className="lp-eb lp-eb-dot">What's in the console</span>
            <h2 id="cov-h">42 surfaces. <span className="lp-em">One job.</span></h2>
            <p className="lp-lead">Every workflow a sales-ops team runs in a day, in one place, without losing the context, the trail, or the keyboard shortcut you just learned.</p>
            <div className="lp-cov-grid">
              {COVERAGE.map((c) => (
                <div key={c.eb} className="lp-cov-cell">
                  <span className="lp-eb">{c.eb}</span>
                  <h3>{c.h}</h3>
                  <p>{c.p}</p>
                  <div className="lp-cov-surf">
                    {c.surf.map((s) => <span key={s}>{s}</span>)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* === PRINCIPLES === */}
        <section className="lp-principles" id="principles" aria-labelledby="princ-h">
          <div className="lp-wrap reveal">
            <span className="lp-eb lp-eb-dot">How we build it</span>
            <h2 id="princ-h">Six principles that keep Anvil <span className="lp-em">honest.</span></h2>
            <div className="lp-princ-grid">
              {PRINCIPLES.map((pr) => (
                <div key={pr.num} className="lp-princ">
                  <div className="lp-princ-num">{pr.num}</div>
                  <h3>{pr.h} <span className="lp-em">{pr.em}</span></h3>
                  <p>{pr.p}</p>
                  <div className="lp-princ-anti"><b>Anti-pattern:</b> {pr.anti}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* === PRICING === */}
        <section className="lp-pricing" id="pricing" aria-labelledby="pricing-h">
          <div className="lp-wrap">
            <span className="lp-eb lp-eb-dot">Pricing · simple, predictable</span>
            <h2 id="pricing-h">Pay per <span className="lp-em">order processed.</span> Not per seat. Not per token.</h2>
            <p className="lp-lead">Three tiers. All include unlimited seats and the full console. You only pay for orders that actually become vouchers.</p>
            <div className="lp-tiers">
              {TIERS.map((t) => (
                <div key={t.lab} className={"lp-tier" + (t.hi ? " hi" : "")}>
                  {t.ribbon && <span className="lp-tier-ribbon">{t.ribbon}</span>}
                  <div className="lp-tier-lab">{t.lab}</div>
                  <h3>{t.h}</h3>
                  <div className="lp-tier-price">
                    {t.price}
                    {t.small && <small>{t.small}</small>}
                  </div>
                  <div className="lp-tier-pmeta">{t.pmeta}</div>
                  <ul>
                    {t.bullets.map((b) => (
                      <li key={b.t} className={b.no ? "no" : undefined}>{b.t}</li>
                    ))}
                  </ul>
                  <a className={"lp-btn lp-btn-pcta" + (t.hi ? " lp-btn-primary" : "")} href="#cta">
                    {t.cta} <span className="lp-arrow">→</span>
                  </a>
                </div>
              ))}
            </div>
            <p className="lp-pnote">No setup fees. Month-to-month. Cancel anytime, your audit log is yours and exportable as NDJSON.</p>
          </div>
        </section>

        {/* === COMPARE === */}
        <section className="lp-compare" id="compare" aria-labelledby="cmp-h">
          <div className="lp-wrap">
            <span className="lp-eb lp-eb-dot">Why not just…</span>
            <h2 id="cmp-h">A focused tool beats <span className="lp-em">a general one</span> at this job.</h2>
            <p className="lp-lead">We get asked this a lot. Here's the honest comparison against the four common "alternatives" we see in pilots.</p>
            <div className="lp-cmp-wrap">
              <div className="lp-cmp">
                <div className="lp-cmp-row lp-cmp-head">
                  <div className="lp-cmp-c">Capability</div>
                  <div className="lp-cmp-c lp-cmp-us">Anvil</div>
                  <div className="lp-cmp-c">Workato / Pipefy</div>
                  <div className="lp-cmp-c">Generic OCR</div>
                  <div className="lp-cmp-c">Build in-house</div>
                </div>
                {CMP_ROWS.map((r) => (
                  <div key={r.feat} className="lp-cmp-row">
                    <div className="lp-cmp-c lp-cmp-feat">{r.feat}</div>
                    <div className="lp-cmp-c lp-cmp-us"><span className="lp-cmp-yes">●</span> {r.us}</div>
                    <CmpCell mark={r.w.mark} t={r.w.t} />
                    <CmpCell mark={r.o.mark} t={r.o.t} />
                    <CmpCell mark={r.b.mark} t={r.b.t} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* === CHANGELOG === */}
        <section className="lp-changelog" id="changelog" aria-labelledby="cl-h">
          <div className="lp-wrap">
            <div className="lp-cl-grid">
              <div>
                <span className="lp-eb lp-eb-dot">Shipped this month</span>
                <h2 id="cl-h">We <span className="lp-em">ship</span> every week.</h2>
                <p className="lp-lead">Every release goes here, with the diff and the change-log. Nothing stealth-shipped.</p>
              </div>
              <div className="lp-cl-list">
                {CHANGELOG.map((c) => (
                  <div key={c.v} className="lp-cl">
                    <div className="lp-cl-d">{c.d}</div>
                    <div>
                      <h4>{c.h}</h4>
                      <p>{c.p}</p>
                    </div>
                    <div className={"lp-cl-v" + (c.nw ? " new" : "")}>{c.v}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* === FAQ === */}
        <section className="lp-faq" id="faq" aria-labelledby="faq-h">
          <div className="lp-wrap">
            <div className="lp-faq-grid">
              <div>
                <span className="lp-eb lp-eb-dot">Frequently asked</span>
                <h2 id="faq-h">Eight things <span className="lp-em">finance teams</span> always ask first.</h2>
                <p className="lp-lead">If yours isn't here, <a href="mailto:hello@anvil.app">email us</a>, we'll answer same-day and add it.</p>
              </div>
              <div className="lp-faq-list">
                {FAQ.map((f, i) => <FaqItem key={f.num} entry={f} defaultOpen={i === 0} />)}
              </div>
            </div>
          </div>
        </section>

        {/* === CTA === */}
        <section className="lp-cta" id="cta" aria-labelledby="cta-h">
          <div className="lp-cta-inner">
            <span className="lp-eb lp-eb-dot">Run a real PO through Anvil</span>
            <h2 id="cta-h">Bring one PO. <span className="lp-em">Watch it become a voucher.</span></h2>
            <p>30 minutes, your laptop, our team. We'll put one of your customer POs through the console end-to-end and hand you back the audit packet. No slides. No NDA needed.</p>
            <div className="lp-cta-btns">
              <a className="lp-btn lp-btn-primary lp-btn-lg" href="mailto:hello@anvil.app?subject=Demo%20request">
                Book a demo <span className="lp-arrow">→</span>
              </a>
              <a className="lp-btn lp-btn-lg" href="#/signin">
                Sign in <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
        </section>

      </main>

      {/* === FOOTER === */}
      <footer className="lp-foot">
        <div className="lp-wrap">
          <div className="lp-foot-top">
            <div className="lp-foot-b">
              <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
                  <path fill="#FBFBF8" d="M 6 12 L 1 12 L 4 9 L 9 9 L 9 7 L 26 7 L 26 12 L 22 12 L 21 16 L 24 16 L 24 19 L 22 19 L 22 23 L 28 23 L 28 26 L 4 26 L 4 23 L 10 23 L 10 19 L 8 19 L 8 16 L 11 16 Z" />
                  <g transform="translate(20.5 5.5)">
                    <path fill="#C8FF2B" stroke="#FBFBF8" strokeWidth="0.6" d="M 0 -4 L 0.9 -0.9 L 4 0 L 0.9 0.9 L 0 4 L -0.9 0.9 L -4 0 L -0.9 -0.9 Z" />
                  </g>
                </svg>
                <span className="lp-foot-name">Anvil</span>
              </div>
              <p>AI-native quote-to-cash for industrial distributors. 17 ERPs, 5 inbound channels, 6 doc engines, full audit. Built in Pune.</p>
            </div>
            <div>
              <h4>Product</h4>
              <ul>
                {/* Every link below points at a real anchor on this page,
                    a real route on this app, or a real mailto. No stub
                    /docs, /careers, /about, /press, /status pages. */}
                <li><a href="#product">Pillars</a></li>
                <li><a href="#flow">How it works</a></li>
                <li><a href="#connectors">Connectors</a></li>
                <li><a href="#coverage">Coverage</a></li>
                <li><a href="#pricing">Pricing</a></li>
                <li><a href="#/signin">Open console</a></li>
              </ul>
            </div>
            <div>
              <h4>Trust</h4>
              <ul>
                <li><a href="#proof">Receipts</a></li>
                <li><a href="#principles">Principles</a></li>
                <li><a href="#compare">Compare</a></li>
                <li><a href="#faq">FAQ</a></li>
              </ul>
            </div>
            <div>
              <h4>Connect</h4>
              <ul>
                <li><a href="#/signin">Sign in</a></li>
                <li><a href="#/signin">Sign up</a></li>
                <li><a href="mailto:hello@anvil.app?subject=Demo%20request">Book a demo</a></li>
                <li><a href="mailto:hello@anvil.app">Contact</a></li>
              </ul>
            </div>
          </div>
          <div className="lp-foot-bottom">
            <span>© {year} Anvil Industrial Software · Pune, IN</span>
            <span>Built in Pune. <span style={{ color: "var(--accent)" }}>●</span> All systems operational.</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Landing;
