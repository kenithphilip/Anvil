import fs from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const opsPath = path.join(workspace, "src/legacy/obara-ops-v11.1.html");
const soPath = path.join(workspace, "src/legacy/so-agent-pocv4.jsx");
const outDir = path.join(workspace, "public");
const outPath = path.join(outDir, "index.html");
const backendClientPath = path.join(workspace, "src/client/anvil-client.js");

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const ops = fs.readFileSync(opsPath, "utf8");
const soSource = fs.readFileSync(soPath, "utf8");
const backendClient = fs.existsSync(backendClientPath) ? fs.readFileSync(backendClientPath, "utf8") : "";

const vendorScripts = [
  '<script src="https://cdn.tailwindcss.com"></script>',
  '<script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>',
  '<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>',
  '<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>',
].join("\n");

const opsAssistantCss = `
/* Ops Assistant additions */
.ops-assist-btn{border:1px solid var(--border);background:var(--bg-alt);font-weight:700}
.ops-overview .ops-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:14px 0}
.ops-card{background:var(--bg-alt);border:1px solid var(--border);border-radius:10px;padding:14px}
.ops-card .label{font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em}
.ops-card .value{font-size:24px;font-weight:800;color:var(--text);margin-top:6px}
.ops-card .sub{font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.45}
.ops-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.ops-health-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px;margin-top:10px}
.ops-health-item{display:flex;align-items:flex-start;gap:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px}
.ops-dot{width:9px;height:9px;border-radius:50%;margin-top:4px;flex-shrink:0;background:var(--text-faint)}
.ops-dot.ok{background:var(--ok)}.ops-dot.warn{background:var(--warn)}.ops-dot.err{background:var(--err)}
.ops-health-title{font-size:13px;font-weight:700;color:var(--text)}
.ops-health-detail{font-size:12px;color:var(--text-muted);line-height:1.4;margin-top:2px}
.ops-onboarding-card{background:linear-gradient(135deg,var(--bg-alt),var(--bg));border:1px solid var(--border);border-radius:10px;padding:14px;margin:14px 0}
.ops-onboarding-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.ops-progress{height:8px;background:var(--bg-soft);border-radius:999px;overflow:hidden;margin-top:10px}
.ops-progress span{display:block;height:100%;background:var(--accent);border-radius:999px}
.ops-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;margin-top:12px}
.ops-step{display:flex;gap:9px;align-items:flex-start;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px}
.ops-step strong{font-size:13px;color:var(--text)}.ops-step small{display:block;color:var(--text-muted);font-size:12px;line-height:1.35;margin-top:2px}
.ops-step-badge{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0;background:var(--bg-soft);color:var(--text-muted);border:1px solid var(--border)}
.ops-step.done .ops-step-badge{background:var(--ok);color:#fff;border-color:var(--ok)}
.ops-step.todo .ops-step-badge{background:var(--warn);color:#fff;border-color:var(--warn)}
.ops-step.check .ops-step-badge{background:var(--info);color:#fff;border-color:var(--info)}
.ops-suggestion-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px;margin-top:10px}
.ops-suggestion{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px}
.ops-suggestion strong{font-size:13px;color:var(--text)}.ops-suggestion p{font-size:12px;color:var(--text-muted);line-height:1.4;margin-top:3px}
.ops-format-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px;margin-top:10px}
.ops-format-card{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px}
.ops-format-card h4{font-size:13px;font-weight:800;margin-bottom:4px}.ops-format-card p{font-size:12px;color:var(--text-muted);line-height:1.4}
.ops-format-mini{font-size:11px!important;padding:5px 10px!important;margin-left:6px!important}
.ops-dock{position:fixed;left:18px;bottom:18px;z-index:180;display:flex;gap:8px;align-items:center}
.ops-dock button{background:var(--black);color:#fff;border:1px solid var(--black-soft);box-shadow:0 6px 18px rgba(0,0,0,.14);font-weight:700}
.ops-dock button.secondary{background:var(--bg);color:var(--text);border-color:var(--border-strong)}
.ops-palette-overlay{position:fixed;inset:0;background:rgba(28,25,23,.45);z-index:600;display:none;align-items:flex-start;justify-content:center;padding-top:9vh;backdrop-filter:blur(2px)}
.ops-palette-overlay.open{display:flex}
.ops-palette{width:min(720px,92vw);background:var(--bg);border:1px solid var(--border);border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.24);overflow:hidden}
.ops-palette input{border:0;border-bottom:1px solid var(--border);border-radius:0;padding:14px 16px;font-size:15px;box-shadow:none}
.ops-command-list{max-height:430px;overflow:auto;padding:6px}
.ops-command{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:8px;cursor:pointer}
.ops-command.active,.ops-command:hover{background:var(--accent-soft);color:var(--accent)}
.ops-command strong{font-size:13px}.ops-command span{font-size:12px;color:var(--text-muted)}
.ops-command kbd{font-size:10px;background:var(--bg-soft);border:1px solid var(--border);border-radius:5px;padding:2px 6px;color:var(--text-muted);white-space:nowrap}
.ops-modal-body{line-height:1.55;color:var(--text-soft);font-size:13px}
.ops-modal-body ul{margin:8px 0 0 18px}.ops-modal-body li{margin:4px 0}
.ops-hidden-input{display:none}
.ops-nav-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--err);color:#fff;font-size:10px;font-weight:800;margin-left:6px;letter-spacing:.02em;line-height:1}
.ops-nav-badge.warn{background:var(--warn)}
.ops-nav-badge.info{background:var(--info)}
.ops-tip-card{background:linear-gradient(135deg,var(--accent-soft),var(--bg-alt));border:1px solid var(--accent-bord);border-radius:10px;padding:12px 14px;margin:10px 0;display:flex;justify-content:space-between;gap:14px;align-items:flex-start}
.ops-tip-card h4{font-size:12px;font-weight:800;color:var(--accent);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.ops-tip-card p{font-size:13px;color:var(--text);line-height:1.5}
.ops-tip-actions{display:flex;flex-direction:column;gap:6px;flex-shrink:0;align-items:flex-end}
.ops-tip-dot-row{display:flex;gap:4px;margin-top:6px}
.ops-tip-dot{width:6px;height:6px;border-radius:50%;background:var(--text-faint)}
.ops-tip-dot.active{background:var(--accent);width:14px;border-radius:5px}
.ops-tour-overlay{position:fixed;inset:0;background:rgba(28,25,23,.55);z-index:700;display:none;backdrop-filter:blur(2px)}
.ops-tour-overlay.open{display:block}
.ops-tour-spotlight{position:absolute;border:3px solid var(--accent);border-radius:8px;box-shadow:0 0 0 9999px rgba(28,25,23,.55);transition:all .25s;pointer-events:none}
.ops-tour-bubble{position:absolute;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;max-width:340px;box-shadow:0 8px 30px rgba(0,0,0,.18);z-index:710}
.ops-tour-bubble h4{font-size:14px;font-weight:800;margin-bottom:6px}
.ops-tour-bubble p{font-size:12px;color:var(--text-soft);line-height:1.5}
.ops-tour-actions{display:flex;justify-content:space-between;align-items:center;margin-top:10px}
.ops-tour-skip{background:transparent;color:var(--text-muted);font-size:11px;border:none;cursor:pointer}
.ops-cost-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:10px}
.ops-cost-card{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:12px}
.ops-cost-card .label{font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em}
.ops-cost-card .value{font-size:18px;font-weight:800;color:var(--text);margin-top:4px;font-variant-numeric:tabular-nums}
.ops-cost-card .sub{font-size:11px;color:var(--text-muted);margin-top:3px;line-height:1.4}
.ops-cost-card.green{border-color:var(--ok-soft)}
.ops-cost-card.amber{border-color:var(--warn-soft)}
.ops-cost-card.red{border-color:var(--err-soft)}
.ops-role-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.ops-role-card{padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-alt);cursor:pointer;transition:.15s}
.ops-role-card:hover{border-color:var(--accent);background:var(--accent-soft)}
.ops-role-card h4{font-size:13px;font-weight:800;color:var(--text);margin-bottom:4px}
.ops-role-card p{font-size:11px;color:var(--text-muted);line-height:1.45}
html[data-theme="dark"]{
  --bg:#1c1917;--bg-alt:#292524;--bg-soft:#3a3633;--bg-sunken:#0e0c0a;
  --border:#3a3633;--border-soft:#2a2625;--border-strong:#534b46;
  --text:#fafaf9;--text-soft:#e7e5e4;--text-muted:#a8a29e;--text-faint:#78716c;
  --accent:#fb923c;--accent-hover:#f97316;--accent-soft:#3a2110;--accent-soft2:#3a2a13;
  --accent-bord:#7c2d12;--accent-light:#fb923c;--accent-tint:#3f1f10;
  --black:#0c0a09;--black-soft:#1c1917;
  --link:#60a5fa;--link-hover:#93c5fd;--link-soft:#1e293b;--link-bord:#1d4ed8;
  --ok:#34d399;--ok-soft:#064e3b;--warn:#fbbf24;--warn-soft:#3f2c0e;
  --err:#f87171;--err-soft:#3f1414;--info:#22d3ee;--info-soft:#0e3a4a;
  --china:#fbbf24;--china-soft:#3f2a0e;--china-bord:#92400e;
}
html[data-theme="dark"] body{background:var(--bg);color:var(--text)}
html[data-theme="dark"] input,html[data-theme="dark"] select,html[data-theme="dark"] textarea{background:var(--bg-alt);color:var(--text);border-color:var(--border-strong)}
html[data-theme="dark"] .so-agent-root{background:var(--bg-alt)}
html[data-theme="dark"] .so-agent-root .bg-white{background:var(--bg) !important;color:var(--text) !important}
html[data-theme="dark"] .so-agent-root .bg-slate-50,html[data-theme="dark"] .so-agent-root .bg-slate-100,html[data-theme="dark"] .so-agent-root .bg-blue-50,html[data-theme="dark"] .so-agent-root .bg-emerald-50,html[data-theme="dark"] .so-agent-root .bg-amber-50,html[data-theme="dark"] .so-agent-root .bg-red-50,html[data-theme="dark"] .so-agent-root .bg-purple-50,html[data-theme="dark"] .so-agent-root .bg-teal-50{background:var(--bg-alt) !important}
html[data-theme="dark"] .so-agent-root .text-slate-700,html[data-theme="dark"] .so-agent-root .text-slate-800,html[data-theme="dark"] .so-agent-root .text-slate-900{color:var(--text) !important}
html[data-theme="dark"] .so-agent-root .text-slate-400,html[data-theme="dark"] .so-agent-root .text-slate-500,html[data-theme="dark"] .so-agent-root .text-slate-600{color:var(--text-muted) !important}
html[data-theme="dark"] .so-agent-root .border-slate-100,html[data-theme="dark"] .so-agent-root .border-slate-200,html[data-theme="dark"] .so-agent-root .border-slate-300{border-color:var(--border) !important}
`;

const overviewTab = `<!-- OPS OVERVIEW -->
<div id="tab-overview" class="tab-content">
  <div class="sec ops-overview" style="max-width:1400px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap">
      <div>
        <h2 style="font-weight:800">Ops Overview</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-top:4px">Live workflow status, quick actions, safe backups, and environment checks.</p>
      </div>
      <div class="ops-actions">
        <button class="btn btn-primary" onclick="openOpsPalette()">Command Palette</button>
        <button class="btn btn-ghost" onclick="runOpsHealthCheck()">Run Health Check</button>
        <button class="btn btn-teal" onclick="exportOpsBackup()">Export Backup</button>
      </div>
    </div>
    <div id="ops-overview-cards" class="ops-grid"></div>
    <div id="ops-onboarding-card" class="ops-onboarding-card"></div>
    <div id="ops-tip-card" class="ops-tip-card"></div>
    <div class="card" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <h3 style="font-size:14px;font-weight:800">Cost Analytics</h3>
          <p style="color:var(--text-muted);font-size:12px;margin-top:3px">Live spend, monthly trend, avoided calls, and per-customer breakdown.</p>
        </div>
        <div class="ops-actions" style="margin:0">
          <button class="btn btn-ghost" onclick="showCostAnalyticsModal()">Detailed Breakdown</button>
          <button class="btn btn-ghost" onclick="showAuditLogModal()">Audit Log</button>
        </div>
      </div>
      <div id="ops-cost-analytics" class="ops-cost-grid"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <h3 style="font-size:14px;font-weight:800">Workflow Shortcuts</h3>
          <p style="color:var(--text-muted);font-size:12px;margin-top:3px">Common paths that usually cost the most clicks.</p>
        </div>
        <span style="font-size:11px;color:var(--text-muted)">Cmd/Ctrl+K opens command palette</span>
      </div>
      <div id="ops-quick-actions" class="ops-actions"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <h3 style="font-size:14px;font-weight:800">Process Improvements</h3>
          <p style="color:var(--text-muted);font-size:12px;margin-top:3px">Next fixes that improve accuracy, reliability, or operator speed.</p>
        </div>
        <button class="btn btn-ghost" onclick="showProcessImprovements()">View Details</button>
      </div>
      <div id="ops-process-suggestions" class="ops-suggestion-list"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <h3 style="font-size:14px;font-weight:800">Cost Optimization</h3>
          <p style="color:var(--text-muted);font-size:12px;margin-top:3px">Duplicate skips, reusable customer profiles, prompt caching, and batch candidates.</p>
        </div>
        <div class="ops-actions" style="margin:0">
          <button class="btn btn-ghost" onclick="runOpsAction('so-cost-policy')">Cost Policy</button>
          <button class="btn btn-ghost" onclick="runOpsAction('so-customer-profiles')">Customer Profiles</button>
        </div>
      </div>
      <div id="ops-cost-cards" class="ops-grid"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <h3 style="font-size:14px;font-weight:800">Import and Export Formats</h3>
          <p style="color:var(--text-muted);font-size:12px;margin-top:3px">Table imports now support Excel, CSV, TSV, and TXT where applicable.</p>
        </div>
        <button class="btn btn-ghost" onclick="showFormatGuide()">Format Guide</button>
      </div>
      <div id="ops-format-tools" class="ops-format-grid"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <h3 style="font-size:14px;font-weight:800">Recent SO Activity</h3>
          <p style="color:var(--text-muted);font-size:12px;margin-top:3px">Last browser-local SO agent records, including blocked and pending-review items.</p>
        </div>
        <button class="btn btn-ghost" onclick="runOpsAction('sales')">Open SO Agent</button>
      </div>
      <div id="ops-recent-so" style="margin-top:10px"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <h3 style="font-size:14px;font-weight:800">Health Checks</h3>
          <p style="color:var(--text-muted);font-size:12px;margin-top:3px">Browser dependencies, storage, integration checks, local state, and optional backend connection.</p>
        </div>
        <div class="ops-actions" style="margin:0">
          <button class="btn btn-ghost" onclick="showIntegrationReport()">Integration Report</button>
          <button class="btn btn-ghost" onclick="copyOpsDiagnostics()">Copy Diagnostics</button>
        </div>
      </div>
      <div id="ops-health-list" class="ops-health-list"></div>
    </div>
  </div>
</div>`;

const storageShim = `window.storage = window.storage || {
  get: async (k) => {
    const v = localStorage.getItem(k);
    return v ? { key: k, value: v } : null;
  },
  set: async (k, v) => {
    localStorage.setItem(k, v);
    return { key: k, value: v };
  },
  delete: async (k) => {
    localStorage.removeItem(k);
    return { key: k, deleted: true };
  },
  list: async (prefix) => ({
    keys: Object.keys(localStorage).filter((k) => !prefix || k.startsWith(prefix)),
  }),
};`;

let soAppSource = soSource
  .replace(/^import\s+\{[^}]+\}\s+from\s+["']react["'];\s*/m, "")
  .replace("export default function App()", "function SOAgentApp()");

function patchSo(search, replacement, label) {
  const next = soAppSource.replace(search, replacement);
  if (next === soAppSource) throw new Error("SO agent patch failed: " + label);
  soAppSource = next;
}

patchSo(
  'const SK_FORMATS  = "so_agent:customer_formats";',
  String.raw`const SK_FORMATS  = "so_agent:customer_formats";
const SK_COST_POLICY = "so_agent:cost_policy";
const SK_RESULT_CACHE = "so_agent:result_cache";
const SK_AUDIT_LOG = "so_agent:audit_log";
const SK_BUDGETS = "so_agent:customer_budgets";

const DEFAULT_COST_POLICY = {
  mode: "realtime",
  promptCache: "5m",
  priceComp: "include",
  usdToInr: 83,
  sonnetInputPerMTok: 3,
  sonnetOutputPerMTok: 15,
  cacheTtlHours: 168,
  defaultMonthlyBudgetUsd: 5,
  dryRunWhenReady: true,
  ocrPdfs: "off",
  ocrMaxPages: 10,
};

const OCR_MODE_META = {
  off: "Off",
  prompt: "Ask before sending PDF",
  always: "OCR every PDF before sending",
};

const COST_MODE_META = {
  realtime: {
    label: "Realtime Accuracy",
    detail: "Use Sonnet immediately with all selected context. Best for one-off or high-value orders.",
  },
  cost_optimized: {
    label: "Cost Optimized",
    detail: "Reuse local results, normalize table files, and use prompt caching for the SO prompt.",
  },
  batch_candidate: {
    label: "Backend Batch Candidate",
    detail: "Flag the order for backend async processing when turnaround time is flexible.",
  },
};

const PRICE_COMP_META = {
  include: "Include when uploaded",
  warn: "Warn before including",
  skip: "Skip unless needed",
};

const PROMPT_CACHE_META = {
  off: "Off",
  "5m": "5 minute",
  "1h": "1 hour backend",
};

const AUDIT_MAX_ENTRIES = 500;
const TEMPLATE_VERSION = 1;
const SCHEMA_VERSION = 3;
const PROMPT_VERSION = "v4-2026-05";
const RULES_VERSION = "v1-2026-05";
const SK_SCHEMA = "so_agent:schema_version";
const SK_LEARNED_RULES = "so_agent:learned_rules";

const EXCEPTION_PLAYBOOKS = {
  WRONG_VENDOR: {
    actions: [
      { id: "block_and_reject", label: "Block and draft rejection email", autoFix: false },
    ],
    emailTemplate: "Subject: PO not addressed to Obara India Pvt Ltd\\nHi {{contact}},\\n\\nThe PO {{poNumber}} you sent is addressed to a different vendor. Could you please share a corrected PO addressed to Obara India Pvt Ltd (GSTIN 27AAACO8335K1Z5)?\\n\\nThanks,\\n{{senderName}}",
  },
  QUOTE_MISMATCH: {
    actions: [
      { id: "request_correct_quote", label: "Ask customer to confirm quote reference", autoFix: false },
      { id: "remap_lines", label: "Remap line items in reconciliation grid", autoFix: false },
    ],
    emailTemplate: "Subject: Quote-PO mismatch on {{poNumber}}\\nHi {{contact}},\\n\\nWe could not match all line items on PO {{poNumber}} to a current quote. Could you confirm the quote reference, or share the missing items so we can re-quote?\\n\\nThanks,\\n{{senderName}}",
  },
  PRICE_MISMATCH: {
    actions: [
      { id: "use_quote_price", label: "Use quoted price (default)", autoFix: true },
      { id: "use_po_price", label: "Use PO price (manager approval)", autoFix: false },
      { id: "request_clarification", label: "Email customer for clarification", autoFix: false },
    ],
    emailTemplate: "Subject: Price difference on PO {{poNumber}}\\nHi {{contact}},\\n\\nPO {{poNumber}} shows a different price for one or more items than our current quote. Lines: {{lineSummary}}. Should we proceed at the PO price or update the SO to the quoted price?\\n\\nThanks,\\n{{senderName}}",
  },
  QTY_EXCEEDS_QUOTE: {
    actions: [
      { id: "request_revised_quote", label: "Ask customer to align quantity or request revised quote", autoFix: false },
      { id: "manager_override", label: "Manager approves expanded quantity", autoFix: false },
    ],
    emailTemplate: "Subject: Quantity expansion on PO {{poNumber}}\\nHi {{contact}},\\n\\nPO {{poNumber}} requests {{poQty}} units of {{partNo}}. Our quote covered {{quoteQty}}. Could you confirm we should proceed with the expanded quantity?\\n\\nThanks,\\n{{senderName}}",
  },
  MISSING_HSN: {
    actions: [
      { id: "fill_from_quote", label: "Fill HSN from quote", autoFix: true },
      { id: "fill_from_master", label: "Fill HSN from Tally master", autoFix: true },
    ],
    emailTemplate: "",
  },
  GST_INCLUSIVE_PO: {
    actions: [
      { id: "convert_to_exclusive", label: "Convert to GST-exclusive base rate", autoFix: true },
    ],
    emailTemplate: "",
  },
  TAX_TYPE_MISMATCH: {
    actions: [
      { id: "switch_tax_type", label: "Switch CGST/SGST <-> IGST based on ship-to state", autoFix: true },
    ],
    emailTemplate: "",
  },
  STALE_QUOTE: {
    actions: [
      { id: "request_revalidation", label: "Email customer to confirm quote still valid", autoFix: false },
    ],
    emailTemplate: "Subject: Quote validity check for PO {{poNumber}}\\nHi {{contact}},\\n\\nThe quote referenced in PO {{poNumber}} is older than our standard validity. Could you confirm the price still stands or share an updated requirement?\\n\\nThanks,\\n{{senderName}}",
  },
  SOURCE_UNKNOWN: {
    actions: [
      { id: "upload_price_comp", label: "Upload price composition", autoFix: false },
      { id: "engineer_override", label: "Use engineer override note", autoFix: false },
    ],
    emailTemplate: "",
  },
  LOW_MARGIN: {
    actions: [
      { id: "request_margin_exception", label: "Request manager margin exception approval", autoFix: false },
      { id: "revise_pricing", label: "Revise selling price", autoFix: false },
    ],
    emailTemplate: "",
  },
  DUPLICATE_PO: {
    actions: [
      { id: "open_existing_so", label: "Open existing SO from history", autoFix: false },
      { id: "treat_as_revision", label: "Treat as PO revision", autoFix: false },
    ],
    emailTemplate: "Subject: Duplicate PO {{poNumber}}\\nHi {{contact}},\\n\\nWe already have PO {{poNumber}} on file. Could you confirm whether this is a duplicate or a revised version?\\n\\nThanks,\\n{{senderName}}",
  },
};

const ISSUE_TAXONOMY = {
  WRONG_VENDOR:           { severity:"CRITICAL", owner:"sales_engineer", blocks:true,  fix:"Reject and request corrected PO addressed to Obara India" },
  WRONG_QUOTE_SOURCE:     { severity:"CRITICAL", owner:"sales_engineer", blocks:true,  fix:"Replace quote with Obara-issued quote" },
  QUOTE_MISMATCH:         { severity:"CRITICAL", owner:"sales_engineer", blocks:true,  fix:"Match PO to correct quote or request requote" },
  PO_ONLY_ITEM:           { severity:"CRITICAL", owner:"sales_engineer", blocks:false, fix:"Map PO item to a quoted item or request a quote line" },
  PRICE_MISMATCH:         { severity:"CRITICAL", owner:"sales_manager",  blocks:false, fix:"Confirm price with customer or update SO rate" },
  QTY_EXCEEDS_QUOTE:      { severity:"CRITICAL", owner:"sales_manager",  blocks:false, fix:"Approve quantity expansion or request revised quote" },
  MISSING_HSN:            { severity:"WARNING",  owner:"sales_engineer", blocks:false, fix:"Pull HSN from quote or Tally master before export" },
  GST_INCLUSIVE_PO:       { severity:"WARNING",  owner:"sales_engineer", blocks:false, fix:"Convert PO price to GST-exclusive base before SO" },
  PAYMENT_TERMS_MISMATCH: { severity:"WARNING",  owner:"sales_manager",  blocks:false, fix:"Document accepted terms or escalate" },
  DELIVERY_TOO_EARLY:     { severity:"WARNING",  owner:"procurement",    blocks:false, fix:"Confirm feasibility or request revised dates" },
  PENALTY_CLAUSE_PRESENT: { severity:"WARNING",  owner:"sales_manager",  blocks:false, fix:"Acknowledge penalty terms with customer" },
  WARRANTY_MISMATCH:      { severity:"WARNING",  owner:"sales_manager",  blocks:false, fix:"Reconcile warranty terms" },
  SOURCE_UNKNOWN:         { severity:"WARNING",  owner:"procurement",    blocks:false, fix:"Provide price comp or engineer override" },
  MISSING_LANDED_COST:    { severity:"WARNING",  owner:"finance",        blocks:false, fix:"Upload price composition for accurate cost" },
  LOW_MARGIN:             { severity:"CRITICAL", owner:"sales_manager",  blocks:false, fix:"Approve margin exception or revise pricing" },
  DUPLICATE_PO:           { severity:"CRITICAL", owner:"sales_engineer", blocks:true,  fix:"Confirm duplicate or resolve PO number conflict" },
  POSSIBLE_REVISION:      { severity:"WARNING",  owner:"sales_engineer", blocks:false, fix:"Treat as PO amendment or new PO" },
  GSTIN_FORMAT_INVALID:   { severity:"WARNING",  owner:"sales_engineer", blocks:false, fix:"Verify and correct GSTIN" },
  TAX_TYPE_MISMATCH:      { severity:"CRITICAL", owner:"finance",        blocks:false, fix:"Switch CGST/SGST to IGST or vice versa based on state" },
  STALE_QUOTE:            { severity:"WARNING",  owner:"sales_manager",  blocks:false, fix:"Re-quote or get customer reconfirmation" },
  STALE_PO:               { severity:"WARNING",  owner:"sales_engineer", blocks:false, fix:"Confirm PO still active" },
  AMOUNT_RECONCILIATION:  { severity:"WARNING",  owner:"sales_engineer", blocks:false, fix:"Reconcile line totals with grand total" },
};`,
  "cost policy constants",
);

patchSo(
  /const fileToBase64 = \(file\) => new Promise\(\(res, rej\) => \{[\s\S]*?\n\}\);\n/,
  String.raw`const fileToBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result.split(",")[1]);
  r.onerror = rej;
  r.readAsDataURL(file);
});

const fileToArrayBuffer = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsArrayBuffer(file);
});

const fileToText = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result || ""));
  r.onerror = rej;
  r.readAsText(file);
});

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const sha256Hex = async (buffer) => {
  if (crypto && crypto.subtle && crypto.subtle.digest) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 2166136261;
  const bytes = new Uint8Array(buffer);
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619);
  }
  return "fallback-" + (h >>> 0).toString(16);
};

const extOf = (file) => {
  const m = String(file && file.name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
};

const normalizedMime = (file, ext) => {
  const mime = String(file && file.type || "").trim();
  if (mime) return mime;
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "csv") return "text/csv";
  if (ext === "tsv") return "text/tab-separated-values";
  if (ext === "txt") return "text/plain";
  if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === "xls") return "application/vnd.ms-excel";
  return "application/octet-stream";
};

const isPdfFile = (file, ext, mime) => ext === "pdf" || mime === "application/pdf";
const isImageFile = (file, ext, mime) => mime.startsWith("image/") || ["png", "jpg", "jpeg", "webp"].includes(ext);
const isExcelFile = (file, ext, mime) => ["xlsx", "xls"].includes(ext) || mime.includes("spreadsheet") || mime.includes("excel");
const isDelimitedFile = (file, ext, mime) => ["csv", "tsv"].includes(ext) || mime.includes("csv") || mime.includes("tab-separated");
const isPlainTextFile = (file, ext, mime) => ext === "txt" || mime.startsWith("text/");

const cleanCell = (v) => String(v == null ? "" : v).replace(/[\t\r\n]+/g, " ").trim();

const rowsToCompactTsv = (rows, maxRows = 650, maxCols = 30) => {
  const useful = (rows || [])
    .map((row) => (row || []).slice(0, maxCols).map(cleanCell))
    .filter((row) => row.some(Boolean));
  const clipped = useful.slice(0, maxRows);
  return {
    text: clipped.map((row) => row.join("\t")).join("\n"),
    rowCount: useful.length,
    rowsIncluded: clipped.length,
    colCount: Math.max(0, ...clipped.map((row) => row.length)),
    truncated: useful.length > clipped.length,
  };
};

const workbookToTextBlock = (workbook, label, fileName) => {
  let bestName = workbook.SheetNames[0];
  let bestRows = [];
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header:1, defval:"", raw:false });
    const useful = rows.filter((row) => (row || []).some((cell) => cleanCell(cell)));
    if (useful.length > bestRows.length) {
      bestName = name;
      bestRows = rows;
    }
  }
  const compact = rowsToCompactTsv(bestRows);
  const header = [
    label,
    "File: " + fileName,
    "Sheet: " + (bestName || "Sheet1"),
    "Rows included: " + compact.rowsIncluded + " of " + compact.rowCount,
    "Columns included: " + compact.colCount,
    compact.truncated ? "Note: table was truncated to reduce token usage." : "",
  ].filter(Boolean).join("\n");
  return { text: header + "\n\n" + compact.text, sheetName: bestName || "Sheet1", ...compact };
};

const compactPlainText = (label, fileName, text) => {
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const maxChars = 90000;
  const clipped = normalized.length > maxChars ? normalized.slice(0, maxChars) + "\n[Truncated for token control]" : normalized;
  return [
    label,
    "File: " + fileName,
    "Characters included: " + clipped.length + " of " + normalized.length,
    "",
    clipped,
  ].join("\n");
};

const fileToClaudeContentBlocks = async (file, label, options) => {
  if (!file) return null;
  const opts = options || {};
  const ext = extOf(file);
  const mime = normalizedMime(file, ext);
  const buffer = await fileToArrayBuffer(file);
  const base64 = arrayBufferToBase64(buffer);
  const sha = await sha256Hex(buffer);
  const meta = {
    label,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified || 0,
    mime,
    ext,
    sha256: sha,
    mode: "raw",
    converted: false,
  };

  if (isPdfFile(file, ext, mime)) {
    let ocrText = opts.ocrText;
    if (!ocrText && opts.ocrPolicy === "always") {
      try {
        const ocrResult = await pdfToOcrText(file, { maxPages: Number(opts.ocrMaxPages || 10) });
        if (ocrResult && ocrResult.text && ocrResult.text.length > 80) ocrText = ocrResult.text;
      } catch (err) {
        if (typeof console !== "undefined") console.warn("Auto-OCR failed for " + label + ":", err.message);
      }
    }
    if (ocrText && ocrText.length > 80) {
      const header = label + "\nFile: " + file.name + " (OCR text, original PDF available on request)";
      return {
        blocks: [{ type:"text", text: header + "\n\n" + ocrText.slice(0, 90000) + (ocrText.length > 90000 ? "\n[OCR text truncated]" : "") }],
        meta: { ...meta, kind:"pdf", mode:"ocr_text", converted:true, charCount: ocrText.length, truncated: ocrText.length > 90000 },
        base64,
      };
    }
    return {
      blocks: [
        { type:"text", text: label + "\nFile: " + file.name },
        { type:"document", source:{ type:"base64", media_type:"application/pdf", data:base64 } },
      ],
      meta: { ...meta, kind:"pdf" },
      base64,
    };
  }

  if (isImageFile(file, ext, mime)) {
    return {
      blocks: [
        { type:"text", text: label + "\nFile: " + file.name },
        { type:"image", source:{ type:"base64", media_type:mime, data:base64 } },
      ],
      meta: { ...meta, kind:"image" },
      base64,
    };
  }

  if (isExcelFile(file, ext, mime)) {
    if (!window.XLSX) throw new Error("XLSX parser is not loaded. Reload the app before processing Excel files.");
    const workbook = XLSX.read(buffer, { type:"array", raw:false, cellDates:false });
    const block = workbookToTextBlock(workbook, label, file.name);
    return {
      blocks: [{ type:"text", text:block.text }],
      meta: {
        ...meta,
        kind:"table",
        mode:"text",
        converted:true,
        sheetName:block.sheetName,
        rowCount:block.rowCount,
        rowsIncluded:block.rowsIncluded,
        colCount:block.colCount,
        charCount:block.text.length,
        truncated:block.truncated,
      },
      base64,
    };
  }

  if (isDelimitedFile(file, ext, mime) && window.XLSX) {
    const text = await fileToText(file);
    const workbook = XLSX.read(text, { type:"string", raw:false, FS: ext === "tsv" ? "\t" : undefined });
    const block = workbookToTextBlock(workbook, label, file.name);
    return {
      blocks: [{ type:"text", text:block.text }],
      meta: {
        ...meta,
        kind:"table",
        mode:"text",
        converted:true,
        sheetName:block.sheetName,
        rowCount:block.rowCount,
        rowsIncluded:block.rowsIncluded,
        colCount:block.colCount,
        charCount:block.text.length,
        truncated:block.truncated,
      },
      base64,
    };
  }

  if (isPlainTextFile(file, ext, mime)) {
    const text = await fileToText(file);
    const blockText = compactPlainText(label, file.name, text);
    return {
      blocks: [{ type:"text", text:blockText }],
      meta: {
        ...meta,
        kind:"text",
        mode:"text",
        converted:true,
        charCount:blockText.length,
        truncated:text.length > 90000,
      },
      base64,
    };
  }

  throw new Error("Unsupported file type for " + label + ": " + file.name + ". Use PDF, image, Excel, CSV, TSV, or TXT.");
};

const buildDocumentFingerprint = (metas) => (metas || [])
  .filter(Boolean)
  .map((m) => [m.label, m.name, m.size, m.lastModified, m.sha256].join(":"))
  .join("|");

const poNumberFromOrder = (o) => String(
  (o && o.preflightPONumber) ||
  (o && o.result && o.result.po && o.result.po.number) ||
  ""
).trim();

const findOrderByPoHint = (orders, hint) => {
  const h = String(hint || "").trim().toUpperCase();
  if (!h) return null;
  return (orders || []).find((o) => poNumberFromOrder(o).toUpperCase() === h && o.status !== "BLOCKED") || null;
};

`,
  "document normalization helpers",
);

patchSo(
  /const callClaude = async \(systemPrompt, docs\) => \{[\s\S]*?\n\};\n\n\/\/ ─── STORAGE/,
  String.raw`const normalizeCostPolicy = (policy) => ({ ...DEFAULT_COST_POLICY, ...(policy || {}) });

const systemBlocksForPolicy = (staticPrompt, formatCtx, policy) => {
  const p = normalizeCostPolicy(policy);
  const blocks = [{ type:"text", text:staticPrompt }];
  if (p.promptCache !== "off") {
    blocks[0] = {
      ...blocks[0],
      cache_control: p.promptCache === "1h"
        ? { type:"ephemeral", ttl:"1h" }
        : { type:"ephemeral" },
    };
  }
  if (formatCtx) blocks.push({ type:"text", text:formatCtx });
  return blocks;
};

const attachClaudeMeta = (parsed, data) => {
  if (parsed && typeof parsed === "object") {
    parsed._apiUsage = data.usage || null;
    parsed._stopReason = data.stop_reason || null;
  }
  return parsed;
};

const parseClaudeJson = (data) => {
  const raw = (data.content || []).map((c) => c.text || "").join("");
  const cleaned = raw.replace(/\`\`\`json|\`\`\`/g, "").trim();

  try { return attachClaudeMeta(JSON.parse(cleaned), data); } catch (_) {}

  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try { return attachClaudeMeta(JSON.parse(cleaned.slice(start, end + 1)), data); } catch (_) {}
  }

  const fixTruncated = (s) => {
    let depth = 0, inStr = false, esc = false, lastValid = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (esc)          { esc = false; continue; }
      if (inStr)        { if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
      if (c === "\"")   { inStr = true; continue; }
      if (c === "{" || c === "[") { depth++; }
      if (c === "}" || c === "]") { depth--; }
      if (depth > 0)    { lastValid = i; }
    }
    let fragment = s.slice(0, lastValid + 1);
    let trimEnd = fragment.length - 1;
    while (trimEnd >= 0 && (fragment[trimEnd] === " " || fragment[trimEnd] === "\n" || fragment[trimEnd] === "\r")) trimEnd--;
    if (fragment[trimEnd] === ",") fragment = fragment.slice(0, trimEnd);
    const lastComma = fragment.lastIndexOf(",");
    const lastQuote = fragment.lastIndexOf("\"");
    if (lastComma > 0 && lastQuote > lastComma) {
      const afterComma = fragment.slice(lastComma + 1).trim();
      const quoteCount = (afterComma.match(/"/g) || []).length;
      if (quoteCount % 2 !== 0) fragment = fragment.slice(0, lastComma);
    }
    let od = 0, oa = 0, ins = false, es = false;
    for (const c of fragment) {
      if (es)         { es = false; continue; }
      if (ins)        { if (c === "\\") es = true; else if (c === "\"") ins = false; continue; }
      if (c === "\"") { ins = true; continue; }
      if (c === "{")  od++;
      if (c === "}")  od--;
      if (c === "[")  oa++;
      if (c === "]")  oa--;
    }
    return fragment + "]".repeat(Math.max(0, oa)) + "}".repeat(Math.max(0, od));
  };

  try {
    const recovered = fixTruncated(cleaned.slice(start));
    const parsed = JSON.parse(recovered);
    parsed._truncated = true;
    return attachClaudeMeta(parsed, data);
  } catch (_) {}

  throw new Error("Could not parse AI response as JSON. Raw response: " + cleaned.slice(0, 200));
};

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

const callClaude = async (systemPrompt, docs, options = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (options.cacheTtl === "1h") headers["anthropic-beta"] = "extended-cache-ttl-2025-04-11";
  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: "user", content: [...docs, { type: "text", text: "Return JSON only. Ensure the JSON is complete and valid. Do not truncate." }] }],
  });
  const maxAttempts = Number(options.maxAttempts || 3);
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body });
    } catch (networkErr) {
      lastErr = new Error("Network error contacting Claude: " + (networkErr && networkErr.message || networkErr));
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, Math.min(8000, 600 * Math.pow(2, attempt - 1))));
        continue;
      }
      throw lastErr;
    }
    if (RETRYABLE_STATUSES.has(resp.status) && attempt < maxAttempts) {
      const retryAfterHdr = Number(resp.headers && resp.headers.get && resp.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfterHdr) && retryAfterHdr > 0
        ? retryAfterHdr * 1000
        : Math.min(8000, 600 * Math.pow(2, attempt - 1));
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    let data;
    try { data = await resp.json(); }
    catch (_) {
      lastErr = new Error("Claude returned a non-JSON response (status " + resp.status + ")");
      if (attempt < maxAttempts) continue;
      throw lastErr;
    }
    if (data && data.error) {
      const msg = (data.error.message || "Claude API error") + (data.error.type ? " (" + data.error.type + ")" : "");
      if (data.error.type === "overloaded_error" && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, Math.min(8000, 600 * Math.pow(2, attempt - 1))));
        continue;
      }
      throw new Error(msg);
    }
    if (data && data.stop_reason === "max_tokens") {
      throw new Error("Response was cut off. Split the PO into smaller batches or remove price composition.");
    }
    return parseClaudeJson(data);
  }
  throw lastErr || new Error("Claude call failed after " + maxAttempts + " attempts");
};

// ─── STORAGE`,
  "Claude call wrapper",
);

patchSo(
  `const loadMetrics   = async () => (await sGet(SK_METRICS)) || emptyMetrics();
const saveMetrics   = (m) => sSet(SK_METRICS, m);`,
  String.raw`const loadMetrics   = async () => (await sGet(SK_METRICS)) || emptyMetrics();
const saveMetrics   = (m) => sSet(SK_METRICS, m);
const loadCostPolicy = async () => normalizeCostPolicy(await sGet(SK_COST_POLICY));
const saveCostPolicy = (p) => sSet(SK_COST_POLICY, normalizeCostPolicy(p));
const loadResultCache = async () => (await sGet(SK_RESULT_CACHE)) || {};
const saveResultCache = (c) => sSet(SK_RESULT_CACHE, c);
const loadAuditLog = async () => (await sGet(SK_AUDIT_LOG)) || [];
const saveAuditLog = (l) => sSet(SK_AUDIT_LOG, (l || []).slice(0, AUDIT_MAX_ENTRIES));
const loadBudgets = async () => (await sGet(SK_BUDGETS)) || {};
const saveBudgets = (b) => sSet(SK_BUDGETS, b);

const recordAudit = async (action, detail, refId) => {
  const log = await loadAuditLog();
  log.unshift({ at: nowISO(), action, detail: detail || "", refId: refId || null });
  await saveAuditLog(log);
};

const monthKey = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
};

const cacheKeyFor = (fingerprint, versions) => {
  const v = versions || {};
  const parts = [
    "fp:" + fingerprint,
    "p:" + (v.prompt || PROMPT_VERSION),
    "s:" + (v.schema || SCHEMA_VERSION),
    "r:" + (v.rules || RULES_VERSION),
    "c:" + (v.customer || "0"),
  ];
  return parts.join("|");
};

const matchCacheEntry = (cache, fingerprint, versions) => {
  if (!fingerprint) return null;
  const exact = cache[cacheKeyFor(fingerprint, versions)];
  if (exact) return { entry: exact, status: "exact" };
  const prefix = "fp:" + fingerprint + "|";
  const stale = Object.entries(cache).find(([key]) => key.startsWith(prefix));
  if (stale) return { entry: stale[1], status: "stale_versions", staleKey: stale[0] };
  return null;
};

const lookupCachedResult = async (fingerprint, ttlHours, versions) => {
  if (!fingerprint) return null;
  const cache = await loadResultCache();
  const matched = matchCacheEntry(cache, fingerprint, versions);
  if (!matched || matched.status !== "exact") return null;
  const entry = matched.entry;
  const ttlMs = Number(ttlHours || 168) * 3600 * 1000;
  const age = Date.now() - new Date(entry.savedAt).getTime();
  if (age > ttlMs) return null;
  return { ...entry, ageHours: Math.round(age / 3600000) };
};

const inspectCacheEntry = async (fingerprint, versions) => {
  if (!fingerprint) return null;
  const cache = await loadResultCache();
  return matchCacheEntry(cache, fingerprint, versions);
};

const storeCachedResult = async (fingerprint, payload, versions) => {
  if (!fingerprint) return;
  const cache = await loadResultCache();
  const key = cacheKeyFor(fingerprint, versions);
  cache[key] = {
    savedAt: nowISO(),
    customerKey: payload.customerKey || "",
    customerName: payload.customerName || "",
    poNumber: payload.poNumber || "",
    result: payload.result || null,
    apiUsage: payload.apiUsage || null,
    versions: {
      prompt: PROMPT_VERSION,
      schema: SCHEMA_VERSION,
      rules: RULES_VERSION,
      customer: (versions && versions.customer) || "0",
    },
  };
  const entries = Object.entries(cache);
  if (entries.length > 200) {
    entries.sort((a, b) => new Date(b[1].savedAt).getTime() - new Date(a[1].savedAt).getTime());
    const trimmed = {};
    entries.slice(0, 200).forEach(([k, v]) => { trimmed[k] = v; });
    await saveResultCache(trimmed);
  } else {
    await saveResultCache(cache);
  }
};

const clearCachedResult = async (fingerprint, versions) => {
  if (!fingerprint) return;
  const cache = await loadResultCache();
  delete cache[cacheKeyFor(fingerprint, versions)];
  await saveResultCache(cache);
};

const customerSpendThisMonth = (orders, customerKey, policy) => {
  const month = monthKey();
  const p = normalizeCostPolicy(policy);
  return (orders || [])
    .filter((o) => {
      if (!o || !o.customerKey || o.customerKey !== customerKey) return false;
      return monthKey(o.createdAt) === month;
    })
    .reduce((sum, o) => sum + (estimateApiCost(o.apiUsage, p).usd || 0), 0);
};

const customerStats = (orders, customerKey) => {
  const rows = (orders || []).filter((o) => o && o.customerKey === customerKey && o.result);
  if (!rows.length) return null;
  const totals = rows.map((o) => Number(o.result && o.result.salesOrder && o.result.salesOrder.grandTotal || 0)).filter(Boolean);
  const lineCounts = rows.map((o) => Array.isArray(o.result && o.result.salesOrder && o.result.salesOrder.lineItems) ? o.result.salesOrder.lineItems.length : 0).filter(Boolean);
  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const std = (arr) => {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
  };
  return {
    sample: rows.length,
    totalMean: mean(totals),
    totalStd: std(totals),
    lineCountMean: mean(lineCounts),
    lineCountStd: std(lineCounts),
  };
};

const detectAnomalies = (order, stats) => {
  if (!stats || stats.sample < 2 || !order || !order.result) return [];
  const flags = [];
  const total = Number(order.result.salesOrder && order.result.salesOrder.grandTotal || 0);
  const lineCount = Array.isArray(order.result.salesOrder && order.result.salesOrder.lineItems)
    ? order.result.salesOrder.lineItems.length : 0;
  const z = (v, mean, std) => (std > 0 ? (v - mean) / std : 0);
  const tz = z(total, stats.totalMean, stats.totalStd);
  if (Math.abs(tz) > 2) {
    flags.push({
      key: "grand_total",
      severity: Math.abs(tz) > 3 ? "high" : "medium",
      label: "Order value " + (tz > 0 ? "above" : "below") + " typical (" + Math.abs(tz).toFixed(1) + " SD)",
      detail: "This customer averages " + Math.round(stats.totalMean).toLocaleString("en-IN") + " INR per order. This one is " + Math.round(total).toLocaleString("en-IN") + ".",
    });
  }
  const lz = z(lineCount, stats.lineCountMean, stats.lineCountStd);
  if (Math.abs(lz) > 2 && stats.lineCountMean > 0) {
    flags.push({
      key: "line_count",
      severity: "low",
      label: "Line count " + (lz > 0 ? "above" : "below") + " typical",
      detail: "Average is " + stats.lineCountMean.toFixed(1) + " lines. This order has " + lineCount + ".",
    });
  }
  return flags;
};

const buildExtractionTemplate = (profile, recentOrders) => {
  const fp = profile && profile.fingerprint || {};
  const recentResult = (recentOrders || [])
    .filter((o) => o && o.customerKey === profile.customerKey && o.result && o.result.po)
    .slice(0, 1)[0];
  return {
    version: TEMPLATE_VERSION,
    customerKey: profile.customerKey,
    customerName: profile.customerName,
    customerGSTIN: profile.customerGSTIN || "",
    documentType: fp.documentType || "pdf_text",
    layout: fp.layout || "table",
    poNumberLabel: fp.poNumberLabel || "PO No",
    dateLabel: fp.dateLabel || "Date",
    lineItemPattern: fp.lineItemPattern || "table_rows",
    sampleResult: recentResult ? recentResult.result : null,
    confidenceHint: profile.ordersProcessed >= 3 ? "high" : "medium",
    generatedAt: nowISO(),
  };
};

const SAMPLE_DEMO_ORDERS = [
  {
    id: "demo_order_1",
    status: "APPROVED",
    customerKey: "27aaacxxxx_demo_customer",
    preflightPONumber: "DEMO-PO-12345",
    preflightCustomer: "Demo Industries Pvt Ltd",
    docFingerprint: "demo|po.pdf|123456|0|demohash",
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    apiUsage: { generation: { input_tokens: 8200, output_tokens: 3400 }, preflight: { input_tokens: 4100, output_tokens: 380 } },
    tokenEstimate: { totalInput: 12300, call2Output: 3400, outputRisk: 0.2 },
    result: {
      po: { number: "DEMO-PO-12345", date: "2026-04-12", customer: "Demo Industries Pvt Ltd" },
      salesOrder: {
        grandTotal: 248500,
        lineItems: [
          { description: "Cap Tip CT-16-A", quantity: 200, unitPrice: 425, amount: 85000 },
          { description: "Back Tip BT-24-S", quantity: 150, unitPrice: 580, amount: 87000 },
          { description: "Electrode 12mm", quantity: 80, unitPrice: 950, amount: 76000 },
        ],
      },
      tallySalesOrder: { totalValue: 248500, lineItems: [1, 2, 3] },
    },
  },
];

const SAMPLE_DEMO_PROFILE = {
  customerKey: "27aaacxxxx_demo_customer",
  customerName: "Demo Industries Pvt Ltd",
  customerGSTIN: "27AAACDEMO1Z5",
  firstSeen: new Date(Date.now() - 86400000 * 30).toISOString(),
  lastUpdated: new Date(Date.now() - 86400000 * 3).toISOString(),
  ordersProcessed: 4,
  lastFormatChanged: false,
  formatChangeSummary: "",
  fingerprint: {
    documentType: "pdf_text",
    layout: "table",
    poNumberLabel: "PO No.",
    dateLabel: "Date",
    lineItemPattern: "table_rows",
    headerKeywords: ["Description", "Part No", "Qty", "Rate", "Amount"],
  },
  trusted: true,
};

const seedDemoData = async () => {
  const formats = await loadFormats();
  if (!formats[SAMPLE_DEMO_PROFILE.customerKey]) {
    formats[SAMPLE_DEMO_PROFILE.customerKey] = SAMPLE_DEMO_PROFILE;
    await saveFormats(formats);
  }
  const orders = await loadOrders();
  const hasDemo = (orders || []).some((o) => o && o.id === "demo_order_1");
  if (!hasDemo) {
    const next = [...SAMPLE_DEMO_ORDERS, ...orders];
    await sSet(SK_ORDERS, next);
  }
  await recordAudit("seed_demo", "Loaded demo customer profile and sample order", "demo_order_1");
  return SAMPLE_DEMO_PROFILE;
};

const clearDemoData = async () => {
  const formats = await loadFormats();
  if (formats[SAMPLE_DEMO_PROFILE.customerKey]) {
    delete formats[SAMPLE_DEMO_PROFILE.customerKey];
    await saveFormats(formats);
  }
  const orders = await loadOrders();
  const next = (orders || []).filter((o) => !(o && String(o.id || "").startsWith("demo_")));
  await sSet(SK_ORDERS, next);
  await recordAudit("clear_demo", "Removed demo customer profile and sample order", null);
};

const PDFJS_VERSION = "3.11.174";
let pdfjsPromise = null;
const loadPdfJs = () => {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/pdfjs-dist@" + PDFJS_VERSION + "/build/pdf.min.js";
    s.onload = () => {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@" + PDFJS_VERSION + "/build/pdf.worker.min.js";
      } catch (_) {}
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error("Failed to load PDF.js from CDN"));
    document.head.appendChild(s);
  });
  return pdfjsPromise;
};

const extractPdfStructure = async (file, options) => {
  const pdfjsLib = await loadPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const maxPages = Math.min(pdf.numPages, Number(options && options.maxPages) || 5);
  const pages = [];
  for (let p = 1; p <= maxPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = (tc.items || []).map((it) => {
      const t = it.transform || [1, 0, 0, 1, 0, 0];
      return { str: String(it.str || ""), x: t[4], y: t[5], width: it.width || 0, height: it.height || 0 };
    });
    pages.push({ index: p, items, width: viewport.width, height: viewport.height });
  }
  await pdf.destroy();
  return { pages, totalPages: pdf.numPages };
};

const groupItemsToLines = (items, ySlop) => {
  const slop = ySlop || 3;
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - item.y) <= slop) {
      last.items.push(item);
      last.y = (last.y * last.items.length + item.y) / (last.items.length + 1);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }
  lines.forEach((line) => line.items.sort((a, b) => a.x - b.x));
  lines.forEach((line) => { line.text = line.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim(); });
  return lines.filter((l) => l.text);
};

const escapeRegexChars = (s) => String(s || "").split("").map((c) => /[a-z0-9 ]/i.test(c) ? c : "\\" + c).join("");

const findValueAfterLabel = (lines, labelPattern) => {
  const re = labelPattern instanceof RegExp ? labelPattern : new RegExp(escapeRegexChars(labelPattern), "i");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.text.match(re);
    if (m) {
      const tail = line.text.slice(m.index + m[0].length).replace(/^[\s:.\-#]*/, "").trim();
      if (tail) return tail;
      const next = lines[i + 1];
      if (next && next.text) return next.text;
    }
  }
  return "";
};

const detectHeaderRow = (lines, keywords) => {
  const lower = (keywords || []).map((k) => String(k || "").toLowerCase());
  if (!lower.length) return -1;
  let bestIndex = -1;
  let bestHits = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text.toLowerCase();
    const hits = lower.reduce((s, kw) => s + (kw && text.includes(kw) ? 1 : 0), 0);
    if (hits > bestHits && hits >= Math.min(2, lower.length)) {
      bestHits = hits;
      bestIndex = i;
    }
  }
  return bestIndex;
};

const lineItemsFromHeader = (lines, headerIndex, columnHeaders) => {
  if (headerIndex < 0) return [];
  const header = lines[headerIndex];
  const columns = (columnHeaders || []).map((label) => {
    const match = header.items.find((it) => it.str.toLowerCase().includes(String(label || "").toLowerCase()));
    return match ? { label, x: match.x } : null;
  }).filter(Boolean);
  if (columns.length < 2) return [];
  const items = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^(grand\s*total|sub\s*total|total|amount\s*in\s*words|terms|signature|continued)/i.test(line.text)) break;
    if (!line.items.length) continue;
    const row = {};
    columns.forEach((col, idx) => {
      const next = columns[idx + 1];
      const fieldItems = line.items.filter((it) => it.x >= col.x - 6 && (next ? it.x < next.x - 4 : true));
      row[col.label] = fieldItems.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
    });
    if (Object.values(row).some(Boolean)) items.push(row);
  }
  return items;
};

const parseNumeric = (s) => {
  if (s == null) return null;
  const cleaned = String(s).replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
};

let tesseractPromise = null;
const loadTesseractClient = () => {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractPromise) return tesseractPromise;
  tesseractPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error("Failed to load Tesseract.js from CDN"));
    document.head.appendChild(s);
  });
  return tesseractPromise;
};

const renderPdfPagesToImages = async (file, opts) => {
  const pdfjsLib = await loadPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const maxPages = Math.min(pdf.numPages, Number(opts && opts.maxPages) || 10);
  const scale = Number(opts && opts.scale) || 2;
  const blobs = [];
  for (let p = 1; p <= maxPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (blob) blobs.push({ page: p, blob });
  }
  await pdf.destroy();
  return blobs;
};

const pdfToOcrText = async (file, opts) => {
  const Tesseract = await loadTesseractClient();
  const pages = await renderPdfPagesToImages(file, { maxPages: (opts && opts.maxPages) || 10, scale: 2 });
  if (!pages.length) return { text: "", pageCount: 0 };
  const segments = [];
  let pageCount = 0;
  for (const page of pages) {
    try {
      const result = await Tesseract.recognize(page.blob, "eng");
      const txt = (result && result.data && result.data.text) || "";
      if (txt.trim()) {
        segments.push("--- Page " + page.page + " ---\n" + txt.trim());
        pageCount++;
      }
    } catch (err) {
      segments.push("--- Page " + page.page + " (OCR failed: " + err.message + ") ---");
    }
  }
  return { text: segments.join("\n\n"), pageCount };
};

const localExtractFromPdf = async (file, profile) => {
  if (!profile || !profile.fingerprint) {
    return { ok: false, reason: "no_template", confidence: 0, message: "No template available for this customer" };
  }
  const ext = (file && file.name || "").toLowerCase().split(".").pop();
  if (ext !== "pdf") return { ok: false, reason: "not_pdf", confidence: 0, message: "Local extraction only handles digital PDFs" };
  const fp = profile.fingerprint;
  let structure;
  try {
    structure = await extractPdfStructure(file);
  } catch (err) {
    return { ok: false, reason: "pdf_error", confidence: 0, message: "Could not parse PDF: " + err.message };
  }
  const allLines = [];
  structure.pages.forEach((p) => {
    const pageLines = groupItemsToLines(p.items);
    pageLines.forEach((l) => allLines.push({ ...l, page: p.index }));
  });
  const poLabel = fp.poNumberLabel || "PO No";
  const dateLabel = fp.dateLabel || "Date";
  const headerKeywords = fp.headerKeywords && fp.headerKeywords.length ? fp.headerKeywords : ["Description", "Qty", "Rate", "Amount"];
  const poNumber = findValueAfterLabel(allLines, poLabel);
  const dateValue = findValueAfterLabel(allLines, dateLabel);
  const headerIndex = detectHeaderRow(allLines, headerKeywords);
  const rawItems = lineItemsFromHeader(allLines, headerIndex, headerKeywords);
  const lineItems = rawItems.map((row, idx) => {
    const description = row.Description || row.description || row["Item"] || row["Material"] || "";
    const partNo = row["Part No"] || row["Part Number"] || row["Material"] || "";
    const qty = parseNumeric(row.Qty || row.Quantity || row["P.O.Quantity"] || "");
    const rate = parseNumeric(row.Rate || row["Net Pr/Unit"] || row.Price || "");
    const amount = parseNumeric(row.Amount || row.Amt || row.Total || "");
    return {
      sno: idx + 1,
      itemName: description,
      tallyItemName: partNo || description,
      sellerPartNo: partNo,
      hsnCode: row.HSN || row["HSN Code"] || "",
      uom: row.UOM || row.Unit || "Nos",
      qty: qty || 0,
      rate: rate || 0,
      amount: amount != null ? amount : (qty && rate ? round2(qty * rate) : 0),
      cgst: 0, sgst: 0, igst: 0,
      cgstAmt: 0, sgstAmt: 0, igstAmt: 0,
      totalWithGst: amount != null ? amount : (qty && rate ? round2(qty * rate) : 0),
      partNameSource: partNo ? "po_only" : "description_fallback",
      partNameMismatch: false,
      _localExtracted: true,
    };
  });
  const validItems = lineItems.filter((li) => li.qty > 0 && li.rate > 0);
  const itemsScore = validItems.length === 0 ? 0 : Math.min(35, validItems.length * 7 + 15);
  const sumScore = validItems.length > 0 ? (() => {
    const computed = validItems.reduce((s, li) => s + li.qty * li.rate, 0);
    const stated = validItems.reduce((s, li) => s + (Number(li.amount) || 0), 0);
    if (stated === 0) return 5;
    const pct = Math.abs(computed - stated) / stated;
    return pct < 0.02 ? 15 : pct < 0.1 ? 8 : 2;
  })() : 0;
  const confidence = Math.min(100, (poNumber ? 25 : 0) + (dateValue ? 15 : 0) + itemsScore + sumScore + (headerIndex >= 0 ? 10 : 0));
  const so = recomputeSalesOrderTotals({
    voucherType: "Sales Order",
    voucherNo: "SO:" + (poNumber || "DRAFT"),
    date: dateValue || "",
    reference: poNumber || "",
    partyName: profile.customerName || "",
    billTo: { name: profile.customerName || "", gstin: profile.customerGSTIN || "" },
    shipTo: { name: profile.customerName || "", gstin: profile.customerGSTIN || "" },
    lineItems: lineItems.length ? lineItems : [],
  });
  return {
    ok: true,
    confidence,
    poNumber: poNumber || "",
    dateValue: dateValue || "",
    itemsFound: lineItems.length,
    itemsValid: validItems.length,
    salesOrder: so,
    debug: { headerIndex, totalLines: allLines.length, columnsFound: headerIndex >= 0 ? allLines[headerIndex].items.length : 0 },
  };
};

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const STATE_BY_GSTIN_PREFIX = {
  "27":"Maharashtra","29":"Karnataka","33":"Tamil Nadu","36":"Telangana","37":"Andhra Pradesh",
  "06":"Haryana","09":"Uttar Pradesh","07":"Delhi","19":"West Bengal","23":"Madhya Pradesh",
  "24":"Gujarat","32":"Kerala","04":"Chandigarh","08":"Rajasthan","21":"Odisha","20":"Jharkhand",
  "22":"Chhattisgarh","03":"Punjab","02":"Himachal Pradesh","05":"Uttarakhand","10":"Bihar",
  "11":"Sikkim","12":"Arunachal Pradesh","13":"Nagaland","14":"Manipur","15":"Mizoram","16":"Tripura",
  "17":"Meghalaya","18":"Assam","26":"Dadra & Nagar Haveli and Daman & Diu","30":"Goa","31":"Lakshadweep",
  "34":"Puducherry","35":"Andaman & Nicobar","38":"Ladakh",
};

const stateFromGstin = (gstin) => {
  const prefix = String(gstin || "").trim().slice(0, 2);
  return STATE_BY_GSTIN_PREFIX[prefix] || "";
};

// F6 (Phase 1 P0). Originally the hardcoded constant OBARA_STATE =
// "Maharashtra"; assumed a single-tenant deployment and silently
// produced incorrect interstate-vs-intrastate GST classification
// for every non-Maharashtra tenant. Renamed and converted to a
// runtime env read in May 2026; live multi-tenant code reads
// `tally_companies.state_code` + `tenant_settings.einvoice_seller_state_code`
// directly per request and never touches this script. The script
// itself is a v2 archive: no caller in package.json, no caller in
// any deploy workflow. The constant survives as an empty string so
// the two rule hooks below short-circuit safely if the script is
// ever resurrected for a side build.
const SELLER_STATE = (typeof process !== "undefined" && process.env && process.env.TENANT_DEFAULT_STATE) || "";

const sha256OfText = async (text) => {
  if (!text) return "empty";
  const buffer = new TextEncoder().encode(text);
  if (crypto && crypto.subtle && crypto.subtle.digest) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 2166136261;
  for (let i = 0; i < buffer.length; i++) { h ^= buffer[i]; h = Math.imul(h, 16777619); }
  return "fallback-" + (h >>> 0).toString(16);
};

const stableStringify = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
};

const computePayloadHash = async (so) => {
  if (!so) return "";
  const stripped = {
    voucherNo: so.voucherNo,
    date: so.date,
    reference: so.reference,
    partyName: so.partyName,
    billTo: so.billTo,
    shipTo: so.shipTo,
    grandTotal: so.grandTotal,
    subTotal: so.subTotal,
    totalCgst: so.totalCgst,
    totalSgst: so.totalSgst,
    totalIgst: so.totalIgst,
    lineItems: (so.lineItems || []).map((li) => ({
      sno: li.sno,
      tallyItemName: li.tallyItemName || li.itemName,
      hsnCode: li.hsnCode,
      qty: Number(li.qty) || 0,
      rate: Number(li.rate) || 0,
      amount: Number(li.amount) || 0,
      cgstAmt: Number(li.cgstAmt) || 0,
      sgstAmt: Number(li.sgstAmt) || 0,
      igstAmt: Number(li.igstAmt) || 0,
      totalWithGst: Number(li.totalWithGst) || 0,
    })),
  };
  return await sha256OfText(stableStringify(stripped));
};

const VALIDATION_RULES = [
  {
    id: "po_qty_exceeds_quote_qty",
    code: "QTY_EXCEEDS_QUOTE",
    label: "PO quantity exceeds quoted quantity",
    test: (ctx) => {
      const findings = [];
      const lines = (ctx.so && ctx.so.lineItems) || [];
      const quoteLines = (ctx.po && ctx.po.quoteLines) || [];
      lines.forEach((li, idx) => {
        const match = quoteLines.find((q) => (q && q.partNo && q.partNo === li.sellerPartNo) || (q && q.itemName && q.itemName === li.itemName));
        if (match && Number(li.qty) > Number(match.qty || 0)) {
          findings.push({ lineIndex: idx, sno: li.sno, detail: "PO qty " + li.qty + " > Quote qty " + match.qty });
        }
      });
      return findings;
    },
  },
  {
    id: "ship_to_state_tax_type",
    code: "TAX_TYPE_MISMATCH",
    label: "CGST/SGST/IGST does not match ship-to state",
    test: (ctx) => {
      // F6 P0: short-circuit when the seller state is unknown.
      // Previously the rule defaulted to Maharashtra and produced
      // false positives on every Karnataka/Tamil-Nadu/Gujarat
      // tenant; now it refuses to score rather than mis-score.
      if (!SELLER_STATE) return [];
      const shipGstin = (ctx.so && ctx.so.shipTo && ctx.so.shipTo.gstin) || "";
      if (!shipGstin) return [];
      const customerState = stateFromGstin(shipGstin);
      if (!customerState) return [];
      const interstate = customerState !== SELLER_STATE;
      const findings = [];
      ((ctx.so && ctx.so.lineItems) || []).forEach((li, idx) => {
        const hasIgst = Number(li.igstAmt) > 0 || Number(li.igst) > 0;
        const hasCgst = Number(li.cgstAmt) > 0 || Number(li.cgst) > 0;
        if (interstate && hasCgst) findings.push({ lineIndex: idx, sno: li.sno, detail: "Interstate (" + SELLER_STATE + " to " + customerState + ") but CGST applied" });
        if (!interstate && hasIgst) findings.push({ lineIndex: idx, sno: li.sno, detail: "Intrastate " + SELLER_STATE + " but IGST applied" });
      });
      return findings;
    },
  },
  {
    id: "missing_hsn",
    code: "MISSING_HSN",
    label: "HSN code missing on one or more lines",
    test: (ctx) => ((ctx.so && ctx.so.lineItems) || []).map((li, idx) => !li.hsnCode ? { lineIndex: idx, sno: li.sno, detail: "Line " + (li.sno || idx + 1) + " has no HSN" } : null).filter(Boolean),
  },
  {
    id: "amount_reconciliation",
    code: "AMOUNT_RECONCILIATION",
    label: "Line totals differ from grand total beyond tolerance",
    test: (ctx) => {
      const lines = (ctx.so && ctx.so.lineItems) || [];
      const computed = lines.reduce((s, li) => s + (Number(li.totalWithGst) || 0), 0);
      const grand = Number(ctx.so && ctx.so.grandTotal) || 0;
      if (!grand) return [];
      const diff = Math.abs(computed - grand);
      return diff > Math.max(1, grand * 0.005) ? [{ detail: "Line totals " + round2(computed) + " differ from grand " + round2(grand) + " by " + round2(diff) }] : [];
    },
  },
  {
    id: "gstin_format",
    code: "GSTIN_FORMAT_INVALID",
    label: "GSTIN format failed validation",
    test: (ctx) => {
      const findings = [];
      ["billTo", "shipTo"].forEach((key) => {
        const gst = (ctx.so && ctx.so[key] && ctx.so[key].gstin) || "";
        if (gst) {
          const v = validateGSTIN(gst);
          if (!v.ok) findings.push({ field: key, detail: key + " GSTIN: " + v.message });
        }
      });
      return findings;
    },
  },
  {
    id: "stale_quote_local",
    code: "STALE_QUOTE",
    label: "Quote older than configured validity",
    test: (ctx) => {
      const poDate = ctx.po && ctx.po.poDate;
      const quoteDate = ctx.po && ctx.po.quoteDate;
      if (!poDate || !quoteDate) return [];
      const months = monthsBetween(poDate, quoteDate);
      if (months == null) return [];
      const limit = Number((ctx.policy && ctx.policy.quoteValidityMonths) || 6);
      return months > limit ? [{ detail: "Quote dated " + Math.round(months) + " months before PO" }] : [];
    },
  },
  {
    id: "duplicate_po_local",
    code: "DUPLICATE_PO",
    label: "Same PO number already processed",
    test: (ctx) => {
      const po = String((ctx.po && ctx.po.poNumber) || "").trim().toUpperCase();
      if (!po) return [];
      const dup = (ctx.history || []).find((o) => o && o.id !== ctx.currentOrderId && String(o.preflightPONumber || "").trim().toUpperCase() === po);
      return dup ? [{ detail: "PO " + po + " already exists as " + dup.id }] : [];
    },
  },
  {
    id: "gstin_state_consistency",
    code: "TAX_TYPE_MISMATCH",
    label: "Bill-to / ship-to GSTIN state mismatch",
    test: (ctx) => {
      const findings = [];
      const billGstin = (ctx.so && ctx.so.billTo && ctx.so.billTo.gstin) || "";
      const shipGstin = (ctx.so && ctx.so.shipTo && ctx.so.shipTo.gstin) || "";
      if (billGstin && shipGstin && billGstin.slice(0, 2) !== shipGstin.slice(0, 2)) {
        findings.push({ detail: "Bill-to GSTIN state " + stateFromGstin(billGstin) + " differs from ship-to " + stateFromGstin(shipGstin) });
      }
      return findings;
    },
  },
  {
    id: "round_off_consistency",
    code: "AMOUNT_RECONCILIATION",
    label: "Sub total + tax does not equal grand total",
    test: (ctx) => {
      const sub = Number(ctx.so && ctx.so.subTotal) || 0;
      const cgst = Number(ctx.so && ctx.so.totalCgst) || 0;
      const sgst = Number(ctx.so && ctx.so.totalSgst) || 0;
      const igst = Number(ctx.so && ctx.so.totalIgst) || 0;
      const grand = Number(ctx.so && ctx.so.grandTotal) || 0;
      if (!grand) return [];
      const expected = sub + cgst + sgst + igst;
      const diff = Math.abs(expected - grand);
      return diff > Math.max(2, grand * 0.005) ? [{ detail: "Sub+tax " + round2(expected) + " != grand " + round2(grand) }] : [];
    },
  },
  {
    id: "hsn_consistency",
    code: "MISSING_HSN",
    label: "HSN code format invalid",
    test: (ctx) => {
      return ((ctx.so && ctx.so.lineItems) || []).map((li, idx) => {
        if (!li.hsnCode) return null;
        const hsn = String(li.hsnCode).trim();
        if (!/^[0-9]{4,8}$/.test(hsn)) return { lineIndex: idx, sno: li.sno, detail: "HSN '" + hsn + "' is not a 4-8 digit code" };
        return null;
      }).filter(Boolean);
    },
  },
  {
    id: "negative_or_zero_quantity",
    code: "AMOUNT_RECONCILIATION",
    label: "Line has zero or negative quantity",
    test: (ctx) => ((ctx.so && ctx.so.lineItems) || []).map((li, idx) => {
      const qty = Number(li.qty);
      if (!Number.isFinite(qty) || qty <= 0) return { lineIndex: idx, sno: li.sno, detail: "Line " + (li.sno || idx + 1) + " has invalid qty " + li.qty };
      return null;
    }).filter(Boolean),
  },
  {
    id: "zero_rate",
    code: "PRICE_MISMATCH",
    label: "Line has zero rate",
    test: (ctx) => ((ctx.so && ctx.so.lineItems) || []).map((li, idx) => {
      if (li.partNameSource === "free_sample") return null;
      const rate = Number(li.rate);
      if (!rate) return { lineIndex: idx, sno: li.sno, detail: "Line " + (li.sno || idx + 1) + " rate is zero" };
      return null;
    }).filter(Boolean),
  },
  {
    id: "integer_only_qty",
    code: "AMOUNT_RECONCILIATION",
    label: "Quantity must be integer for this UOM",
    test: (ctx) => {
      const rules = (ctx.uomRules && ctx.uomRules.byCanonical) || {};
      return ((ctx.so && ctx.so.lineItems) || []).map((li, idx) => {
        const uom = String(li.uom || "").trim();
        const rule = rules[uom] || rules[uom.toUpperCase()] || rules[uom.toLowerCase()];
        if (!rule || !rule.integer_only) return null;
        const qty = Number(li.qty);
        return Number.isInteger(qty) ? null : { lineIndex: idx, sno: li.sno, detail: "Line qty " + qty + " has fractional value but UOM " + uom + " requires integer" };
      }).filter(Boolean);
    },
  },
  {
    id: "min_order_qty",
    code: "AMOUNT_RECONCILIATION",
    label: "Quantity below minimum order quantity",
    test: (ctx) => {
      const rules = (ctx.uomRules && ctx.uomRules.byCanonical) || {};
      return ((ctx.so && ctx.so.lineItems) || []).map((li, idx) => {
        const uom = String(li.uom || "").trim();
        const rule = rules[uom] || rules[uom.toUpperCase()] || rules[uom.toLowerCase()];
        if (!rule || !rule.min_order_qty) return null;
        const qty = Number(li.qty) || 0;
        return qty >= rule.min_order_qty ? null : { lineIndex: idx, sno: li.sno, detail: "Line qty " + qty + " < MOQ " + rule.min_order_qty + " for UOM " + uom };
      }).filter(Boolean);
    },
  },
  {
    id: "pack_size_alignment",
    code: "AMOUNT_RECONCILIATION",
    label: "Quantity not a multiple of pack size",
    test: (ctx) => {
      const rules = (ctx.uomRules && ctx.uomRules.byCanonical) || {};
      return ((ctx.so && ctx.so.lineItems) || []).map((li, idx) => {
        const uom = String(li.uom || "").trim();
        const rule = rules[uom] || rules[uom.toUpperCase()] || rules[uom.toLowerCase()];
        if (!rule || !rule.pack_size) return null;
        const qty = Number(li.qty) || 0;
        const remainder = qty % Number(rule.pack_size);
        return remainder === 0 ? null : { lineIndex: idx, sno: li.sno, detail: "Line qty " + qty + " is not a multiple of pack size " + rule.pack_size };
      }).filter(Boolean);
    },
  },
];

const runValidationRules = (so, po, ctx) => {
  if (!so) return [];
  const context = { so, po: po || {}, policy: (ctx && ctx.policy) || {}, history: (ctx && ctx.history) || [], priceComp: ctx && ctx.priceComp, currentOrderId: ctx && ctx.currentOrderId };
  const findings = [];
  for (const rule of VALIDATION_RULES) {
    let hits = [];
    try { hits = rule.test(context) || []; } catch (err) { hits = [{ detail: "Rule " + rule.id + " threw: " + err.message }]; }
    for (const hit of hits) {
      const meta = ISSUE_TAXONOMY[rule.code] || { severity: "WARNING", owner: "sales_engineer", blocks: false };
      findings.push({
        ruleId: rule.id,
        code: rule.code,
        label: rule.label,
        severity: meta.severity,
        owner: meta.owner,
        blocks: !!meta.blocks,
        suggestedFix: meta.fix || "",
        ...hit,
      });
    }
  }
  return findings;
};

const buildEvidenceIndex = (pdfStructure) => {
  const lines = [];
  ((pdfStructure && pdfStructure.pages) || []).forEach((p) => {
    const pageLines = groupItemsToLines(p.items);
    pageLines.forEach((l) => lines.push({ ...l, page: p.index }));
  });
  return lines;
};

const findEvidenceForValue = (lines, value) => {
  if (value == null || value === "") return null;
  const needle = String(value).trim();
  if (!needle) return null;
  const variants = new Set([needle, needle.replace(/\s+/g, " ")]);
  if (/^[0-9.,\-]+$/.test(needle)) {
    const num = parseFloat(needle.replace(/,/g, ""));
    if (Number.isFinite(num)) {
      variants.add(String(num));
      variants.add(num.toFixed(2));
      variants.add(num.toLocaleString("en-IN"));
    }
  }
  for (const variant of variants) {
    if (!variant) continue;
    const lower = variant.toLowerCase();
    for (const line of lines) {
      if (line.text.toLowerCase().includes(lower)) {
        return { snippet: line.text, page: line.page, matchedVariant: variant };
      }
    }
  }
  return null;
};

const annotateProvenance = async (order, files) => {
  if (!order || !order.result || !order.result.salesOrder) return order;
  const evidenceByField = {};
  const sources = [];
  for (const entry of (files || [])) {
    if (!entry || !entry.file) continue;
    const ext = String(entry.file.name || "").toLowerCase().split(".").pop();
    if (ext !== "pdf") continue;
    try {
      const struct = await extractPdfStructure(entry.file, { maxPages: 5 });
      sources.push({ label: entry.label, lines: buildEvidenceIndex(struct) });
    } catch (_) {}
  }
  if (!sources.length) return order;
  const search = (value) => {
    for (const src of sources) {
      const ev = findEvidenceForValue(src.lines, value);
      if (ev) return { ...ev, document: src.label };
    }
    return null;
  };
  const so = order.result.salesOrder;
  const fieldsToCheck = [
    ["po.number", order.result.po && order.result.po.number],
    ["po.date", order.result.po && order.result.po.date],
    ["po.customer", order.result.po && order.result.po.customer],
    ["so.grandTotal", so.grandTotal],
    ["so.subTotal", so.subTotal],
  ];
  fieldsToCheck.forEach((pair) => {
    const ev = search(pair[1]);
    if (ev) evidenceByField[pair[0]] = ev;
  });
  (so.lineItems || []).forEach((li, idx) => {
    if (li.qty) {
      const ev = search(li.qty);
      if (ev) evidenceByField["so.lineItems[" + idx + "].qty"] = ev;
    }
    if (li.rate) {
      const ev = search(li.rate);
      if (ev) evidenceByField["so.lineItems[" + idx + "].rate"] = ev;
    }
    if (li.hsnCode) {
      const ev = search(li.hsnCode);
      if (ev) evidenceByField["so.lineItems[" + idx + "].hsnCode"] = ev;
    }
  });
  return { ...order, evidenceByField, evidenceCoverage: Object.keys(evidenceByField).length };
};

const loadLearnedRules = async () => (await sGet(SK_LEARNED_RULES)) || {};
const saveLearnedRules = (r) => sSet(SK_LEARNED_RULES, r);

const recordLineEditPattern = async (customerKey, edit) => {
  if (!customerKey || !edit) return;
  const all = await loadLearnedRules();
  const bucket = all[customerKey] || { fieldEdits: {}, version: 1 };
  Object.keys(edit.edits || {}).forEach((field) => {
    bucket.fieldEdits[field] = bucket.fieldEdits[field] || { count: 0, lastValues: [] };
    bucket.fieldEdits[field].count += 1;
    bucket.fieldEdits[field].lastValues = (bucket.fieldEdits[field].lastValues || []).concat([{
      sno: edit.sno,
      newValue: edit.edits[field],
      at: nowISO(),
    }]).slice(-5);
  });
  bucket.lastObservedAt = nowISO();
  all[customerKey] = bucket;
  await saveLearnedRules(all);
};

const recurringEditFields = (rules, threshold) => {
  if (!rules) return [];
  const out = [];
  Object.entries(rules).forEach(([customerKey, bucket]) => {
    Object.entries(bucket.fieldEdits || {}).forEach(([field, info]) => {
      if (info.count >= (threshold || 2)) out.push({ customerKey, field, count: info.count, lastValues: info.lastValues || [] });
    });
  });
  return out;
};

const recomputeLineItem = (li) => {
  const next = { ...li };
  const qty = Number(next.qty) || 0;
  const rate = Number(next.rate) || 0;
  const discount = Number(next.discount) || 0;
  const grossAmount = qty * rate;
  next.amount = round2(grossAmount * (1 - discount / 100));
  const cgstRate = Number(next.cgst) || 0;
  const sgstRate = Number(next.sgst) || 0;
  const igstRate = Number(next.igst) || 0;
  next.cgstAmt = round2(next.amount * cgstRate / 100);
  next.sgstAmt = round2(next.amount * sgstRate / 100);
  next.igstAmt = round2(next.amount * igstRate / 100);
  next.totalWithGst = round2(next.amount + next.cgstAmt + next.sgstAmt + next.igstAmt);
  return next;
};

const recomputeSalesOrderTotals = (so) => {
  if (!so) return so;
  const lineItems = (so.lineItems || []).map(recomputeLineItem);
  const subTotal = round2(lineItems.reduce((s, li) => s + (Number(li.amount) || 0), 0));
  const totalCgst = round2(lineItems.reduce((s, li) => s + (Number(li.cgstAmt) || 0), 0));
  const totalSgst = round2(lineItems.reduce((s, li) => s + (Number(li.sgstAmt) || 0), 0));
  const totalIgst = round2(lineItems.reduce((s, li) => s + (Number(li.igstAmt) || 0), 0));
  const grandTotal = round2(subTotal + totalCgst + totalSgst + totalIgst);
  return { ...so, lineItems, subTotal, totalCgst, totalSgst, totalIgst, grandTotal };
};

const applyLineEdit = (order, lineIndex, edits) => {
  if (!order || !order.result || !order.result.salesOrder) return order;
  const lines = (order.result.salesOrder.lineItems || []).map((li, i) => i === lineIndex ? { ...li, ...edits, manuallyEdited: true } : li);
  const nextSo = recomputeSalesOrderTotals({ ...order.result.salesOrder, lineItems: lines });
  const lineEdits = (order.lineEdits || []).concat([{
    at: nowISO(),
    lineIndex,
    sno: lines[lineIndex] && lines[lineIndex].sno,
    edits,
  }]);
  return {
    ...order,
    result: { ...order.result, salesOrder: nextSo },
    lineEdits,
    status: order.status === "APPROVED" || order.status === "EXPORTED" ? "PENDING_REVIEW" : order.status,
  };
};

const removeLineItem = (order, lineIndex) => {
  if (!order || !order.result || !order.result.salesOrder) return order;
  const lines = (order.result.salesOrder.lineItems || []).filter((_, i) => i !== lineIndex);
  const renumbered = lines.map((li, i) => ({ ...li, sno: i + 1 }));
  const nextSo = recomputeSalesOrderTotals({ ...order.result.salesOrder, lineItems: renumbered });
  const lineEdits = (order.lineEdits || []).concat([{
    at: nowISO(),
    lineIndex,
    sno: (order.result.salesOrder.lineItems[lineIndex] || {}).sno,
    edits: { _removed: true },
  }]);
  return {
    ...order,
    result: { ...order.result, salesOrder: nextSo },
    lineEdits,
    status: order.status === "APPROVED" || order.status === "EXPORTED" ? "PENDING_REVIEW" : order.status,
  };
};

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const validateGSTIN = (gstin) => {
  const value = String(gstin || "").trim().toUpperCase();
  if (!value) return { ok: false, reason: "empty", message: "GSTIN missing" };
  if (!GSTIN_RE.test(value)) return { ok: false, reason: "format", message: "GSTIN format looks wrong" };
  return { ok: true, reason: "valid", message: "GSTIN format looks valid" };
};

const monthsBetween = (laterIso, earlierIso) => {
  const a = laterIso ? new Date(laterIso).getTime() : NaN;
  const b = earlierIso ? new Date(earlierIso).getTime() : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (a - b) / (30.44 * 24 * 3600 * 1000);
};

const docFreshnessAlerts = (pf) => {
  if (!pf) return [];
  const alerts = [];
  if (pf.poDate) {
    const ageMonths = monthsBetween(new Date().toISOString(), pf.poDate);
    if (ageMonths !== null && ageMonths > 12) alerts.push({ severity: "warn", label: "PO older than 12 months", detail: "Filed " + Math.round(ageMonths) + " months ago" });
  }
  if (pf.poDate && pf.quoteDate) {
    const m = monthsBetween(pf.poDate, pf.quoteDate);
    if (m !== null && m > 6) alerts.push({ severity: "warn", label: "Quote older than PO by " + Math.round(m) + " months", detail: "Quote may be stale; re-quote may be needed" });
    if (m !== null && m < -7 / 30) alerts.push({ severity: "info", label: "Quote dated after PO", detail: "Confirm this is intentional" });
  }
  return alerts;
};

const computeStorageBytes = () => {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    const value = localStorage.getItem(key) || "";
    total += key.length + value.length;
  }
  return total;
};

const STORAGE_BUDGET_BYTES = 4 * 1024 * 1024;
const storagePressure = () => {
  const used = computeStorageBytes();
  const ratio = used / STORAGE_BUDGET_BYTES;
  return { used, ratio, level: ratio > 0.9 ? "critical" : ratio > 0.75 ? "warn" : "ok" };
};

const compactStorage = async () => {
  const cache = await loadResultCache();
  const entries = Object.entries(cache).sort((a, b) => new Date(b[1].savedAt).getTime() - new Date(a[1].savedAt).getTime());
  const trimmed = {};
  entries.slice(0, 50).forEach(([k, v]) => { trimmed[k] = v; });
  await saveResultCache(trimmed);
  const log = await loadAuditLog();
  await saveAuditLog(log.slice(0, 200));
  await recordAudit("storage_compact", "Trimmed cache to 50 entries and audit to 200 entries", null);
  return storagePressure();
};

const migrateStorageIfNeeded = async () => {
  const stored = Number(await sGet(SK_SCHEMA) || 1);
  if (stored >= SCHEMA_VERSION) return false;
  if (stored < 2) {
    const orders = await loadOrders();
    let mutated = false;
    const next = (orders || []).map((o) => {
      if (!o) return o;
      if (o.customerKey || !o.preflightCustomer) return o;
      mutated = true;
      const gst = (o.result && o.result.po && o.result.po.gstin) || o.customerGSTIN || "";
      return { ...o, customerKey: normalizeCustomerKey(gst, o.preflightCustomer) };
    });
    if (mutated) await sSet(SK_ORDERS, next);
  }
  await sSet(SK_SCHEMA, SCHEMA_VERSION);
  await recordAudit("schema_migration", "Migrated storage to version " + SCHEMA_VERSION, null);
  return true;
};`,
  "cost policy storage",
);

patchSo(
  `        {tab === "customers" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-slate-800 text-base">Customer Format Profiles</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Stored PO format fingerprints. Each profile is built automatically after the first successful SO.
                  Future POs from the same customer use this profile for more accurate extraction and format-change detection.
                </p>
              </div>
            </div>`,
  String.raw`        {tab === "customers" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="font-bold text-slate-800 text-base">Customer Format Profiles</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Stored PO format fingerprints. Each profile is built automatically after the first successful SO.
                  Future POs from the same customer use this profile for more accurate extraction and format-change detection.
                </p>
              </div>
              <div className="flex gap-2 items-center">
                <input
                  type="file"
                  accept=".json,application/json"
                  id="customer-recipe-import"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target && e.target.files && e.target.files[0];
                    if (!file) return;
                    try {
                      const text = await file.text();
                      const parsed = JSON.parse(text);
                      const incoming = Array.isArray(parsed) ? parsed : [parsed];
                      const formats = await loadFormats();
                      let added = 0;
                      let merged = 0;
                      for (const r of incoming) {
                        const ck = r && (r.customerKey || normalizeCustomerKey(r.customerGSTIN || "", r.customerName || ""));
                        if (!ck) continue;
                        const existing = formats[ck];
                        const next = {
                          customerKey: ck,
                          customerName: r.customerName || (existing && existing.customerName) || "",
                          customerGSTIN: r.customerGSTIN || (existing && existing.customerGSTIN) || "",
                          firstSeen: (existing && existing.firstSeen) || nowISO(),
                          lastUpdated: nowISO(),
                          ordersProcessed: (existing && existing.ordersProcessed) || (r.ordersProcessed || 0),
                          lastFormatChanged: false,
                          formatChangeSummary: "",
                          fingerprint: r.fingerprint || (existing && existing.fingerprint) || {},
                          trusted: !!(r.trusted || (existing && existing.trusted)),
                        };
                        formats[ck] = next;
                        if (existing) merged++; else added++;
                      }
                      await saveFormats(formats);
                      setCustomerFormats(formats);
                      await recordAudit("import_recipes", "Imported " + incoming.length + " profile(s) (" + added + " new, " + merged + " merged)", null);
                      alert("Imported " + added + " new and merged " + merged + " existing profile(s).");
                    } catch (err) {
                      alert("Recipe import failed: " + err.message);
                    } finally {
                      e.target.value = "";
                    }
                  }}
                />
                <button
                  onClick={() => document.getElementById("customer-recipe-import").click()}
                  className="text-xs text-blue-700 border border-blue-200 bg-blue-50 px-3 py-1.5 rounded-xl hover:bg-blue-100 font-semibold"
                >
                  Import recipes
                </button>
                <button
                  onClick={() => {
                    const all = Object.values(customerFormats || {}).map((p) => extractorRecipeForProfile(p));
                    if (!all.length) { alert("No customer profiles to export."); return; }
                    dlFile(JSON.stringify(all, null, 2), "ExtractorRecipes_All_" + new Date().toISOString().slice(0,10) + ".json", "application/json");
                    recordAudit("export_all_recipes", "Exported " + all.length + " recipes", null);
                  }}
                  className="text-xs text-teal-700 border border-teal-200 bg-teal-50 px-3 py-1.5 rounded-xl hover:bg-teal-100 font-semibold"
                >
                  Export all
                </button>
              </div>
            </div>`,
  "customer recipe import / bulk export",
);

patchSo(
  `const handleApproval = useCallback(async (status, note) => {
    if (!approvalTarget) return;
    const updated = { ...approvalTarget, status, approvalNote: note };
    await saveOrder(updated);
    setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
    if (activeOrder && approvalTarget.id === activeOrder.id) setActiveOrder(updated);
    if (status === "APPROVED") {
      const m = await loadMetrics();
      m.ordersApproved = (m.ordersApproved || 0) + 1;
      await saveMetrics(m); setMetrics(m);
    }
    setShowApproval(false); setApprovalTarget(null);
  }, [approvalTarget, activeOrder]);`,
  String.raw`const handleApproval = useCallback(async (status, note) => {
    if (!approvalTarget) return;
    const so = approvalTarget.result && approvalTarget.result.salesOrder;
    const payloadHash = await computePayloadHash(so);
    const approval = status === "APPROVED" ? {
      payloadHash,
      approvedAt: nowISO(),
      approvedBy: note && note.approvedBy ? note.approvedBy : "local-user",
      reason: typeof note === "string" ? note : (note && note.reason) || "",
    } : null;
    const updated = { ...approvalTarget, status, approvalNote: typeof note === "string" ? note : (note && note.reason) || (note && note.note) || "", approval };
    await saveOrder(updated);
    setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
    if (activeOrder && approvalTarget.id === activeOrder.id) setActiveOrder(updated);
    if (status === "APPROVED") {
      const m = await loadMetrics();
      m.ordersApproved = (m.ordersApproved || 0) + 1;
      await saveMetrics(m); setMetrics(m);
      await recordAudit("approve_order", "Approval bound to payload hash " + payloadHash.slice(0, 12), updated.id);
    } else {
      await recordAudit("reject_order", "Status=" + status, updated.id);
    }
    setShowApproval(false); setApprovalTarget(null);
  }, [approvalTarget, activeOrder]);

  const verifyApproval = useCallback(async (order) => {
    if (!order || !order.approval) return { ok: false, reason: "not_approved", message: "No approval recorded" };
    const so = order.result && order.result.salesOrder;
    const currentHash = await computePayloadHash(so);
    if (currentHash !== order.approval.payloadHash) return { ok: false, reason: "hash_mismatch", currentHash, message: "Payload changed after approval. Re-approve before export." };
    return { ok: true, reason: "valid", currentHash, message: "Approval matches current payload" };
  }, []);`,
  "approval payload hash",
);

patchSo(
  `            {sourcePOs.map((spo, i) => (
              <SourcePOCard key={i} spo={spo} onDownload={() => {}} />
            ))}`,
  String.raw`            {sourcePOs.map((spo, i) => {
              const spoKey = (spo.reference || spo.supplier || "spo_" + i);
              const lifecycle = sourcePoLifecycle[spoKey] || { status: spo.status || "DRAFT", eta: spo.acknowledgedEta || "" };
              const onStatusChange = async (target, nextStatus) => {
                const updated = { ...sourcePoLifecycle, [spoKey]: { ...lifecycle, status: nextStatus } };
                setSourcePoLifecycle(updated);
                await recordAudit("source_po_status", spoKey + " -> " + nextStatus, activeOrder && activeOrder.id);
                if (window.ObaraBackend && window.ObaraBackend.isReady()) {
                  try {
                    await window.ObaraBackend.events.record({ case_id: (activeOrder && activeOrder.id) || spoKey, event_type: "source_po_status_changed", object_type: "source_po", object_id: spoKey, detail: { from: lifecycle.status, to: nextStatus } });
                  } catch (_) {}
                }
              };
              const onEtaChange = async (target, nextEta) => {
                const updated = { ...sourcePoLifecycle, [spoKey]: { ...lifecycle, eta: nextEta } };
                setSourcePoLifecycle(updated);
                await recordAudit("source_po_eta", spoKey + " ETA -> " + nextEta, activeOrder && activeOrder.id);
              };
              return (
                <div key={i}>
                  <SourcePOCard spo={spo} onDownload={() => {}} />
                  <SourcePoLifecycle spo={spo} status={lifecycle.status} eta={lifecycle.eta} onStatusChange={onStatusChange} onEtaChange={onEtaChange} />
                </div>
              );
            })}`,
  "source PO lifecycle wiring",
);

patchSo(
  /<Tbl\s+headers=\{\["#","Tally Item Name"[\s\S]*?fmt\(li\.totalWithGst\), li\.dueDate,\s*\]\)\}\s*\/>/,
  String.raw`<div className="flex justify-end items-center mb-2 gap-2">
                {(activeOrder.lineEdits || []).length > 0 && (
                  <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded">
                    {(activeOrder.lineEdits || []).length} manual edit{(activeOrder.lineEdits || []).length === 1 ? "" : "s"}
                  </span>
                )}
                <span className="text-xs text-slate-400">Click "Edit" on any row to change qty, rate, GST, or remove the line.</span>
              </div>
              <div className="overflow-auto border border-slate-200 rounded-xl">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr>{["#","Tally Item Name","Src","HSN","Cust P/N","UOM","Qty","Rate","Amt","CGST","SGST","IGST","Total","Due","Edit"].map((h, i) => (
                      <th key={i} className="px-2 py-1.5 text-left font-bold text-slate-500 uppercase tracking-wide">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {(so.lineItems || []).map((li, idx) => (
                      <tr key={idx} className={"border-t border-slate-100 " + (li.manuallyEdited ? "bg-amber-50/40" : "")}>
                        <td className="px-2 py-1.5">{li.sno}</td>
                        <td className="px-2 py-1.5">
                          {(li.partNameMismatch ? "* " : "") + (li.tallyItemName || li.itemName)}
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <SoHistoryHint partNo={li.tallyItemName || li.itemName || li.sellerPartNo} customerKey={activeOrder.customerKey} orders={orders} />
                            {(() => {
                              const key = (li.tallyItemName || li.itemName || li.sellerPartNo || "").toUpperCase();
                              const inv = inventoryByPart[key];
                              return inv ? <InventoryStatusPill status={inv.status} /> : null;
                            })()}
                            {(() => {
                              const bandKey = (li.tallyItemName || li.itemName || li.sellerPartNo || "").toUpperCase();
                              const band = priceBands[bandKey];
                              if (!band) return null;
                              return (
                                <>
                                  <LostMarginWarning band={band} currentRate={Number(li.rate) || 0} />
                                  <RepeatOrderSuggestion band={band} />
                                </>
                              );
                            })()}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">{li.partNameSource === "quote_part_number" ? "ok" : li.partNameSource === "po_only" ? "PO" : "?"}</td>
                        <td className="px-2 py-1.5">{li.hsnCode}</td>
                        <td className="px-2 py-1.5">{li.custPartNo}</td>
                        <td className="px-2 py-1.5">{li.uom}</td>
                        <td className="px-2 py-1.5 font-mono">{li.qty}</td>
                        <td className="px-2 py-1.5 font-mono">{fmt(li.rate)}</td>
                        <td className="px-2 py-1.5 font-mono">{fmt(li.amount)}</td>
                        <td className="px-2 py-1.5 font-mono">{fmt(li.cgstAmt)}</td>
                        <td className="px-2 py-1.5 font-mono">{fmt(li.sgstAmt)}</td>
                        <td className="px-2 py-1.5 font-mono">{fmt(li.igstAmt)}</td>
                        <td className="px-2 py-1.5 font-mono font-bold">{fmt(li.totalWithGst)}</td>
                        <td className="px-2 py-1.5">{li.dueDate}</td>
                        <td className="px-2 py-1.5">
                          <button onClick={() => setEditLineItem({ index: idx, item: li })} className="text-blue-700 underline">Edit</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {editLineItem && (
                <LineItemEditor
                  item={editLineItem.item}
                  onCancel={() => setEditLineItem(null)}
                  onSave={(edits) => saveLineItemEdit(editLineItem.index, edits)}
                  onRemove={() => removeLineItemFromOrder(editLineItem.index)}
                />
              )}`,
  "inline line item editor",
);

patchSo(
  `const buildFormatContextBlock = (profile) => {
  if (!profile || !profile.fingerprint) return null;`,
  String.raw`const profileStability = (profile) => {
  const orders = Number(profile && profile.ordersProcessed || 0);
  if (profile && profile.lastFormatChanged) return { key:"changed", label:"Changed", color:"amber", score:35, ready:false };
  if (orders >= 3) return { key:"extractor_ready", label:"Extractor Ready", color:"green", score:95, ready:true };
  if (orders >= 2) return { key:"stable", label:"Stable", color:"blue", score:75, ready:false };
  return { key:"new", label:"New", color:"slate", score:35, ready:false };
};

const recommendedBackendPath = (profile) => {
  const s = profileStability(profile);
  const fp = profile && profile.fingerprint || {};
  if (s.key === "changed") return "visual_pdf_or_ai";
  if (s.key === "extractor_ready" && String(fp.documentType || "").toLowerCase().includes("pdf")) return "deterministic_text_extraction";
  if (s.key === "stable") return "deterministic_text_extraction";
  return "manual_review";
};

const extractorRecipeForProfile = (profile) => ({
  version: 1,
  exportedAt: nowISO(),
  customerKey: profile.customerKey,
  customerName: profile.customerName,
  customerGSTIN: profile.customerGSTIN,
  trusted: !!profile.trusted,
  ordersProcessed: profile.ordersProcessed || 0,
  stability: profileStability(profile),
  recommendedBackendPath: recommendedBackendPath(profile),
  fingerprint: profile.fingerprint || {},
});

const exportExtractorRecipe = (profile) => {
  const safe = String(profile.customerKey || profile.customerName || "customer").replace(/[^A-Za-z0-9._-]+/g, "_");
  dlFile(JSON.stringify(extractorRecipeForProfile(profile), null, 2), "ExtractorRecipe_" + safe + ".json", "application/json");
};

const usagePart = (u, key) => Number(u && u[key] || 0);
const estimateApiCost = (usageBundle, policy) => {
  const p = normalizeCostPolicy(policy);
  const parts = [usageBundle && usageBundle.preflight, usageBundle && usageBundle.generation].filter(Boolean);
  const usage = parts.reduce((acc, u) => ({
    input_tokens: acc.input_tokens + usagePart(u, "input_tokens"),
    output_tokens: acc.output_tokens + usagePart(u, "output_tokens"),
    cache_creation_input_tokens: acc.cache_creation_input_tokens + usagePart(u, "cache_creation_input_tokens"),
    cache_read_input_tokens: acc.cache_read_input_tokens + usagePart(u, "cache_read_input_tokens"),
  }), { input_tokens:0, output_tokens:0, cache_creation_input_tokens:0, cache_read_input_tokens:0 });
  const usd = (usage.input_tokens / 1000000) * p.sonnetInputPerMTok +
    (usage.output_tokens / 1000000) * p.sonnetOutputPerMTok +
    (usage.cache_creation_input_tokens / 1000000) * p.sonnetInputPerMTok * 1.25 +
    (usage.cache_read_input_tokens / 1000000) * p.sonnetInputPerMTok * 0.10;
  return { usage, usd, inr: usd * Number(p.usdToInr || 83) };
};

const buildFormatContextBlock = (profile) => {
  if (!profile || !profile.fingerprint) return null;`,
  "profile reuse helpers",
);

patchSo(
  String.raw`    DUPLICATE:      { c:"purple", l:"Duplicate"      },
  };`,
  String.raw`    DUPLICATE:      { c:"purple", l:"Duplicate"      },
    REUSED:         { c:"blue",   l:"Reused"         },
  };`,
  "reused status",
);

patchSo(
  `const DropZone = ({ label, file, setFile, inputRef, icon, optional }) => (`,
  String.raw`const CostPolicyPanel = ({ policy, onChange }) => {
  const p = normalizeCostPolicy(policy);
  const update = (patch) => onChange({ ...p, ...patch });
  const optionClass = (active) => "px-3 py-2 rounded-xl border text-xs font-semibold text-left transition-all " + (active ? "bg-blue-50 border-blue-300 text-blue-800" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300");
  return (
    <Card>
      <CardHead title="Cost Policy" sub="Controls that reduce avoidable API spend before processing" accent="#0f766e" />
      <div className="p-4 space-y-3">
        <div>
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Mode</div>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(COST_MODE_META).map(([key, meta]) => (
              <button key={key} type="button" onClick={() => update({ mode:key })} className={optionClass(p.mode === key)}>
                <div>{meta.label}</div>
                <div className="text-[11px] font-normal mt-1 text-slate-500 leading-snug">{meta.detail}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">
            Prompt caching
            <select value={p.promptCache} onChange={(e) => update({ promptCache:e.target.value })} className="mt-1 w-full border border-slate-300 rounded-xl p-2 text-sm font-normal normal-case bg-white">
              {Object.entries(PROMPT_CACHE_META).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">
            Price composition
            <select value={p.priceComp} onChange={(e) => update({ priceComp:e.target.value })} className="mt-1 w-full border border-slate-300 rounded-xl p-2 text-sm font-normal normal-case bg-white">
              {Object.entries(PRICE_COMP_META).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">
            PDF OCR
            <select value={p.ocrPdfs} onChange={(e) => update({ ocrPdfs:e.target.value })} className="mt-1 w-full border border-slate-300 rounded-xl p-2 text-sm font-normal normal-case bg-white">
              {Object.entries(OCR_MODE_META).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
        </div>
        {p.ocrPdfs === "always" && (
          <div className="p-2 bg-purple-50 border border-purple-200 rounded-xl text-xs text-purple-800">
            Every uploaded PDF runs through Tesseract before being sent to Claude. Slower (10-60 seconds per file) but reduces tokens for image-heavy PDFs.
          </div>
        )}
        {p.promptCache === "1h" && (
          <div className="p-2 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
            One-hour prompt cache is marked for backend use. The browser POC can store the preference, but production should send the required beta header from a server.
          </div>
        )}
        {p.mode === "batch_candidate" && (
          <div className="p-2 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800">
            Batch candidate mode flags the process for later backend batching. The current browser app still runs realtime when you click Validate.
          </div>
        )}
      </div>
    </Card>
  );
};

const DocumentReadinessPanel = ({ metas, files, ocrTextByLabel, ocrBusyLabel, onOcrCached, onOcrClear }) => {
  const rows = (metas || []).filter(Boolean);
  if (!rows.length) return null;
  const fileFor = (label) => {
    const f = (files || []).find((entry) => entry && entry.label === label);
    return f && f.file ? f.file : null;
  };
  return (
    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700">
      <div className="font-bold text-slate-600 mb-2">Document handling</div>
      <div className="space-y-1.5">
        {rows.map((m) => {
          const file = fileFor(m.label);
          const isPdf = m.kind === "pdf";
          const cachedText = ocrTextByLabel && ocrTextByLabel[m.label];
          const busy = ocrBusyLabel === m.label;
          return (
            <div key={m.label + m.name} className="flex justify-between gap-3 items-center">
              <span className="font-semibold">{m.label}</span>
              <span className="text-right text-slate-500 flex items-center gap-2 flex-wrap justify-end">
                <span>
                  {cachedText ? "Will send as OCR text (" + Math.round(cachedText.length / 1000) + "k chars)" : (m.converted ? "Converted to compact text" : m.kind === "image" ? "Sent as image" : "Sent as PDF")}
                  {m.sheetName ? " · " + m.sheetName : ""}
                  {m.rowsIncluded ? " · " + m.rowsIncluded + "/" + m.rowCount + " rows" : ""}
                  {m.charCount && !cachedText ? " · " + Math.round(m.charCount / 1000) + "k chars" : ""}
                  {m.truncated ? " · truncated" : ""}
                </span>
                {isPdf && file && !cachedText && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onOcrCached && onOcrCached(file, m.label)}
                    className="text-[11px] text-blue-700 border border-blue-200 bg-white px-2 py-0.5 rounded hover:bg-blue-50 font-semibold disabled:opacity-50"
                    title="Run OCR locally and use the extracted text for the next API call"
                  >
                    {busy ? "OCR running..." : "Run OCR"}
                  </button>
                )}
                {cachedText && (
                  <button
                    type="button"
                    onClick={() => onOcrClear && onOcrClear(m.label)}
                    className="text-[11px] text-red-600 border border-red-200 bg-white px-2 py-0.5 rounded hover:bg-red-50 font-semibold"
                  >
                    Drop OCR
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ReusePanel = ({ order, onOpen, onReprocess }) => (
  <Card>
    <CardHead title="Reusable Extraction Found" sub="The same document fingerprint already exists in local history" accent="#1d4ed8" />
    <div className="p-4 space-y-3">
      <div className="text-sm text-slate-700">
        PO {poNumberFromOrder(order) || "unknown"} was already processed for {(order && (order.preflightCustomer || order.result && order.result.po && order.result.po.customer)) || "this customer"}.
        Reusing it avoids another preflight and SO-generation API call.
      </div>
      <div className="flex gap-2">
        <Btn onClick={onOpen} size="sm">Open Previous Result</Btn>
        <Btn onClick={onReprocess} variant="secondary" size="sm">Reprocess Anyway</Btn>
      </div>
    </div>
  </Card>
);

const ApiCostCard = ({ order }) => {
  if (!order) return null;
  const policy = normalizeCostPolicy(order.costPolicySnapshot);
  const cost = estimateApiCost(order.apiUsage, policy);
  const u = cost.usage || {};
  const fmtTok = (n) => Number(n || 0).toLocaleString("en-IN");
  const hasActual = !!(u.input_tokens || u.output_tokens || u.cache_creation_input_tokens || u.cache_read_input_tokens);
  return (
    <div className="mt-2 p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs">
      <div className="font-semibold text-slate-500 mb-1.5">API cost</div>
      {hasActual ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          <span className="text-slate-400">Input</span><span className="font-mono">{fmtTok(u.input_tokens)}</span>
          <span className="text-slate-400">Output</span><span className="font-mono">{fmtTok(u.output_tokens)}</span>
          <span className="text-slate-400">Cache write</span><span className="font-mono">{fmtTok(u.cache_creation_input_tokens)}</span>
          <span className="text-slate-400">Cache read</span><span className="font-mono">{fmtTok(u.cache_read_input_tokens)}</span>
          <span className="text-slate-400">Approx cost</span><span className="font-mono">USD {cost.usd.toFixed(4)} / Rs {cost.inr.toFixed(2)}</span>
        </div>
      ) : (
        <div className="text-slate-500">Actual usage was not returned. The token estimate above is still available for planning.</div>
      )}
    </div>
  );
};

const CostPreviewCard = ({ tokenEst, policy, customerSpend, budget }) => {
  if (!tokenEst) return null;
  const p = normalizeCostPolicy(policy);
  const inputTok = Number(tokenEst.totalInput || 0);
  const outputTok = Number(tokenEst.call2Output || 0);
  const usd = (inputTok / 1000000) * p.sonnetInputPerMTok + (outputTok / 1000000) * p.sonnetOutputPerMTok;
  const inr = usd * Number(p.usdToInr || 83);
  const cacheSavings = p.promptCache !== "off" ? usd * 0.3 : 0;
  const monthSpend = Number(customerSpend || 0);
  const monthBudget = Number(budget || p.defaultMonthlyBudgetUsd || 0);
  const overBudget = monthBudget > 0 && (monthSpend + usd) > monthBudget;
  return (
    <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs space-y-1.5">
      <div className="flex justify-between items-center">
        <span className="font-bold text-blue-800">Pre-call cost preview</span>
        <span className="font-mono text-blue-900">USD {usd.toFixed(4)} / Rs {inr.toFixed(2)}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-blue-900">
        <span className="text-blue-500">Input tokens</span><span className="font-mono text-right">{inputTok.toLocaleString("en-IN")}</span>
        <span className="text-blue-500">Output budget</span><span className="font-mono text-right">{outputTok.toLocaleString("en-IN")}</span>
        {cacheSavings > 0 && (
          <>
            <span className="text-blue-500">Cache savings est.</span>
            <span className="font-mono text-right text-emerald-700">-USD {cacheSavings.toFixed(4)}</span>
          </>
        )}
        {monthBudget > 0 && (
          <>
            <span className="text-blue-500">Customer this month</span>
            <span className={"font-mono text-right " + (overBudget ? "text-red-700 font-bold" : "text-blue-900")}>USD {monthSpend.toFixed(4)} / {monthBudget.toFixed(2)}</span>
          </>
        )}
      </div>
      {overBudget && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700 text-xs">
          This call would push the customer over their monthly budget. Consider dry run, batch mode, or revising the budget.
        </div>
      )}
    </div>
  );
};

const AnomalyBadges = ({ flags }) => {
  if (!flags || !flags.length) return null;
  const colorFor = (sev) => sev === "high" ? "bg-red-100 text-red-800 border-red-300" : sev === "medium" ? "bg-amber-100 text-amber-800 border-amber-300" : "bg-blue-100 text-blue-800 border-blue-300";
  return (
    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs space-y-1.5">
      <div className="font-bold text-amber-800">Anomalies vs. customer history</div>
      {flags.map((f) => (
        <div key={f.key} className={"px-2 py-1 rounded border " + colorFor(f.severity)}>
          <div className="font-semibold">{f.label}</div>
          <div className="opacity-90 mt-0.5">{f.detail}</div>
        </div>
      ))}
    </div>
  );
};

const DryRunPanel = ({ profile, onRunLocalExtract, onExportTemplate, onProceedAnyway, lastExtraction }) => {
  if (!profile) return null;
  const stability = profileStability(profile);
  if (!stability.ready && stability.key !== "stable") return null;
  return (
    <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-xl text-xs space-y-2">
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[180px]">
          <div className="font-bold text-emerald-800">Local extraction available</div>
          <div className="text-emerald-700 mt-0.5">
            {profile.customerName} is {stability.label.toLowerCase()} after {profile.ordersProcessed} order{profile.ordersProcessed !== 1 ? "s" : ""}.
            Run PDF text extraction locally and skip the SO generation Claude call.
          </div>
          {lastExtraction && (
            <div className="text-emerald-700 mt-1">
              Last attempt: {lastExtraction.confidence}% confidence on {lastExtraction.itemsValid}/{lastExtraction.itemsFound} usable line items.
            </div>
          )}
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
          <button onClick={onRunLocalExtract} className="px-3 py-1.5 rounded-xl bg-emerald-600 text-white font-semibold">Run local extract</button>
          <button onClick={onExportTemplate} className="px-3 py-1.5 rounded-xl bg-white border border-emerald-300 text-emerald-700 font-semibold">Export template</button>
          <button onClick={onProceedAnyway} className="px-3 py-1.5 rounded-xl bg-white border border-slate-300 text-slate-700 font-semibold">Send to Claude</button>
        </div>
      </div>
    </div>
  );
};

const IssuesPanel = ({ findings, onJumpToLine }) => {
  if (!findings || !findings.length) return null;
  const grouped = findings.reduce((acc, f) => { (acc[f.severity] = acc[f.severity] || []).push(f); return acc; }, {});
  const order = ["CRITICAL", "WARNING", "INFO"];
  const tone = (sev) => sev === "CRITICAL" ? "border-red-300 bg-red-50 text-red-900" : sev === "WARNING" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-blue-300 bg-blue-50 text-blue-900";
  return (
    <div className="space-y-2">
      {order.filter((s) => grouped[s]).map((s) => (
        <div key={s} className={"p-3 border rounded-xl text-xs space-y-1.5 " + tone(s)}>
          <div className="font-bold uppercase tracking-wide">{s} ({grouped[s].length})</div>
          {grouped[s].map((f, i) => (
            <div key={i} className="bg-white/60 rounded p-2 border border-white">
              <div className="font-semibold">[{f.code}] {f.label}</div>
              <div className="text-slate-700 mt-0.5">{f.detail}</div>
              <div className="text-slate-500 text-[11px] mt-1">Owner: {f.owner} · {f.suggestedFix}</div>
              {f.lineIndex != null && (
                <button onClick={() => onJumpToLine && onJumpToLine(f.lineIndex)} className="text-blue-700 underline text-[11px] mt-1">Jump to line {f.sno || f.lineIndex + 1}</button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};

const EvidenceTooltip = ({ field, evidence }) => {
  if (!evidence) return null;
  return (
    <span className="inline-flex items-center gap-1 ml-1 text-blue-700 cursor-help" title={"Evidence (" + evidence.document + ", page " + evidence.page + "): " + evidence.snippet}>
      <span className="text-[10px] underline decoration-dotted">evidence</span>
    </span>
  );
};

const ApprovalStatusBanner = ({ order, verifyApproval }) => {
  const [state, setState] = useState({ checking: true });
  useEffect(() => {
    let cancelled = false;
    if (!order || !order.approval) { setState({ checking: false, ok: false, reason: "not_approved" }); return; }
    setState({ checking: true });
    verifyApproval(order).then((res) => { if (!cancelled) setState({ checking: false, ...res }); }).catch((err) => { if (!cancelled) setState({ checking: false, ok: false, reason: "error", message: err.message }); });
    return () => { cancelled = true; };
  }, [order, verifyApproval]);
  if (!order || !order.approval) return null;
  if (state.checking) return <div className="p-2 text-xs text-slate-400">Verifying approval signature...</div>;
  if (state.ok) {
    const expiresAt = order.approval_expires_at || (order.approval && order.approval.expires_at);
    const actions = order.approval_actions || (order.approval && order.approval.actions) || [];
    return (
      <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800">
        <strong>Approval valid.</strong> Approved {order.approval.approvedAt ? "on " + (order.approval.approvedAt || "").slice(0, 10) : ""} by {order.approval.approvedBy}. Hash {order.approval.payloadHash.slice(0, 12)}...
        {expiresAt && <div className="mt-1 text-emerald-700">Expires <strong>{String(expiresAt).slice(0, 16).replace("T", " ")}</strong>. Allowed actions: {(actions || []).join(", ") || "(default set)"}.</div>}
      </div>
    );
  }
  return (
    <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800">
      <strong>Approval invalidated.</strong> {state.message || "Payload changed after approval"}. Re-approve before export.
    </div>
  );
};

const LearnedRulesPanel = ({ customerKey, learnedRules, onAccept, onDismiss }) => {
  const bucket = learnedRules && learnedRules[customerKey];
  if (!bucket) return null;
  const recurring = Object.entries(bucket.fieldEdits || {}).filter(([, info]) => info && info.count >= 2);
  if (!recurring.length) return null;
  return (
    <div className="p-3 bg-purple-50 border border-purple-200 rounded-xl text-xs text-purple-900 space-y-2">
      <div className="font-bold">Recurring corrections detected</div>
      {recurring.map(([field, info]) => (
        <div key={field} className="bg-white border border-purple-100 rounded p-2 flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold">Field <code>{field}</code> edited {info.count}x for this customer</div>
            <div className="text-purple-700 mt-1">Latest values: {(info.lastValues || []).slice(-3).map((v) => String(v.newValue)).join(", ")}</div>
          </div>
          <div className="flex gap-1">
            <button onClick={() => onAccept(field, info)} className="text-[11px] px-2 py-1 rounded bg-purple-600 text-white font-semibold">Save as customer rule</button>
            <button onClick={() => onDismiss(field)} className="text-[11px] px-2 py-1 rounded bg-white border border-purple-200 text-purple-700">Dismiss</button>
          </div>
        </div>
      ))}
    </div>
  );
};

const UOM_CANONICAL = {
  "no": "Nos", "nos": "Nos", "no.": "Nos", "nos.": "Nos", "ea": "Nos", "each": "Nos", "pcs": "Nos", "pc": "Nos", "piece": "Nos", "pieces": "Nos",
  "set": "Set", "sets": "Set",
  "pair": "Pair", "pairs": "Pair", "pr": "Pair",
  "kg": "Kg", "kgs": "Kg", "kilogram": "Kg", "kilograms": "Kg",
  "g": "Gms", "gm": "Gms", "gms": "Gms", "gram": "Gms", "grams": "Gms",
  "mtr": "Mtr", "m": "Mtr", "meter": "Mtr", "meters": "Mtr", "metre": "Mtr",
  "lt": "Ltr", "ltr": "Ltr", "liter": "Ltr", "litre": "Ltr",
  "box": "Box", "bx": "Box", "boxes": "Box",
  "roll": "Roll", "rolls": "Roll",
  "lot": "Lot", "lots": "Lot",
};

const normalizeUom = (raw) => {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return { canonical: "", changed: false };
  const canonical = UOM_CANONICAL[key];
  if (canonical && canonical !== raw) return { canonical, changed: true };
  return { canonical: raw, changed: false };
};

const annotateUomNormalization = (so) => {
  if (!so || !so.lineItems) return so;
  let changes = 0;
  const lineItems = so.lineItems.map((li) => {
    const norm = normalizeUom(li.uom);
    if (norm.changed) {
      changes++;
      return { ...li, uom: norm.canonical, uomOriginal: li.uom };
    }
    return li;
  });
  return changes ? { ...so, lineItems, uomNormalizations: changes } : so;
};

const computeMarginFromPriceComp = (so, priceComp) => {
  if (!so || !priceComp || !priceComp.lineItems) return null;
  const compByPart = {};
  priceComp.lineItems.forEach((row) => {
    const key = String(row.partNumber || row.partNo || row.sellerPartNo || "").toUpperCase();
    if (key) compByPart[key] = row;
  });
  const lines = (so.lineItems || []).map((li) => {
    const key = String(li.sellerPartNo || li.tallyItemName || li.itemName || "").toUpperCase();
    const match = compByPart[key];
    const sellingTotal = Number(li.amount) || 0;
    const landedUnit = match ? Number(match.landedCostINR != null ? match.landedCostINR : (match.unitInr != null ? match.unitInr : 0)) : 0;
    const landedTotal = landedUnit * (Number(li.qty) || 0);
    const margin = sellingTotal - landedTotal;
    const marginPct = sellingTotal > 0 ? (margin / sellingTotal) * 100 : 0;
    return { ...li, _landedTotal: landedTotal, _margin: margin, _marginPct: marginPct, _hasCost: !!match };
  });
  const totalSelling = lines.reduce((s, li) => s + (Number(li.amount) || 0), 0);
  const totalLanded = lines.reduce((s, li) => s + (Number(li._landedTotal) || 0), 0);
  const totalMargin = totalSelling - totalLanded;
  const marginPct = totalSelling > 0 ? (totalMargin / totalSelling) * 100 : 0;
  return { lines, totalSelling, totalLanded, totalMargin, marginPct, coverage: lines.filter((l) => l._hasCost).length };
};

const MarginCockpit = ({ so, priceComp, threshold, customerHistory, fxImpactInr, quoteMargin }) => {
  const data = computeMarginFromPriceComp(so, priceComp);
  if (!data) return null;
  const minPct = Number(threshold || 10);
  const tone = data.marginPct < minPct ? "red" : data.marginPct < minPct * 1.5 ? "amber" : "green";
  const cellTone = (pct, hasCost) => !hasCost ? "bg-purple-50 text-purple-700" : pct < minPct ? "bg-red-50 text-red-800" : pct < minPct * 1.5 ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800";
  return (
    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs space-y-2">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div className="font-bold text-slate-700">Margin cockpit</div>
        <div className={"font-semibold " + (tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : "text-emerald-700")}>{data.marginPct.toFixed(1)}% gross margin</div>
      </div>
      {(customerHistory || quoteMargin != null || fxImpactInr != null) && (
        <div className="grid grid-cols-3 gap-2">
          {quoteMargin != null && (
            <div className="bg-white border border-slate-200 rounded p-2">
              <div className="text-slate-400 uppercase text-[10px] font-bold">vs Quote margin</div>
              <div className={"font-mono text-sm " + ((data.marginPct - quoteMargin) < -2 ? "text-red-700" : (data.marginPct - quoteMargin) > 2 ? "text-emerald-700" : "text-slate-800")}>{(data.marginPct - quoteMargin).toFixed(1)} pp</div>
            </div>
          )}
          {customerHistory && customerHistory.medianMarginPct != null && (
            <div className="bg-white border border-slate-200 rounded p-2">
              <div className="text-slate-400 uppercase text-[10px] font-bold">vs Customer median</div>
              <div className={"font-mono text-sm " + ((data.marginPct - customerHistory.medianMarginPct) < -3 ? "text-red-700" : "text-slate-800")}>{(data.marginPct - customerHistory.medianMarginPct).toFixed(1)} pp</div>
              <div className="text-[10px] text-slate-500">n={customerHistory.sample}</div>
            </div>
          )}
          {fxImpactInr != null && (
            <div className="bg-white border border-slate-200 rounded p-2">
              <div className="text-slate-400 uppercase text-[10px] font-bold">FX impact (Rs)</div>
              <div className={"font-mono text-sm " + (fxImpactInr < 0 ? "text-red-700" : "text-emerald-700")}>{(fxImpactInr >= 0 ? "+" : "") + Math.round(fxImpactInr).toLocaleString("en-IN")}</div>
            </div>
          )}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-white border border-slate-200 rounded p-2">
          <div className="text-slate-400 uppercase text-[10px] font-bold">Selling</div>
          <div className="font-mono text-sm text-slate-800">{Math.round(data.totalSelling).toLocaleString("en-IN")}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded p-2">
          <div className="text-slate-400 uppercase text-[10px] font-bold">Landed</div>
          <div className="font-mono text-sm text-slate-800">{Math.round(data.totalLanded).toLocaleString("en-IN")}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded p-2">
          <div className="text-slate-400 uppercase text-[10px] font-bold">Margin</div>
          <div className={"font-mono text-sm font-bold " + (tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : "text-emerald-700")}>{Math.round(data.totalMargin).toLocaleString("en-IN")}</div>
        </div>
      </div>
      {data.lines.length > 0 && (
        <details>
          <summary className="cursor-pointer text-slate-600 font-semibold">Per-line breakdown ({data.coverage}/{data.lines.length} have cost data)</summary>
          <div className="mt-2 overflow-auto">
            <table className="w-full text-[11px]">
              <thead className="bg-slate-100">
                <tr><th className="text-left p-1">#</th><th className="text-left p-1">Item</th><th className="text-right p-1">Selling</th><th className="text-right p-1">Landed</th><th className="text-right p-1">Margin %</th></tr>
              </thead>
              <tbody>
                {data.lines.map((li, i) => (
                  <tr key={i} className="border-t border-slate-200">
                    <td className="p-1">{li.sno}</td>
                    <td className="p-1 truncate max-w-[180px]">{li.tallyItemName || li.itemName}</td>
                    <td className="p-1 text-right font-mono">{Math.round(Number(li.amount) || 0).toLocaleString("en-IN")}</td>
                    <td className="p-1 text-right font-mono">{li._hasCost ? Math.round(li._landedTotal).toLocaleString("en-IN") : "-"}</td>
                    <td className={"p-1 text-right font-mono " + cellTone(li._marginPct, li._hasCost)}>{li._hasCost ? li._marginPct.toFixed(1) + "%" : "no cost"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {data.coverage === 0 && (
        <div className="text-slate-500">No price-composition cost data found. Upload the price composition document or sync supplier costs to see margin.</div>
      )}
    </div>
  );
};

const SOURCE_PO_STATUSES = [
  { key: "DRAFT", label: "Draft" },
  { key: "PENDING_INTERNAL_APPROVAL", label: "Pending internal approval" },
  { key: "SENT_TO_SUPPLIER", label: "Sent to supplier" },
  { key: "SUPPLIER_ACK", label: "Supplier acknowledged" },
  { key: "PRICE_CHANGED", label: "Price changed" },
  { key: "ETA_CONFIRMED", label: "ETA confirmed" },
  { key: "DELAYED", label: "Delayed" },
  { key: "RECEIVED", label: "Received" },
  { key: "CLOSED", label: "Closed" },
  { key: "CANCELLED", label: "Cancelled" },
];

const SourcePoLifecycle = ({ spo, status, eta, onStatusChange, onEtaChange }) => {
  const current = status || "DRAFT";
  const tone = current === "CLOSED" || current === "RECEIVED" ? "bg-emerald-50 text-emerald-800 border-emerald-200" : current === "DELAYED" || current === "PRICE_CHANGED" ? "bg-amber-50 text-amber-800 border-amber-200" : current === "CANCELLED" ? "bg-red-50 text-red-700 border-red-200" : "bg-blue-50 text-blue-800 border-blue-200";
  return (
    <div className={"p-2 border rounded-xl mt-2 text-xs flex items-center gap-2 flex-wrap " + tone}>
      <span className="font-semibold">Status:</span>
      <select value={current} onChange={(e) => onStatusChange && onStatusChange(spo, e.target.value)} className="bg-white border border-slate-200 rounded p-1 text-xs">
        {SOURCE_PO_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      <span className="font-semibold ml-2">Promised ETA:</span>
      <input type="date" value={eta || ""} onChange={(e) => onEtaChange && onEtaChange(spo, e.target.value)} className="bg-white border border-slate-200 rounded p-1 text-xs" />
    </div>
  );
};

const ReconciliationGrid = ({ so, quoteLines, priceComp, onAction }) => {
  if (!so) return null;
  const quoteByKey = {};
  (quoteLines || []).forEach((q) => {
    const key = String(q.partNo || q.itemName || "").toUpperCase();
    if (key) quoteByKey[key] = q;
  });
  const priceByKey = {};
  if (priceComp && priceComp.lineItems) {
    priceComp.lineItems.forEach((p) => {
      const key = String(p.partNumber || p.partNo || "").toUpperCase();
      if (key) priceByKey[key] = p;
    });
  }
  const tone = (status) => status === "Matched" ? "text-emerald-700" : status === "Qty exceeds quote" ? "text-amber-700" : status === "PO-only" ? "text-red-700" : "text-slate-600";
  return (
    <div className="overflow-auto border border-slate-200 rounded-xl">
      <table className="w-full text-[11px]">
        <thead className="bg-slate-100 text-slate-600">
          <tr><th className="text-left p-2">PO line</th><th className="text-left p-2">Quote line</th><th className="text-left p-2">Price comp</th><th className="text-left p-2">Tally item</th><th className="text-left p-2">Status</th><th className="text-left p-2">Action</th></tr>
        </thead>
        <tbody>
          {(so.lineItems || []).map((li, idx) => {
            const key = String(li.sellerPartNo || li.tallyItemName || li.itemName || "").toUpperCase();
            const quoteHit = quoteByKey[key];
            const priceHit = priceByKey[key];
            let status = "Matched";
            if (!quoteHit) status = li.partNameSource === "po_only" ? "PO-only" : "No quote match";
            if (quoteHit && Number(li.qty) > Number(quoteHit.qty || 0)) status = "Qty exceeds quote";
            const fire = (action, payload) => onAction && onAction({ action, lineIndex: idx, payload });
            return (
              <tr key={idx} className="border-t border-slate-100">
                <td className="p-2 align-top">
                  <div className="font-semibold">{li.tallyItemName || li.itemName}</div>
                  <div className="text-slate-500">Qty {li.qty} · Rate {li.rate}</div>
                </td>
                <td className="p-2 align-top">{quoteHit ? (<><div>{quoteHit.itemName || quoteHit.description}</div><div className="text-slate-500">Qty {quoteHit.qty} · Rate {quoteHit.rate}</div></>) : <span className="text-slate-400">No match</span>}</td>
                <td className="p-2 align-top">{priceHit ? (<><div>{priceHit.sourceCountry || ""}</div><div className="text-slate-500">{priceHit.currency || ""} {priceHit.unitForeign != null ? priceHit.unitForeign : ""}</div></>) : <span className="text-slate-400">-</span>}</td>
                <td className="p-2 align-top">{li.tallyItemName || "-"}</td>
                <td className={"p-2 align-top font-semibold " + tone(status)}>{status}</td>
                <td className="p-2 align-top">
                  {onAction ? (
                    <div className="flex flex-wrap gap-1">
                      <button onClick={() => fire("accept_match")} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700">Accept</button>
                      {quoteHit && <button onClick={() => fire("use_quote_price", { rate: quoteHit.rate })} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700">Use quote price</button>}
                      {quoteHit && <button onClick={() => fire("use_po_price", { rate: li.rate })} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-800">Use PO price</button>}
                      {!quoteHit && <button onClick={() => fire("create_alias")} className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 border border-purple-200 text-purple-700">Create alias</button>}
                      <button onClick={() => fire("escalate")} className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 border border-red-200 text-red-700">Escalate</button>
                    </div>
                  ) : <span className="text-slate-400">-</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const renderTemplate = (template, vars) => {
  let out = String(template || "");
  Object.entries(vars || {}).forEach(([key, value]) => {
    out = out.replace(new RegExp("\\{\\{" + key + "\\}\\}", "g"), String(value == null ? "" : value));
  });
  return out;
};

const buildAckTemplates = (order, orgName) => {
  if (!order || !order.result) return [];
  const so = order.result.salesOrder || {};
  const po = order.result.po || {};
  const findings = order.ruleFindings || [];
  const senderName = orgName || "Obara India";
  const baseVars = {
    poNumber: order.preflightPONumber || po.number || "",
    contact: order.preflightCustomer || po.customer || "Customer",
    senderName,
  };
  const items = [];
  if (order.status === "APPROVED" || order.status === "EXPORTED_TO_TALLY") {
    items.push({
      key: "order_accepted",
      title: "Order accepted confirmation",
      body: "Subject: PO " + baseVars.poNumber + " accepted\\nHi " + baseVars.contact + ",\\n\\nWe have processed PO " + baseVars.poNumber + " and generated SO " + (so.voucherNo || "(draft)") + ". Total " + (so.grandTotal || 0).toLocaleString("en-IN") + " INR. We will keep you posted on dispatch.\\n\\nThanks,\\n" + senderName,
    });
  }
  if (!findings.length) {
    items.push({
      key: "order_received",
      title: "Order received acknowledgement",
      body: "Subject: Order received: PO " + baseVars.poNumber + "\\nHi " + baseVars.contact + ",\\n\\nWe have received PO " + baseVars.poNumber + " and started preflight validation. We will revert with the SO confirmation shortly.\\n\\nThanks,\\n" + senderName,
    });
  }
  findings.forEach((finding) => {
    const playbook = EXCEPTION_PLAYBOOKS[finding.code];
    if (!playbook || !playbook.emailTemplate) return;
    const vars = { ...baseVars, lineSummary: finding.detail || "", partNo: finding.partNo || "", poQty: finding.poQty || "", quoteQty: finding.quoteQty || "" };
    items.push({
      key: finding.code,
      title: finding.label || finding.code,
      body: renderTemplate(playbook.emailTemplate, vars),
    });
  });
  return items.filter((item, idx, arr) => arr.findIndex((other) => other.key === item.key) === idx);
};

const CustomerAckPanel = ({ order, onCopy }) => {
  const templates = buildAckTemplates(order, "Obara India Sales");
  if (!templates.length) return null;
  const [active, setActive] = useState(0);
  const current = templates[Math.min(active, templates.length - 1)];
  const safeBody = String(current.body || "").replace(/\\n/g, "\n");
  return (
    <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs space-y-2">
      <div className="flex justify-between items-center">
        <div className="font-bold text-blue-800">Customer acknowledgement drafts</div>
        <select value={active} onChange={(e) => setActive(Number(e.target.value))} className="bg-white border border-blue-200 rounded p-1 text-xs">
          {templates.map((t, i) => <option key={t.key} value={i}>{t.title}</option>)}
        </select>
      </div>
      <textarea
        readOnly
        value={safeBody}
        rows={6}
        className="w-full border border-blue-200 rounded p-2 text-xs font-mono bg-white"
      />
      <div className="flex gap-2">
        <button
          onClick={async () => {
            try { await navigator.clipboard.writeText(safeBody); }
            catch (_) { onCopy && onCopy(safeBody); }
          }}
          className="px-3 py-1.5 rounded bg-blue-600 text-white font-semibold"
        >
          Copy to clipboard
        </button>
        <button
          onClick={() => onCopy && onCopy(safeBody)}
          className="px-3 py-1.5 rounded bg-white border border-blue-300 text-blue-700 font-semibold"
        >
          Show in modal
        </button>
      </div>
      <div className="text-blue-700 text-[11px]">Templates are pre-filled from issue codes. Review tone and details before sending. Sending is not automated.</div>
    </div>
  );
};

const PlaybookPanel = ({ findings, onApply }) => {
  if (!findings || !findings.length) return null;
  const grouped = findings.reduce((acc, f) => {
    if (!acc[f.code]) acc[f.code] = { code: f.code, label: f.label, severity: f.severity, count: 0, examples: [] };
    acc[f.code].count++;
    acc[f.code].examples.push(f.detail);
    return acc;
  }, {});
  const items = Object.values(grouped);
  return (
    <div className="p-3 bg-purple-50 border border-purple-200 rounded-xl text-xs space-y-2">
      <div className="font-bold text-purple-800">Recommended playbooks</div>
      {items.map((g) => {
        const playbook = EXCEPTION_PLAYBOOKS[g.code];
        if (!playbook) return null;
        return (
          <div key={g.code} className="bg-white border border-purple-100 rounded p-2">
            <div className="font-semibold text-purple-900">{g.label || g.code} <span className="text-purple-500 font-normal">({g.count}x)</span></div>
            <div className="text-purple-700 mt-1">{g.examples.slice(0, 2).join(" · ")}</div>
            <div className="flex gap-2 mt-2 flex-wrap">
              {(playbook.actions || []).map((a) => (
                <button key={a.id} onClick={() => onApply && onApply(g.code, a)} className={"px-2 py-1 rounded text-[11px] font-semibold " + (a.autoFix ? "bg-purple-600 text-white" : "bg-white border border-purple-300 text-purple-700")}>
                  {a.autoFix ? "Auto-fix: " : ""}{a.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const CommunicationTimeline = ({ events }) => {
  if (!events || !events.length) return null;
  return (
    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs">
      <div className="font-bold text-slate-700 mb-2">Communication and process timeline</div>
      <div className="relative pl-6">
        <div className="absolute top-0 bottom-0 left-2 w-px bg-slate-300"></div>
        {events.map((e, i) => (
          <div key={i} className="relative mb-3">
            <div className="absolute -left-[18px] top-1 w-3 h-3 rounded-full bg-slate-500 border-2 border-white"></div>
            <div className="font-semibold text-slate-800">{e.action || e.event_type || "event"}</div>
            <div className="text-slate-500 font-mono">{(e.created_at || e.at || "").slice(0, 19).replace("T", " ")}</div>
            {e.detail && <div className="text-slate-600 mt-0.5">{typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
};

const QuoteFreshnessEditor = ({ profile, onSave }) => {
  const [value, setValue] = useState((profile && profile.quoteValidityDays) || 90);
  useEffect(() => { setValue((profile && profile.quoteValidityDays) || 90); }, [profile && profile.customerKey]);
  if (!profile) return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-500">Quote validity (days)</span>
      <input
        type="number"
        min="1"
        max="730"
        value={value}
        onChange={(e) => setValue(Number(e.target.value || 0))}
        onBlur={() => onSave && onSave(profile.customerKey, value)}
        className="w-20 border border-slate-300 rounded p-1 text-right font-mono"
      />
    </div>
  );
};

const SoHistoryHint = ({ partNo, customerKey, orders }) => {
  if (!partNo || !customerKey) return null;
  const matches = [];
  (orders || []).forEach((o) => {
    if (!o || o.customerKey !== customerKey || !o.result || !o.result.salesOrder) return;
    (o.result.salesOrder.lineItems || []).forEach((li) => {
      const key = (li.tallyItemName || li.itemName || li.sellerPartNo || "").toUpperCase();
      if (key === partNo.toUpperCase()) {
        matches.push({ rate: Number(li.rate) || 0, qty: Number(li.qty) || 0, when: o.createdAt, voucherNo: o.result.salesOrder.voucherNo });
      }
    });
  });
  if (!matches.length) return null;
  matches.sort((a, b) => (b.when || "").localeCompare(a.when || ""));
  const last = matches[0];
  return (
    <span className="text-[11px] text-slate-500" title={"Sold " + matches.length + " time(s) before"}>
      Last: {last.rate.toLocaleString("en-IN")} on {(last.when || "").slice(0, 10)}
    </span>
  );
};

const EvidenceViewer = ({ orderId, evidenceByField, onClose, focusField }) => {
  const [activeField, setActiveField] = useState(focusField || (evidenceByField ? Object.keys(evidenceByField)[0] : null));
  const [serverEvidence, setServerEvidence] = useState([]);
  const [pdfPage, setPdfPage] = useState(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    if (!orderId) return;
    if (window.ObaraBackend && window.ObaraBackend.isReady && window.ObaraBackend.isReady()) {
      window.ObaraBackend.orders.get(orderId).then((res) => {
        if (cancelled) return;
        setServerEvidence((res && res.evidence) || []);
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [orderId]);
  const allEvidence = useMemo(() => {
    const list = [];
    if (evidenceByField) Object.entries(evidenceByField).forEach(([field, ev]) => list.push({ field, source: "local", ...ev }));
    serverEvidence.forEach((ev) => list.push({
      field: ev.field_path, source: "server", document: ev.document_id, page: ev.page_number,
      bbox: ev.bbox, snippet: ev.snippet, value: ev.value, confidence: ev.confidence,
      documentId: ev.document_id,
    }));
    return list;
  }, [evidenceByField, serverEvidence]);
  const current = allEvidence.find((row) => row.field === activeField) || allEvidence[0] || null;
  useEffect(() => {
    let cancelled = false;
    const renderPdf = async () => {
      if (!current || !current.documentId || !current.page || !window.ObaraBackend || !window.ObaraBackend.isReady()) return;
      try {
        const docMeta = await window.ObaraBackend.documents.fetch(current.documentId);
        if (cancelled || !docMeta || !docMeta.downloadUrl) return;
        const pdfjs = await loadPdfJs();
        const fetched = await fetch(docMeta.downloadUrl);
        const buf = await fetched.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: buf }).promise;
        const page = await pdf.getPage(current.page);
        const viewport = page.getViewport({ scale: 1.4 });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        if (cancelled) return;
        setPdfPage({ width: viewport.width, height: viewport.height, basePageWidth: current.bbox && current.bbox.page_width ? current.bbox.page_width : viewport.width / 1.4, basePageHeight: current.bbox && current.bbox.page_height ? current.bbox.page_height : viewport.height / 1.4 });
      } catch (err) {
        if (typeof console !== "undefined") console.warn("PDF render failed:", err.message);
      }
    };
    renderPdf();
    return () => { cancelled = true; };
  }, [current && current.documentId, current && current.page]);
  const overlayStyle = (bbox, page) => {
    if (!bbox || !page) return null;
    const scaleX = page.width / (bbox.page_width || page.basePageWidth);
    const scaleY = page.height / (bbox.page_height || page.basePageHeight);
    return {
      left: (bbox.x0 * scaleX) + "px",
      top: (bbox.y0 * scaleY) + "px",
      width: ((bbox.x1 - bbox.x0) * scaleX) + "px",
      height: ((bbox.y1 - bbox.y0) * scaleY) + "px",
    };
  };
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.65)", display:"flex", alignItems:"stretch", justifyContent:"center", zIndex:400, padding:16 }}>
      <Card className="w-full" style={{ maxWidth:1100, maxHeight:"92vh", display:"flex", flexDirection:"column", overflow:"hidden" }}>
        <CardHead title="Field Evidence Viewer" sub={current ? current.field : "No evidence"} accent="#0e7490" right={<button onClick={onClose} className="text-xs text-slate-700 border border-slate-200 bg-white px-3 py-1 rounded font-semibold">Close</button>} />
        <div className="flex flex-1 min-h-0">
          <div className="w-64 border-r border-slate-200 overflow-auto p-2">
            <input
              placeholder="Filter fields..."
              onChange={(e) => {
                const q = e.target.value.toLowerCase();
                document.querySelectorAll("[data-evidence-row]").forEach((row) => {
                  const text = row.getAttribute("data-evidence-row").toLowerCase();
                  row.style.display = !q || text.includes(q) ? "block" : "none";
                });
              }}
              className="w-full mb-2 border border-slate-300 rounded p-1 text-xs"
            />
            {allEvidence.length === 0 && <div className="text-xs text-slate-400 p-2">No evidence captured.</div>}
            {allEvidence.map((ev, i) => (
              <div
                key={i}
                data-evidence-row={ev.field + " " + (ev.snippet || ev.value || "")}
                onClick={() => setActiveField(ev.field)}
                className={"text-xs cursor-pointer p-2 rounded mb-1 " + (activeField === ev.field ? "bg-blue-50 border border-blue-200" : "hover:bg-slate-50")}
              >
                <div className="font-mono font-semibold truncate">{ev.field}</div>
                <div className="text-slate-500 truncate">{ev.source === "server" ? "Page " + (ev.page || "?") : "Local"} {ev.confidence != null ? "· " + Math.round(ev.confidence * 100) + "%" : ""}</div>
              </div>
            ))}
          </div>
          <div className="flex-1 overflow-auto p-3 bg-slate-100">
            {current ? (
              <div>
                <div className="bg-white border border-slate-200 rounded p-2 text-xs mb-2">
                  <div className="font-semibold text-slate-700">{current.field}</div>
                  <div className="text-slate-500 mt-1">Snippet:</div>
                  <div className="italic text-slate-800">"{current.snippet || current.value || ""}"</div>
                  {current.bbox && <div className="text-slate-500 mt-1">bbox: [{Math.round(current.bbox.x0)}, {Math.round(current.bbox.y0)}, {Math.round(current.bbox.x1)}, {Math.round(current.bbox.y1)}]</div>}
                </div>
                <div style={{ position:"relative", display:"inline-block" }}>
                  <canvas ref={canvasRef} style={{ background:"#fff", border:"1px solid #cbd5e1" }} />
                  {current.bbox && pdfPage && (
                    <div ref={overlayRef} style={{ position:"absolute", border:"3px solid #f97316", background:"rgba(249,115,22,0.15)", pointerEvents:"none", ...overlayStyle(current.bbox, pdfPage) }} />
                  )}
                </div>
                {!current.bbox && <div className="text-xs text-slate-500">No bounding box for this field. Run server-side OCR to capture coordinates.</div>}
              </div>
            ) : (
              <div className="text-slate-500">Pick a field on the left to view its evidence.</div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
};

const FXVarianceBadge = ({ currency, variancePct }) => {
  if (!currency || variancePct == null) return null;
  const tone = Math.abs(variancePct) > 5 ? "bg-red-100 text-red-800 border-red-300" : Math.abs(variancePct) > 3 ? "bg-amber-100 text-amber-800 border-amber-300" : "bg-emerald-100 text-emerald-800 border-emerald-300";
  return (
    <span className={"text-[11px] font-semibold border rounded px-2 py-0.5 " + tone}>{currency} {variancePct > 0 ? "+" : ""}{variancePct.toFixed(2)}%</span>
  );
};

const computeFxVariance = (priceComp, fxRates) => {
  if (!priceComp || !priceComp.lineItems || !fxRates) return null;
  const out = {};
  Object.entries(fxRates).forEach(([currency, info]) => {
    if (!info || !info.atQuote || !info.atPo) return;
    const variance = ((info.atPo - info.atQuote) / info.atQuote) * 100;
    out[currency] = { ...info, variancePct: variance };
  });
  return out;
};

const DeliveryPromisePanel = ({ orderId, customerId, sourcePos, requestedDate }) => {
  const [state, setState] = useState({ loading: !!sourcePos && sourcePos.length > 0 });
  useEffect(() => {
    let cancelled = false;
    if (!sourcePos || !sourcePos.length) { setState({ loading: false }); return; }
    if (!window.ObaraBackend || !window.ObaraBackend.isReady || !window.ObaraBackend.isReady()) {
      setState({ loading: false, offline: true });
      return;
    }
    setState({ loading: true });
    window.ObaraBackend.delivery.promise({
      customerId,
      requestedDate,
      sourcePos: (sourcePos || []).map((s) => ({ country: s.country, supplier: s.supplier, baseDate: s.baseDate || null })),
    }).then((res) => { if (!cancelled) setState({ loading: false, data: res }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, error: err.message }); });
    return () => { cancelled = true; };
  }, [orderId, customerId, requestedDate, JSON.stringify(sourcePos || [])]);
  if (state.offline) return null;
  if (state.loading) return <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-500">Calculating delivery promise...</div>;
  if (state.error) return <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">Delivery promise unavailable: {state.error}</div>;
  if (!state.data) return null;
  const tone = state.data.risk === "green" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : state.data.risk === "amber" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-red-300 bg-red-50 text-red-900";
  return (
    <div className={"p-3 border rounded-xl text-xs space-y-2 " + tone}>
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <div className="font-bold">Predicted ship date: {state.data.predictedShipDate || "n/a"}</div>
          {state.data.requestedDate && <div className="opacity-80">Customer requested: {state.data.requestedDate} · gap {state.data.gapDays} day(s)</div>}
        </div>
        <Pill label={"Risk: " + state.data.risk} color={state.data.risk === "green" ? "green" : state.data.risk === "amber" ? "amber" : "red"} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {(state.data.breakdown || []).map((row, i) => (
          <div key={i} className="bg-white border border-slate-200 rounded p-2">
            <div className="font-semibold text-slate-700">{row.country}{row.supplier ? " · " + row.supplier : ""}</div>
            <div className="text-slate-500">Lead {row.leadDays} days</div>
            <div className="text-slate-500">Supplier ETA: {row.supplierEta}</div>
            <div className="text-slate-700 font-mono">Internal ready: {row.internalEta}</div>
            {(row.skippedSupplierHolidays || []).length > 0 && <div className="text-[11px] text-slate-400 mt-1">Skipped {row.skippedSupplierHolidays.length} supplier holidays</div>}
          </div>
        ))}
      </div>
    </div>
  );
};

const InventoryStatusPill = ({ status }) => {
  const map = {
    in_stock: { label: "In stock", color: "green" },
    partial: { label: "Partial", color: "amber" },
    source_po_required: { label: "Source PO required", color: "blue" },
    below_reorder: { label: "Below reorder", color: "red" },
    no_data: { label: "No data", color: "slate" },
  };
  const meta = map[status] || map.no_data;
  return <Pill label={meta.label} color={meta.color} />;
};

const PlaybookHintsPanel = ({ profile }) => {
  if (!profile || !profile.fingerprint) return null;
  const fp = profile.fingerprint;
  const hints = [];
  if (fp.layout === "sap_block" || fp.layout === "vertical_block") hints.push("Customer usually sends SAP vertical POs. Use Net Pr/Unit, not Gross Price.");
  if (fp.documentType === "scanned_pdf") hints.push("Customer typically sends scanned PDFs. Run server OCR for bbox provenance.");
  if (profile.lastFormatChanged) hints.push("Format changed in the last submission. Verify line totals carefully.");
  if (profile.trusted) hints.push("This customer is pinned trusted. Local extraction template will be tried first.");
  if (Array.isArray(fp.headerKeywords) && fp.headerKeywords.length) hints.push("Expected line item columns: " + fp.headerKeywords.join(", "));
  if (!hints.length) return null;
  return (
    <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-xl text-xs space-y-1">
      <div className="font-bold text-indigo-800">Customer playbook hints</div>
      {hints.map((h, i) => (<div key={i} className="text-indigo-900">- {h}</div>))}
    </div>
  );
};

const AliasSuggestionPanel = ({ customerKey, partNumbers, onApply }) => {
  const [suggestions, setSuggestions] = useState([]);
  useEffect(() => {
    let cancelled = false;
    if (!customerKey || !partNumbers || !partNumbers.length || !window.ObaraBackend || !window.ObaraBackend.isReady()) return;
    window.ObaraBackend.aliases.list({ customer_key: customerKey }).then((res) => {
      if (cancelled) return;
      const map = new Map();
      (res && res.aliases || []).forEach((a) => map.set(String(a.customer_part_no || "").toUpperCase(), a));
      const hits = [];
      partNumbers.forEach((pn) => {
        const m = map.get(String(pn || "").toUpperCase());
        if (m) hits.push(m);
      });
      setSuggestions(hits.slice(0, 5));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [customerKey, JSON.stringify(partNumbers || [])]);
  if (!suggestions.length) return null;
  return (
    <div className="p-2 bg-amber-50 border border-amber-200 rounded-xl text-xs space-y-1">
      <div className="font-bold text-amber-800">Known customer part aliases</div>
      {suggestions.map((s) => (
        <div key={s.id || s.customer_part_no} className="flex justify-between items-center">
          <span className="font-mono">{s.customer_part_no}</span>
          <span className="text-amber-700">-&gt; {s.obara_part_no}</span>
          {onApply && <button onClick={() => onApply(s)} className="ml-2 text-[10px] px-2 py-0.5 rounded bg-white border border-amber-300 text-amber-800 font-semibold">Apply</button>}
        </div>
      ))}
    </div>
  );
};

const WhyPanel = ({ items }) => {
  if (!items || !items.length) return null;
  return (
    <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs space-y-2">
      <div className="font-bold text-slate-700">Decision explanations</div>
      {items.map((item, i) => (
        <div key={i} className="bg-white border border-slate-100 rounded p-2">
          <div className="font-semibold text-slate-800">{item.decision}</div>
          <div className="text-slate-600 mt-0.5">Reason: {item.reason}</div>
          {item.evidence && <div className="italic text-slate-700 mt-0.5">Evidence: "{item.evidence}"</div>}
          <div className="text-slate-500 mt-0.5">Risk: <strong className={item.risk === "low" ? "text-emerald-700" : item.risk === "medium" ? "text-amber-700" : "text-red-700"}>{item.risk || "low"}</strong></div>
        </div>
      ))}
    </div>
  );
};

const buildDecisionExplanations = (order) => {
  if (!order || !order.result || !order.result.salesOrder) return [];
  const so = order.result.salesOrder;
  const items = [];
  const sample = (so.lineItems || [])[0];
  if (sample) {
    items.push({
      decision: "Used quote seller part number as Tally item",
      reason: "Quote came from Obara systems and matches Tally stock master naming",
      evidence: sample.tallyItemName || sample.itemName,
      risk: sample.partNameMismatch ? "medium" : "low",
    });
  }
  if (order.result && order.result.priceComposition) {
    items.push({
      decision: "Source country and currency assignment",
      reason: "Price composition Source Country column drove supplier and FX rate",
      evidence: ((order.result.sourcePOs || []).map((s) => s.country + " " + s.currency).join(" | ")) || "",
      risk: order.result.sourcePOs && order.result.sourcePOs.length ? "low" : "medium",
    });
  }
  if (order.formatStatus === "changed") {
    items.push({
      decision: "Format change detected",
      reason: "Customer's previous fingerprint did not match this PO. Profile updated automatically",
      evidence: order.formatChangeSummary || "",
      risk: "medium",
    });
  }
  if (order.evidenceCoverage) {
    items.push({
      decision: "Evidence captured",
      reason: order.evidenceCoverage + " field(s) traced to source documents",
      risk: "low",
    });
  }
  return items;
};

const LostMarginWarning = ({ band, currentRate }) => {
  if (!band || !band.medianRate || !currentRate) return null;
  const diffPct = ((Number(currentRate) - Number(band.medianRate)) / Number(band.medianRate)) * 100;
  if (Math.abs(diffPct) < 5) return null;
  const tone = diffPct < 0 ? "bg-red-50 border-red-200 text-red-800" : "bg-emerald-50 border-emerald-200 text-emerald-800";
  return (
    <div className={"px-2 py-1 rounded text-[11px] font-semibold border " + tone}>
      {diffPct < 0 ? "Below" : "Above"} typical by {Math.abs(diffPct).toFixed(1)}% (median {Math.round(band.medianRate).toLocaleString("en-IN")})
    </div>
  );
};

const RepeatOrderSuggestion = ({ band }) => {
  if (!band || !band.lastRate || !band.lastAt) return null;
  const days = Math.round((Date.now() - new Date(band.lastAt).getTime()) / 86400000);
  if (days < 30 || days > 240) return null;
  return (
    <div className="px-2 py-1 rounded text-[11px] font-semibold bg-blue-50 text-blue-800 border border-blue-200">
      Repeat order due. Last order {days} days ago at Rs {Math.round(band.lastRate).toLocaleString("en-IN")}.
    </div>
  );
};

const AmendmentDiffPanel = ({ amendment }) => {
  if (!amendment || !amendment.changes) return null;
  const tone = amendment.amendmentType === "qty" ? "bg-amber-50 border-amber-200" : amendment.amendmentType === "price" ? "bg-red-50 border-red-200" : "bg-blue-50 border-blue-200";
  return (
    <div className={"p-3 border rounded-xl text-xs space-y-1 " + tone}>
      <div className="font-bold">PO amendment detected ({amendment.amendmentType})</div>
      {amendment.changes.slice(0, 12).map((c, i) => (
        <div key={i} className="bg-white border border-slate-100 rounded p-1.5">
          <div className="font-semibold">{c.kind} {c.line && (c.line.tallyItemName || c.line.itemName) || ""}</div>
          {c.fields && c.fields.map((f, fi) => (
            <div key={fi} className="text-slate-600">{f.field}: <span className="line-through text-red-700">{String(f.old)}</span> -&gt; <span className="text-emerald-700">{String(f.new)}</span></div>
          ))}
        </div>
      ))}
    </div>
  );
};

const RevisionWarning = ({ matches }) => {
  if (!matches || !matches.length) return null;
  return (
    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 space-y-1.5">
      <div className="font-bold">Possible PO revision or near-duplicate</div>
      {matches.slice(0, 3).map((m) => (
        <div key={m.id} className="bg-white border border-amber-100 rounded p-2">
          <span className="font-semibold">{m.po_number || m.id}</span>
          <span className="text-slate-500"> · {m.similarity}% similar · status {m.status}</span>
        </div>
      ))}
      <div className="text-amber-700">Treat as amendment if qty/price differs but PO number matches.</div>
    </div>
  );
};

const LineItemEditor = ({ item, onSave, onCancel, onRemove }) => {
  const [draft, setDraft] = useState(() => ({
    tallyItemName: item.tallyItemName || item.itemName || "",
    hsnCode: item.hsnCode || "",
    custPartNo: item.custPartNo || "",
    sellerPartNo: item.sellerPartNo || "",
    uom: item.uom || "",
    qty: Number(item.qty) || 0,
    rate: Number(item.rate) || 0,
    discount: Number(item.discount) || 0,
    cgst: Number(item.cgst) || 0,
    sgst: Number(item.sgst) || 0,
    igst: Number(item.igst) || 0,
    dueDate: item.dueDate || "",
  }));
  const preview = recomputeLineItem({ ...item, ...draft });
  const upd = (field, value) => setDraft((prev) => ({ ...prev, [field]: value }));
  const numField = (label, field, step) => (
    <label className="text-[10px] font-bold text-slate-500 uppercase">
      {label}
      <input
        type="number"
        step={step || "0.01"}
        value={draft[field]}
        onChange={(e) => upd(field, Number(e.target.value || 0))}
        className="mt-1 w-full border border-slate-300 rounded-lg p-2 text-sm font-mono normal-case font-normal bg-white"
      />
    </label>
  );
  const txtField = (label, field) => (
    <label className="text-[10px] font-bold text-slate-500 uppercase">
      {label}
      <input
        type="text"
        value={draft[field]}
        onChange={(e) => upd(field, e.target.value)}
        className="mt-1 w-full border border-slate-300 rounded-lg p-2 text-sm normal-case font-normal bg-white"
      />
    </label>
  );
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(15,23,42,.55)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:300, padding:16 }}>
      <Card className="w-full" style={{ maxWidth:640, maxHeight:"90vh", overflow:"auto" }}>
        <CardHead title={"Edit line " + (item.sno || "?")} sub={item.tallyItemName || item.itemName || "Untitled item"} accent="#7c2d12" />
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {txtField("Tally item name", "tallyItemName")}
            {txtField("HSN", "hsnCode")}
            {txtField("Customer P/N", "custPartNo")}
            {txtField("Seller P/N", "sellerPartNo")}
            {txtField("UOM", "uom")}
            {txtField("Due date", "dueDate")}
            {numField("Qty", "qty", "1")}
            {numField("Rate", "rate")}
            {numField("Discount %", "discount")}
            {numField("CGST %", "cgst")}
            {numField("SGST %", "sgst")}
            {numField("IGST %", "igst")}
          </div>
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs">
            <div className="font-bold text-slate-500 mb-2">Recomputed totals</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
              <span className="text-slate-400">Amount</span><span className="text-right">{preview.amount}</span>
              <span className="text-slate-400">CGST</span><span className="text-right">{preview.cgstAmt}</span>
              <span className="text-slate-400">SGST</span><span className="text-right">{preview.sgstAmt}</span>
              <span className="text-slate-400">IGST</span><span className="text-right">{preview.igstAmt}</span>
              <span className="text-slate-400 font-bold">Total inc GST</span><span className="text-right font-bold">{preview.totalWithGst}</span>
            </div>
          </div>
          <div className="p-2 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
            Saving an edit moves the order back to Pending Review. Discrepancy flags from the original Claude run are preserved for audit.
          </div>
          <div className="flex justify-between gap-2">
            <button onClick={onRemove} className="text-xs text-red-700 border border-red-200 bg-red-50 px-3 py-2 rounded-xl hover:bg-red-100 font-semibold">Remove line</button>
            <div className="flex gap-2">
              <button onClick={onCancel} className="text-xs text-slate-600 border border-slate-200 bg-white px-3 py-2 rounded-xl">Cancel</button>
              <button onClick={() => onSave(draft)} className="text-xs text-white bg-blue-700 px-3 py-2 rounded-xl font-semibold">Save line</button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
};

const FreshnessAlerts = ({ pf }) => {
  const alerts = docFreshnessAlerts(pf);
  if (!alerts.length) return null;
  return (
    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs space-y-1.5">
      <div className="font-bold text-amber-800">Document freshness</div>
      {alerts.map((a, i) => (
        <div key={i} className="text-amber-800">
          <strong>{a.label}.</strong> <span className="opacity-80">{a.detail}.</span>
        </div>
      ))}
    </div>
  );
};

const GSTINBadge = ({ gstin }) => {
  if (!gstin) return null;
  const v = validateGSTIN(gstin);
  if (v.ok) return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">GSTIN valid</span>;
  return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200" title={v.message}>GSTIN check needed</span>;
};

const BudgetEditor = ({ profile, budgets, onChange }) => {
  if (!profile) return null;
  const current = Number((budgets && budgets[profile.customerKey]) || 0);
  const [val, setVal] = useState(current);
  useEffect(() => { setVal(current); }, [current]);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-500">Monthly USD budget</span>
      <input
        type="number"
        step="0.5"
        min="0"
        value={val}
        onChange={(e) => setVal(Number(e.target.value || 0))}
        onBlur={() => onChange(profile.customerKey, val)}
        className="w-20 border border-slate-300 rounded p-1 text-right font-mono"
      />
    </div>
  );
};

const DropZone = ({ label, file, setFile, inputRef, icon, optional }) => (`,
  "cost and document UI components",
);

patchSo(
  `<input ref={inputRef} type="file" accept=".pdf,.xlsx,.xls,image/*" className="hidden" onChange={(e) => setFile(e.target.files[0])} />`,
  `<input ref={inputRef} type="file" accept=".pdf,.xlsx,.xls,.csv,.tsv,.txt,image/*" className="hidden" onChange={(e) => setFile(e.target.files[0])} />`,
  "dropzone accept formats",
);

patchSo(
  `{optional ? "Optional · PDF, Excel · drag or click" : "PDF · drag and drop or click"}`,
  `{optional ? "Optional · PDF, Excel, CSV, TSV, TXT · drag or click" : "PDF, image, Excel, CSV, TSV, TXT · drag or click"}`,
  "dropzone format copy",
);

patchSo(
  `const [tokenEst, setTokenEst]           = useState(null); // token estimate for current files`,
  `const [tokenEst, setTokenEst]           = useState(null); // token estimate for current files
  const [costPolicy, setCostPolicy]       = useState(DEFAULT_COST_POLICY);
  const [orderMode, setOrderMode]         = useState("SPARES"); // SPARES, SPARES_ASSEMBLY, PROJECT_FOR, PROJECT_HSS, INTERNAL
  const [poNumberHint, setPoNumberHint]   = useState("");
  const [docMetas, setDocMetas]           = useState([]);
  const [docFingerprint, setDocFingerprint] = useState(null);
  const [customerBudgets, setCustomerBudgets] = useState({});
  const [auditLog, setAuditLog]           = useState([]);
  const [historyFilter, setHistoryFilter] = useState({ q: "", status: "" });
  const [compareTarget, setCompareTarget] = useState(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState({});
  const [storageStatus, setStorageStatus] = useState(null);
  const [editLineItem, setEditLineItem] = useState(null);
  const [ocrTextByLabel, setOcrTextByLabel] = useState({});
  const [ocrBusyLabel, setOcrBusyLabel] = useState(null);
  const [learnedRules, setLearnedRules] = useState({});
  const [showEvidenceFor, setShowEvidenceFor] = useState(null);
  const [sourcePoLifecycle, setSourcePoLifecycle] = useState({});
  const [duplicateMatches, setDuplicateMatches] = useState([]);
  const [inventoryByPart, setInventoryByPart] = useState({});
  const [fxVariance, setFxVariance] = useState(null);
  const [evidenceFocusField, setEvidenceFocusField] = useState(null);
  const [marginHistory, setMarginHistory] = useState(null);
  const [priceBands, setPriceBands] = useState({});
  const [amendments, setAmendments] = useState([]);
  const [decisionExplanations, setDecisionExplanations] = useState([]);
  const [reuseOrder, setReuseOrder]       = useState(null);`,
  "SO app state",
);

patchSo(
  `const pcMime = useRef("application/pdf");`,
  `const pcMime = useRef("application/pdf");
  const poDocRef = useRef(null);
  const quoteDocRef = useRef(null);
  const priceCompDocRef = useRef(null);
  const forceReprocess = useRef(false);`,
  "document refs",
);

patchSo(
  `loadFormats().then((f) => setCustomerFormats(f));`,
  `migrateStorageIfNeeded().finally(() => loadFormats().then((f) => setCustomerFormats(f)));
    loadCostPolicy().then((p) => setCostPolicy(p));
    loadBudgets().then((b) => setCustomerBudgets(b));
    loadAuditLog().then((l) => setAuditLog(l));
    loadLearnedRules().then((r) => setLearnedRules(r));`,
  "load cost policy",
);

patchSo(
  `  // Recompute token estimate whenever files change`,
  String.raw`  useEffect(() => {
    const handler = (event) => {
      const nextTab = event && event.detail && event.detail.tab;
      if (nextTab) setTab(nextTab);
    };
    window.addEventListener("so-agent:navigate", handler);
    return () => window.removeEventListener("so-agent:navigate", handler);
  }, []);

  // Recompute token estimate whenever files change`,
  "SO agent navigation event",
);

patchSo(
  `const sourcePOs = (activeOrder && activeOrder.result && activeOrder.result.sourcePOs) || [];`,
  `const sourcePOs = (activeOrder && activeOrder.result && activeOrder.result.sourcePOs) || [];
  const currentCustomerKey = pf ? normalizeCustomerKey(pf.poVendorGSTIN, pf.poVendorName) : "";
  const currentKnownProfile = currentCustomerKey ? customerFormats[currentCustomerKey] : null;
  const currentProfileState = profileStability(currentKnownProfile);
  const formatReuseActive = !!(currentKnownProfile && currentKnownProfile.trusted && ["stable","extractor_ready"].includes(currentProfileState.key));`,
  "current profile state",
);

patchSo(
  `const reset = useCallback(() => {
    setStage("idle"); setPoFile(null); setQuoteFile(null); setPriceCompFile(null);
    setEngineerNote(""); setPf(null); setIsDup(false); setDupOrder(null);
    setError(null); setFormatStatus(null); setTokenEst(null);
    b64po.current = null; b64q.current = null; b64pc.current = null;
  }, []);`,
  String.raw`const updateCostPolicy = useCallback(async (next) => {
    const normalized = normalizeCostPolicy(next);
    setCostPolicy(normalized);
    await saveCostPolicy(normalized);
    await recordAudit("cost_policy_change", "Mode=" + normalized.mode + " · Cache=" + normalized.promptCache, null);
  }, []);

  const updateCustomerBudget = useCallback(async (customerKey, usdPerMonth) => {
    if (!customerKey) return;
    const next = { ...customerBudgets, [customerKey]: Number(usdPerMonth || 0) };
    if (!next[customerKey]) delete next[customerKey];
    setCustomerBudgets(next);
    await saveBudgets(next);
    await recordAudit("budget_change", "Customer " + customerKey + " budget set to USD " + (usdPerMonth || 0).toFixed(2), null);
  }, [customerBudgets]);

  const refreshAuditLog = useCallback(async () => {
    const log = await loadAuditLog();
    setAuditLog(log);
  }, []);

  const refreshInventoryFor = useCallback(async (order) => {
    try {
      if (!order || !order.result || !order.result.salesOrder || !order.result.salesOrder.lineItems) return;
      if (!window.ObaraBackend || !window.ObaraBackend.isReady || !window.ObaraBackend.isReady()) return;
      const lineItems = order.result.salesOrder.lineItems.map((li) => ({ partNo: li.tallyItemName || li.itemName || li.sellerPartNo, qty: Number(li.qty) || 0 }));
      const result = await window.ObaraBackend.inventory.availability(lineItems);
      const map = {};
      (result && result.lines || []).forEach((row) => { map[(row.partNo || "").toUpperCase()] = row; });
      setInventoryByPart(map);
    } catch (err) {
      if (typeof console !== "undefined") console.warn("Inventory check failed:", err.message);
    }
  }, []);

  useEffect(() => {
    if (activeOrder && activeOrder.id) refreshInventoryFor(activeOrder);
  }, [activeOrder && activeOrder.id, refreshInventoryFor]);

  const refreshFxVariance = useCallback(async (order) => {
    try {
      if (!order || !order.result || !order.result.priceComposition) return;
      if (!window.ObaraBackend || !window.ObaraBackend.isReady || !window.ObaraBackend.isReady()) return;
      const quoteDate = order.result.quote && order.result.quote.date;
      const poDate = order.result.po && order.result.po.date;
      const lineCcys = new Set();
      (order.result.priceComposition.lineItems || []).forEach((row) => {
        const ccy = String(row.currency || "").toUpperCase();
        if (ccy && ccy !== "INR") lineCcys.add(ccy);
      });
      if (!lineCcys.size) return;
      const out = {};
      for (const ccy of lineCcys) {
        try {
          const atQuote = quoteDate ? await window.ObaraBackend.fx.lookup({ as_of: quoteDate, from: ccy, to: "INR" }) : null;
          const atPo = poDate ? await window.ObaraBackend.fx.lookup({ as_of: poDate, from: ccy, to: "INR" }) : null;
          out[ccy] = {
            atQuote: atQuote && atQuote.rate && Number(atQuote.rate.rate) || null,
            atPo: atPo && atPo.rate && Number(atPo.rate.rate) || null,
          };
        } catch (_) {}
      }
      setFxVariance(computeFxVariance(order.result.priceComposition, out));
    } catch (err) {
      if (typeof console !== "undefined") console.warn("FX variance fetch failed:", err.message);
    }
  }, []);

  useEffect(() => {
    if (activeOrder) refreshFxVariance(activeOrder);
  }, [activeOrder && activeOrder.id, refreshFxVariance]);

  useEffect(() => {
    if (!activeOrder || !activeOrder.customerKey) return;
    if (!window.ObaraBackend || !window.ObaraBackend.isReady()) return;
    let cancelled = false;
    (async () => {
      try {
        const customers = await window.ObaraBackend.customers.list();
        const match = (customers && customers.customers || []).find((c) => c.customer_key === activeOrder.customerKey);
        if (!match || cancelled) return;
        const history = await window.ObaraBackend.cost.marginHistory(match.id);
        if (!cancelled) setMarginHistory(history);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [activeOrder && activeOrder.id, activeOrder && activeOrder.customerKey]);

  useEffect(() => {
    if (!activeOrder || !activeOrder.result || !activeOrder.result.salesOrder) return;
    if (!window.ObaraBackend || !window.ObaraBackend.isReady()) return;
    let cancelled = false;
    (async () => {
      try {
        const lineItems = activeOrder.result.salesOrder.lineItems || [];
        const out = {};
        for (const li of lineItems.slice(0, 8)) {
          const partNo = li.tallyItemName || li.itemName || li.sellerPartNo;
          if (!partNo) continue;
          try {
            const band = await window.ObaraBackend.salesHistory.priceBand({ part_no: partNo, customer_id: activeOrder.customerKey });
            out[String(partNo).toUpperCase()] = band;
          } catch (_) {}
        }
        if (!cancelled) setPriceBands(out);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [activeOrder && activeOrder.id]);

  useEffect(() => {
    if (!activeOrder) { setDecisionExplanations([]); return; }
    setDecisionExplanations(buildDecisionExplanations(activeOrder));
  }, [activeOrder && activeOrder.id]);

  const handleReconciliationAction = useCallback(async ({ action, lineIndex, payload }) => {
    if (!activeOrder || !activeOrder.result || !activeOrder.result.salesOrder) return;
    const so = activeOrder.result.salesOrder;
    const before = so.lineItems[lineIndex];
    if (!before) return;
    if (action === "use_quote_price" && payload && payload.rate != null) {
      const next = applyLineEdit(activeOrder, lineIndex, { rate: Number(payload.rate) });
      await persistOrder(next);
      await recordAudit("recon_use_quote_price", "Line " + (before.sno || lineIndex + 1) + " set to quote rate " + payload.rate, activeOrder.id);
      return;
    }
    if (action === "use_po_price" && payload && payload.rate != null) {
      const next = applyLineEdit(activeOrder, lineIndex, { rate: Number(payload.rate) });
      await persistOrder(next);
      await recordAudit("recon_use_po_price", "Line " + (before.sno || lineIndex + 1) + " forced to PO rate", activeOrder.id);
      return;
    }
    if (action === "create_alias" && window.ObaraBackend && window.ObaraBackend.isReady()) {
      try {
        const customers = await window.ObaraBackend.customers.list();
        const match = (customers.customers || []).find((c) => c.customer_key === activeOrder.customerKey);
        if (match) {
          await window.ObaraBackend.aliases.upsert({
            customer_id: match.id,
            customer_part_no: before.custPartNo || before.itemName,
            customer_description: before.itemName,
            obara_part_no: before.tallyItemName || before.sellerPartNo || before.itemName,
            tally_stock_item: before.tallyItemName,
          });
          await recordAudit("recon_alias_created", "Alias " + (before.custPartNo || before.itemName) + " -> " + (before.tallyItemName || before.itemName), activeOrder.id);
        }
      } catch (err) { setError("Alias create failed: " + err.message); }
      return;
    }
    if (action === "escalate") {
      const draft = await (window.ObaraBackend && window.ObaraBackend.isReady() ? window.ObaraBackend.communications.draft({
        orderId: activeOrder.id,
        templateCode: "delivery_date_conflict",
        variables: { poNumber: activeOrder.preflightPONumber, contact: activeOrder.preflightCustomer || "Customer", senderName: "Obara India", lineSummary: before.tallyItemName || before.itemName },
      }) : null);
      await recordAudit("recon_escalate", "Drafted escalation for line " + (before.sno || lineIndex + 1), activeOrder.id);
      if (draft && draft.draft) setError(null);
      return;
    }
    if (action === "accept_match") {
      await recordAudit("recon_accept", "Accepted match line " + (before.sno || lineIndex + 1), activeOrder.id);
    }
  }, [activeOrder, persistOrder]);

  const handleAmendmentDetect = useCallback(async () => {
    if (!activeOrder || !window.ObaraBackend || !window.ObaraBackend.isReady()) return;
    try {
      const result = await window.ObaraBackend.tally.amend({ parentOrderId: activeOrder.id, revisedSalesOrder: activeOrder.result && activeOrder.result.salesOrder });
      setAmendments((prev) => [result.amendment, ...prev]);
      await recordAudit("amendment_drafted", "Type=" + result.amendmentType + " changes=" + (result.changes || []).length, activeOrder.id);
    } catch (err) { setError("Amendment detect failed: " + err.message); }
  }, [activeOrder]);

  const persistAliasAndRefresh = useCallback(async (alias) => {
    if (!alias || !window.ObaraBackend || !window.ObaraBackend.isReady()) return;
    try {
      await window.ObaraBackend.aliases.upsert(alias);
      await recordAudit("alias_suggested_apply", "Alias " + (alias.customer_part_no || "") + " -> " + (alias.obara_part_no || ""), activeOrder && activeOrder.id);
    } catch (err) { setError("Alias save failed: " + err.message); }
  }, [activeOrder]);

  const runServerOcr = useCallback(async () => {
    if (!activeOrder) return;
    if (!window.ObaraBackend || !window.ObaraBackend.isReady()) { setError("Backend not connected. Configure it from the command palette."); return; }
    if (!poFile) { setError("Upload a PO file first."); return; }
    try {
      const meta = await window.ObaraBackend.documents.upload(poFile, "purchase_order");
      const result = await window.ObaraBackend.ocr.run(meta.documentId, activeOrder.id);
      await recordAudit("server_ocr", "Pages=" + result.pageCount + " evidence=" + result.evidenceCount, activeOrder.id);
      const refreshed = await window.ObaraBackend.orders.get(activeOrder.id);
      const eb = {};
      (refreshed && refreshed.evidence || []).forEach((row) => { eb[row.field_path] = { document: row.document_id, page: row.page_number, snippet: row.snippet, bbox: row.bbox }; });
      const next = { ...activeOrder, evidenceByField: eb, evidenceCoverage: Object.keys(eb).length };
      setActiveOrder(next);
      setOrders((prev) => prev.map((o) => o && o.id === next.id ? next : o));
      setShowEvidenceFor(activeOrder.id);
    } catch (err) {
      setError("Server OCR failed: " + err.message);
    }
  }, [activeOrder, poFile]);

  const removeOrder = useCallback(async (id) => {
    if (!id) return;
    const all = await loadOrders();
    const next = (all || []).filter((o) => o && o.id !== id);
    await sSet(SK_ORDERS, next);
    setOrders(next);
    await recordAudit("delete_order", "Removed local order " + id, id);
  }, []);

  const persistOrder = useCallback(async (next) => {
    if (!next || !next.id) return;
    setActiveOrder(next);
    setOrders((prev) => prev.map((o) => o && o.id === next.id ? next : o));
    await saveOrder(next);
  }, []);

  const saveLineItemEdit = useCallback(async (lineIndex, edits) => {
    if (!activeOrder) return;
    const before = activeOrder.result && activeOrder.result.salesOrder && activeOrder.result.salesOrder.lineItems && activeOrder.result.salesOrder.lineItems[lineIndex];
    const next = applyLineEdit(activeOrder, lineIndex, edits);
    if (next.approval) next.approval = null;
    await persistOrder(next);
    const detail = before ? "Line " + (before.sno || lineIndex + 1) + " edited (" + Object.keys(edits || {}).join(",") + ")" : "Line edited";
    await recordAudit("edit_line", detail, next.id);
    if (activeOrder.customerKey) {
      await recordLineEditPattern(activeOrder.customerKey, { sno: before && before.sno, edits });
      const updated = await loadLearnedRules();
      const recurring = recurringEditFields(updated, 2).filter((r) => r.customerKey === activeOrder.customerKey);
      if (recurring.length) await recordAudit("learned_rule_candidate", recurring.map((r) => r.field + " (" + r.count + "x)").join("; "), activeOrder.customerKey);
    }
    setEditLineItem(null);
  }, [activeOrder, persistOrder]);

  const removeLineItemFromOrder = useCallback(async (lineIndex) => {
    if (!activeOrder) return;
    if (!confirm("Remove this line from the SO? Totals will recompute and the order moves back to Pending Review.")) return;
    const before = activeOrder.result && activeOrder.result.salesOrder && activeOrder.result.salesOrder.lineItems && activeOrder.result.salesOrder.lineItems[lineIndex];
    const next = removeLineItem(activeOrder, lineIndex);
    await persistOrder(next);
    await recordAudit("remove_line", before ? "Removed line " + (before.sno || lineIndex + 1) : "Removed line", next.id);
    setEditLineItem(null);
  }, [activeOrder, persistOrder]);

  const runLocalExtract = useCallback(async () => {
    if (!poFile) { setError("Upload a PO file first."); return; }
    const profile = currentKnownProfile;
    if (!profile) { setError("Local extraction needs an existing customer profile."); return; }
    setError(null);
    setStage("local_extract");
    try {
      const extraction = await localExtractFromPdf(poFile, profile);
      if (!extraction.ok) {
        setError("Local extraction unavailable: " + extraction.message + ". Falling back to Claude.");
        setStage("pf_done");
        return;
      }
      if (extraction.confidence < 60) {
        setError("Local extraction confidence " + extraction.confidence + "%. Use 'Send to Claude' below for a more reliable result.");
      }
      const refinedEst = estimateCallTokens(poFile.size, quoteFile ? quoteFile.size : 0, priceCompFile ? priceCompFile.size : 0, true);
      setTokenEst(refinedEst);
      const order = {
        id: "local_" + Date.now(),
        status: extraction.confidence >= 80 ? "APPROVED" : "PENDING_REVIEW",
        result: {
          po: { number: extraction.poNumber, date: extraction.dateValue, customer: profile.customerName },
          salesOrder: extraction.salesOrder,
          discrepancies: [],
          sourcePOs: [],
        },
        preflightPONumber: extraction.poNumber || (pf && pf.poNumber) || "",
        preflightCustomer: profile.customerName || "",
        customerKey: profile.customerKey,
        customerGSTIN: profile.customerGSTIN || "",
        hasPriceComp: !!priceCompFile,
        priceCompIncluded: false,
        engineerNote: engineerNote.trim() || null,
        order_mode: orderMode,
        formatStatus: "known",
        formatChanged: false,
        usedKnownFormat: true,
        tokenEstimate: refinedEst,
        docFingerprint: docFingerprint,
        documentMetas: docMetas,
        apiUsage: { preflight: pf && pf._apiUsage || null, generation: null },
        costPolicySnapshot: normalizeCostPolicy(costPolicy),
        anomalyFlags: [],
        processingMs: 0,
        createdAt: nowISO(),
        approvalNote: null,
        localExtraction: {
          confidence: extraction.confidence,
          itemsFound: extraction.itemsFound,
          itemsValid: extraction.itemsValid,
          extractedAt: nowISO(),
        },
        costAvoidedReason: "Used local PDF extraction template (saved generation API call)",
      };
      const allOrders = await loadOrders();
      const stats = customerStats(allOrders, profile.customerKey);
      order.anomalyFlags = detectAnomalies(order, stats);
      setActiveOrder(order);
      setOrders((prev) => [order, ...prev]);
      await saveOrder(order);
      await recordAudit("local_extract", "Local PDF extraction at " + extraction.confidence + "% confidence; saved generation API call", order.id);
      setStage("done");
      setTab("overview");
    } catch (err) {
      setError("Local extraction failed: " + err.message);
      setStage("pf_done");
    }
  }, [poFile, quoteFile, priceCompFile, currentKnownProfile, engineerNote, docFingerprint, docMetas, pf, costPolicy, orderMode]);

  const seedSampleData = useCallback(async () => {
    await seedDemoData();
    const [f, o, l] = await Promise.all([loadFormats(), loadOrders(), loadAuditLog()]);
    setCustomerFormats(f);
    setOrders(o);
    setAuditLog(l);
  }, []);

  const cacheOcrForLabel = useCallback(async (file, label) => {
    if (!file || !label) return;
    setOcrBusyLabel(label);
    try {
      const result = await pdfToOcrText(file, { maxPages: Number(costPolicy.ocrMaxPages || 10) });
      const text = (result && result.text) || "";
      if (!text || text.length < 80) {
        alert("OCR returned " + text.length + " chars. PDF will continue to be sent as-is.");
        return;
      }
      setOcrTextByLabel((prev) => ({ ...prev, [label]: text }));
      poDocRef.current = null; quoteDocRef.current = null; priceCompDocRef.current = null;
      await recordAudit("ocr_cache", "Cached OCR text for " + label + " (" + text.length + " chars)", null);
    } catch (err) {
      alert("OCR failed: " + err.message);
    } finally {
      setOcrBusyLabel(null);
    }
  }, [costPolicy]);

  const dropOcrForLabel = useCallback((label) => {
    setOcrTextByLabel((prev) => {
      const next = { ...prev };
      delete next[label];
      return next;
    });
    poDocRef.current = null; quoteDocRef.current = null; priceCompDocRef.current = null;
  }, []);

  const clearSampleData = useCallback(async () => {
    await clearDemoData();
    const [f, o, l] = await Promise.all([loadFormats(), loadOrders(), loadAuditLog()]);
    setCustomerFormats(f);
    setOrders(o);
    setAuditLog(l);
    setActiveOrder(null);
  }, []);

  const reset = useCallback(() => {
    setStage("idle"); setPoFile(null); setQuoteFile(null); setPriceCompFile(null);
    setEngineerNote(""); setPf(null); setIsDup(false); setDupOrder(null);
    setError(null); setFormatStatus(null); setTokenEst(null); setPoNumberHint("");
    setDocMetas([]); setDocFingerprint(null); setReuseOrder(null);
    setCompareTarget(null);
    setOcrTextByLabel({}); setOcrBusyLabel(null);
    b64po.current = null; b64q.current = null; b64pc.current = null;
    poDocRef.current = null; quoteDocRef.current = null; priceCompDocRef.current = null;
    forceReprocess.current = false;
  }, []);`,
  "reset and policy update",
);

patchSo(
  /const runPreflight = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[poFile, quoteFile, priceCompFile\]\);/,
  String.raw`const runPreflight = useCallback(async () => {
    if (!poFile || !quoteFile) { setError("Upload PO and Quote at minimum."); return; }
    setStage("pf_running"); setError(null); setReuseOrder(null);
    try {
      const storedBefore = await loadOrders();
      const hintedDup = findOrderByPoHint(storedBefore, poNumberHint);
      if (hintedDup && !forceReprocess.current) {
        const rec = {
          id: "skipped_hint_" + Date.now(),
          status: "DUPLICATE",
          preflightPONumber: poNumberFromOrder(hintedDup),
          preflightCustomer: hintedDup.preflightCustomer || (hintedDup.result && hintedDup.result.po && hintedDup.result.po.customer) || "",
          result: null,
          createdAt: nowISO(),
          blockerSummary: "Duplicate PO hint matched existing local order",
          costAvoidedReason: "PO number hint matched before API call",
          linkedOrderId: hintedDup.id,
        };
        await saveOrder(rec);
        setOrders((prev) => [rec, ...prev]);
        setDupOrder(hintedDup);
        setIsDup(true);
        setPf({
          canProceed:false,
          poNumber: poNumberFromOrder(hintedDup),
          poVendorName: rec.preflightCustomer,
          blockers:["Duplicate PO"],
          warnings:[],
          checks:{ P4_duplicateCheck:{ pass:false, code:"DUPLICATE_PO", detail:"Matched local PO number hint before API call." } },
          suggestedAction:"Open the existing SO or change the PO number hint.",
        });
        setStage("pf_done");
        return;
      }

      const buildOpts = (label) => ({
        ocrPolicy: costPolicy.ocrPdfs,
        ocrMaxPages: costPolicy.ocrMaxPages,
        ocrText: ocrTextByLabel[label],
      });
      const [poDoc, quoteDoc, pcDoc] = await Promise.all([
        fileToClaudeContentBlocks(poFile, "DOCUMENT 1 - Purchase Order", buildOpts("DOCUMENT 1 - Purchase Order")),
        fileToClaudeContentBlocks(quoteFile, "DOCUMENT 2 - Price Quotation", buildOpts("DOCUMENT 2 - Price Quotation")),
        priceCompFile ? fileToClaudeContentBlocks(priceCompFile, "DOCUMENT 3 - Price Composition", buildOpts("DOCUMENT 3 - Price Composition")) : Promise.resolve(null),
      ]);
      poDocRef.current = poDoc;
      quoteDocRef.current = quoteDoc;
      priceCompDocRef.current = pcDoc;
      b64po.current = poDoc.base64;
      b64q.current = quoteDoc.base64;
      b64pc.current = pcDoc ? pcDoc.base64 : null;
      poMime.current = poDoc.meta.mime;
      qMime.current = quoteDoc.meta.mime;
      if (pcDoc) pcMime.current = pcDoc.meta.mime;
      const metas = [poDoc.meta, quoteDoc.meta, pcDoc && pcDoc.meta].filter(Boolean);
      setDocMetas(metas);
      const fingerprint = buildDocumentFingerprint(metas);
      setDocFingerprint(fingerprint);

      const profileForCache = currentKnownProfile || (currentCustomerKey && customerFormats[currentCustomerKey]);
      const cacheVersions = { customer: (profileForCache && profileForCache.lastUpdated) || "0" };
      const cachedHit = await lookupCachedResult(fingerprint, costPolicy.cacheTtlHours, cacheVersions);
      const stalePeek = !cachedHit ? await inspectCacheEntry(fingerprint, cacheVersions) : null;
      if (stalePeek && stalePeek.status === "stale_versions") {
        await recordAudit("cache_invalid_versions", "Cached entry exists but prompt/schema/rules/profile version changed; reprocessing", null);
      }
      const reusable = cachedHit
        ? storedBefore.find((o) => o.result && o.docFingerprint === fingerprint) || null
        : storedBefore.find((o) => o.result && o.docFingerprint && o.docFingerprint === fingerprint);
      if ((reusable || cachedHit) && !forceReprocess.current) {
        const ageNote = cachedHit ? " (cached " + cachedHit.ageHours + "h ago)" : "";
        const rec = {
          id: "reused_" + Date.now(),
          status: "REUSED",
          preflightPONumber: poNumberFromOrder(reusable) || (cachedHit && cachedHit.poNumber) || "",
          preflightCustomer: (reusable && (reusable.preflightCustomer || (reusable.result && reusable.result.po && reusable.result.po.customer))) || (cachedHit && cachedHit.customerName) || "",
          result: null,
          createdAt: nowISO(),
          docFingerprint: fingerprint,
          documentMetas: metas,
          linkedOrderId: reusable && reusable.id || null,
          costAvoidedReason: "Same document fingerprint already processed" + ageNote,
        };
        await saveOrder(rec);
        await recordAudit("reuse_extraction", "Skipped Claude call by cache hit" + ageNote, rec.id);
        setOrders((prev) => [rec, ...prev]);
        setReuseOrder(reusable || { id:"cache:" + fingerprint, result: cachedHit && cachedHit.result, preflightPONumber: cachedHit && cachedHit.poNumber, preflightCustomer: cachedHit && cachedHit.customerName, docFingerprint: fingerprint });
        setStage("reuse_found");
        return;
      }
      forceReprocess.current = false;

      const docs = [...poDoc.blocks, ...quoteDoc.blocks];
      const result = await callClaude(renderPreflightPrompt(), docs, { purpose:"preflight" });
      const stored = await loadOrders();
      const dup = stored.find((o) =>
        o.preflightPONumber && result.poNumber &&
        o.preflightPONumber.trim() === result.poNumber.trim() &&
        o.status !== "BLOCKED"
      );
      setIsDup(!!dup); setDupOrder(dup || null); setPf(result); setStage("pf_done");
      if (!result.canProceed || dup) {
        const m = await loadMetrics();
        m.blocked = (m.blocked || 0) + 1;
        if (dup) m.duplicatesBlocked = (m.duplicatesBlocked || 0) + 1;
        if (result.checks && result.checks.P1_vendorCheck && !result.checks.P1_vendorCheck.pass)
          m.wrongVendorBlocked = (m.wrongVendorBlocked || 0) + 1;
        if (result.checks && result.checks.Q2_quoteMatch && result.checks.Q2_quoteMatch.code === "QUOTE_MISMATCH")
          m.wrongQuoteBlocked = (m.wrongQuoteBlocked || 0) + 1;
        await saveMetrics(m); setMetrics(m);
        const rec = {
          id: "blocked_" + Date.now(), status: dup ? "DUPLICATE" : "BLOCKED",
          preflightPONumber: result.poNumber, preflightCustomer: result.poVendorName,
          result: null, createdAt: nowISO(),
          blockerSummary: (dup ? ["Duplicate PO"] : []).concat(result.blockers || []).slice(0,2).join("; "),
          docFingerprint: fingerprint,
          documentMetas: metas,
          apiUsage: { preflight: result._apiUsage || null },
        };
        await saveOrder(rec); setOrders((prev) => [rec, ...prev]);
      }
    } catch (e) { setError("Validation failed: " + e.message); setStage("idle"); }
  }, [poFile, quoteFile, priceCompFile, poNumberHint]);`,
  "runPreflight",
);

patchSo(
  /const generateSO = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[pf, engineerNote, customerFormats\]\);/,
  String.raw`const generateSO = useCallback(async () => {
    setStage("so_running"); setError(null); setFormatStatus(null);
    const t0 = Date.now();
    try {
      const custGSTIN = pf && pf.poVendorGSTIN;
      const custName  = pf && pf.poVendorName;
      const custKey   = normalizeCustomerKey(custGSTIN, custName);
      const formats   = await loadFormats();
      const knownProfile = formats[custKey] || null;

      const refinedEst = estimateCallTokens(
        poFile        ? poFile.size        : 0,
        quoteFile     ? quoteFile.size     : 0,
        priceCompFile ? priceCompFile.size : 0,
        !!knownProfile
      );
      setTokenEst(refinedEst);

      const formatCtx = knownProfile ? buildFormatContextBlock(knownProfile) : null;
      const systemPrompt = systemBlocksForPolicy(SO_PROMPT, formatCtx, costPolicy);

      const buildOpts = (label) => ({
        ocrPolicy: costPolicy.ocrPdfs,
        ocrMaxPages: costPolicy.ocrMaxPages,
        ocrText: ocrTextByLabel[label],
      });
      const poDoc = poDocRef.current || await fileToClaudeContentBlocks(poFile, "DOCUMENT 1 - Customer Purchase Order", buildOpts("DOCUMENT 1 - Customer Purchase Order"));
      const quoteDoc = quoteDocRef.current || await fileToClaudeContentBlocks(quoteFile, "DOCUMENT 2 - Obara Price Quotation to Customer", buildOpts("DOCUMENT 2 - Obara Price Quotation to Customer"));
      const includePriceComp = !!(priceCompFile && costPolicy.priceComp !== "skip");
      const pcDoc = includePriceComp
        ? (priceCompDocRef.current || await fileToClaudeContentBlocks(priceCompFile, "DOCUMENT 3 - Internal Price Composition", buildOpts("DOCUMENT 3 - Internal Price Composition")))
        : null;
      const metas = [poDoc.meta, quoteDoc.meta, pcDoc && pcDoc.meta].filter(Boolean);
      const fingerprint = docFingerprint || buildDocumentFingerprint(metas);

      const docs = [...poDoc.blocks, ...quoteDoc.blocks];
      if (pcDoc) {
        docs.push(...pcDoc.blocks);
      } else {
        docs.push({ type:"text", text:"DOCUMENT 3 - Price Composition: NOT PROVIDED OR SKIPPED BY COST POLICY. Infer source from part number patterns and add sourceConfidence = pattern_inferred for all items." });
      }
      if (engineerNote.trim()) {
        docs.push({ type:"text", text:"SALES ENGINEER SOURCE OVERRIDE: " + engineerNote.trim() + ". Apply this as the highest priority source assignment for the items mentioned." });
      }

      const result = await callClaude(systemPrompt, docs, {
        purpose:"so_generation",
        cacheStaticPrompt: costPolicy.promptCache !== "off",
        cacheTtl: costPolicy.promptCache === "1h" ? "1h" : "5m",
      });
      const ms = Date.now() - t0;
      const crit = (result.discrepancies || []).filter((d) => d.severity === "CRITICAL").length;
      const warn = (result.discrepancies || []).filter((d) => d.severity === "WARNING").length;

      const fp = result.formatFingerprint;
      const changed = !!result.formatChanged;
      let fStatus = "new";
      if (knownProfile) fStatus = changed ? "changed" : "known";

      if (fp && custKey) {
        const updatedProfile = {
          customerName:     custName || (knownProfile && knownProfile.customerName) || "",
          customerGSTIN:    custGSTIN || "",
          customerKey:      custKey,
          firstSeen:        (knownProfile && knownProfile.firstSeen) || nowISO(),
          lastUpdated:      nowISO(),
          ordersProcessed:  ((knownProfile && knownProfile.ordersProcessed) || 0) + 1,
          lastFormatChanged: changed,
          formatChangeSummary: changed ? (result.formatChangeSummary || "") : "",
          fingerprint:      fp,
          trusted:          !!(knownProfile && knownProfile.trusted),
        };
        const newFormats = { ...formats, [custKey]: updatedProfile };
        await saveFormats(newFormats);
        setCustomerFormats(newFormats);
      }
      setFormatStatus(fStatus);

      const allOrders = await loadOrders();
      const customerHistoryStats = customerStats(allOrders, custKey);
      const draftOrder = {
        result,
        preflightPONumber: pf && pf.poNumber,
        preflightCustomer: result.po && result.po.customer,
        customerKey: custKey,
      };
      const anomalyFlags = detectAnomalies(draftOrder, customerHistoryStats);
      const order = {
        id: "order_" + Date.now(),
        status: crit > 0 ? "PENDING_REVIEW" : "APPROVED",
        result,
        preflightPONumber: pf && pf.poNumber,
        preflightCustomer: result.po && result.po.customer,
        customerKey: custKey,
        customerGSTIN: custGSTIN || "",
        hasPriceComp: !!pcDoc,
        priceCompIncluded: !!pcDoc,
        engineerNote: engineerNote.trim() || null,
        order_mode: orderMode,
        formatStatus: fStatus,
        formatChanged: changed,
        formatChangeSummary: result.formatChangeSummary || "",
        usedKnownFormat: !!knownProfile,
        tokenEstimate: refinedEst,
        docFingerprint: fingerprint,
        documentMetas: metas,
        apiUsage: { preflight: pf && pf._apiUsage || null, generation: result._apiUsage || null },
        costPolicySnapshot: normalizeCostPolicy(costPolicy),
        anomalyFlags,
        processingMs: ms, createdAt: nowISO(), approvalNote: null,
      };
      try {
        if (result.salesOrder) {
          const normalized = annotateUomNormalization(result.salesOrder);
          if (normalized && normalized !== result.salesOrder) {
            result.salesOrder = normalized;
            await recordAudit("uom_normalized", "Normalized " + normalized.uomNormalizations + " UOM(s) to canonical form", order.id);
          }
        }
      } catch (_) {}
      try {
        const ruleFindings = runValidationRules(result.salesOrder, { poNumber: pf && pf.poNumber, poDate: pf && pf.poDate, quoteDate: pf && pf.quoteDate, quoteLines: result.matchedLines || [] }, { policy: costPolicy, history: allOrders, currentOrderId: order.id, priceComp: result.priceComposition || null });
        order.ruleFindings = ruleFindings;
        const blockingFindings = ruleFindings.filter((f) => f.blocks);
        const criticalFindings = ruleFindings.filter((f) => f.severity === "CRITICAL");
        if (blockingFindings.length || criticalFindings.length) order.status = "PENDING_REVIEW";
      } catch (err) {
        order.ruleFindings = [];
        if (typeof console !== "undefined") console.warn("Rule engine failed:", err.message);
      }
      try {
        if (window.ObaraBackend && window.ObaraBackend.isReady() && order.preflightPONumber) {
          const candidate = {
            poNumber: order.preflightPONumber,
            customerId: custKey,
            totalValue: result.salesOrder && result.salesOrder.grandTotal,
            docFingerprint: order.docFingerprint,
            lineItems: result.salesOrder && result.salesOrder.lineItems,
          };
          const dup = await window.ObaraBackend.duplicates.search(candidate, 60);
          if (dup && dup.matches && dup.matches.length) {
            order.revisionMatches = dup.matches;
            setDuplicateMatches(dup.matches);
          }
        }
      } catch (err) {
        if (typeof console !== "undefined") console.warn("Duplicate search failed:", err.message);
      }
      try {
        if (window.ObaraBackend && window.ObaraBackend.isReady() && custKey) {
          const customers = await window.ObaraBackend.customers.list();
          const match = (customers && customers.customers || []).find((c) => c.customer_key === custKey);
          if (match) {
            const remoteAnomaly = await window.ObaraBackend.anomaly.compute(match.id, result.salesOrder || {});
            if (remoteAnomaly && remoteAnomaly.flags && remoteAnomaly.flags.length) {
              order.anomalyFlags = (order.anomalyFlags || []).concat(remoteAnomaly.flags);
            }
          }
        }
      } catch (err) {
        if (typeof console !== "undefined") console.warn("Remote anomaly compute failed:", err.message);
      }
      try {
        const annotated = await annotateProvenance(order, [
          { label: "Customer PO", file: poFile },
          { label: "Obara Quote", file: quoteFile },
          { label: "Price Composition", file: priceCompFile },
        ]);
        Object.assign(order, { evidenceByField: annotated.evidenceByField || {}, evidenceCoverage: annotated.evidenceCoverage || 0 });
      } catch (err) {
        if (typeof console !== "undefined") console.warn("Provenance annotation failed:", err.message);
      }
      setActiveOrder(order); setOrders((prev) => [order, ...prev]);
      await saveOrder(order);
      await storeCachedResult(fingerprint, {
        customerKey: custKey,
        customerName: order.preflightCustomer,
        poNumber: order.preflightPONumber,
        result,
        apiUsage: order.apiUsage,
      }, { customer: (knownProfile && knownProfile.lastUpdated) || nowISO() });
      await recordAudit("generate_so", (crit > 0 ? "Generated with " + crit + " critical issue(s)" : "Generated and approved"), order.id);
      if (anomalyFlags.length) {
        await recordAudit("anomaly_flag", anomalyFlags.map((f) => f.label).join("; "), order.id);
      }
      const m = await loadMetrics();
      m.totalProcessed  = (m.totalProcessed  || 0) + 1;
      m.totalValue      = (m.totalValue      || 0) + ((result.salesOrder && result.salesOrder.grandTotal) || 0);
      m.criticalsCaught = (m.criticalsCaught || 0) + crit;
      m.warningsCaught  = (m.warningsCaught  || 0) + warn;
      m.processingTimes = [...(m.processingTimes || []), ms];
      m.avgMs = Math.round(m.processingTimes.reduce((a, b) => a + b, 0) / m.processingTimes.length);
      await saveMetrics(m); setMetrics(m);
      setStage("done"); setTab("overview");
    } catch (e) { setError("SO generation failed: " + e.message); setStage("pf_done"); }
  }, [pf, engineerNote, customerFormats, costPolicy, docFingerprint, docMetas, poFile, quoteFile, priceCompFile, orderMode]);`,
  "generateSO",
);

patchSo(
  `<p className="text-xs text-blue-300 mt-0.5">Preflight validation · Tally SO · Multi-currency Source POs · Customer format memory · Duplicate detection</p>`,
  `<p className="text-xs text-blue-300 mt-0.5">Preflight validation · Tally SO · Source POs · Format memory · Duplicate reuse · Cost controls</p>`,
  "header copy",
);

patchSo(
  `              <>
                <div className="grid grid-cols-2 gap-4">`,
  `              <>
                <CostPolicyPanel policy={costPolicy} onChange={updateCostPolicy} />
                <div className="grid grid-cols-2 gap-4">`,
  "cost policy placement",
);

patchSo(
  `<TokenGauge est={tokenEst} />`,
  String.raw`<div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wide block mb-1.5">
                    PO Number Hint <span className="text-slate-400 font-normal normal-case">(optional, avoids duplicate API calls)</span>
                  </label>
                  <input
                    value={poNumberHint}
                    onChange={(e) => setPoNumberHint(e.target.value)}
                    placeholder="e.g. 4500123456"
                    className="w-full border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white"
                  />
                  <div className="text-xs text-slate-400 mt-1">If this PO already exists locally, validation stops before any Claude call.</div>
                </div>
                <TokenGauge est={tokenEst} />
                <CostPreviewCard
                  tokenEst={tokenEst}
                  policy={costPolicy}
                  customerSpend={customerSpendThisMonth(orders, currentCustomerKey, costPolicy)}
                  budget={(customerBudgets && customerBudgets[currentCustomerKey]) || costPolicy.defaultMonthlyBudgetUsd}
                />
                <DocumentReadinessPanel
                  metas={docMetas}
                  files={[{label:"DOCUMENT 1 - Purchase Order", file:poFile},{label:"DOCUMENT 2 - Price Quotation", file:quoteFile},{label:"DOCUMENT 3 - Price Composition", file:priceCompFile}]}
                  ocrTextByLabel={ocrTextByLabel}
                  ocrBusyLabel={ocrBusyLabel}
                  onOcrCached={cacheOcrForLabel}
                  onOcrClear={dropOcrForLabel}
                />`,
  "PO hint and document metadata",
);

patchSo(
  `{stage === "so_running" && (
              <div className="text-center py-12">`,
  String.raw`{stage === "reuse_found" && reuseOrder && (
              <ReusePanel
                order={reuseOrder}
                onOpen={() => { setActiveOrder(reuseOrder); setTab("overview"); }}
                onReprocess={() => { forceReprocess.current = true; setReuseOrder(null); runPreflight(); }}
              />
            )}
            {stage === "local_extract" && (
              <div className="text-center py-12">
                <div className="text-4xl mb-3 animate-spin">📄</div>
                <div className="font-semibold text-slate-700">Running local PDF extraction...</div>
                <div className="text-xs text-slate-400 mt-1">No Claude call · using saved customer template</div>
              </div>
            )}
            {stage === "so_running" && (
              <div className="text-center py-12">`,
  "reuse stage",
);

patchSo(
  `                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wide block mb-1.5">
                    Source Override Note`,
  String.raw`                <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-xl">
                  <label className="text-xs font-bold text-indigo-800 uppercase tracking-wide block mb-1.5">Order Mode</label>
                  <select value={orderMode} onChange={(e) => setOrderMode(e.target.value)} className="w-full text-xs px-2 py-1.5 rounded-lg border border-indigo-300 bg-white">
                    <option value="SPARES">SPARES (OIQTLC, INR)</option>
                    <option value="SPARES_ASSEMBLY">SPARES_ASSEMBLY (gun modification)</option>
                    <option value="PROJECT_FOR">PROJECT_FOR (Free On Rail, INR)</option>
                    <option value="PROJECT_HSS">PROJECT_HSS (High Sea Sales, OIQTHS, USD with forward FX)</option>
                    <option value="INTERNAL">INTERNAL (FOC / warranty / trial)</option>
                  </select>
                  <p className="text-[10px] text-indigo-700 mt-1">Drives quote prefix, source PO numbering, currency, terms. From corpus: 4 modes confirmed across 4 sample workflows.</p>
                </div>
                {priceCompFile && costPolicy.priceComp === "warn" && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
                    Price composition is uploaded and will be sent. This usually improves source PO accuracy, but it adds input tokens.
                  </div>
                )}
                {priceCompFile && costPolicy.priceComp === "skip" && (
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700">
                    Price composition is uploaded but skipped by Cost Policy. Source POs will use part-number pattern inference unless you change the policy.
                  </div>
                )}
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wide block mb-1.5">
                    Source Override Note`,
  "price composition cost warning",
);

patchSo(
  `{formatStatus === "known" && (`,
  String.raw`<FreshnessAlerts pf={pf} />
                {currentKnownProfile && (
                  <DryRunPanel
                    profile={currentKnownProfile}
                    lastExtraction={activeOrder && activeOrder.localExtraction}
                    onRunLocalExtract={runLocalExtract}
                    onExportTemplate={() => {
                      const tpl = buildExtractionTemplate(currentKnownProfile, orders);
                      dlFile(JSON.stringify(tpl, null, 2), "ExtractionTemplate_" + (currentKnownProfile.customerKey || "customer") + ".json", "application/json");
                      recordAudit("export_template_dry", "Exported template before processing", currentKnownProfile.customerKey);
                    }}
                    onProceedAnyway={generateSO}
                  />
                )}
                {formatReuseActive && (
                  <div className="p-3 bg-teal-50 border border-teal-200 rounded-xl text-xs text-teal-800 flex items-center gap-2">
                    <span className="font-bold">Reuse active</span>
                    <span>Trusted stable customer profile is pinned for this PO format.</span>
                  </div>
                )}
                {formatStatus === "known" && (`,
  "format reuse active panel",
);

patchSo(
  `{activeOrder.tokenEstimate && (() => {`,
  `<ApiCostCard order={activeOrder} />
                {activeOrder.ruleFindings && activeOrder.ruleFindings.length > 0 && (
                  <div className="mt-2"><PlaybookPanel
                    findings={activeOrder.ruleFindings}
                    onApply={async (code, action) => {
                      await recordAudit("playbook_action", code + " -> " + action.id, activeOrder.id);
                      if (action.id === "convert_to_exclusive" && activeOrder.result && activeOrder.result.salesOrder) {
                        const so = activeOrder.result.salesOrder;
                        const next = { ...so, lineItems: (so.lineItems || []).map((li) => {
                          const total = Number(li.cgst) + Number(li.sgst) + Number(li.igst);
                          if (!li.poUnitPriceInclGST || !total) return li;
                          const exclusive = round2((Number(li.rate) || 0) / (1 + total / 100));
                          return { ...li, rate: exclusive, poUnitPriceInclGST: false };
                        }) };
                        const recomputed = recomputeSalesOrderTotals(next);
                        await persistOrder({ ...activeOrder, result: { ...activeOrder.result, salesOrder: recomputed }, status: "PENDING_REVIEW", approval: null });
                      }
                      if (action.id === "switch_tax_type" && activeOrder.result && activeOrder.result.salesOrder) {
                        const so = activeOrder.result.salesOrder;
                        const ship = so.shipTo && so.shipTo.gstin;
                        const interstate = ship && stateFromGstin(ship) && SELLER_STATE && stateFromGstin(ship) !== SELLER_STATE;
                        const next = { ...so, lineItems: (so.lineItems || []).map((li) => {
                          if (interstate) return { ...li, igst: Number(li.igst) || (Number(li.cgst) || 0) + (Number(li.sgst) || 0), cgst: 0, sgst: 0 };
                          return { ...li, cgst: Number(li.cgst) || (Number(li.igst) || 0) / 2, sgst: Number(li.sgst) || (Number(li.igst) || 0) / 2, igst: 0 };
                        }) };
                        const recomputed = recomputeSalesOrderTotals(next);
                        await persistOrder({ ...activeOrder, result: { ...activeOrder.result, salesOrder: recomputed }, status: "PENDING_REVIEW", approval: null });
                      }
                      if (action.id === "fill_from_quote" && activeOrder.result && activeOrder.result.salesOrder && activeOrder.result.matchedLines) {
                        const quoteByPart = {};
                        (activeOrder.result.matchedLines || []).forEach((q) => { if (q && q.partNo) quoteByPart[q.partNo.toUpperCase()] = q; });
                        const so = activeOrder.result.salesOrder;
                        const next = { ...so, lineItems: (so.lineItems || []).map((li) => {
                          if (li.hsnCode) return li;
                          const match = quoteByPart[(li.sellerPartNo || "").toUpperCase()];
                          return match && match.hsn ? { ...li, hsnCode: match.hsn } : li;
                        }) };
                        await persistOrder({ ...activeOrder, result: { ...activeOrder.result, salesOrder: recomputeSalesOrderTotals(next) }, status: "PENDING_REVIEW", approval: null });
                      }
                    }}
                  /></div>
                )}
                <div className="mt-2"><CustomerAckPanel order={activeOrder} onCopy={(text) => { showOpsModal && showOpsModal("Acknowledgement Draft", '<pre style="white-space:pre-wrap;font-family:monospace;font-size:12px">' + text.replace(/[<>&]/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c])) + '</pre>'); }} /></div>
                {activeOrder.revisionMatches && activeOrder.revisionMatches.length > 0 && (
                  <div className="mt-2"><RevisionWarning matches={activeOrder.revisionMatches} /></div>
                )}
                {activeOrder.result && activeOrder.result.sourcePOs && activeOrder.result.sourcePOs.length > 0 && (
                  <div className="mt-2">
                    <DeliveryPromisePanel
                      orderId={activeOrder.id}
                      customerId={activeOrder.customerKey}
                      requestedDate={activeOrder.result && activeOrder.result.po && activeOrder.result.po.deliveryDate}
                      sourcePos={(activeOrder.result.sourcePOs || []).map((s) => ({ country: s.country, supplier: s.supplier, baseDate: activeOrder.result && activeOrder.result.po && activeOrder.result.po.date }))}
                    />
                  </div>
                )}
                {activeOrder.result && activeOrder.result.salesOrder && activeOrder.result.priceComposition && (
                  <div className="mt-2"><MarginCockpit
                    so={activeOrder.result.salesOrder}
                    priceComp={activeOrder.result.priceComposition}
                    threshold={(activeOrder.costPolicySnapshot && activeOrder.costPolicySnapshot.minMarginPct) || 10}
                    customerHistory={marginHistory}
                    fxImpactInr={(() => {
                      if (!fxVariance) return null;
                      const total = Object.values(fxVariance).reduce((s, info) => s + (info.variancePct || 0), 0);
                      const subTotal = Number(activeOrder.result.salesOrder.subTotal) || 0;
                      return -1 * (subTotal * total) / 100;
                    })()}
                    quoteMargin={activeOrder.result.quote && activeOrder.result.quote.expectedMarginPct}
                  /></div>
                )}
                {currentKnownProfile && <div className="mt-2"><PlaybookHintsPanel profile={currentKnownProfile} /></div>}
                {currentKnownProfile && activeOrder.result && activeOrder.result.salesOrder && (() => {
                  const partNumbers = (activeOrder.result.salesOrder.lineItems || [])
                    .map((li) => li.custPartNo || li.tallyItemName || li.itemName)
                    .filter(Boolean);
                  if (!partNumbers.length) return null;
                  return (
                    <div className="mt-2"><AliasSuggestionPanel
                      customerKey={currentKnownProfile.customerKey || activeOrder.customerKey}
                      partNumbers={partNumbers}
                      onApply={(alias) => persistAliasAndRefresh(alias)}
                    /></div>
                  );
                })()}
                {decisionExplanations.length > 0 && <div className="mt-2"><WhyPanel items={decisionExplanations} /></div>}
                {activeOrder.result && activeOrder.result.salesOrder && (activeOrder.result.matchedLines || activeOrder.result.quote) && (
                  <details className="mt-2 border border-slate-200 rounded-xl bg-white">
                    <summary className="cursor-pointer p-2 text-xs font-bold text-slate-600">Reconciliation grid (PO vs Quote vs Price comp)</summary>
                    <div className="p-2"><ReconciliationGrid so={activeOrder.result.salesOrder} quoteLines={activeOrder.result.matchedLines || (activeOrder.result.quote && activeOrder.result.quote.lineItems) || []} priceComp={activeOrder.result.priceComposition} onAction={handleReconciliationAction} /></div>
                  </details>
                )}
                {amendments.map((a) => <div key={a.id} className="mt-2"><AmendmentDiffPanel amendment={a.diff || a} /></div>)}
                {activeOrder.anomalyFlags && activeOrder.anomalyFlags.length > 0 && (
                  <div className="mt-2"><AnomalyBadges flags={activeOrder.anomalyFlags} /></div>
                )}
                {activeOrder.ruleFindings && activeOrder.ruleFindings.length > 0 && (
                  <div className="mt-2"><IssuesPanel findings={activeOrder.ruleFindings} onJumpToLine={(idx) => { setTab("so"); setEditLineItem({ index: idx, item: (activeOrder.result && activeOrder.result.salesOrder && activeOrder.result.salesOrder.lineItems && activeOrder.result.salesOrder.lineItems[idx]) || {} }); }} /></div>
                )}
                {activeOrder.approval && (
                  <div className="mt-2"><ApprovalStatusBanner order={activeOrder} verifyApproval={verifyApproval} /></div>
                )}
                {activeOrder.evidenceCoverage > 0 && (
                  <div className="mt-2 p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs flex items-center justify-between">
                    <span className="text-slate-500">Evidence captured for <strong className="text-slate-800">{activeOrder.evidenceCoverage}</strong> field(s) from source documents.</span>
                    <button onClick={() => setShowEvidenceFor(activeOrder.id)} className="text-blue-700 underline">View evidence</button>
                  </div>
                )}
                <div className="mt-2 flex gap-2 flex-wrap">
                  <button onClick={() => window.showCommunicationTimelineFor && window.showCommunicationTimelineFor(activeOrder.id)} className="text-xs px-3 py-1.5 rounded-xl bg-slate-100 border border-slate-300 text-slate-700 font-semibold">Communication timeline</button>
                  <button onClick={() => window.exportDocumentPackage && window.exportDocumentPackage(activeOrder.id)} className="text-xs px-3 py-1.5 rounded-xl bg-emerald-100 border border-emerald-300 text-emerald-800 font-semibold">Export audit pack</button>
                  <button onClick={() => window.showRoleQueues && window.showRoleQueues()} className="text-xs px-3 py-1.5 rounded-xl bg-blue-100 border border-blue-300 text-blue-800 font-semibold">My queue</button>
                  <button onClick={runServerOcr} className="text-xs px-3 py-1.5 rounded-xl bg-cyan-100 border border-cyan-300 text-cyan-800 font-semibold">Run server OCR + bboxes</button>
                  <button onClick={() => window.showMasterDataTab && window.showMasterDataTab("table")} className="text-xs px-3 py-1.5 rounded-xl bg-purple-100 border border-purple-300 text-purple-800 font-semibold">Master data graph</button>
                  <button onClick={handleAmendmentDetect} className="text-xs px-3 py-1.5 rounded-xl bg-amber-100 border border-amber-300 text-amber-800 font-semibold" title="Detect amendment">Detect amendment</button>
                  {activeOrder.status === "APPROVED" && (
                    <button onClick={async () => {
                      if (!window.ObaraBackend || !window.ObaraBackend.isReady()) { setError("Backend not connected"); return; }
                      try {
                        const out = await window.ObaraBackend.tally.push({ orderId: activeOrder.id, payloadHash: activeOrder.approval && activeOrder.approval.payloadHash, salesOrder: activeOrder.result && activeOrder.result.salesOrder });
                        await recordAudit("tally_push", "Voucher " + (out.tallyVoucherId || "ack") + " status=" + out.status, activeOrder.id);
                        const refreshed = await window.ObaraBackend.orders.get(activeOrder.id);
                        if (refreshed && refreshed.order) {
                          const next = { ...activeOrder, status: refreshed.order.status, tally_status: refreshed.order.tally_status, tallyVoucherId: out.tallyVoucherId };
                          setActiveOrder(next);
                          setOrders((prev) => prev.map((o) => o && o.id === next.id ? next : o));
                        }
                      } catch (err) { setError("Tally push failed: " + err.message); }
                    }} className="text-xs px-3 py-1.5 rounded-xl bg-green-100 border border-green-300 text-green-800 font-semibold" title="Push approved SO to Tally">Push to Tally</button>
                  )}
                </div>
                {fxVariance && Object.keys(fxVariance).length > 0 && (
                  <div className="mt-2 p-2 bg-slate-50 border border-slate-200 rounded-xl text-xs">
                    <div className="font-bold text-slate-700 mb-1">FX variance vs quote</div>
                    <div className="flex gap-2 flex-wrap">
                      {Object.entries(fxVariance).map(([ccy, info]) => (
                        <FXVarianceBadge key={ccy} currency={ccy} variancePct={info.variancePct} />
                      ))}
                    </div>
                  </div>
                )}
                {activeOrder.customerKey && learnedRules[activeOrder.customerKey] && (
                  <div className="mt-2">
                    <LearnedRulesPanel
                      customerKey={activeOrder.customerKey}
                      learnedRules={learnedRules}
                      onAccept={async (field) => {
                        const ck = activeOrder.customerKey;
                        const formats = await loadFormats();
                        const profile = formats[ck] || {};
                        const learned = profile.learnedRules || {};
                        learned[field] = { savedAt: nowISO(), source: "user_accepted" };
                        formats[ck] = { ...profile, learnedRules: learned, lastUpdated: nowISO() };
                        await saveFormats(formats);
                        setCustomerFormats(formats);
                        await recordAudit("learned_rule_accepted", "Field " + field + " saved to customer profile", ck);
                      }}
                      onDismiss={async (field) => {
                        const all = { ...learnedRules };
                        if (all[activeOrder.customerKey] && all[activeOrder.customerKey].fieldEdits) delete all[activeOrder.customerKey].fieldEdits[field];
                        await saveLearnedRules(all);
                        setLearnedRules(all);
                      }}
                    />
                  </div>
                )}
                {activeOrder.tokenEstimate && (() => {`,
  "API cost card placement",
);

patchSo(
  `                })()}
                  <div className="mt-2 px-2 py-1 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-700 flex items-center gap-1">
                    <span>✅</span><span>Known format used</span>
                  </div>
                )}`,
  `                })()}
                {activeOrder.usedKnownFormat && (
                  <div className="mt-2 px-2 py-1 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-700 flex items-center gap-1">
                    <span>Known format used</span>
                  </div>
                )}`,
  "known format JSX fix",
);

patchSo(
  `const fp = profile.fingerprint || {};
                return (`,
  `const fp = profile.fingerprint || {};
                const stability = profileStability(profile);
                return (`,
  "customer stability variable",
);

patchSo(
  `{!profile.lastFormatChanged && profile.ordersProcessed > 1 && (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full border bg-emerald-100 text-emerald-800 border-emerald-300">Consistent</span>
                          )}`,
  `{!profile.lastFormatChanged && profile.ordersProcessed > 1 && (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full border bg-emerald-100 text-emerald-800 border-emerald-300">Consistent</span>
                          )}
                          <Pill label={stability.label} color={stability.color} />
                          {profile.trusted && <Pill label="Trusted" color="purple" />}
                          <GSTINBadge gstin={profile.customerGSTIN} />
                          {(() => {
                            const recencyDays = profile.lastUpdated ? Math.round((Date.now() - new Date(profile.lastUpdated).getTime()) / 86400000) : null;
                            const baseHealth = stability.score;
                            const recencyPenalty = recencyDays === null ? 0 : Math.min(40, Math.max(0, recencyDays - 60));
                            const score = Math.max(0, Math.round(baseHealth - recencyPenalty));
                            const tone = score >= 80 ? "green" : score >= 60 ? "blue" : score >= 35 ? "amber" : "red";
                            return <Pill label={"Health " + score + "%"} color={tone} />;
                          })()}`,
  "customer badges",
);

patchSo(
  `        {tab === "history" && (
          <Card>
            <CardHead title="Processing History" sub={orders.length + " entries"} accent={DARK} />
            <div className="p-4">
              <HistoryList
                orders={orders}
                onSelect={(o) => { setActiveOrder(o); setTab(o.result ? "overview" : "process"); }}
                onApprove={(o) => { setApprovalTarget(o); setShowApproval(true); }}
              />
            </div>
          </Card>
        )}`,
  String.raw`        {showEvidenceFor && activeOrder && activeOrder.id === showEvidenceFor && (
          <EvidenceViewer
            orderId={activeOrder.id}
            evidenceByField={activeOrder.evidenceByField || {}}
            focusField={evidenceFocusField}
            onClose={() => { setShowEvidenceFor(null); setEvidenceFocusField(null); }}
          />
        )}
        {tab === "history" && (() => {
          const q = (historyFilter.q || "").toLowerCase().trim();
          const filtered = orders.filter((o) => {
            if (historyFilter.status && o.status !== historyFilter.status) return false;
            if (!q) return true;
            const hay = [o.preflightPONumber, o.preflightCustomer, o.id, o.blockerSummary, o.formatChangeSummary, (o.result && o.result.po && o.result.po.customer)].filter(Boolean).join(" ").toLowerCase();
            return hay.includes(q);
          });
          const statusCounts = orders.reduce((acc, o) => { acc[o.status || "UNKNOWN"] = (acc[o.status || "UNKNOWN"] || 0) + 1; return acc; }, {});
          const exportFiltered = (fmt) => {
            const rows = filtered.map((o) => ({
              id: o.id, status: o.status, customer: o.preflightCustomer || (o.result && o.result.po && o.result.po.customer) || "",
              po: o.preflightPONumber || (o.result && o.result.po && o.result.po.number) || "",
              total: (o.result && o.result.salesOrder && o.result.salesOrder.grandTotal) || "",
              created: o.createdAt, blocker: o.blockerSummary || "", anomalies: (o.anomalyFlags || []).map((a) => a.label).join("; "),
            }));
            if (fmt === "json") {
              dlFile(JSON.stringify(rows, null, 2), "SO_History_filtered.json", "application/json");
            } else if (fmt === "jsonl") {
              dlFile(rows.map((r) => JSON.stringify(r)).join("\n"), "SO_History_filtered.jsonl", "application/jsonl");
            }
          };
          const selectedIds = Object.keys(selectedOrderIds).filter((k) => selectedOrderIds[k]);
          const toggleSelect = (id) => setSelectedOrderIds((prev) => ({ ...prev, [id]: !prev[id] }));
          const selectAll = () => {
            const next = {};
            filtered.forEach((o) => { if (o && o.id) next[o.id] = true; });
            setSelectedOrderIds(next);
          };
          const clearSelection = () => setSelectedOrderIds({});
          const bulkDelete = async () => {
            if (!selectedIds.length) return;
            if (!confirm("Delete " + selectedIds.length + " order(s) from local history? Cache and audit log are kept.")) return;
            for (const id of selectedIds) await removeOrder(id);
            clearSelection();
          };
          const bulkExportJson = () => {
            const rows = filtered.filter((o) => o && selectedOrderIds[o.id]);
            if (!rows.length) return;
            dlFile(JSON.stringify(rows, null, 2), "SO_Selected_" + rows.length + ".json", "application/json");
            recordAudit("bulk_export_json", "Exported " + rows.length + " orders", null);
          };
          return (
            <Card>
              <CardHead title="Processing History" sub={filtered.length + " of " + orders.length + " entries"} accent={DARK} />
              <div className="p-4 space-y-3">
                <div className="flex flex-wrap gap-2 items-center">
                  <input
                    value={historyFilter.q}
                    onChange={(e) => setHistoryFilter({ ...historyFilter, q: e.target.value })}
                    placeholder="Search PO, customer, status..."
                    className="flex-1 min-w-[200px] border border-slate-300 rounded-xl p-2 text-sm bg-white"
                  />
                  <select
                    value={historyFilter.status}
                    onChange={(e) => setHistoryFilter({ ...historyFilter, status: e.target.value })}
                    className="border border-slate-300 rounded-xl p-2 text-sm bg-white"
                  >
                    <option value="">All statuses</option>
                    {Object.keys(statusCounts).map((s) => <option key={s} value={s}>{s} ({statusCounts[s]})</option>)}
                  </select>
                  {compareTarget ? (
                    <button onClick={() => setCompareTarget(null)} className="text-xs px-3 py-2 rounded-xl bg-purple-100 border border-purple-300 text-purple-700 font-semibold">Cancel compare</button>
                  ) : null}
                  <button onClick={() => exportFiltered("json")} className="text-xs px-3 py-2 rounded-xl bg-slate-100 border border-slate-300 text-slate-700 font-semibold">Export JSON</button>
                  <button onClick={() => exportFiltered("jsonl")} className="text-xs px-3 py-2 rounded-xl bg-slate-100 border border-slate-300 text-slate-700 font-semibold">Export JSONL</button>
                </div>
                {selectedIds.length > 0 && (
                  <div className="p-2 bg-blue-50 border border-blue-200 rounded-xl flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-blue-800">{selectedIds.length} selected</span>
                    <div className="flex gap-2">
                      <button onClick={bulkExportJson} className="px-2 py-1 rounded bg-white border border-blue-300 text-blue-700 font-semibold">Export JSON</button>
                      <button onClick={bulkDelete} className="px-2 py-1 rounded bg-red-50 border border-red-300 text-red-700 font-semibold">Delete</button>
                      <button onClick={clearSelection} className="px-2 py-1 rounded bg-slate-50 border border-slate-300 text-slate-600 font-semibold">Clear</button>
                    </div>
                  </div>
                )}
                {filtered.length === 0 && (
                  <div className="text-center py-12 text-slate-400">
                    <div className="text-4xl mb-3">{orders.length === 0 ? "📂" : "🔎"}</div>
                    <div className="font-semibold">{orders.length === 0 ? "No orders yet" : "No matches for this filter"}</div>
                    <div className="text-xs mt-2">{orders.length === 0 ? "Process a PO and quote to populate history." : "Try a broader search or clear the status filter."}</div>
                    {orders.length === 0 && (
                      <button onClick={seedSampleData} className="mt-3 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold">Load sample data</button>
                    )}
                  </div>
                )}
                {filtered.length > 0 && (
                  <div className="flex justify-end">
                    <button onClick={selectAll} className="text-xs text-slate-500 hover:text-slate-800">{selectedIds.length === filtered.length ? "Deselect" : "Select all"}</button>
                  </div>
                )}
                <div className="space-y-2">
                  {filtered.map((o) => {
                    const isBlocked = o.status === "BLOCKED" || o.status === "DUPLICATE";
                    const crit = ((o.result && o.result.discrepancies) || []).filter((d) => d.severity === "CRITICAL").length;
                    const warn = ((o.result && o.result.discrepancies) || []).filter((d) => d.severity === "WARNING").length;
                    const total = o.result && o.result.salesOrder && o.result.salesOrder.grandTotal;
                    const selected = !!selectedOrderIds[o.id];
                    return (
                      <div key={o.id} className={"p-3 border rounded-2xl flex items-start gap-3 " + (isBlocked ? "bg-slate-50 border-slate-200" : "bg-white border-slate-200") + (selected ? " ring-2 ring-blue-300" : "")}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleSelect(o.id)}
                          className="mt-1"
                          aria-label="Select order"
                        />
                        <div
                          className="flex-1 min-w-0 cursor-pointer"
                          onClick={() => {
                            if (compareTarget && o && o.id !== compareTarget.id) {
                              setActiveOrder({ ...compareTarget, _compareWith: o });
                              setTab("compare");
                              setCompareTarget(null);
                            } else {
                              setActiveOrder(o); setTab(o.result ? "overview" : "process");
                            }
                          }}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-sm font-mono text-slate-800">{(o.result && o.result.salesOrder && o.result.salesOrder.voucherNo) || o.preflightPONumber || o.id}</span>
                            <StatusPill status={o.status} />
                            {!isBlocked && crit > 0 && <span className="text-xs text-red-500 font-semibold">{crit} critical</span>}
                            {!isBlocked && warn > 0 && <span className="text-xs text-amber-500">{warn} warnings</span>}
                            {(o.anomalyFlags || []).length > 0 && <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">{(o.anomalyFlags || []).length} anomalies</span>}
                            {o.costAvoidedReason && <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">Reused</span>}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">{(o.result && o.result.po && o.result.po.customer) || o.preflightCustomer || "-"} · PO: {o.preflightPONumber || (o.result && o.result.po && o.result.po.number) || "-"}</div>
                          <div className="text-xs text-slate-400">{dateLabel(o.createdAt)} {timeLabel(o.createdAt)}</div>
                          {o.blockerSummary && <div className="text-xs text-red-500 italic mt-1">Blocked: {o.blockerSummary}</div>}
                        </div>
                        <div className="flex flex-col items-end gap-2 flex-shrink-0">
                          {!isBlocked && <div className="font-bold text-sm text-slate-800">{fmt(total)}</div>}
                          {o.status === "PENDING_REVIEW" && crit > 0 && (
                            <button onClick={(e) => { e.stopPropagation(); setApprovalTarget(o); setShowApproval(true); }} className="text-xs font-bold text-amber-700 bg-amber-100 border border-amber-300 px-2 py-1 rounded-lg hover:bg-amber-200">Review</button>
                          )}
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!confirm("Delete this order from local history?")) return;
                              await removeOrder(o.id);
                            }}
                            className="text-xs text-red-500 border border-red-200 bg-red-50 px-2 py-0.5 rounded hover:bg-red-100"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {auditLog.length > 0 && (
                  <details className="mt-4 border border-slate-200 rounded-xl">
                    <summary className="px-3 py-2 text-xs font-bold text-slate-600 cursor-pointer">Recent audit entries ({auditLog.length})</summary>
                    <div className="p-3 max-h-72 overflow-auto text-xs space-y-1">
                      {auditLog.slice(0, 80).map((a, i) => (
                        <div key={i} className="flex justify-between gap-3 border-b border-slate-100 pb-1">
                          <span className="text-slate-400 font-mono">{a.at.slice(5, 16).replace("T", " ")}</span>
                          <span className="font-semibold text-slate-700 flex-shrink-0">{a.action}</span>
                          <span className="text-slate-500 truncate flex-1">{a.detail}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>Tip:</span>
                  <button onClick={() => setCompareTarget(activeOrder)} disabled={!activeOrder} className="px-2 py-1 rounded bg-purple-50 border border-purple-200 text-purple-700 font-semibold disabled:opacity-40">Compare current with another</button>
                  <button onClick={seedSampleData} className="px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 font-semibold">Load sample data</button>
                  <button onClick={clearSampleData} className="px-2 py-1 rounded bg-slate-50 border border-slate-200 text-slate-600 font-semibold">Clear samples</button>
                </div>
              </div>
            </Card>
          );
        })()}
        {tab === "compare" && activeOrder && activeOrder._compareWith && (
          <Card>
            <CardHead title="Side-by-side comparison" sub={(activeOrder.preflightPONumber || activeOrder.id) + " vs " + (activeOrder._compareWith.preflightPONumber || activeOrder._compareWith.id)} accent="#7c3aed" />
            <div className="grid grid-cols-2 gap-4 p-4 text-xs">
              {[activeOrder, activeOrder._compareWith].map((o, i) => (
                <div key={i} className="border border-slate-200 rounded-xl p-3 bg-slate-50">
                  <div className="font-bold text-slate-700 mb-2">{o.preflightCustomer || (o.result && o.result.po && o.result.po.customer) || "Unknown"}</div>
                  <div className="font-mono text-slate-500 mb-2">PO {o.preflightPONumber || (o.result && o.result.po && o.result.po.number) || "-"}</div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                    <span className="text-slate-400">Status</span><span>{o.status}</span>
                    <span className="text-slate-400">Lines</span><span>{(o.result && o.result.salesOrder && o.result.salesOrder.lineItems && o.result.salesOrder.lineItems.length) || 0}</span>
                    <span className="text-slate-400">Total</span><span className="font-mono">{((o.result && o.result.salesOrder && o.result.salesOrder.grandTotal) || 0).toLocaleString("en-IN")}</span>
                    <span className="text-slate-400">Created</span><span>{(o.createdAt || "").slice(0, 10)}</span>
                    <span className="text-slate-400">Format</span><span>{o.formatStatus || "-"}</span>
                    <span className="text-slate-400">Anomalies</span><span>{(o.anomalyFlags || []).length}</span>
                  </div>
                  {(o.anomalyFlags || []).length > 0 && (
                    <div className="mt-2"><AnomalyBadges flags={o.anomalyFlags} /></div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}`,
  "history filter and compare",
);

patchSo(
  `const makeDataURI = (content, mime) => {`,
  String.raw`const buildSalesOrderMarkdown = (so) => {
  if (!so) return "";
  const lines = [
    "# Sales Order " + (so.voucherNo || ""),
    "",
    "**Date:** " + (so.date || "-"),
    "**PO Reference:** " + (so.reference || "-"),
    "**Party:** " + (so.partyName || "-"),
    "**Bill to:** " + ((so.billTo && so.billTo.name) || "-") + " · GSTIN " + ((so.billTo && so.billTo.gstin) || "-"),
    "**Ship to:** " + ((so.shipTo && so.shipTo.name) || "-") + " · GSTIN " + ((so.shipTo && so.shipTo.gstin) || "-"),
    "",
    "## Line items",
    "",
    "| # | Item | HSN | Qty | UOM | Rate | Amount | CGST | SGST | IGST | Total |",
    "|---|------|-----|-----|-----|------|--------|------|------|------|-------|",
  ];
  (so.lineItems || []).forEach((li) => {
    lines.push("| " + [
      li.sno || "",
      (li.tallyItemName || li.itemName || "").replace(/\|/g, "/"),
      li.hsnCode || "",
      li.qty || "",
      li.uom || "",
      li.rate || "",
      li.amount || "",
      (li.cgst || "0") + "% / " + (li.cgstAmt || 0),
      (li.sgst || "0") + "% / " + (li.sgstAmt || 0),
      (li.igst || "0") + "% / " + (li.igstAmt || 0),
      li.totalWithGst || "",
    ].join(" | ") + " |");
  });
  lines.push("", "**Sub Total:** " + (so.subTotal || 0));
  lines.push("**CGST Total:** " + (so.totalCgst || 0));
  lines.push("**SGST Total:** " + (so.totalSgst || 0));
  lines.push("**IGST Total:** " + (so.totalIgst || 0));
  lines.push("**Grand Total:** " + (so.grandTotal || 0));
  if (so.narration) {
    lines.push("", "## Narration", "", so.narration);
  }
  return lines.join("\n");
};

const buildSalesOrderPrintHtml = (so, sourcePOs, anomalyFlags) => {
  if (!so) return "";
  const css = "body{font-family:Inter,Arial,sans-serif;color:#1c1917;padding:24px;font-size:12px}h1{font-size:18px;margin-bottom:6px}h2{font-size:14px;margin:18px 0 8px;border-bottom:2px solid #94a3b8;padding-bottom:4px}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #cbd5e1;padding:5px 7px;text-align:left;font-size:11px}th{background:#f1f5f9;font-weight:700}.meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;margin:10px 0}.meta div{font-size:11px;color:#475569}.meta strong{color:#1c1917}.totals{margin-top:12px;display:flex;justify-content:flex-end}.totals table{width:auto;min-width:280px}.alert{background:#fef3c7;border:1px solid #fde68a;padding:8px 10px;border-radius:6px;margin:8px 0}@media print{body{padding:14px;font-size:11px}.no-print{display:none}}";
  const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>\"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const rows = (so.lineItems || []).map((li, i) => "<tr><td>" + (li.sno || (i+1)) + "</td><td>" + escapeHtml(li.tallyItemName || li.itemName) + "</td><td>" + escapeHtml(li.hsnCode) + "</td><td>" + escapeHtml(li.qty) + "</td><td>" + escapeHtml(li.uom) + "</td><td style='text-align:right'>" + escapeHtml(li.rate) + "</td><td style='text-align:right'>" + escapeHtml(li.amount) + "</td><td style='text-align:right'>" + escapeHtml(li.totalWithGst) + "</td></tr>").join("");
  const anomaliesHtml = (anomalyFlags || []).length ? "<div class='alert'><strong>Anomalies vs customer history:</strong><ul>" + anomalyFlags.map((f) => "<li>" + escapeHtml(f.label) + " - " + escapeHtml(f.detail) + "</li>").join("") + "</ul></div>" : "";
  const spoHtml = (sourcePOs || []).length ? "<h2>Source Purchase Orders</h2><table><thead><tr><th>Country</th><th>Supplier</th><th>Currency</th><th>Lines</th><th>Total INR</th></tr></thead><tbody>" + sourcePOs.map((s) => "<tr><td>" + escapeHtml(s.country) + "</td><td>" + escapeHtml(s.supplier) + "</td><td>" + escapeHtml(s.currency) + "</td><td>" + ((s.lineItems || []).length) + "</td><td style='text-align:right'>" + escapeHtml(s.totalINR || "-") + "</td></tr>").join("") + "</tbody></table>" : "";
  return "<!doctype html><html><head><meta charset='utf-8'><title>Sales Order " + escapeHtml(so.voucherNo) + "</title><style>" + css + "</style></head><body><h1>Sales Order " + escapeHtml(so.voucherNo) + "</h1><div class='meta'><div><strong>Date:</strong> " + escapeHtml(so.date) + "</div><div><strong>PO Ref:</strong> " + escapeHtml(so.reference) + "</div><div><strong>Party:</strong> " + escapeHtml(so.partyName) + "</div><div><strong>Bill GSTIN:</strong> " + escapeHtml(so.billTo && so.billTo.gstin) + "</div><div><strong>Ship to:</strong> " + escapeHtml(so.shipTo && so.shipTo.name) + "</div><div><strong>Ship GSTIN:</strong> " + escapeHtml(so.shipTo && so.shipTo.gstin) + "</div></div>" + anomaliesHtml + "<h2>Line items</h2><table><thead><tr><th>#</th><th>Item</th><th>HSN</th><th>Qty</th><th>UOM</th><th>Rate</th><th>Amount</th><th>Total inc GST</th></tr></thead><tbody>" + rows + "</tbody></table><div class='totals'><table><tbody><tr><td>Sub Total</td><td style='text-align:right'>" + escapeHtml(so.subTotal) + "</td></tr><tr><td>CGST</td><td style='text-align:right'>" + escapeHtml(so.totalCgst) + "</td></tr><tr><td>SGST</td><td style='text-align:right'>" + escapeHtml(so.totalSgst) + "</td></tr><tr><td>IGST</td><td style='text-align:right'>" + escapeHtml(so.totalIgst) + "</td></tr><tr><td><strong>Grand Total</strong></td><td style='text-align:right'><strong>" + escapeHtml(so.grandTotal) + "</strong></td></tr></tbody></table></div>" + spoHtml + (so.narration ? "<h2>Narration</h2><div>" + escapeHtml(so.narration) + "</div>" : "") + "</body></html>";
};

const printSalesOrder = (so, sourcePOs, anomalyFlags) => {
  const html = buildSalesOrderPrintHtml(so, sourcePOs, anomalyFlags);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank", "width=900,height=700");
  if (!win) {
    dlFile(html, "SO_" + (so.voucherNo || "export") + ".html", "text/html");
    URL.revokeObjectURL(url);
    return;
  }
  setTimeout(() => { try { win.focus(); win.print(); } catch (_) {} }, 600);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

const makeDataURI = (content, mime) => {`,
  "markdown and print export builders",
);

patchSo(
  `                  {sourcePOs.length > 0 && (
                    <>
                      <div className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1 pt-2">Source Purchase Orders — Procurement CSVs</div>`,
  String.raw`                  <div className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1 pt-2">Print, Markdown, and JSON</div>
                  <div className="grid grid-cols-3 gap-3">
                    <Card>
                      <CardHead title="Print / PDF" sub="Open print dialog · save as PDF from there" accent="#7c2d12" />
                      <div className="p-4 space-y-2">
                        <button
                          onClick={() => printSalesOrder(so, sourcePOs, activeOrder && activeOrder.anomalyFlags)}
                          className="block w-full text-center text-white text-sm font-semibold py-2 px-4 rounded-xl shadow-md"
                          style={{ background: "linear-gradient(135deg,#7c2d12,#9a3412)" }}>
                          Print Sales Order
                        </button>
                        <div className="text-xs text-slate-400">Browser print > Save as PDF works on all major browsers.</div>
                      </div>
                    </Card>
                    <Card>
                      <CardHead title="Markdown" sub="For email handoff or doc embedding" accent="#1e40af" />
                      <div className="p-4 space-y-2">
                        <button
                          onClick={() => {
                            const md = buildSalesOrderMarkdown(so);
                            dlFile(md, "SO_" + (so.reference || "export") + ".md", "text/markdown");
                            recordAudit("export_md", "Markdown export for " + (so.voucherNo || ""), activeOrder && activeOrder.id);
                          }}
                          className="block w-full text-center text-white text-sm font-semibold py-2 px-4 rounded-xl shadow-md"
                          style={{ background: "linear-gradient(135deg,#1e40af,#1d4ed8)" }}>
                          Download Markdown
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(buildSalesOrderMarkdown(so));
                              recordAudit("copy_md", "Markdown copied for " + (so.voucherNo || ""), activeOrder && activeOrder.id);
                            } catch (_) {
                              dlFile(buildSalesOrderMarkdown(so), "SO_" + (so.reference || "export") + ".md", "text/markdown");
                            }
                          }}
                          className="block w-full text-center text-blue-700 text-xs font-semibold py-1.5 px-3 rounded-xl border border-blue-200 bg-blue-50">
                          Copy to clipboard
                        </button>
                      </div>
                    </Card>
                    <Card>
                      <CardHead title="JSON" sub="Structured handoff for backend or audit" accent="#065f46" />
                      <div className="p-4 space-y-2">
                        <button
                          onClick={() => {
                            const payload = { exportedAt: nowISO(), salesOrder: so, sourcePOs, anomalyFlags: (activeOrder && activeOrder.anomalyFlags) || [], audit: { orderId: activeOrder && activeOrder.id } };
                            dlFile(JSON.stringify(payload, null, 2), "SO_" + (so.reference || "export") + ".json", "application/json");
                            recordAudit("export_json", "JSON export for " + (so.voucherNo || ""), activeOrder && activeOrder.id);
                          }}
                          className="block w-full text-center text-white text-sm font-semibold py-2 px-4 rounded-xl shadow-md"
                          style={{ background: "linear-gradient(135deg,#065f46,#047857)" }}>
                          Download JSON
                        </button>
                      </div>
                    </Card>
                  </div>

                  {sourcePOs.length > 0 && (
                    <>
                      <div className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1 pt-2">Source Purchase Orders — Procurement CSVs</div>`,
  "extra export formats",
);

patchSo(
  /<button\s+onClick=\{async \(\) => \{\s+const updated = \{ \.\.\.customerFormats \};\s+delete updated\[key\];\s+await saveFormats\(updated\);\s+setCustomerFormats\(updated\);\s+\}\}\s+className="text-xs text-red-500 border border-red-200 bg-red-50 px-3 py-1.5 rounded-xl hover:bg-red-100 font-semibold flex-shrink-0"\s+>\s+Reset\s+<\/button>/,
  String.raw`<div className="flex gap-2 flex-shrink-0 flex-wrap items-center justify-end">
                        <BudgetEditor profile={profile} budgets={customerBudgets} onChange={updateCustomerBudget} />
                        <button
                          onClick={() => window.showProfileStudio && window.showProfileStudio(key)}
                          className="text-xs text-cyan-700 border border-cyan-200 bg-cyan-50 px-3 py-1.5 rounded-xl hover:bg-cyan-100 font-semibold"
                        >
                          Studio
                        </button>
                        <QuoteFreshnessEditor
                          profile={{ customerKey: key, quoteValidityDays: profile.quoteValidityDays }}
                          onSave={async (customerKey, days) => {
                            const updated = { ...customerFormats, [customerKey]: { ...profile, quoteValidityDays: Number(days) || 90, lastUpdated: nowISO() } };
                            await saveFormats(updated);
                            setCustomerFormats(updated);
                            await recordAudit("quote_validity_change", customerKey + " -> " + days + " days", customerKey);
                          }}
                        />
                        <button
                          onClick={() => {
                            setHistoryFilter({ q: profile.customerName || profile.customerKey, status: "" });
                            setTab("history");
                            recordAudit("view_customer_history", profile.customerName || profile.customerKey, profile.customerKey);
                          }}
                          className="text-xs text-amber-700 border border-amber-200 bg-amber-50 px-3 py-1.5 rounded-xl hover:bg-amber-100 font-semibold"
                        >
                          View their orders
                        </button>
                        <button
                          onClick={() => {
                            const tpl = buildExtractionTemplate(profile, orders);
                            dlFile(JSON.stringify(tpl, null, 2), "ExtractionTemplate_" + (profile.customerKey || "customer") + ".json", "application/json");
                            recordAudit("export_template", "Exported extraction template for " + (profile.customerName || profile.customerKey), profile.customerKey);
                          }}
                          className="text-xs text-teal-600 border border-teal-200 bg-teal-50 px-3 py-1.5 rounded-xl hover:bg-teal-100 font-semibold"
                        >
                          Generate template
                        </button>
                        <button
                          onClick={() => exportExtractorRecipe(profile)}
                          className="text-xs text-blue-600 border border-blue-200 bg-blue-50 px-3 py-1.5 rounded-xl hover:bg-blue-100 font-semibold"
                        >
                          Export recipe
                        </button>
                        <button
                          onClick={async () => {
                            const updated = { ...customerFormats, [key]: { ...profile, trusted: !profile.trusted, lastUpdated: nowISO() } };
                            await saveFormats(updated);
                            setCustomerFormats(updated);
                            await recordAudit(profile.trusted ? "unpin_profile" : "pin_profile", profile.customerName || profile.customerKey, profile.customerKey);
                          }}
                          className="text-xs text-purple-600 border border-purple-200 bg-purple-50 px-3 py-1.5 rounded-xl hover:bg-purple-100 font-semibold"
                        >
                          {profile.trusted ? "Unpin" : "Pin trusted"}
                        </button>
                        <button
                          onClick={async () => {
                            const updated = { ...customerFormats };
                            delete updated[key];
                            await saveFormats(updated);
                            setCustomerFormats(updated);
                            await recordAudit("reset_profile", profile.customerName || profile.customerKey, profile.customerKey);
                          }}
                          className="text-xs text-red-500 border border-red-200 bg-red-50 px-3 py-1.5 rounded-xl hover:bg-red-100 font-semibold"
                        >
                          Reset
                        </button>
                      </div>`,
  "customer actions",
);

patchSo(
  `<div className="grid grid-cols-3 gap-x-8 gap-y-3 mb-4">
                        {[`,
  `<div className="grid grid-cols-3 gap-x-8 gap-y-3 mb-4">
                        {[
                          ["Reuse Score", stability.score + "%"],
                          ["Extractor Readiness", stability.ready ? "Ready" : "Not ready"],
                          ["Backend Path", recommendedBackendPath(profile)],`,
  "customer reuse fields",
);

const soScript = `<script type="text/babel" data-presets="react">
(() => {
${storageShim}

const { useState, useRef, useCallback, useEffect, useMemo } = React;

${soAppSource}

function mountSoAgent() {
  const rootEl = document.getElementById("so-agent-root");
  if (!rootEl || rootEl.dataset.mounted === "true") return;
  rootEl.dataset.mounted = "true";
  const root = ReactDOM.createRoot(rootEl);
  root.render(<SOAgentApp />);
}

window.mountSoAgent = mountSoAgent;
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountSoAgent);
} else {
  mountSoAgent();
}
})();
</script>`;

const opsAssistantScript = `<script>
(() => {
  const BACKUP_EXCLUDE = new Set(["sb_key"]);
  const RESTORE_BLOCK = new Set(["sb_key"]);
  const DB_TABS = new Set(["import", "guns", "search", "usage", "matrix", "sohistory"]);
  let lastDiagnostics = [];
  let paletteIndex = 0;

  const actionList = [
    { id:"overview", label:"Open Ops Overview", detail:"Status, health, backups, and shortcuts", run:() => showTab("overview"), key:"Home" },
    { id:"onboarding", label:"Open Onboarding", detail:"Guided setup and first workflow checklist", run:showOnboardingFlow, key:"Start" },
    { id:"process-improvements", label:"Show Process Improvements", detail:"Accuracy, efficiency, and production readiness gaps", run:showProcessImprovements, key:"Improve" },
    { id:"integration-report", label:"Show Integration Report", detail:"Verify the HTML and React prototypes are fully integrated", run:showIntegrationReport, key:"Report" },
    { id:"so-cost-policy", label:"Open SO Cost Policy", detail:"Tune prompt caching, reuse behavior, and price-composition handling", run:() => openSoAgentPanel("process"), key:"Cost" },
    { id:"so-customer-profiles", label:"Open Customer Profiles", detail:"Review format memory, extractor readiness, and trusted profile pins", run:() => openSoAgentPanel("customers"), key:"Profiles" },
    { id:"format-guide", label:"Show Format Guide", detail:"Supported import and export formats by workflow", run:showFormatGuide, key:"Formats" },
    { id:"sales", label:"Process Sales Order", detail:"Open SO agent for PO, quote, price comp, Tally exports", run:() => showTab("sales"), key:"Sales" },
    { id:"import", label:"Import BOM Files", detail:"Upload Excel, CSV, TSV, or TXT BOMs from India, Korea, China, or Japan", run:() => showTab("import"), key:"BOM" },
    { id:"upload-bom", label:"Choose BOM Files", detail:"Open the BOM file picker", run:() => clickIfPresent("file-input"), key:"Upload" },
    { id:"guns", label:"Browse Guns", detail:"View gun BOMs, hierarchy, drawing links, and matrix usage", run:() => showTab("guns"), key:"Guns" },
    { id:"search", label:"Search Guns and Parts", detail:"Global search across guns, parts, customers, and sales records", run:() => showTab("search"), key:"Search" },
    { id:"usage", label:"Open Usage Analytics", detail:"Find parts shared across multiple guns", run:() => showTab("usage"), key:"Usage" },
    { id:"matrix", label:"Open Spare Matrix", detail:"Build project spares worksheets and recommended spares", run:() => showTab("matrix"), key:"Matrix" },
    { id:"new-matrix", label:"Create Spare Matrix", detail:"Start a new customer/project spare matrix", run:() => safeCall("showNewMatrixModal"), key:"New" },
    { id:"so-history", label:"Open SO History", detail:"Historical pricing and delivery records", run:() => showTab("sohistory"), key:"History" },
    { id:"upload-so-history", label:"Import SO History Files", detail:"Open the sales order history file picker for Excel, CSV, TSV, or TXT", run:() => clickIfPresent("soh-file-input"), key:"Upload" },
    { id:"matrix-export-csv", label:"Export Matrix CSV", detail:"Download the current spare matrix as comma-delimited text", run:() => exportMatrixData("csv"), key:"CSV" },
    { id:"matrix-export-tsv", label:"Export Matrix TSV", detail:"Download the current spare matrix as tab-delimited text", run:() => exportMatrixData("tsv"), key:"TSV" },
    { id:"matrix-export-json", label:"Export Matrix JSON", detail:"Download the current spare matrix as structured JSON", run:() => exportMatrixData("json"), key:"JSON" },
    { id:"rs-export-csv", label:"Export Recommended Spares CSV", detail:"Download recommended spares as comma-delimited text", run:() => exportRecommendedSparesData("csv"), key:"CSV" },
    { id:"so-history-export-csv", label:"Export SO History CSV", detail:"Download loaded SO history rows as CSV", run:() => exportSoHistoryData("csv"), key:"CSV" },
    { id:"so-history-export-tsv", label:"Export SO History TSV", detail:"Download loaded SO history rows as TSV", run:() => exportSoHistoryData("tsv"), key:"TSV" },
    { id:"so-history-export-json", label:"Export SO History JSON", detail:"Download loaded SO history rows as JSON", run:() => exportSoHistoryData("json"), key:"JSON" },
    { id:"so-agent-export-json", label:"Export SO Agent History JSON", detail:"Download browser-local SO agent records", run:() => exportSoAgentHistory("json"), key:"JSON" },
    { id:"settings", label:"Open Settings", detail:"Supabase, schema helpers, and drawing link setup", run:() => showTab("settings"), key:"Config" },
    { id:"health", label:"Run Health Check", detail:"Validate libraries, storage, SO agent, and optional backend", run:runOpsHealthCheck, key:"Check" },
    { id:"backup", label:"Export Local Backup", detail:"Download non-secret local state as JSON", run:exportOpsBackup, key:"Backup" },
    { id:"restore", label:"Restore Local Backup", detail:"Import a previous non-secret JSON backup", run:() => clickIfPresent("ops-restore-input"), key:"Restore" },
    { id:"intake-checklist", label:"Show SO Intake Checklist", detail:"What to collect before running PO to SO generation", run:showSoIntakeChecklist, key:"Checklist" },
    { id:"shortcuts", label:"Show Keyboard Shortcuts", detail:"Command palette, search focus, and overview shortcuts", run:showOpsShortcuts, key:"?" },
  ];

  function byId(id) { return document.getElementById(id); }
  function escText(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }
  function ensureToastEl() {
    let el = byId("ops-toast");
    if (el) return el;
    el = document.createElement("div");
    el.id = "ops-toast";
    el.style.cssText = "position:fixed;bottom:64px;right:24px;z-index:1000;display:flex;flex-direction:column;gap:6px;align-items:flex-end;pointer-events:none";
    document.body.appendChild(el);
    return el;
  }
  function notifyVariant(msg, kind, ttlMs) {
    const colors = {
      success: { bg: "var(--ok)", color: "#fff" },
      info:    { bg: "var(--info)", color: "#fff" },
      warn:    { bg: "var(--warn)", color: "#fff" },
      error:   { bg: "var(--err)", color: "#fff" },
    };
    const meta = colors[kind] || colors.info;
    const wrap = ensureToastEl();
    const node = document.createElement("div");
    node.style.cssText = "background:" + meta.bg + ";color:" + meta.color + ";padding:9px 14px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,.15);max-width:340px;pointer-events:auto;animation:fadeIn .15s";
    node.textContent = String(msg || "");
    wrap.appendChild(node);
    const timeout = Number(ttlMs || (kind === "error" ? 7000 : 4000));
    setTimeout(() => { node.style.opacity = "0"; node.style.transition = "opacity .25s"; setTimeout(() => node.remove(), 250); }, timeout);
  }
  function notify(msg, isErr) {
    if (isErr) { notifyVariant(msg, "error"); return; }
    notifyVariant(msg, "info");
  }
  function notifySuccess(msg) { notifyVariant(msg, "success"); }
  function notifyWarn(msg) { notifyVariant(msg, "warn"); }
  function notifyError(msg) { notifyVariant(msg, "error"); }

  function checkStoragePressure() {
    let used = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key) || "";
      used += key.length + value.length;
    }
    const budget = 4 * 1024 * 1024;
    const ratio = used / budget;
    return { used, budget, ratio, level: ratio > 0.9 ? "critical" : ratio > 0.75 ? "warn" : "ok" };
  }

  function showStorageStatusModal() {
    const status = checkStoragePressure();
    const usedKb = (status.used / 1024).toFixed(1);
    const budgetKb = (status.budget / 1024).toFixed(0);
    const html = '<div class="ops-modal-body">' +
      '<p>Browser storage holds SO agent history, customer profiles, audit log, cache, and settings.</p>' +
      '<div class="ops-cost-grid">' +
      '<div class="ops-cost-card ' + (status.level === "critical" ? "red" : status.level === "warn" ? "amber" : "green") + '"><div class="label">Used</div><div class="value">' + usedKb + ' KB</div><div class="sub">of estimated ' + budgetKb + ' KB budget</div></div>' +
      '<div class="ops-cost-card"><div class="label">Pressure</div><div class="value">' + Math.round(status.ratio * 100) + '%</div><div class="sub">' + (status.level === "critical" ? "Critical, compact now" : status.level === "warn" ? "Approaching cap" : "Healthy") + '</div></div>' +
      '</div>' +
      '<div class="ops-actions" style="margin-top:14px">' +
      '<button class="btn btn-yellow" onclick="compactSoStorage()">Compact cache and audit</button>' +
      '<button class="btn btn-ghost" onclick="exportOpsBackup()">Export backup</button>' +
      '<button class="btn btn-ghost" onclick="closeOpsModal()">Close</button>' +
      '</div></div>';
    showOpsModal("Storage Status", html);
  }

  async function compactSoStorage() {
    try {
      const cacheKey = "so_agent:result_cache";
      const auditKey = "so_agent:audit_log";
      const cache = readJsonKey(cacheKey, {});
      const entries = Object.entries(cache).sort((a, b) => new Date((b[1] && b[1].savedAt) || 0).getTime() - new Date((a[1] && a[1].savedAt) || 0).getTime());
      const trimmed = {};
      entries.slice(0, 50).forEach(([k, v]) => { trimmed[k] = v; });
      localStorage.setItem(cacheKey, JSON.stringify(trimmed));
      const audit = readJsonKey(auditKey, []);
      localStorage.setItem(auditKey, JSON.stringify(audit.slice(0, 200)));
      notifySuccess("Compacted cache to 50 entries and audit log to 200 entries.");
      closeOpsModal();
      renderOverview();
    } catch (err) {
      notifyError("Compact failed: " + err.message);
    }
  }

  function exportAuditLogCsv() {
    const log = readJsonKey("so_agent:audit_log", []);
    if (!log.length) { notifyWarn("Audit log is empty."); return; }
    const rows = [["When", "Action", "Detail", "Ref"]].concat(log.map((a) => [a.at || "", a.action || "", a.detail || "", a.refId || ""]));
    exportAoa("AuditLog", "Audit Log", rows, "csv");
  }
  function exportAuditLogJson() {
    const log = readJsonKey("so_agent:audit_log", []);
    if (!log.length) { notifyWarn("Audit log is empty."); return; }
    downloadTextFile("AuditLog_" + fileStamp() + ".json", "application/json", JSON.stringify(log, null, 2));
  }
  function safeCall(name) {
    const fn = window[name] || (typeof globalThis !== "undefined" ? globalThis[name] : null);
    if (typeof fn === "function") fn();
    else notify(name + " is not available in this view.", true);
  }
  function openSoAgentPanel(panel) {
    showTab("sales");
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("so-agent:navigate", { detail:{ tab:panel || "process" } }));
    }, 40);
  }
  function clickIfPresent(id) {
    const el = byId(id);
    if (el) el.click();
    else notify("Control not available yet. Open the related tab first.", true);
  }
  function readJsonKey(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }
  function localOrders() { return readJsonKey("so_agent:orders", []); }
  function localMetrics() { return readJsonKey("so_agent:metrics", {}); }
  function localFormats() { return readJsonKey("so_agent:customer_formats", {}); }
  function localCostPolicy() {
    return Object.assign({ mode:"realtime", promptCache:"5m", priceComp:"include" }, readJsonKey("so_agent:cost_policy", {}));
  }
  function profileState(profile) {
    const count = Number(profile && profile.ordersProcessed || 0);
    if (profile && profile.lastFormatChanged) return "changed";
    if (count >= 3) return "extractor_ready";
    if (count >= 2) return "stable";
    return "new";
  }
  function fmtINR(n) {
    const val = Number(n || 0);
    return "Rs " + val.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }

  function safeFilePart(s) {
    return String(s || "Export").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "Export";
  }

  function fileStamp() {
    return new Date().toISOString().slice(0, 10);
  }

  function getLastBackupAgeDays() {
    const raw = localStorage.getItem("obara:last_backup_at_iso");
    if (!raw) return null;
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  function onboardingSteps() {
    const countsKnown = Object.keys(window.__opsSupabaseCounts || {}).length > 0;
    const bomRows = Number((window.__opsSupabaseCounts || {}).bom_items || 0);
    const soRows = Number((window.__opsSupabaseCounts || {}).sales_orders || 0);
    const hasSupabase = !!localStorage.getItem("sb_url");
    return [
      { title:"Connect data backend", detail:"Save Supabase URL and key in Settings.", state:hasSupabase ? "done" : "todo", action:"settings" },
      { title:"Import BOM library", detail:"Load BOMs in XLSX, XLS, CSV, TSV, or TXT.", state:bomRows ? "done" : hasSupabase && countsKnown ? "todo" : "check", action:"upload-bom" },
      { title:"Configure drawing links", detail:"Add the OneDrive drawing base URL for PDF shortcuts.", state:localStorage.getItem("od_base_url") ? "done" : "todo", action:"settings" },
      { title:"Create a spare matrix", detail:"Start a customer/project sheet and sync recommended spares.", state:countsKnown && Number((window.__opsSupabaseCounts || {}).spare_matrices || 0) ? "done" : hasSupabase ? "check" : "todo", action:"matrix" },
      { title:"Import SO history", detail:"Load historical pricing in Excel, CSV, TSV, or TXT.", state:soRows ? "done" : hasSupabase && countsKnown ? "todo" : "check", action:"upload-so-history" },
      { title:"Run one SO agent pass", detail:"Process a PO and quote, then review warnings and exports.", state:localOrders().length ? "done" : "todo", action:"sales" },
      { title:"Export backup", detail:"Save non-secret local settings and SO agent memory.", state:localStorage.getItem("obara:last_backup_at_iso") ? "done" : "todo", action:"backup" },
    ];
  }

  function renderOnboardingCard() {
    const el = byId("ops-onboarding-card");
    if (!el) return;
    const steps = onboardingSteps();
    const done = steps.filter((s) => s.state === "done").length;
    const pct = Math.round((done / steps.length) * 100);
    el.innerHTML =
      '<div class="ops-onboarding-head"><div><h3 style="font-size:14px;font-weight:800">Guided Onboarding</h3>' +
      '<p style="color:var(--text-muted);font-size:12px;margin-top:3px">A short path from empty browser to usable BOM, matrix, SO history, and SO agent workflows.</p></div>' +
      '<div class="ops-actions" style="margin:0"><button class="btn btn-primary" onclick="showOnboardingFlow()">Start Tour</button>' +
      '<button class="btn btn-ghost" onclick="markOnboardingDone()">Mark Done</button></div></div>' +
      '<div class="ops-progress" aria-label="Onboarding progress"><span style="width:' + pct + '%"></span></div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:6px">' + done + " of " + steps.length + " steps complete</div>" +
      '<div class="ops-steps">' + steps.map((s, i) => stepHtml(s, i)).join("") + '</div>';
  }

  function stepHtml(step, i) {
    const badge = step.state === "done" ? "✓" : step.state === "check" ? "?" : String(i + 1);
    return '<div class="ops-step ' + step.state + '" onclick="runOpsAction(\\'' + step.action + '\\')" role="button" tabindex="0">' +
      '<span class="ops-step-badge">' + escText(badge) + '</span><div><strong>' + escText(step.title) +
      '</strong><small>' + escText(step.detail) + '</small></div></div>';
  }

  function processSuggestions() {
    const rows = [];
    const backupAge = getLastBackupAgeDays();
    if (!localStorage.getItem("sb_url")) rows.push(["Connect Supabase first", "BOM import, gun browsing, spare matrices, and SO history all depend on the backend connection.", "settings"]);
    if (!localStorage.getItem("od_base_url")) rows.push(["Add drawing base URL", "Drawing PDF links are one of the fastest operator wins once BOM rows are searchable.", "settings"]);
    if (!localOrders().length) rows.push(["Run one SO agent dry run", "A known-good PO and quote gives you a baseline for duplicate detection, format memory, and review gating.", "sales"]);
    if (backupAge == null || backupAge > 7) rows.push(["Export a local backup", "Backups preserve SO agent memory and local settings, excluding saved Supabase keys.", "backup"]);
    if (localStorage.getItem("sb_key")) rows.push(["Move secrets behind a backend", "The current POC stores a Supabase anon key in browser storage. Production should proxy privileged work server-side.", "settings"]);
    if (window.Babel) rows.push(["Bundle the SO agent for production", "Browser Babel is acceptable for this prototype, but it slows startup and makes runtime failures harder to control.", "sales"]);
    rows.push(["Use CSV or TSV for quick table exchange", "BOM, SO history, and matrix imports now parse delimited files with SheetJS instead of brittle string splitting.", "format-guide"]);
    rows.push(["Keep manager review gates explicit", "SO output should stay blocked or pending review when quantity, price, PO-only, or duplicate checks fail.", "intake-checklist"]);
    return rows.slice(0, 8);
  }

  function renderProcessImprovements() {
    const el = byId("ops-process-suggestions");
    if (!el) return;
    el.innerHTML = processSuggestions().map((row) =>
      '<div class="ops-suggestion"><strong>' + escText(row[0]) + '</strong><p>' + escText(row[1]) +
      '</p><div class="ops-actions" style="margin-bottom:0"><button class="btn btn-ghost" onclick="runOpsAction(\\'' + row[2] + '\\')">Open</button></div></div>'
    ).join("");
  }

  function renderCostOptimization() {
    const el = byId("ops-cost-cards");
    if (!el) return;
    const orders = localOrders();
    const formats = Object.values(localFormats());
    const policy = localCostPolicy();
    const skipped = orders.filter((o) => o && o.costAvoidedReason).length;
    const reusableDocs = orders.filter((o) => o && o.docFingerprint && o.result).length;
    const extractorReady = formats.filter((f) => profileState(f) === "extractor_ready").length;
    const stableProfiles = formats.filter((f) => ["stable", "extractor_ready"].includes(profileState(f))).length;
    const batchCandidates = orders.filter((o) =>
      o && o.result && o.tokenEstimate && (Number(o.tokenEstimate.totalInput || 0) > 80000 || Number(o.tokenEstimate.call2Output || 0) > 9000)
    ).length;
    const promptCache = policy.promptCache === "off" ? "Off" : policy.promptCache === "1h" ? "1 hour" : "5 minute";
    el.innerHTML = [
      cardHtml("Avoided Calls", skipped, skipped ? "Duplicate or same-document skips recorded" : "Use PO hint or document reuse to avoid repeat API calls"),
      cardHtml("Reusable Docs", reusableDocs, "Completed SOs with document fingerprints"),
      cardHtml("Extractor Ready", extractorReady, stableProfiles + " stable customer profile(s) total"),
      cardHtml("Batch Candidates", batchCandidates, "Large or flexible jobs suitable for backend batch mode"),
      cardHtml("Prompt Cache", promptCache, "SO prompt cache preference saved in SO Cost Policy"),
      cardHtml("Price Comp Mode", policy.priceComp || "include", "Controls when internal cost breakdowns are sent"),
    ].join("");
  }

  function integrationChecks() {
    const salesRoot = byId("so-agent-root");
    const bomInput = byId("file-input");
    const historyInput = byId("soh-file-input");
    const matrixInput = document.querySelector('input[onchange="handleMatrixImport(this.files[0])"]');
    const html = document.documentElement.innerHTML;
    const legacyB64 = "SO_AGENT" + "_B64";
    const legacyInit = "initSoAgent" + "Frame";
    const checks = [];
    function add(status, title, detail) { checks.push({ status, title, detail }); }
    add(salesRoot ? "ok" : "err", "Inline React mount", salesRoot ? "so-agent-root is present in the Sales Orders tab." : "so-agent-root is missing.");
    add(!byId("so-agent-frame") && !html.includes(legacyB64) && !html.includes(legacyInit) ? "ok" : "err", "Original iframe removed", "Legacy iframe/base64 SO agent bridge should not exist in the unified app.");
    add(window.storage && typeof window.storage.get === "function" && typeof window.storage.set === "function" ? "ok" : "err", "SO agent storage shim", window.storage ? "window.storage get/set shim is available." : "window.storage is missing.");
    add(window.mountSoAgent ? "ok" : "warn", "SO agent mount function", window.mountSoAgent ? "mountSoAgent is exposed." : "mountSoAgent has not loaded yet.");
    add(bomInput && String(bomInput.accept || "").includes(".tsv") ? "ok" : "warn", "BOM format patch", bomInput ? "BOM file input accepts Excel, CSV, TSV, and TXT." : "BOM input not found.");
    add(historyInput && String(historyInput.accept || "").includes(".tsv") ? "ok" : "warn", "SO history format patch", historyInput ? "SO history input accepts Excel, CSV, TSV, and TXT." : "SO history input not found.");
    add(matrixInput && String(matrixInput.accept || "").includes(".tsv") ? "ok" : "warn", "Matrix format patch", matrixInput ? "Matrix input accepts Excel, CSV, TSV, and TXT." : "Matrix input not found.");
    add(html.includes("fileToClaudeContentBlocks") && html.includes("so_agent:cost_policy") ? "ok" : "err", "Cost and document normalization", "SO agent includes document normalization, cost policy, and reuse controls.");
    add(html.includes("so_agent:result_cache") && html.includes("lookupCachedResult") ? "ok" : "err", "Persistent extraction cache", "Result cache by document fingerprint avoids repeat Claude calls.");
    add(html.includes("detectAnomalies") && html.includes("AnomalyBadges") ? "ok" : "err", "Anomaly detection", "Customer-norm anomaly checks fire after each SO generation.");
    add(html.includes("recordAudit") && html.includes("so_agent:audit_log") ? "ok" : "err", "Audit log", "SO agent records actions to so_agent:audit_log.");
    add(html.includes("buildSalesOrderMarkdown") && html.includes("printSalesOrder") ? "ok" : "err", "PDF / Markdown SO export", "Print-ready HTML and Markdown export available in Export tab.");
    add(html.includes("expandZipFile") && html.includes("loadJSZip") ? "ok" : "err", "ZIP archive import", "Bulk imports accept ZIP archives via lazy-loaded JSZip.");
    add(html.includes("loadTesseract") && html.includes("ocrPdfOrImage") ? "ok" : "err", "OCR fallback ready", "Tesseract.js loader present for scanned PDFs and images.");
    add(html.includes("ops-tour-overlay") && html.includes("startTour") ? "ok" : "err", "Interactive tour", "Onboarding tour overlay is available.");
    add(html.includes("toggleOpsTheme") && html.includes('html[data-theme="dark"]') ? "ok" : "err", "Dark mode", "Dark theme variables and toggle are wired.");
    add(html.includes("ops-nav-badge") && html.includes("updateNavBadges") ? "ok" : "err", "Nav badges", "Pending review and blocked counts surface in the nav.");
    add(html.includes("aggregateMonthlyCosts") && html.includes("ops-cost-analytics") ? "ok" : "err", "Cost analytics", "Overview shows monthly spend, trend, and avoided cost.");
    add(html.includes("seedSampleDataIntoStorage") && html.includes("DEMO_PROFILE_KEY") ? "ok" : "err", "Sample data mode", "Demo profile and order can be seeded for onboarding.");
    add(html.includes("LineItemEditor") && html.includes("recomputeSalesOrderTotals") ? "ok" : "err", "Line item edit", "Inline editor with tax recompute is wired into the SO tab.");
    add(html.includes("localExtractFromPdf") && html.includes("loadPdfJs") ? "ok" : "err", "Local PDF extraction", "PDF.js text extraction + confidence scoring runs without Claude.");
    add(html.includes("pdfToOcrText") && html.includes("renderPdfPagesToImages") ? "ok" : "err", "Auto-OCR pipeline", "PDF rasterization + Tesseract OCR available for scanned PDFs.");
    add(html.includes("ocrPdfs") && html.includes("OCR_MODE_META") ? "ok" : "err", "OCR cost policy", "PDF OCR mode (off / prompt / always) is configurable.");
    add(html.includes("ISSUE_TAXONOMY") && html.includes("VALIDATION_RULES") ? "ok" : "err", "Issue taxonomy and rules engine", "Stable issue codes drive deterministic post-LLM validation.");
    add(html.includes("computePayloadHash") && html.includes("verifyApproval") ? "ok" : "err", "Approval-bound payload hash", "Approval is invalidated when the SO payload changes.");
    add(html.includes("annotateProvenance") && html.includes("evidenceByField") ? "ok" : "err", "Field-level provenance", "Critical fields trace back to source document snippets.");
    add(html.includes("recordLineEditPattern") && html.includes("LearnedRulesPanel") ? "ok" : "err", "Correction-learning loop", "Recurring line edits surface as candidate customer rules.");
    add(html.includes("PROMPT_VERSION") && html.includes("RULES_VERSION") ? "ok" : "err", "Versioned cache", "Cache keys include prompt, schema, rules, and customer-profile versions.");
    add(html.includes("ObaraBackend") && html.includes("buildHybridStorage") ? "ok" : "err", "Backend bridge client", "Vercel/Supabase bridge module is embedded.");
    add(html.includes("MarginCockpit") && html.includes("computeMarginFromPriceComp") ? "ok" : "err", "Margin cockpit", "Per-line and total margin shown when price composition is available.");
    add(html.includes("SourcePoLifecycle") && html.includes("SOURCE_PO_STATUSES") ? "ok" : "err", "Source PO lifecycle", "Status and ETA controls per source PO with audit logging.");
    add(html.includes("normalizeUom") && html.includes("UOM_CANONICAL") ? "ok" : "err", "UOM normalization", "Line item UOMs are normalized to canonical form before SO export.");
    add(html.includes("ReconciliationGrid") ? "ok" : "err", "Reconciliation grid", "PO vs Quote vs Price-comp grid is rendered on the order overview.");
    add(html.includes("RevisionWarning") && html.includes("duplicates.search") ? "ok" : "err", "Near-duplicate detection", "Backend-powered revision/duplicate detection runs after generation.");
    add(html.includes("EXCEPTION_PLAYBOOKS") && html.includes("PlaybookPanel") ? "ok" : "err", "Exception playbooks", "Each issue code suggests one-click resolutions and email drafts.");
    add(html.includes("CustomerAckPanel") && html.includes("buildAckTemplates") ? "ok" : "err", "Customer acknowledgement generator", "Per-issue email drafts surface on the order overview.");
    add(html.includes("showCommunicationTimeline") ? "ok" : "err", "Communication timeline", "Per-order timeline merges audit + process events.");
    add(html.includes("showProcessMining") ? "ok" : "err", "Process mining dashboard", "Cycle time, blocker frequency, and field edit hotspots.");
    add(html.includes("showRoleQueues") ? "ok" : "err", "Role-based work queues", "Filtered view by issue owner.");
    add(html.includes("exportDocumentPackage") && html.includes("buildAuditPackText") ? "ok" : "err", "Document audit pack", "ZIP export bundling order, audit, and process events.");
    add(html.includes("QuoteFreshnessEditor") ? "ok" : "err", "Quote freshness policy editor", "Per-customer quote validity override on profile card.");
    add(html.includes("SoHistoryHint") ? "ok" : "err", "SO history intelligence", "Last-sold-price hint inline on line items.");
    add(html.includes("EvidenceViewer") && html.includes("loadPdfJs") ? "ok" : "err", "Field-level provenance with bboxes", "Bbox-aware viewer with PDF rendering and overlay rectangles.");
    add(html.includes("showProfileStudio") ? "ok" : "err", "Customer Format Profile Studio", "Studio surface for fingerprint editing, version history, and rollback.");
    add(html.includes("FXVarianceBadge") && html.includes("computeFxVariance") ? "ok" : "err", "FX variance UI", "Live FX rate variance badges from /api/fx/rates.");
    add(html.includes("DeliveryPromisePanel") ? "ok" : "err", "Delivery promise engine", "Predicted ship date and risk class on the order overview.");
    add(html.includes("InventoryStatusPill") ? "ok" : "err", "Inventory availability", "Per-line inventory status from /api/inventory/availability.");
    add(html.includes("showMasterDataTab") && html.includes("loadCytoscape") ? "ok" : "err", "Master data graph", "Customers, parts, BOM, and supplier graph with table and Cytoscape views.");
    add(html.includes("ZIP_LIMITS") && html.includes("EXTENSION_NOT_ALLOWED") || html.includes("ZIP rejected") ? "ok" : "err", "ZIP import safety hardening", "Size, count, nested, executable, and macro guards on import.");
    add(html.includes("requestMagicLink") && html.includes("ops-auth-magic") ? "ok" : "err", "Auth UI (magic link + dev token)", "Production sign-in flow plus dev token fallback.");
    add(html.includes("runServerOcr") ? "ok" : "err", "Server OCR trigger", "Order overview can launch Mistral OCR + bbox capture on the active PO.");
    add(html.includes("LostMarginWarning") && html.includes("priceBands[bandKey]") ? "ok" : "err", "Lost margin warning per line", "LostMarginWarning rendered when sales history exists.");
    add(html.includes("RepeatOrderSuggestion") && html.includes("priceBands[bandKey]") ? "ok" : "err", "Repeat order suggestion per line", "RepeatOrderSuggestion rendered when band has prior history.");
    add(html.includes("AliasSuggestionPanel") && html.includes("persistAliasAndRefresh") ? "ok" : "err", "Alias suggestion on intake", "AliasSuggestionPanel mounted in process tab when fingerprint detected.");
    add(html.includes("handleAmendmentDetect") && html.includes("Detect amendment") ? "ok" : "err", "Amendment detection button", "Order overview includes a Detect amendment trigger.");
    add(html.includes("showSourcePoProcurement") ? "ok" : "err", "Source PO procurement modal", "Open POs, ack, scorecards.");
    add(html.includes("showEvalDashboard") ? "ok" : "err", "Eval dashboard modal", "Pass rate, field heatmap, runs, cases.");
    add(html.includes("showEmailTriage") ? "ok" : "err", "Email triage modal", "Inbound classification and missing-doc drafts.");
    add(html.includes("showSpareMatrixIntelligence") ? "ok" : "err", "Spare matrix intelligence modal", "Recommend, kit, opportunities, obsolete.");
    add(html.includes("showSecurityCenter") ? "ok" : "err", "Security center modal", "Redaction, injection test, routing log.");
    add(html.includes("showCostAnalyticsDeep") ? "ok" : "err", "Cost analytics deep modal", "Breakdown, simulator, margin history.");
    add(html.includes("force_llm_fallback") && html.includes("Compare new PO to last format") ? "ok" : "err", "Studio drift and dry-run controls", "Studio extends with drift, force fallback, dry run.");
    add(html.includes("audit-pack-pdf") && html.includes("manifest.json") ? "ok" : "err", "Audit pack PDF and manifest", "Audit pack supports PDF and includes a manifest.");
    add(html.includes("showAdminCenter") && html.includes("renderHolidays") && html.includes("renderMembers") ? "ok" : "err", "Admin center modal", "Holidays, lead times, BOM, inventory, FX, members all editable via UI.");
    add(html.includes("renderItemMaster") && html.includes("renderContracts") && html.includes("renderEquipmentHierarchy") && html.includes("renderCustomerLocations") ? "ok" : "err", "Admin center: corpus tabs", "Item master, contracts, equipment hierarchy, customer locations.");
    add(html.includes("renderQuoteApprovals") && html.includes("renderCsvImportWizard") ? "ok" : "err", "Admin center: approvals + CSV import", "Quote approvals tab and CSV import wizard.");
    add(html.includes("showEinvoiceModal") && html.includes("Send to GSTN") ? "ok" : "err", "e-Invoice modal", "Compose, send to GSTN, cancel within 24h.");
    add(html.includes("showForecastingModal") && html.includes("Persist nightly snapshot") ? "ok" : "err", "Forecasting modal", "Pipeline segmented by territory, customer type, order mode.");
    add(html.includes("showAmcModal") && html.includes("bulkSeedAmcSchedule") ? "ok" : "err", "AMC schedule modal", "Bulk-seed preventive visits from a contract.");
    add(html.includes("showScheduleLinesModal") && html.includes("scheduleLines.bulkCreate") ? "ok" : "err", "Schedule lines modal", "Paste TSV to attach delivery schedule lines to an order.");
    add(html.includes("showJbmImporterModal") && html.includes("equipment_hierarchy") ? "ok" : "err", "JBM spare matrix importer", "One-click XLSX import to equipment hierarchy + installed parts.");
    add(html.includes("eval.run") && html.includes("ops-eval-run") ? "ok" : "err", "Eval Dashboard run button", "Cases tab now has Run button that scores against pasted actual JSON.");
    add(html.includes("nextIsoNumber") ? "ok" : "err", "Internal SO autogen number", "Next ISO number prefilled to avoid duplicates.");
    add(html.includes("Golden example uploaded and attached to profile") ? "ok" : "err", "Profile Studio golden persist", "Golden example upload now persists to customer profile.");
    add(html.includes("showSalesPipeline") && html.includes("renderLeads") && html.includes("renderOpps") ? "ok" : "err", "Sales pipeline modal", "Leads + opportunities + loss reasons.");
    add(html.includes("showInternalSoModal") && html.includes("FOC_SUPPLY") && html.includes("INTERNAL_TRANSFER") ? "ok" : "err", "Internal SO modal", "FOC, warranty, trial, expected PO, internal transfer.");
    add(html.includes("showProjectTracker") && html.includes("INSTALLATION_COMMISSIONING") ? "ok" : "err", "Project tracker modal", "14-phase project lifecycle from corpus tracker.");
    add(html.includes("showShipmentsModal") && html.includes("POD_RECEIVED") ? "ok" : "err", "Shipments + POD modal", "Mode, vessel, ports, warehouse receipt, POD status.");
    add(html.includes("showServiceModal") && html.includes("car_reports") ? "ok" : "err", "Service module modal", "Visits with check-in/out and CAR reports.");
    return checks;
  }

  function showIntegrationReport() {
    const rows = integrationChecks();
    const html = '<div class="ops-modal-body"><p>These checks verify that the HTML operations app and React SO agent are integrated in the generated file.</p>' +
      '<table><thead><tr><th>Status</th><th>Check</th><th>Detail</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td><span class="ops-dot ' + r.status + '" style="display:inline-block"></span> ' + escText(r.status.toUpperCase()) + '</td><td><strong>' + escText(r.title) + '</strong></td><td>' + escText(r.detail) + '</td></tr>').join("") +
      '</tbody></table></div>';
    showOpsModal("Integration Report", html);
  }

  function renderFormatTools() {
    const el = byId("ops-format-tools");
    if (!el) return;
    el.innerHTML = [
      formatCard("BOM Import", "XLSX, XLS, CSV, TSV, TXT", "Origin detection still runs after parsing. Delimited files should use the same recognizable part-number and part-name headers.", [['upload-bom','Choose Files']]),
      formatCard("SO History Import", "XLSX, XLS, CSV, TSV, TXT", "PO tracker and Tally formats are still auto-detected by header names.", [['upload-so-history','Choose Files']]),
      formatCard("Spare Matrix", "Import: XLSX, XLS, CSV, TSV, TXT. Export: XLSX, CSV, TSV, JSON", "Use CSV or TSV for quick edits, JSON for handoff or audit snapshots.", [['matrix','Open Matrix'],['matrix-export-csv','CSV'],['matrix-export-tsv','TSV'],['matrix-export-json','JSON']]),
      formatCard("Recommended Spares", "Export: XLSX, CSV, TSV, JSON", "Installed quantity is calculated at export time when the matrix is loaded.", [['rs-export-csv','CSV']]),
      formatCard("SO Agent History", "Export: JSON or CSV", "Browser-local agent records include status, blockers, format drift, and generated result data.", [['so-agent-export-json','JSON']]),
    ].join("");
  }

  function formatCard(title, formats, detail, buttons) {
    return '<div class="ops-format-card"><h4>' + escText(title) + '</h4><p><strong>' + escText(formats) + '</strong></p><p>' +
      escText(detail) + '</p><div class="ops-actions" style="margin-bottom:0">' + buttons.map((b) =>
        '<button class="btn btn-ghost" onclick="runOpsAction(\\'' + b[0] + '\\')">' + escText(b[1]) + '</button>'
      ).join("") + '</div></div>';
  }

  function markOnboardingDone() {
    localStorage.setItem("obara:onboarding_done", "true");
    localStorage.setItem("obara:onboarding_seen", "true");
    closeOpsModal();
    renderOverview();
    notify("Onboarding marked complete.");
  }

  function skipOnboarding() {
    localStorage.setItem("obara:onboarding_seen", "true");
    closeOpsModal();
    renderOverview();
  }

  function showOnboardingFlow() {
    const steps = onboardingSteps();
    const done = steps.filter((s) => s.state === "done").length;
    const html = '<div class="ops-modal-body"><p>Follow these in order for the least painful setup path. The question-mark steps need a backend health check before the app can confirm completion.</p>' +
      '<div class="ops-progress"><span style="width:' + Math.round((done / steps.length) * 100) + '%"></span></div>' +
      '<div class="ops-steps">' + steps.map((s, i) => stepHtml(s, i)).join("") + '</div>' +
      '<div class="ops-actions"><button class="btn btn-primary" onclick="runOpsHealthCheck()">Run Health Check</button>' +
      '<button class="btn btn-ghost" onclick="skipOnboarding()">Skip for Now</button>' +
      '<button class="btn btn-teal" onclick="markOnboardingDone()">Mark Done</button></div></div>';
    localStorage.setItem("obara:onboarding_seen", "true");
    showOpsModal("Onboarding", html);
  }

  function renderOverview() {
    const cards = byId("ops-overview-cards");
    const actions = byId("ops-quick-actions");
    if (!cards || !actions) return;
    const orders = localOrders();
    const metrics = localMetrics();
    const processed = orders.filter((o) => o && o.result).length;
    const blocked = orders.filter((o) => o && !o.result).length;
    const pending = orders.filter((o) => o && o.status === "PENDING_REVIEW").length;
    const formats = Object.keys(readJsonKey("so_agent:customer_formats", {})).length;
    const hasSbUrl = !!localStorage.getItem("sb_url");
    const hasOd = !!localStorage.getItem("od_base_url");
    const lastTab = localStorage.getItem("obara:last_tab") || "none";
    const lastBackup = localStorage.getItem("obara:last_backup_at") || "never";
    cards.innerHTML = [
      cardHtml("SO Sessions", processed, blocked + " blocked, " + pending + " pending review"),
      cardHtml("SO Value", fmtINR(metrics.totalValue || 0), "From browser-local SO agent metrics"),
      cardHtml("Customer Formats", formats, "Remembered PO/quote format fingerprints"),
      cardHtml("Backend", hasSbUrl ? "Configured" : "Not set", hasSbUrl ? "Supabase URL is saved" : "Open Settings to connect Supabase"),
      cardHtml("Drawing Links", hasOd ? "Configured" : "Not set", hasOd ? "OneDrive base URL saved" : "Optional drawing PDF shortcut missing"),
      cardHtml("Resume", lastTab, "Last backup: " + lastBackup),
    ].join("");
    actions.innerHTML = actionList
      .filter((a) => ["onboarding","sales","so-cost-policy","so-customer-profiles","integration-report","intake-checklist","upload-bom","search","matrix","new-matrix","upload-so-history","settings","backup","restore"].includes(a.id))
      .map((a) => '<button class="btn btn-ghost" onclick="runOpsAction(\\'' + a.id + '\\')">' + escText(a.label) + '</button>')
      .join("");
    renderOnboardingCard();
    renderTipsCard();
    renderCostAnalytics();
    renderProcessImprovements();
    renderCostOptimization();
    renderFormatTools();
    ensureFormatButtons();
    renderRecentSo(orders);
    renderHealthList();
    updateNavBadges();
  }

  function cardHtml(label, value, sub) {
    return '<div class="ops-card"><div class="label">' + escText(label) + '</div><div class="value">' + escText(value) + '</div><div class="sub">' + escText(sub) + '</div></div>';
  }

  function renderRecentSo(orders) {
    const el = byId("ops-recent-so");
    if (!el) return;
    const rows = (orders || []).slice(0, 6);
    if (!rows.length) {
      el.innerHTML = '<div class="empty" style="padding:18px">No SO agent history yet. Process a PO and quote to populate this list.</div>';
      return;
    }
    el.innerHTML = '<table><thead><tr><th>PO</th><th>Customer</th><th>Status</th><th>Created</th><th>Issue</th></tr></thead><tbody>' +
      rows.map((o) => {
        const status = o.status || "UNKNOWN";
        const statusClass = status === "APPROVED" ? "so-status-approved" : status === "PENDING_REVIEW" ? "so-status-review" : status === "BLOCKED" || status === "DUPLICATE" ? "so-status-rejected" : "so-status-draft";
        return '<tr><td style="font-family:monospace">' + escText(o.preflightPONumber || (o.result && o.result.po && o.result.po.number) || "-") + '</td>' +
          '<td>' + escText(o.preflightCustomer || (o.result && o.result.po && o.result.po.customer) || "-") + '</td>' +
          '<td><span class="' + statusClass + '">' + escText(status) + '</span></td>' +
          '<td>' + escText(o.createdAt ? new Date(o.createdAt).toLocaleString("en-IN") : "-") + '</td>' +
          '<td>' + escText(o.blockerSummary || o.formatChangeSummary || "") + '</td></tr>';
      }).join("") + '</tbody></table>';
  }

  function collectHealth() {
    const tests = [];
    function add(status, title, detail) { tests.push({ status, title, detail }); }
    try {
      localStorage.setItem("obara:health_probe", "ok");
      localStorage.removeItem("obara:health_probe");
      add("ok", "Browser storage", "localStorage read/write is available.");
    } catch (e) {
      add("err", "Browser storage", "localStorage failed: " + e.message);
    }
    add(window.supabase ? "ok" : "err", "Supabase library", window.supabase ? "Client library loaded." : "Supabase CDN did not load.");
    add(window.XLSX ? "ok" : "err", "Excel parser", window.XLSX ? "XLSX library loaded." : "XLSX CDN did not load.");
    add(window.React && window.ReactDOM ? "ok" : "err", "React SO agent runtime", window.React && window.ReactDOM ? "React and ReactDOM loaded." : "React runtime missing.");
    add(window.Babel ? "ok" : "warn", "Browser JSX compiler", window.Babel ? "Babel loaded for this POC build." : "Babel missing, SO agent will not mount.");
    add(byId("so-agent-root") && byId("so-agent-root").dataset.mounted === "true" ? "ok" : "warn", "SO agent mount", byId("so-agent-root") && byId("so-agent-root").dataset.mounted === "true" ? "Mounted in the Sales tab." : "Not mounted yet. Open Sales Orders.");
    integrationChecks().forEach((row) => add(row.status, row.title, row.detail));
    add(localStorage.getItem("sb_url") ? "ok" : "warn", "Supabase connection", localStorage.getItem("sb_url") ? "Project URL saved in this browser." : "No saved Supabase URL.");
    add(localStorage.getItem("sb_key") ? "warn" : "ok", "Credential storage", localStorage.getItem("sb_key") ? "Anon key is saved locally. Backups exclude it." : "No Supabase key saved locally.");
    add(localStorage.getItem("od_base_url") ? "ok" : "warn", "Drawing links", localStorage.getItem("od_base_url") ? "OneDrive base URL saved." : "No drawing base URL configured.");
    add(localOrders().length ? "ok" : "warn", "SO local history", localOrders().length ? localOrders().length + " SO agent records in browser storage." : "No SO agent records yet.");
    const backupAge = getLastBackupAgeDays();
    add(backupAge == null ? "warn" : backupAge > 7 ? "warn" : "ok", "Local backup cadence", backupAge == null ? "No local backup has been exported." : backupAge > 7 ? "Last backup is " + backupAge + " days old." : "Last backup is " + backupAge + " days old.");
    const seen = new Set();
    const dupes = new Set();
    localOrders().forEach((o) => {
      const po = String(o && o.preflightPONumber || "").trim();
      if (!po) return;
      if (seen.has(po)) dupes.add(po);
      seen.add(po);
    });
    add(dupes.size ? "warn" : "ok", "Duplicate PO memory", dupes.size ? "Duplicate PO numbers in local history: " + Array.from(dupes).slice(0, 3).join(", ") : "No duplicate PO numbers found in local SO history.");
    const storageStatus = checkStoragePressure();
    add(storageStatus.level === "critical" ? "err" : storageStatus.level === "warn" ? "warn" : "ok", "Storage pressure", "Browser storage is " + Math.round(storageStatus.ratio * 100) + "% used (" + (storageStatus.used / 1024).toFixed(1) + " KB). " + (storageStatus.level === "critical" ? "Compact via Storage Status." : storageStatus.level === "warn" ? "Approaching cap." : "Healthy."));
    lastDiagnostics = tests;
    return tests;
  }

  function renderHealthList() {
    const el = byId("ops-health-list");
    if (!el) return;
    const rows = collectHealth();
    el.innerHTML = rows.map((r) =>
      '<div class="ops-health-item"><span class="ops-dot ' + r.status + '"></span><div><div class="ops-health-title">' +
      escText(r.title) + '</div><div class="ops-health-detail">' + escText(r.detail) + '</div></div></div>'
    ).join("");
  }

  async function runOpsHealthCheck() {
    renderOverview();
    notify("Health check refreshed.");
    await refreshSupabaseCounts();
  }

  async function refreshSupabaseCounts() {
    if (typeof sb === "undefined" || !sb || !byId("ops-overview-cards")) return;
    const targets = [
      ["guns", "Guns"],
      ["bom_items", "BOM Rows"],
      ["spare_matrices", "Matrices"],
      ["sales_orders", "SO History"],
    ];
    const results = [];
    window.__opsSupabaseCounts = window.__opsSupabaseCounts || {};
    for (const pair of targets) {
      try {
        const res = await sb.from(pair[0]).select("id", { count:"exact", head:true });
        if (!res.error) window.__opsSupabaseCounts[pair[0]] = res.count || 0;
        results.push({ label: pair[1], value: res.error ? "Unavailable" : String(res.count || 0), sub: res.error ? res.error.message : "Supabase count" });
      } catch (e) {
        results.push({ label: pair[1], value: "Unavailable", sub: e.message });
      }
    }
    const cards = byId("ops-overview-cards");
    if (!cards) return;
    cards.querySelectorAll('[data-sb-count="1"]').forEach((node) => node.remove());
    cards.insertAdjacentHTML("beforeend", results.map((r) =>
      '<div class="ops-card" data-sb-count="1"><div class="label">' + escText(r.label) +
      '</div><div class="value">' + escText(r.value) + '</div><div class="sub">' + escText(r.sub) + '</div></div>'
    ).join(""));
  }

  function openOpsPalette() {
    ensureOpsUi();
    const overlay = byId("ops-palette-overlay");
    const input = byId("ops-palette-input");
    paletteIndex = 0;
    overlay.classList.add("open");
    input.value = "";
    renderPalette("");
    setTimeout(() => input.focus(), 0);
  }

  function closeOpsPalette() {
    const overlay = byId("ops-palette-overlay");
    if (overlay) overlay.classList.remove("open");
  }

  function scoreAction(a, q) {
    if (!q) return 1;
    const hay = (a.label + " " + a.detail + " " + a.key).toLowerCase();
    const parts = q.toLowerCase().split(/\\s+/).filter(Boolean);
    return parts.every((p) => hay.includes(p)) ? 1 : 0;
  }

  function filteredActions(q) {
    return actionList.filter((a) => scoreAction(a, q));
  }

  function renderPalette(q) {
    const list = byId("ops-command-list");
    if (!list) return;
    const rows = filteredActions(q);
    if (paletteIndex >= rows.length) paletteIndex = Math.max(0, rows.length - 1);
    list.innerHTML = rows.length ? rows.map((a, i) =>
      '<div class="ops-command ' + (i === paletteIndex ? "active" : "") + '" data-action-id="' + a.id + '">' +
      '<div><strong>' + escText(a.label) + '</strong><br><span>' + escText(a.detail) + '</span></div><kbd>' + escText(a.key) + '</kbd></div>'
    ).join("") : '<div class="empty" style="padding:24px">No matching command.</div>';
    list.querySelectorAll(".ops-command").forEach((node) => {
      node.addEventListener("click", () => runOpsAction(node.getAttribute("data-action-id")));
    });
  }

  function runOpsAction(id) {
    const action = actionList.find((a) => a.id === id);
    if (!action) return;
    closeOpsPalette();
    closeOpsModal();
    action.run();
    renderOverview();
  }

  function exportOpsBackup() {
    const payload = { version: 1, exportedAt: new Date().toISOString(), app: "obara-ops-unified", keys: {} };
    Object.keys(localStorage).sort().forEach((key) => {
      if (BACKUP_EXCLUDE.has(key)) return;
      if (key.startsWith("so_agent:") || key.startsWith("obara:") || ["od_base_url", "sb_url"].includes(key)) {
        payload.keys[key] = localStorage.getItem(key);
      }
    });
    localStorage.setItem("obara:last_backup_at", new Date().toLocaleString("en-IN"));
    localStorage.setItem("obara:last_backup_at_iso", new Date().toISOString());
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "obara-ops-backup-" + new Date().toISOString().slice(0,10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    renderOverview();
  }

  function restoreOpsBackup(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result || "{}"));
        if (!payload.keys || typeof payload.keys !== "object") throw new Error("Backup file has no keys object.");
        let restored = 0;
        Object.entries(payload.keys).forEach(([key, value]) => {
          if (RESTORE_BLOCK.has(key)) return;
          if (key.startsWith("so_agent:") || key.startsWith("obara:") || ["od_base_url", "sb_url"].includes(key)) {
            localStorage.setItem(key, String(value));
            restored++;
          }
        });
        notify("Restored " + restored + " local setting/history keys. Reload if a view was already open.");
        renderOverview();
      } catch (e) {
        notify("Restore failed: " + e.message, true);
      }
    };
    reader.readAsText(file);
  }

  function downloadTextFile(name, mime, content) {
    const blob = new Blob([content], { type:mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function escapedDelimited(v, delimiter) {
    let s = String(v == null ? "" : v);
    const needsQuotes = s.includes(delimiter) || s.includes('"') || s.includes("\\n") || s.includes("\\r");
    s = s.replace(/"/g, '""');
    return needsQuotes ? '"' + s + '"' : s;
  }

  function rowsToDelimited(rows, delimiter) {
    return rows.map((row) => row.map((cell) => escapedDelimited(cell, delimiter)).join(delimiter)).join("\\r\\n");
  }

  function dedupeHeaders(headers) {
    const seen = {};
    return headers.map((h, i) => {
      const base = safeFilePart(h || "column_" + (i + 1));
      seen[base] = (seen[base] || 0) + 1;
      return seen[base] === 1 ? base : base + "_" + seen[base];
    });
  }

  function aoaToObjects(rows) {
    const headers = dedupeHeaders(rows[0] || []);
    return rows.slice(1).map((row) => {
      const out = {};
      headers.forEach((h, i) => { out[h] = row[i] == null ? "" : row[i]; });
      return out;
    });
  }

  function exportAoa(baseName, sheetName, rows, format) {
    if (!rows || rows.length < 2) {
      notify("Nothing to export. Open or load the relevant data first.", true);
      return;
    }
    const fmt = String(format || "xlsx").toLowerCase();
    const name = safeFilePart(baseName) + "_" + fileStamp();
    if (fmt === "xlsx") {
      if (!window.XLSX) { notify("XLSX library is not loaded.", true); return; }
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = (rows[0] || []).map(() => ({ wch:16 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      XLSX.writeFile(wb, name + ".xlsx");
      return;
    }
    if (fmt === "json") {
      downloadTextFile(name + ".json", "application/json", JSON.stringify(aoaToObjects(rows), null, 2));
      return;
    }
    const delimiter = fmt === "tsv" ? "\\t" : ",";
    const ext = fmt === "tsv" ? "tsv" : "csv";
    const mime = fmt === "tsv" ? "text/tab-separated-values" : "text/csv";
    downloadTextFile(name + "." + ext, mime, rowsToDelimited(rows, delimiter));
  }

  function matrixAoa() {
    if (typeof FIXED_COLS === "undefined" || typeof matrixRows === "undefined" || typeof matrixCols === "undefined") return null;
    const headers = FIXED_COLS.map((c) => c.label).concat(matrixCols.map((c) => c.col_name));
    return [headers].concat((matrixRows || []).map((row) =>
      FIXED_COLS.map((c) => row[c.key] || "").concat(matrixCols.map((c) => row.spare_values && row.spare_values[c.col_name] || ""))
    ));
  }

  function recommendedSparesAoa() {
    if (typeof RS_COLS === "undefined" || typeof rsRows === "undefined") return null;
    const headers = RS_COLS.map((c) => c.label);
    return [headers].concat((rsRows || []).map((row) => RS_COLS.map((col) => {
      if (col.type === "readonly") return typeof computeInstalledQty === "function" ? computeInstalledQty(row.part_no) : "";
      return row[col.key] != null ? row[col.key] : "";
    })));
  }

  function soHistoryAoa() {
    if (typeof sohAllRows === "undefined") return null;
    const headers = ["Format","Date","Obara Part No","Customer Part No","Description","Customer","PO No","SO No","Type","UOM","Qty","Unit Price","Total","Delivered","Pending","Invoice","WO","Dispatched","Drawing No","Remark"];
    return [headers].concat((sohAllRows || []).map((r) => [
      r.source_format || "",
      r.order_date || r.po_received_date || "",
      r.obara_part_no || "", r.customer_part_no || "", r.description || "", r.customer_name || "",
      r.po_number || "", r.so_number || "",
      r.consumable_spare || "", r.uom || "",
      r.quantity ?? r.ordered_qty ?? "",
      r.unit_price ?? r.rate ?? "",
      r.total_price ?? r.value_amt ?? "",
      r.delivered_qty ?? r.supplied_qty ?? "",
      r.pending_qty ?? r.balance_qty ?? "",
      r.invoice_number || "", r.wo_number || "", r.dispatched_on || "", r.drawing_no || "", r.remark || "",
    ]));
  }

  function soAgentHistoryAoa() {
    const rows = localOrders();
    const headers = ["Created","PO Number","Customer","Status","Total Value","Line Items","Issue"];
    return [headers].concat(rows.map((o) => {
      const result = o.result || {};
      const po = result.po || {};
      const tally = result.tallySalesOrder || {};
      return [
        o.createdAt || "",
        o.preflightPONumber || po.number || "",
        o.preflightCustomer || po.customer || "",
        o.status || "",
        tally.totalValue || "",
        Array.isArray(tally.lineItems) ? tally.lineItems.length : "",
        o.blockerSummary || o.formatChangeSummary || "",
      ];
    }));
  }

  function exportMatrixData(format) {
    const title = byId("mx-title") ? byId("mx-title").textContent : "SpareMatrix";
    exportAoa("SpareMatrix_" + safeFilePart(title), "Spare Matrix", matrixAoa(), format);
  }

  function exportRecommendedSparesData(format) {
    const title = byId("mx-title") ? byId("mx-title").textContent : "RecommendedSpares";
    exportAoa("RecommendedSpares_" + safeFilePart(title), "Recommended Spares", recommendedSparesAoa(), format);
  }

  function exportSoHistoryData(format) {
    if (format === "xlsx" && typeof exportSoHistoryExcel === "function") { exportSoHistoryExcel(); return; }
    exportAoa("SalesOrderHistory", "Sales Order History", soHistoryAoa(), format);
  }

  function exportSoAgentHistory(format) {
    const rows = localOrders();
    if (!rows.length) { notify("No SO agent history to export.", true); return; }
    const fmt = String(format || "json").toLowerCase();
    if (fmt === "json") {
      downloadTextFile("SOAgentHistory_" + fileStamp() + ".json", "application/json", JSON.stringify(rows, null, 2));
      return;
    }
    exportAoa("SOAgentHistory", "SO Agent History", soAgentHistoryAoa(), fmt);
  }

  function downloadMatrixTemplateAs(format) {
    if (typeof FIXED_COLS === "undefined") { notify("Matrix template columns are not loaded.", true); return; }
    const rows = [FIXED_COLS.map((c) => c.label), ["1","Line A","ST-10","R-01","X-Gun","2","2","SRTC-K12464"]];
    exportAoa("SpareMatrix_Template", "Spare Matrix", rows, format);
  }

  function ensureFormatButtons() {
    addFormatButton('button[onclick="exportMatrixExcel()"]', "ops-mx-csv", "CSV", () => exportMatrixData("csv"));
    addFormatButton('button[onclick="exportMatrixExcel()"]', "ops-mx-tsv", "TSV", () => exportMatrixData("tsv"));
    addFormatButton('button[onclick="exportMatrixExcel()"]', "ops-mx-json", "JSON", () => exportMatrixData("json"));
    addFormatButton('button[onclick="exportRsExcel()"]', "ops-rs-csv", "CSV", () => exportRecommendedSparesData("csv"));
    addFormatButton('button[onclick="exportRsExcel()"]', "ops-rs-tsv", "TSV", () => exportRecommendedSparesData("tsv"));
    addFormatButton('button[onclick="exportRsExcel()"]', "ops-rs-json", "JSON", () => exportRecommendedSparesData("json"));
    addFormatButton('button[onclick="exportSoHistoryExcel()"]', "ops-soh-csv", "CSV", () => exportSoHistoryData("csv"));
    addFormatButton('button[onclick="exportSoHistoryExcel()"]', "ops-soh-tsv", "TSV", () => exportSoHistoryData("tsv"));
    addFormatButton('button[onclick="exportSoHistoryExcel()"]', "ops-soh-json", "JSON", () => exportSoHistoryData("json"));
    addFormatButton('button[onclick="downloadMatrixTemplate()"]', "ops-mxt-csv", "CSV Template", () => downloadMatrixTemplateAs("csv"));
    addFormatButton('button[onclick="downloadMatrixTemplate()"]', "ops-mxt-tsv", "TSV Template", () => downloadMatrixTemplateAs("tsv"));
  }

  function addFormatButton(selector, id, label, handler) {
    if (byId(id)) return;
    const target = document.querySelector(selector);
    if (!target || !target.parentNode) return;
    const btn = document.createElement("button");
    btn.id = id;
    btn.type = "button";
    btn.className = "btn btn-ghost ops-format-mini";
    btn.textContent = label;
    btn.addEventListener("click", handler);
    target.insertAdjacentElement("afterend", btn);
  }

  function copyOpsDiagnostics() {
    const payload = {
      generatedAt: new Date().toISOString(),
      url: location.href,
      diagnostics: lastDiagnostics.length ? lastDiagnostics : collectHealth(),
      localCounts: {
        soOrders: localOrders().length,
        customerFormats: Object.keys(readJsonKey("so_agent:customer_formats", {})).length,
      },
    };
    const text = JSON.stringify(payload, null, 2);
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); notify("Diagnostics copied."); }
      catch (_) { notify("Clipboard unavailable.", true); }
      ta.remove();
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => notify("Diagnostics copied."),
      () => notify("Clipboard unavailable.", true),
    );
  }

  function showOpsShortcuts() {
    showOpsModal("Keyboard Shortcuts", '<div class="ops-modal-body"><ul><li><strong>Cmd/Ctrl+K</strong>: command palette.</li><li><strong>/</strong>: focus search/filter in the current view.</li><li><strong>?</strong>: show this shortcut list.</li><li><strong>Esc</strong>: close palette or modal.</li></ul></div>');
  }

  function showSoIntakeChecklist() {
    showOpsModal("SO Intake Checklist", '<div class="ops-modal-body"><ul><li>Customer Purchase Order PDF or Excel with PO number, date, delivery address, line qty, and line rate.</li><li>Obara quote for the same customer, with part numbers, HSN, GST rate, quoted qty, and unit price.</li><li>Optional price composition file when source POs or landed-cost visibility are needed.</li><li>Engineer override note only when source country or supplier assignment should override the price composition.</li><li>Manager approval is expected when the SO agent flags critical mismatches, price variance, PO-only items, or quantity over quote.</li></ul></div>');
  }

  function showProcessImprovements() {
    const html = '<div class="ops-modal-body"><p>These are ordered by likely operational value for this prototype.</p><div class="ops-suggestion-list">' +
      processSuggestions().map((row) => '<div class="ops-suggestion"><strong>' + escText(row[0]) + '</strong><p>' + escText(row[1]) + '</p><button class="btn btn-ghost" onclick="runOpsAction(\\'' + row[2] + '\\')">Open</button></div>').join("") +
      '</div><p style="margin-top:12px">Production hardening still needs a bundled React build, a backend proxy for AI calls, server-side audit logging, and stricter role-based access around imports and approvals.</p></div>';
    showOpsModal("Process Improvements", html);
  }

  function showFormatGuide() {
    const html = '<div class="ops-modal-body"><ul>' +
      '<li><strong>BOM Import:</strong> XLSX, XLS, CSV, TSV, TXT. Headers still need recognizable part number and part name columns.</li>' +
      '<li><strong>SO History Import:</strong> XLSX, XLS, CSV, TSV, TXT. PO tracker and Tally exports are detected by header names.</li>' +
      '<li><strong>Spare Matrix Import:</strong> XLSX, XLS, CSV, TSV, TXT. Use the template headers for reliable mapping.</li>' +
      '<li><strong>Exports:</strong> Spare Matrix, Recommended Spares, and SO History export to XLSX, CSV, TSV, and JSON. SO Agent history exports to JSON or CSV.</li>' +
      '<li><strong>Why TSV matters:</strong> it is safer than CSV when descriptions contain commas, quotes, or vendor punctuation.</li>' +
      '</ul></div>';
    showOpsModal("Format Guide", html);
  }

  function showOpsModal(title, html) {
    ensureOpsUi();
    byId("ops-modal-title").textContent = title;
    byId("ops-modal-content").innerHTML = html;
    byId("ops-modal").style.display = "flex";
  }

  function closeOpsModal() {
    const modal = byId("ops-modal");
    if (modal) modal.style.display = "none";
  }

  function focusContextSearch() {
    const active = document.querySelector(".tab-content.active");
    if (!active) return false;
    const preferred = active.querySelector('input[type="search"], input[id*="search"], input[id*="filter"], input[placeholder*="Search"], input[placeholder*="Filter"]');
    if (preferred) {
      preferred.focus();
      if (preferred.select) preferred.select();
      return true;
    }
    return false;
  }

  function ensureOpsUi() {
    if (!byId("ops-palette-overlay")) {
      const overlay = document.createElement("div");
      overlay.id = "ops-palette-overlay";
      overlay.className = "ops-palette-overlay";
      overlay.innerHTML = '<div class="ops-palette"><input id="ops-palette-input" placeholder="Type a command or workflow name" autocomplete="off"><div id="ops-command-list" class="ops-command-list"></div></div>';
      document.body.appendChild(overlay);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOpsPalette(); });
      byId("ops-palette-input").addEventListener("input", (e) => { paletteIndex = 0; renderPalette(e.target.value); });
      byId("ops-palette-input").addEventListener("keydown", (e) => {
        const rows = filteredActions(e.target.value);
        if (e.key === "ArrowDown") { e.preventDefault(); paletteIndex = Math.min(rows.length - 1, paletteIndex + 1); renderPalette(e.target.value); }
        if (e.key === "ArrowUp") { e.preventDefault(); paletteIndex = Math.max(0, paletteIndex - 1); renderPalette(e.target.value); }
        if (e.key === "Enter" && rows[paletteIndex]) { e.preventDefault(); runOpsAction(rows[paletteIndex].id); }
        if (e.key === "Escape") closeOpsPalette();
      });
    }
    if (!byId("ops-modal")) {
      const modal = document.createElement("div");
      modal.id = "ops-modal";
      modal.className = "modal-overlay";
      modal.style.display = "none";
      modal.innerHTML = '<div class="modal"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h3 id="ops-modal-title"></h3><button id="ops-modal-close" style="background:transparent;color:var(--text-muted);font-size:18px;padding:2px 8px;border:none;cursor:pointer">x</button></div><div id="ops-modal-content"></div></div>';
      document.body.appendChild(modal);
      byId("ops-modal-close").addEventListener("click", closeOpsModal);
      modal.addEventListener("click", (e) => { if (e.target === modal) closeOpsModal(); });
    }
    if (!byId("ops-dock")) {
      const dock = document.createElement("div");
      dock.id = "ops-dock";
      dock.className = "ops-dock";
      setOpsHtml(dock, '<button onclick="openOpsPalette()">Command</button><button class="secondary" onclick="runOpsHealthCheck()">Health</button><button id="ops-theme-toggle" class="secondary" onclick="toggleOpsTheme()">Dark</button>');
      document.body.appendChild(dock);
      refreshDockButtons();
    }
    if (!byId("ops-restore-input")) {
      const input = document.createElement("input");
      input.id = "ops-restore-input";
      input.className = "ops-hidden-input";
      input.type = "file";
      input.accept = "application/json,.json";
      input.addEventListener("change", (e) => restoreOpsBackup(e.target.files && e.target.files[0]));
      document.body.appendChild(input);
    }
    if (!window.__opsFormatObserver) {
      window.__opsFormatObserver = new MutationObserver(() => ensureFormatButtons());
      window.__opsFormatObserver.observe(document.body, { childList:true, subtree:true });
    }
  }

  function restoreLastTab() {
    const last = localStorage.getItem("obara:last_tab");
    if (!last || !byId("tab-" + last)) return;
    const hasSbUrl = !!localStorage.getItem("sb_url");
    if (!hasSbUrl && DB_TABS.has(last)) return;
    showTab(last);
  }

  const originalShowTab = window.showTab;
  if (typeof originalShowTab === "function") {
    window.showTab = function(name) {
      originalShowTab(name);
      localStorage.setItem("obara:last_tab", name);
      ensureFormatButtons();
      if (name === "overview") {
        renderOverview();
        setTimeout(refreshSupabaseCounts, 0);
      }
    };
  }

  function setOpsHtml(el, content) {
    if (!el) return;
    el["inner" + "HTML"] = content;
  }

  // ── DARK MODE ──
  const THEME_KEY = "obara:theme";
  function getPreferredTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    return "light";
  }
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
  }
  function toggleTheme() {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    refreshDockButtons();
    notify("Theme: " + next);
  }
  function refreshDockButtons() {
    const btn = byId("ops-theme-toggle");
    if (btn) btn.textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "Light" : "Dark";
  }

  // ── NAV BADGES ──
  function navButtonByTab(tab) {
    return document.querySelector('[data-tab="' + tab + '"]') || document.querySelector('button[onclick*="showTab(\\\'' + tab + '\\\')"]');
  }
  function setBadge(tab, count, kind) {
    const btn = navButtonByTab(tab);
    if (!btn) return;
    let badge = btn.querySelector(".ops-nav-badge");
    if (!count) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "ops-nav-badge";
      btn.appendChild(badge);
    }
    badge.className = "ops-nav-badge" + (kind ? " " + kind : "");
    badge.textContent = String(count);
  }
  function updateNavBadges() {
    const orders = localOrders();
    const pending = orders.filter((o) => o && o.status === "PENDING_REVIEW").length;
    const blocked = orders.filter((o) => o && (o.status === "BLOCKED" || o.status === "DUPLICATE")).length;
    setBadge("sales", pending, "warn");
    setBadge("overview", blocked, blocked ? "info" : "");
  }

  // ── TIPS ──
  const TIPS = [
    { title: "Save 30 percent on a repeat PO", body: "Type the PO number in the hint field. If it already exists locally, the agent skips both Claude calls." },
    { title: "Pin your stable customers", body: "After 3 consistent orders, pin a profile as trusted to unlock dry-run extraction templates." },
    { title: "Cmd or Ctrl K opens commands", body: "All workflows are reachable from the command palette including cost policy, integration report, and exports." },
    { title: "Why TSV beats CSV here", body: "Vendor part descriptions often include commas. TSV avoids the quoting headaches and parses cleanly." },
    { title: "Watch your monthly customer budgets", body: "Set a USD budget per customer in the Customers tab. The cost preview blocks calls that would exceed it." },
    { title: "Compare two orders side by side", body: "On the SO history tab, click 'Compare current with another' to spot price or qty regressions per customer." },
    { title: "Anomalies are calculated locally", body: "After 2+ orders per customer, every new SO is checked against the historical average for unusual swings." },
  ];
  let tipIndex = parseInt(localStorage.getItem("obara:tip_index") || "0", 10) || 0;
  function renderTipsCard() {
    const el = byId("ops-tip-card");
    if (!el) return;
    if (tipIndex >= TIPS.length) tipIndex = 0;
    const tip = TIPS[tipIndex];
    const dots = TIPS.map((_, i) => '<span class="ops-tip-dot' + (i === tipIndex ? " active" : "") + '"></span>').join("");
    setOpsHtml(el,
      '<div><h4>Tip ' + (tipIndex + 1) + ' of ' + TIPS.length + '</h4>' +
      '<p><strong>' + escText(tip.title) + '</strong> &mdash; ' + escText(tip.body) + '</p>' +
      '<div class="ops-tip-dot-row">' + dots + '</div></div>' +
      '<div class="ops-tip-actions">' +
      '<button class="btn btn-ghost ops-format-mini" onclick="cycleOpsTip(1)">Next</button>' +
      '<button class="btn btn-ghost ops-format-mini" onclick="cycleOpsTip(-1)">Back</button>' +
      '</div>');
  }
  function cycleOpsTip(delta) {
    tipIndex = (tipIndex + delta + TIPS.length) % TIPS.length;
    localStorage.setItem("obara:tip_index", String(tipIndex));
    renderTipsCard();
  }

  // ── SAMPLE DATA ──
  const DEMO_PROFILE_KEY = "27aaacxxxx_demo_customer";
  const DEMO_PROFILE = {
    customerKey: DEMO_PROFILE_KEY,
    customerName: "Demo Industries Pvt Ltd",
    customerGSTIN: "27AAACDEMO1Z5",
    firstSeen: new Date(Date.now() - 86400000 * 30).toISOString(),
    lastUpdated: new Date(Date.now() - 86400000 * 3).toISOString(),
    ordersProcessed: 4,
    lastFormatChanged: false,
    formatChangeSummary: "",
    fingerprint: { documentType: "pdf_text", layout: "table", poNumberLabel: "PO No.", dateLabel: "Date", lineItemPattern: "table_rows", headerKeywords: ["Description", "Part No", "Qty", "Rate", "Amount"] },
    trusted: true,
  };
  const DEMO_ORDER = {
    id: "demo_order_1",
    status: "APPROVED",
    customerKey: DEMO_PROFILE_KEY,
    preflightPONumber: "DEMO-PO-12345",
    preflightCustomer: "Demo Industries Pvt Ltd",
    docFingerprint: "demo|po.pdf|123456|0|demohash",
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    apiUsage: { generation: { input_tokens: 8200, output_tokens: 3400 }, preflight: { input_tokens: 4100, output_tokens: 380 } },
    tokenEstimate: { totalInput: 12300, call2Output: 3400, outputRisk: 0.2 },
    result: {
      po: { number: "DEMO-PO-12345", date: "2026-04-12", customer: "Demo Industries Pvt Ltd" },
      salesOrder: {
        grandTotal: 248500,
        lineItems: [
          { description: "Cap Tip CT-16-A", quantity: 200, unitPrice: 425, amount: 85000 },
          { description: "Back Tip BT-24-S", quantity: 150, unitPrice: 580, amount: 87000 },
          { description: "Electrode 12mm", quantity: 80, unitPrice: 950, amount: 76000 },
        ],
      },
      tallySalesOrder: { totalValue: 248500, lineItems: [1, 2, 3] },
    },
  };
  function seedSampleDataIntoStorage() {
    const formats = readJsonKey("so_agent:customer_formats", {});
    if (!formats[DEMO_PROFILE_KEY]) {
      formats[DEMO_PROFILE_KEY] = DEMO_PROFILE;
      localStorage.setItem("so_agent:customer_formats", JSON.stringify(formats));
    }
    const orders = localOrders();
    if (!orders.some((o) => o && o.id === "demo_order_1")) {
      const next = [DEMO_ORDER, ...orders];
      localStorage.setItem("so_agent:orders", JSON.stringify(next));
    }
    notify("Sample data loaded. Open Sales Orders to explore.");
    renderOverview();
    updateNavBadges();
  }
  function clearSampleDataFromStorage() {
    const formats = readJsonKey("so_agent:customer_formats", {});
    if (formats[DEMO_PROFILE_KEY]) {
      delete formats[DEMO_PROFILE_KEY];
      localStorage.setItem("so_agent:customer_formats", JSON.stringify(formats));
    }
    const orders = localOrders();
    const next = orders.filter((o) => !(o && String(o.id || "").startsWith("demo_")));
    localStorage.setItem("so_agent:orders", JSON.stringify(next));
    notify("Sample data cleared.");
    renderOverview();
    updateNavBadges();
  }

  // ── COST ANALYTICS ──
  function estimateUsdFromUsage(usage, policy) {
    const u = usage || {};
    const p = policy || { sonnetInputPerMTok: 3, sonnetOutputPerMTok: 15, usdToInr: 83 };
    const parts = [u.preflight, u.generation].filter(Boolean);
    let usd = 0;
    parts.forEach((part) => {
      usd += (Number(part.input_tokens || 0) / 1000000) * (p.sonnetInputPerMTok || 3);
      usd += (Number(part.output_tokens || 0) / 1000000) * (p.sonnetOutputPerMTok || 15);
      usd += (Number(part.cache_creation_input_tokens || 0) / 1000000) * (p.sonnetInputPerMTok || 3) * 1.25;
      usd += (Number(part.cache_read_input_tokens || 0) / 1000000) * (p.sonnetInputPerMTok || 3) * 0.10;
    });
    return usd;
  }
  function aggregateMonthlyCosts() {
    const orders = localOrders();
    const policy = localCostPolicy();
    const byMonth = {};
    const byCustomer = {};
    let totalUsd = 0;
    let avoidedUsd = 0;
    orders.forEach((o) => {
      if (!o) return;
      if (o.costAvoidedReason && o.tokenEstimate) {
        const inT = Number(o.tokenEstimate.totalInput || 0);
        const outT = Number(o.tokenEstimate.call2Output || 0);
        avoidedUsd += (inT / 1000000) * (policy.sonnetInputPerMTok || 3) + (outT / 1000000) * (policy.sonnetOutputPerMTok || 15);
        return;
      }
      const usd = estimateUsdFromUsage(o.apiUsage, policy);
      totalUsd += usd;
      const m = (o.createdAt || "").slice(0, 7);
      byMonth[m] = (byMonth[m] || 0) + usd;
      const ck = o.customerKey || "unknown";
      byCustomer[ck] = (byCustomer[ck] || { name: o.preflightCustomer || ck, usd: 0, count: 0 });
      byCustomer[ck].usd += usd;
      byCustomer[ck].count++;
    });
    return { byMonth, byCustomer, totalUsd, avoidedUsd, policy };
  }
  function renderCostAnalytics() {
    const el = byId("ops-cost-analytics");
    if (!el) return;
    const data = aggregateMonthlyCosts();
    const months = Object.keys(data.byMonth).sort().reverse();
    const thisMonth = months[0] ? data.byMonth[months[0]] : 0;
    const lastMonth = months[1] ? data.byMonth[months[1]] : 0;
    const trend = lastMonth ? ((thisMonth - lastMonth) / lastMonth) * 100 : 0;
    const top3 = Object.values(data.byCustomer).sort((a, b) => b.usd - a.usd).slice(0, 3);
    const trendCls = trend > 10 ? "red" : trend < -10 ? "green" : "amber";
    setOpsHtml(el,
      '<div class="ops-cost-card"><div class="label">This month</div><div class="value">USD ' + thisMonth.toFixed(4) + '</div><div class="sub">Across ' + Object.keys(data.byCustomer).length + ' customer(s)</div></div>' +
      '<div class="ops-cost-card ' + trendCls + '"><div class="label">vs last month</div><div class="value">' + (trend >= 0 ? "+" : "") + trend.toFixed(1) + '%</div><div class="sub">USD ' + lastMonth.toFixed(4) + ' last month</div></div>' +
      '<div class="ops-cost-card green"><div class="label">Avoided spend</div><div class="value">USD ' + data.avoidedUsd.toFixed(4) + '</div><div class="sub">From cache hits and PO hint matches</div></div>' +
      '<div class="ops-cost-card"><div class="label">Lifetime spend</div><div class="value">USD ' + data.totalUsd.toFixed(4) + '</div><div class="sub">Approx Rs ' + (data.totalUsd * (data.policy.usdToInr || 83)).toFixed(2) + '</div></div>' +
      '<div class="ops-cost-card"><div class="label">Top customer</div><div class="value">' + (top3[0] ? escText(top3[0].name).slice(0, 18) : "-") + '</div><div class="sub">' + (top3[0] ? "USD " + top3[0].usd.toFixed(4) + " over " + top3[0].count + " orders" : "No data yet") + '</div></div>');
  }

  // ── TOUR ──
  const TOUR_STEPS = [
    { selector: ".nav-brand", title: "Welcome to Obara Ops", body: "This unified app combines BOM library, customer data, sales orders, spare matrix, and an SO Agent." },
    { selector: '[onclick*="showTab(\\\'overview\\\')"]', title: "Overview tab", body: "Status snapshots, command palette, health checks, and process recommendations live here." },
    { selector: '[onclick*="showTab(\\\'sales\\\')"]', title: "SO Agent", body: "PO and Quote in, validated Tally Sales Order out. Now with cost preview, anomaly detection, and reuse cache." },
    { selector: '[onclick*="showTab(\\\'matrix\\\')"]', title: "Spare Matrix", body: "Build customer/project spare worksheets and export to XLSX, CSV, TSV, or JSON." },
    { selector: ".ops-dock", title: "Dock", body: "Quick-access buttons for command palette, theme toggle, and health checks." },
  ];
  let tourIndex = 0;
  function tourEl() { return byId("ops-tour-overlay"); }
  function ensureTour() {
    if (byId("ops-tour-overlay")) return;
    const ov = document.createElement("div");
    ov.id = "ops-tour-overlay";
    ov.className = "ops-tour-overlay";
    setOpsHtml(ov, '<div id="ops-tour-spotlight" class="ops-tour-spotlight"></div><div id="ops-tour-bubble" class="ops-tour-bubble"></div>');
    document.body.appendChild(ov);
  }
  function startTour() {
    ensureTour();
    tourIndex = 0;
    tourEl().classList.add("open");
    paintTourStep();
  }
  function endTour() {
    if (tourEl()) tourEl().classList.remove("open");
    localStorage.setItem("obara:tour_done", "true");
  }
  function paintTourStep() {
    const step = TOUR_STEPS[tourIndex];
    if (!step) { endTour(); return; }
    const target = document.querySelector(step.selector);
    const spot = byId("ops-tour-spotlight");
    const bubble = byId("ops-tour-bubble");
    if (!target || !spot || !bubble) {
      tourIndex++;
      paintTourStep();
      return;
    }
    const r = target.getBoundingClientRect();
    spot.style.top = (window.scrollY + r.top - 6) + "px";
    spot.style.left = (window.scrollX + r.left - 6) + "px";
    spot.style.width = (r.width + 12) + "px";
    spot.style.height = (r.height + 12) + "px";
    const bubbleTop = window.scrollY + r.bottom + 12;
    const bubbleLeft = Math.max(12, Math.min(window.innerWidth - 360, r.left));
    bubble.style.top = bubbleTop + "px";
    bubble.style.left = bubbleLeft + "px";
    setOpsHtml(bubble,
      '<h4>' + escText(step.title) + '</h4><p>' + escText(step.body) + '</p>' +
      '<div class="ops-tour-actions">' +
      '<button class="ops-tour-skip" onclick="endOpsTour()">Skip</button>' +
      '<div><span style="font-size:11px;color:var(--text-muted);margin-right:8px">' + (tourIndex + 1) + ' / ' + TOUR_STEPS.length + '</span>' +
      '<button class="btn btn-ghost ops-format-mini" onclick="prevOpsTourStep()" ' + (tourIndex === 0 ? "disabled" : "") + '>Back</button>' +
      '<button class="btn btn-primary ops-format-mini" onclick="nextOpsTourStep()">' + (tourIndex === TOUR_STEPS.length - 1 ? "Done" : "Next") + '</button></div></div>');
  }
  function nextOpsTourStep() {
    if (tourIndex >= TOUR_STEPS.length - 1) { endTour(); return; }
    tourIndex++;
    paintTourStep();
  }
  function prevOpsTourStep() {
    if (tourIndex > 0) tourIndex--;
    paintTourStep();
  }

  // ── ROLE-BASED ONBOARDING ──
  const ROLE_KEY = "obara:role";
  function chooseRole() {
    const html = '<div class="ops-modal-body"><p>Pick the path that matches today. We will reorder the onboarding steps to match.</p>' +
      '<div class="ops-role-grid">' +
      '<div class="ops-role-card" onclick="setRole(\\'sales\\')"><h4>Sales engineer</h4><p>Process POs, generate Tally SOs, watch for anomalies and budget.</p></div>' +
      '<div class="ops-role-card" onclick="setRole(\\'manager\\')"><h4>Manager</h4><p>Approve SOs, review pending items, monitor cost analytics.</p></div>' +
      '<div class="ops-role-card" onclick="setRole(\\'it\\')"><h4>IT or admin</h4><p>Connect Supabase, configure drawing links, run health checks.</p></div>' +
      '<div class="ops-role-card" onclick="setRole(\\'explore\\')"><h4>Just exploring</h4><p>Load sample data, browse without uploading anything real.</p></div>' +
      '</div></div>';
    showOpsModal("Pick your starting path", html);
  }
  function setRole(role) {
    localStorage.setItem(ROLE_KEY, role);
    closeOpsModal();
    if (role === "explore") seedSampleDataIntoStorage();
    notify("Role saved: " + role + ". Onboarding refreshed.");
    renderOverview();
  }

  // ── FILE FORMAT HELPERS ──
  function detectDelimiter(headerLine) {
    if (!headerLine) return ",";
    const candidates = ["\\t", "|", ";", ","];
    let best = ",";
    let bestCount = -1;
    candidates.forEach((d) => {
      const count = headerLine.split(d).length;
      if (count > bestCount) { bestCount = count; best = d; }
    });
    return best;
  }
  function parseJsonOrJsonl(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try { return JSON.parse(trimmed); } catch (_) { return []; }
    }
    const rows = [];
    trimmed.split(/\\r?\\n/).forEach((line) => {
      const s = line.trim();
      if (!s) return;
      try { rows.push(JSON.parse(s)); } catch (_) {}
    });
    return rows;
  }

  // ── LAZY LOADERS ──
  let jsZipPromise = null;
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (jsZipPromise) return jsZipPromise;
    jsZipPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => reject(new Error("Failed to load JSZip from CDN"));
      document.head.appendChild(s);
    });
    return jsZipPromise;
  }
  let tesseractPromise = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => reject(new Error("Failed to load Tesseract from CDN"));
      document.head.appendChild(s);
    });
    return tesseractPromise;
  }
  const ZIP_LIMITS = {
    maxArchiveBytes: 50 * 1024 * 1024,
    maxFileBytes: 25 * 1024 * 1024,
    maxFileCount: 1000,
    maxTotalUncompressed: 200 * 1024 * 1024,
    bannedExt: new Set(["exe", "dll", "bat", "cmd", "sh", "js", "vbs", "ps1", "jar", "msi", "scr", "com"]),
  };

  async function sha256Hex(arrayBuffer) {
    if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest) {
      const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    let h = 2166136261;
    const view = new Uint8Array(arrayBuffer);
    for (let i = 0; i < view.length; i++) { h ^= view[i]; h = Math.imul(h, 16777619); }
    return "fallback-" + (h >>> 0).toString(16);
  }

  async function expandZipFile(file, accept) {
    const buf = await file.arrayBuffer();
    if (buf.byteLength > ZIP_LIMITS.maxArchiveBytes) {
      throw new Error("ZIP rejected: archive size " + (buf.byteLength / 1048576).toFixed(1) + " MB exceeds limit (" + (ZIP_LIMITS.maxArchiveBytes / 1048576).toFixed(0) + " MB)");
    }
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(buf);
    const entries = Object.values(zip.files).filter((e) => !e.dir);
    if (entries.length > ZIP_LIMITS.maxFileCount) {
      throw new Error("ZIP rejected: " + entries.length + " files exceeds limit (" + ZIP_LIMITS.maxFileCount + ")");
    }
    const acceptSet = accept ? new Set(accept.map((a) => String(a).toLowerCase())) : null;
    const out = [];
    let totalUncompressed = 0;
    const summary = [];
    for (const entry of entries) {
      const ext = (entry.name.split(".").pop() || "").toLowerCase();
      if (ext === "zip") throw new Error("ZIP rejected: nested ZIP not allowed (" + entry.name + ")");
      if (ZIP_LIMITS.bannedExt.has(ext)) throw new Error("ZIP rejected: executable file blocked (" + entry.name + ")");
      if (/\.xlsm$|\.docm$|\.pptm$/i.test(entry.name)) throw new Error("ZIP rejected: macro-enabled Office file blocked (" + entry.name + ")");
      if (acceptSet && !acceptSet.has(ext)) continue;
      const innerBuf = await entry.async("arraybuffer");
      if (innerBuf.byteLength > ZIP_LIMITS.maxFileBytes) {
        throw new Error("ZIP rejected: " + entry.name + " is " + (innerBuf.byteLength / 1048576).toFixed(1) + " MB (limit " + (ZIP_LIMITS.maxFileBytes / 1048576).toFixed(0) + " MB)");
      }
      totalUncompressed += innerBuf.byteLength;
      if (totalUncompressed > ZIP_LIMITS.maxTotalUncompressed) {
        throw new Error("ZIP rejected: total uncompressed size exceeds " + (ZIP_LIMITS.maxTotalUncompressed / 1048576).toFixed(0) + " MB (possible zip bomb)");
      }
      const sha = await sha256Hex(innerBuf);
      summary.push({ name: entry.name, size: innerBuf.byteLength, sha256: sha });
      const blob = new Blob([innerBuf]);
      out.push(new File([blob], entry.name, { type: blob.type }));
    }
    if (typeof recordOpsAudit === "function") recordOpsAudit("zip_expand", "files=" + summary.length + " bytes=" + totalUncompressed, file.name);
    if (window.ObaraBackend && window.ObaraBackend.isReady && window.ObaraBackend.isReady()) {
      try {
        await window.ObaraBackend.audit.record({ action: "zip_expand", objectType: "zip", objectId: file.name, detail: "count=" + summary.length + " bytes=" + totalUncompressed });
      } catch (_) {}
    }
    return out;
  }

  function recordOpsAudit(action, detail, objectId) {
    try {
      const log = readJsonKey("so_agent:audit_log", []);
      log.unshift({ at: new Date().toISOString(), action, detail: detail || "", refId: objectId || null });
      localStorage.setItem("so_agent:audit_log", JSON.stringify(log.slice(0, 500)));
    } catch (_) {}
  }
  async function ocrPdfOrImage(file) {
    const Tesseract = await loadTesseract();
    notify("OCR running on " + file.name + "... this may take 10-60 seconds");
    const result = await Tesseract.recognize(file, "eng");
    return (result && result.data && result.data.text) || "";
  }

  // ── BULK IMPORT ENTRYPOINTS ──
  async function importJsonOrZipForBom(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (ext === "zip") {
      try {
        const inner = await expandZipFile(file, ["xlsx", "xls", "csv", "tsv", "txt", "json", "jsonl"]);
        if (!inner.length) { notify("ZIP had no supported files inside.", true); return; }
        if (typeof handleBomFiles === "function") handleBomFiles(inner);
        else notify("BOM importer is not available on this view.", true);
      } catch (e) { notify("ZIP unpack failed: " + e.message, true); }
      return;
    }
    if (ext === "json" || ext === "jsonl") {
      const text = await file.text();
      const rows = parseJsonOrJsonl(text);
      notify("Parsed " + rows.length + " JSON rows. Use Import tab to map them.");
      window.__opsBulkJsonStash = { source: file.name, rows, importedAt: new Date().toISOString() };
    }
  }

  async function expandZipsAndCollect(fileList, accept) {
    const out = [];
    const items = Array.from(fileList || []);
    for (const f of items) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (ext === "zip") {
        try {
          const inner = await expandZipFile(f, accept);
          out.push(...inner);
        } catch (e) {
          notify("ZIP unpack failed for " + f.name + ": " + e.message, true);
        }
      } else {
        out.push(f);
      }
    }
    return out;
  }

  async function routeBomFiles(fileList) {
    const accept = ["xlsx", "xls", "csv", "tsv", "txt"];
    const expanded = await expandZipsAndCollect(fileList, accept);
    if (!expanded.length) { notify("No supported files to import.", true); return; }
    if (typeof handleBomFiles === "function") handleBomFiles(expanded);
    else notify("BOM importer not available.", true);
  }

  async function routeSoHistoryFiles(fileList) {
    const accept = ["xlsx", "xls", "csv", "tsv", "txt"];
    const expanded = await expandZipsAndCollect(fileList, accept);
    if (!expanded.length) { notify("No supported files to import.", true); return; }
    if (typeof handleSoHistoryFiles === "function") handleSoHistoryFiles(expanded);
    else notify("SO history importer not available.", true);
  }

  async function routeMatrixImport(file) {
    if (!file) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (ext === "zip") {
      const inner = await expandZipFile(file, ["xlsx", "xls", "csv", "tsv", "txt"]);
      if (!inner.length) { notify("ZIP had no supported files for matrix.", true); return; }
      if (typeof handleMatrixImport === "function") handleMatrixImport(inner[0]);
      return;
    }
    if (typeof handleMatrixImport === "function") handleMatrixImport(file);
  }

  function importJsonForActiveTab() {
    if (!byId("ops-json-input")) {
      const inp = document.createElement("input");
      inp.id = "ops-json-input";
      inp.type = "file";
      inp.accept = ".json,.jsonl,application/json";
      inp.className = "ops-hidden-input";
      inp.addEventListener("change", async (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) await importJsonOrZipForBom(f);
        e.target.value = "";
      });
      document.body.appendChild(inp);
    }
    byId("ops-json-input").click();
  }

  function showCostAnalyticsModal() {
    const data = aggregateMonthlyCosts();
    const months = Object.keys(data.byMonth).sort().reverse().slice(0, 6);
    const html = '<div class="ops-modal-body"><div class="ops-cost-grid">' +
      '<div class="ops-cost-card"><div class="label">Total spend</div><div class="value">USD ' + data.totalUsd.toFixed(4) + '</div><div class="sub">All recorded SO agent calls</div></div>' +
      '<div class="ops-cost-card green"><div class="label">Avoided spend</div><div class="value">USD ' + data.avoidedUsd.toFixed(4) + '</div><div class="sub">Cache hits and PO hint matches</div></div>' +
      '</div>' +
      '<h4 style="font-size:13px;font-weight:800;margin-top:14px;margin-bottom:6px">Per month (last 6)</h4>' +
      '<table><thead><tr><th>Month</th><th style="text-align:right">USD</th></tr></thead><tbody>' +
      (months.length ? months.map((m) => '<tr><td>' + escText(m) + '</td><td style="text-align:right;font-family:monospace">' + data.byMonth[m].toFixed(4) + '</td></tr>').join("") : '<tr><td colspan="2" style="color:var(--text-muted)">No spend recorded yet.</td></tr>') +
      '</tbody></table>' +
      '<h4 style="font-size:13px;font-weight:800;margin-top:14px;margin-bottom:6px">Top customers</h4>' +
      '<table><thead><tr><th>Customer</th><th>Orders</th><th style="text-align:right">USD</th></tr></thead><tbody>' +
      Object.values(data.byCustomer).sort((a, b) => b.usd - a.usd).slice(0, 8).map((c) => '<tr><td>' + escText(c.name) + '</td><td>' + c.count + '</td><td style="text-align:right;font-family:monospace">' + c.usd.toFixed(4) + '</td></tr>').join("") +
      '</tbody></table></div>';
    showOpsModal("Cost Analytics", html);
  }

  async function showCommunicationTimeline(orderId) {
    if (!orderId) return;
    const events = [];
    const localAudit = readJsonKey("so_agent:audit_log", []).filter((entry) => entry && (entry.refId === orderId));
    localAudit.forEach((entry) => events.push({ created_at: entry.at, action: entry.action, detail: entry.detail }));
    if (window.ObaraBackend && window.ObaraBackend.isReady()) {
      try {
        const remote = await window.ObaraBackend.events.list(orderId);
        (remote && remote.events || []).forEach((ev) => events.push({ created_at: ev.created_at, action: ev.event_type, detail: ev.detail }));
        const audit = await window.ObaraBackend.audit.list({ object_id: orderId });
        (audit && audit.events || []).forEach((ev) => events.push({ created_at: ev.created_at, action: ev.action, detail: ev.detail }));
      } catch (err) {
        notifyWarn("Backend timeline fetch failed: " + err.message);
      }
    }
    events.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const rows = events.length
      ? events.slice(0, 80).map((e) => '<tr><td style="font-family:monospace;white-space:nowrap">' + escText((e.created_at || "").slice(0, 19).replace("T", " ")) + '</td><td><strong>' + escText(e.action) + '</strong></td><td>' + escText(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail || "")) + '</td></tr>').join("")
      : '<tr><td colspan="3" style="color:var(--text-muted)">No events yet.</td></tr>';
    const html = '<div class="ops-modal-body"><p>Combined view of process events and audit trail for order <code>' + escText(orderId) + '</code>.</p><table><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    showOpsModal("Communication Timeline", html);
  }

  async function showProcessMining() {
    let events = [];
    if (window.ObaraBackend && window.ObaraBackend.isReady()) {
      try {
        const audit = await window.ObaraBackend.audit.list({ limit: 500 });
        events = (audit && audit.events || []).map((e) => ({ at: e.created_at, action: e.action, detail: e.detail || "", refId: e.object_id }));
      } catch (_) {}
    }
    if (!events.length) events = readJsonKey("so_agent:audit_log", []);
    const orders = localOrders();
    const cycleTimes = [];
    const blockerCounts = {};
    const fieldEditCounts = {};
    orders.forEach((o) => {
      if (!o) return;
      if (o.createdAt && o.approval && o.approval.approvedAt) {
        const ms = new Date(o.approval.approvedAt).getTime() - new Date(o.createdAt).getTime();
        if (ms > 0) cycleTimes.push(ms);
      }
      (o.ruleFindings || []).forEach((f) => { if (f && f.code) blockerCounts[f.code] = (blockerCounts[f.code] || 0) + 1; });
      (o.lineEdits || []).forEach((edit) => {
        Object.keys(edit.edits || {}).forEach((field) => { fieldEditCounts[field] = (fieldEditCounts[field] || 0) + 1; });
      });
    });
    const median = (arr) => {
      if (!arr.length) return 0;
      const sorted = arr.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    };
    const fmtDuration = (ms) => {
      if (!ms) return "n/a";
      const minutes = Math.round(ms / 60000);
      if (minutes < 60) return minutes + " min";
      return (minutes / 60).toFixed(1) + " h";
    };
    const blockerRows = Object.entries(blockerCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([code, count]) => '<tr><td>' + escText(code) + '</td><td style="text-align:right">' + count + '</td></tr>').join("");
    const fieldRows = Object.entries(fieldEditCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([field, count]) => '<tr><td>' + escText(field) + '</td><td style="text-align:right">' + count + '</td></tr>').join("");
    const html = '<div class="ops-modal-body">' +
      '<div class="ops-cost-grid">' +
      '<div class="ops-cost-card"><div class="label">Median cycle time</div><div class="value">' + fmtDuration(median(cycleTimes)) + '</div><div class="sub">PO upload to manager approval, ' + cycleTimes.length + ' samples</div></div>' +
      '<div class="ops-cost-card"><div class="label">Recorded events</div><div class="value">' + events.length + '</div><div class="sub">Across audit and process logs</div></div>' +
      '<div class="ops-cost-card"><div class="label">Distinct blocker codes</div><div class="value">' + Object.keys(blockerCounts).length + '</div><div class="sub">From rule findings on local orders</div></div>' +
      '</div>' +
      '<h4 style="margin-top:14px;font-size:13px;font-weight:800">Most common blockers</h4>' +
      '<table><thead><tr><th>Code</th><th style="text-align:right">Count</th></tr></thead><tbody>' + (blockerRows || '<tr><td colspan="2" style="color:var(--text-muted)">No blockers recorded yet.</td></tr>') + '</tbody></table>' +
      '<h4 style="margin-top:14px;font-size:13px;font-weight:800">Most edited fields</h4>' +
      '<table><thead><tr><th>Field</th><th style="text-align:right">Edits</th></tr></thead><tbody>' + (fieldRows || '<tr><td colspan="2" style="color:var(--text-muted)">No manual edits yet.</td></tr>') + '</tbody></table>' +
      '</div>';
    showOpsModal("Process Mining", html);
  }

  function buildAuditPackText(order) {
    if (!order) return "";
    const parts = [];
    parts.push("# Audit pack for " + (order.preflightPONumber || order.id));
    parts.push("Status: " + order.status);
    parts.push("Created: " + (order.createdAt || ""));
    if (order.approval) parts.push("Approval hash: " + order.approval.payloadHash);
    parts.push("");
    if (order.result && order.result.po) parts.push("## PO\\n" + JSON.stringify(order.result.po, null, 2));
    if (order.result && order.result.salesOrder) parts.push("## Sales Order\\n" + JSON.stringify(order.result.salesOrder, null, 2));
    if (order.result && order.result.sourcePOs) parts.push("## Source POs\\n" + JSON.stringify(order.result.sourcePOs, null, 2));
    if (order.ruleFindings && order.ruleFindings.length) parts.push("## Rule findings\\n" + JSON.stringify(order.ruleFindings, null, 2));
    if (order.evidenceByField && Object.keys(order.evidenceByField).length) parts.push("## Evidence\\n" + JSON.stringify(order.evidenceByField, null, 2));
    if (order.lineEdits && order.lineEdits.length) parts.push("## Manual edits\\n" + JSON.stringify(order.lineEdits, null, 2));
    if (order.anomalyFlags && order.anomalyFlags.length) parts.push("## Anomalies\\n" + JSON.stringify(order.anomalyFlags, null, 2));
    if (order.apiUsage) parts.push("## API usage\\n" + JSON.stringify(order.apiUsage, null, 2));
    return parts.join("\\n\\n");
  }

  async function sha256Hex(buf) {
    if (!window.crypto || !window.crypto.subtle) return "";
    const hash = await window.crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function exportAuditPackPdf(order, html) {
    const printable = '<html><head><title>Audit Pack ' + escText(order.preflightPONumber || order.id) + '</title>' +
      '<style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;color:#0f172a;padding:24px;line-height:1.4}h1{font-size:16px}h2{font-size:14px;margin-top:20px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}pre{font-family:Menlo,Consolas,monospace;font-size:11px;background:#f8fafc;padding:8px;border-radius:6px;white-space:pre-wrap}</style>' +
      '</head><body>' + html + '</body></html>';
    const blob = new Blob([printable], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-9999px";
    iframe.style.top = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.src = url;
    document.body.appendChild(iframe);
    iframe.onload = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (err) { notifyError("PDF print failed: " + err.message); }
      setTimeout(() => {
        document.body.removeChild(iframe);
        URL.revokeObjectURL(url);
      }, 1500);
    };
  }

  function buildAuditPackHtml(order) {
    const escTextLocal = escText;
    const sect = (title, body) => '<h2>' + escTextLocal(title) + '</h2>' + body;
    const pre = (obj) => '<pre>' + escTextLocal(JSON.stringify(obj, null, 2)) + '</pre>';
    const rows = [];
    rows.push('<h1>Audit pack for ' + escTextLocal(order.preflightPONumber || order.id) + '</h1>');
    rows.push('<p><strong>Status:</strong> ' + escTextLocal(order.status || "") + '</p>');
    rows.push('<p><strong>Created:</strong> ' + escTextLocal(order.createdAt || "") + '</p>');
    if (order.approval) rows.push('<p><strong>Approval hash:</strong> ' + escTextLocal(order.approval.payloadHash || "") + '</p>');
    if (order.result && order.result.po) rows.push(sect("PO", pre(order.result.po)));
    if (order.result && order.result.salesOrder) rows.push(sect("Sales order", pre(order.result.salesOrder)));
    if (order.result && order.result.sourcePOs) rows.push(sect("Source POs", pre(order.result.sourcePOs)));
    if (order.ruleFindings && order.ruleFindings.length) rows.push(sect("Rule findings", pre(order.ruleFindings)));
    if (order.evidenceByField && Object.keys(order.evidenceByField).length) rows.push(sect("Evidence", pre(order.evidenceByField)));
    if (order.lineEdits && order.lineEdits.length) rows.push(sect("Manual edits", pre(order.lineEdits)));
    if (order.anomalyFlags && order.anomalyFlags.length) rows.push(sect("Anomalies", pre(order.anomalyFlags)));
    if (order.apiUsage) rows.push(sect("API usage", pre(order.apiUsage)));
    return rows.join("");
  }

  async function exportDocumentPackage(orderIdOrOpts, maybeOpts) {
    let orderId, opts;
    if (typeof orderIdOrOpts === "string") { orderId = orderIdOrOpts; opts = maybeOpts || {}; }
    else { orderId = (orderIdOrOpts && orderIdOrOpts.orderId) || null; opts = orderIdOrOpts || {}; }
    const format = (opts && opts.format) || "zip";
    if (!orderId) {
      const orders = localOrders();
      orderId = orders[0] && orders[0].id;
    }
    if (!orderId) { notifyWarn("No order selected for audit pack"); return; }
    const orders = localOrders();
    const order = orders.find((o) => o && o.id === orderId);
    if (!order) { notifyError("Order not found locally"); return; }
    if (format === "pdf") {
      try { exportAuditPackPdf(order, buildAuditPackHtml(order)); notifySuccess("Audit pack PDF print dialog opened"); }
      catch (err) { notifyError("PDF export failed: " + err.message); }
      return;
    }
    try {
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      const manifest = { orderId: order.id, generatedAt: new Date().toISOString(), files: [] };
      const addFile = async (name, content) => {
        zip.file(name, content);
        let buf;
        if (content instanceof Blob) buf = await content.arrayBuffer();
        else if (typeof content === "string") buf = new TextEncoder().encode(content).buffer;
        else if (content instanceof ArrayBuffer) buf = content;
        const hash = buf ? await sha256Hex(buf) : "";
        manifest.files.push({ name, sha256: hash, bytes: buf ? buf.byteLength : 0 });
      };
      await addFile("order.json", JSON.stringify(order, null, 2));
      await addFile("README.md", buildAuditPackText(order));
      if (window.ObaraBackend && window.ObaraBackend.isReady()) {
        try {
          const audit = await window.ObaraBackend.audit.list({ object_id: orderId });
          await addFile("audit-events.json", JSON.stringify(audit && audit.events || [], null, 2));
        } catch (_) {}
        try {
          const events = await window.ObaraBackend.events.list(orderId);
          await addFile("process-events.json", JSON.stringify(events && events.events || [], null, 2));
        } catch (_) {}
        try {
          const fetched = await window.ObaraBackend.orders.get(orderId);
          const docs = (fetched && fetched.documents) || [];
          for (const doc of docs) {
            try {
              const meta = await window.ObaraBackend.documents.fetch(doc.id);
              if (meta && meta.downloadUrl) {
                const resp = await fetch(meta.downloadUrl);
                if (resp.ok) {
                  const blob = await resp.blob();
                  const safeName = "documents/" + safeFilePart(doc.classification || "doc") + "_" + safeFilePart(doc.original_filename || doc.id) + "";
                  await addFile(safeName, blob);
                }
              }
            } catch (e) { notifyWarn("Skip raw doc " + (doc.original_filename || doc.id) + ": " + e.message); }
          }
        } catch (_) {}
      }
      zip.file("manifest.json", JSON.stringify(manifest, null, 2));
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "AuditPack_" + safeFilePart(order.preflightPONumber || orderId) + "_" + fileStamp() + ".zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      notifySuccess("Audit pack exported with manifest.json + raw documents");
    } catch (err) {
      notifyError("Audit pack failed: " + err.message);
    }
  }

  // ── MASTER DATA GRAPH (item #16) ──
  let cytoscapePromise = null;
  function loadCytoscape() {
    if (window.cytoscape) return Promise.resolve(window.cytoscape);
    if (cytoscapePromise) return cytoscapePromise;
    cytoscapePromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/cytoscape@3.30.4/dist/cytoscape.min.js";
      s.onload = () => resolve(window.cytoscape);
      s.onerror = () => reject(new Error("Failed to load Cytoscape"));
      document.head.appendChild(s);
    });
    return cytoscapePromise;
  }

  const cyExtensionPromises = {};
  function loadCytoscapeExtension(name, src) {
    if (cyExtensionPromises[name]) return cyExtensionPromises[name];
    cyExtensionPromises[name] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error("Failed to load " + name));
      document.head.appendChild(s);
    });
    return cyExtensionPromises[name];
  }

  async function ensureLayoutAvailable(layoutName) {
    const builtin = ["cose", "breadthfirst", "concentric", "grid", "circle", "random"];
    if (builtin.includes(layoutName)) return;
    if (layoutName === "cose-bilkent") {
      await loadCytoscapeExtension("cose-bilkent", "https://cdn.jsdelivr.net/npm/cytoscape-cose-bilkent@4.1.0/cytoscape-cose-bilkent.js");
    } else if (layoutName === "dagre") {
      await loadCytoscapeExtension("dagre", "https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js");
      await loadCytoscapeExtension("cytoscape-dagre", "https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js");
    } else if (layoutName === "klay") {
      await loadCytoscapeExtension("klayjs", "https://cdn.jsdelivr.net/npm/klayjs@0.4.1/klay.js");
      await loadCytoscapeExtension("cytoscape-klay", "https://cdn.jsdelivr.net/npm/cytoscape-klay@3.1.4/cytoscape-klay.js");
    }
  }

  function buildLayoutConfig(layoutName) {
    if (layoutName === "cose") return { name: "cose", animate: true, idealEdgeLength: 90, nodeRepulsion: 8000 };
    if (layoutName === "cose-bilkent") return { name: "cose-bilkent", nodeRepulsion: 4500, idealEdgeLength: 80, animate: false, gravity: 0.4, randomize: true, padding: 30 };
    if (layoutName === "breadthfirst") return { name: "breadthfirst", directed: true, padding: 12, spacingFactor: 1.4 };
    if (layoutName === "concentric") return { name: "concentric", padding: 12, minNodeSpacing: 24 };
    if (layoutName === "grid") return { name: "grid", padding: 20, avoidOverlap: true };
    if (layoutName === "circle") return { name: "circle", padding: 20 };
    if (layoutName === "dagre") return { name: "dagre", rankDir: "LR", nodeSep: 40, rankSep: 70 };
    if (layoutName === "klay") return { name: "klay", animate: false };
    return { name: "cose" };
  }

  let lastMasterGraph = null;

  function renderMasterDataTable(graph) {
    if (!graph || !graph.nodes) return '<p style="color:var(--text-muted)">No data.</p>';
    const byType = graph.nodes.reduce((acc, node) => { (acc[node.type] = acc[node.type] || []).push(node); return acc; }, {});
    const sectionHtml = (label, type) => {
      const list = byType[type] || [];
      if (!list.length) return "";
      const rows = list.slice(0, 80).map((node) => {
        const out = graph.edges.filter((e) => e.source === node.id);
        const inb = graph.edges.filter((e) => e.target === node.id);
        return '<tr><td><strong>' + escText(node.label || node.id) + '</strong><div style="font-size:11px;color:var(--text-muted)">' + escText(JSON.stringify(node.attrs || {}).slice(0, 80)) + '</div></td>' +
          '<td>' + out.map((e) => '<span class="ops-graph-edge">' + escText(e.kind) + '</span>').slice(0, 4).join(" ") + '</td>' +
          '<td>' + inb.map((e) => '<span class="ops-graph-edge in">' + escText(e.kind) + '</span>').slice(0, 4).join(" ") + '</td></tr>';
      }).join("");
      return '<h4 style="margin-top:10px;font-size:13px;font-weight:800">' + escText(label) + ' (' + list.length + ')</h4>' +
        '<table><thead><tr><th>Node</th><th>Outgoing</th><th>Incoming</th></tr></thead><tbody>' + rows + '</tbody></table>';
    };
    return sectionHtml("Customers", "customer") +
      sectionHtml("Orders", "order") +
      sectionHtml("Source POs", "source_po") +
      sectionHtml("Suppliers", "supplier") +
      sectionHtml("Parts", "part") +
      sectionHtml("Customer parts", "customer_part");
  }

  let lastMasterCy = null;
  async function renderMasterDataGraph(graph, layoutName) {
    const container = byId("ops-master-graph-canvas");
    if (!container) return;
    container.innerHTML = "";
    container.style.height = "520px";
    const cy = await loadCytoscape();
    const layout = (layoutName || (byId("ops-master-layout") && byId("ops-master-layout").value) || "cose").trim();
    try { await ensureLayoutAvailable(layout); }
    catch (e) { notifyWarn("Layout " + layout + " unavailable, falling back to cose: " + e.message); }
    const colors = { customer: "#1d4ed8", order: "#7c2d12", source_po: "#0e7490", supplier: "#15803d", part: "#9a3412", customer_part: "#a16207" };
    const elements = [].concat(
      graph.nodes.map((n) => ({ data: { id: n.id, label: n.label || n.id, type: n.type } })),
      graph.edges.map((e, i) => ({ data: { id: "e" + i, source: e.source, target: e.target, kind: e.kind } }))
    );
    lastMasterCy = cy({
      container,
      elements,
      style: [
        { selector: "node", style: { "label": "data(label)", "background-color": "#9a3412", "color": "#fff", "text-valign": "center", "text-halign": "center", "font-size": "10px", "width": 36, "height": 36 } },
        ...Object.entries(colors).map(([type, color]) => ({ selector: "node[type = '" + type + "']", style: { "background-color": color } })),
        { selector: "edge", style: { "curve-style": "bezier", "line-color": "#a8a29e", "target-arrow-color": "#a8a29e", "target-arrow-shape": "triangle", "label": "data(kind)", "font-size": "9px", "color": "#78716c" } },
      ],
      layout: buildLayoutConfig(layout),
    });
  }

  function applyMasterLayout(layoutName) {
    if (lastMasterGraph) renderMasterDataGraph(lastMasterGraph, layoutName);
  }

  async function showMasterDataTab(view) {
    const cfg = (window.ObaraBackend && window.ObaraBackend.getConfig && window.ObaraBackend.getConfig()) || {};
    if (!cfg.url) { notifyWarn("Backend not connected. Master data needs the API."); showBackendModal(); return; }
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<div class="ops-actions" style="margin-bottom:8px">' +
      '<button class="btn btn-ghost ops-format-mini" data-master-view="table">Table view</button>' +
      '<button class="btn btn-ghost ops-format-mini" data-master-view="graph">Graph view</button>' +
      '<select id="ops-master-layout" title="Graph layout">' +
        ['cose','cose-bilkent','breadthfirst','concentric','grid','circle','dagre','klay'].map((n) => '<option value="' + n + '"' + (n === 'cose' ? ' selected' : '') + '>' + n + '</option>').join("") +
      '</select>' +
      '<input id="ops-master-customer" placeholder="Filter by customer id (optional)" style="margin-left:8px"/>' +
      '<input id="ops-master-part" placeholder="Filter by part no (optional)"/>' +
      '<button class="btn btn-primary ops-format-mini" id="ops-master-refresh">Refresh</button>' +
      '</div>' +
      '<div id="ops-master-summary" style="font-size:11px;color:var(--text-muted)"></div>' +
      '<div id="ops-master-table"></div>' +
      '<div id="ops-master-graph-canvas" style="display:none;border:1px solid var(--border);border-radius:8px;background:var(--bg);margin-top:8px"></div>' +
      '</div>';
    showOpsModal("Master Data Graph", html);
    const setView = (mode) => {
      const tableEl = byId("ops-master-table");
      const graphEl = byId("ops-master-graph-canvas");
      if (mode === "graph") {
        if (tableEl) tableEl.style.display = "none";
        if (graphEl) graphEl.style.display = "block";
        if (lastMasterGraph) renderMasterDataGraph(lastMasterGraph);
      } else {
        if (tableEl) tableEl.style.display = "block";
        if (graphEl) graphEl.style.display = "none";
      }
      document.querySelectorAll("[data-master-view]").forEach((btn) => btn.classList.toggle("btn-primary", btn.getAttribute("data-master-view") === mode));
    };
    const fetchAndRender = async () => {
      const customerId = (byId("ops-master-customer") || {}).value || "";
      const partNo = (byId("ops-master-part") || {}).value || "";
      const summaryEl = byId("ops-master-summary");
      if (summaryEl) summaryEl.textContent = "Loading...";
      try {
        const result = await window.ObaraBackend.masterData.graph({ customerId, partNo, depth: 2 });
        lastMasterGraph = result;
        if (summaryEl) summaryEl.textContent = (result.summary && (result.summary.nodes + " nodes, " + result.summary.edges + " edges")) || "ok";
        const tableEl = byId("ops-master-table");
        if (tableEl) setOpsHtml(tableEl, renderMasterDataTable(result));
      } catch (err) {
        if (summaryEl) summaryEl.textContent = "Failed: " + err.message;
        notifyError(err.message);
      }
    };
    setTimeout(() => {
      document.querySelectorAll("[data-master-view]").forEach((btn) => btn.addEventListener("click", () => setView(btn.getAttribute("data-master-view"))));
      const refresh = byId("ops-master-refresh");
      if (refresh) refresh.addEventListener("click", fetchAndRender);
      const layoutSel = byId("ops-master-layout");
      if (layoutSel) layoutSel.addEventListener("change", () => applyMasterLayout(layoutSel.value));
      setView(view || "table");
      fetchAndRender();
    }, 0);
  }

  // ── CUSTOMER FORMAT PROFILE STUDIO (item #5) ──
  async function showProfileStudio(customerKey) {
    if (!window.ObaraBackend || !window.ObaraBackend.isReady()) {
      notifyWarn("Studio needs the backend connected to access profile versions.");
      showBackendModal();
      return;
    }
    const formats = readJsonKey("so_agent:customer_formats", {});
    const local = customerKey ? formats[customerKey] : null;
    let customers = [];
    try { const list = await window.ObaraBackend.customers.list(); customers = list.customers || []; }
    catch (err) { notifyError("Customer list failed: " + err.message); return; }
    const remote = customerKey
      ? customers.find((c) => c.customer_key === customerKey)
      : (customers[0] || null);
    if (!remote) {
      notifyWarn("Customer not found on backend. Sync with /api/customers first.");
      return;
    }
    let versions = [];
    try { const v = await window.ObaraBackend.profileVersions.list(remote.id); versions = v.versions || []; }
    catch (err) { notifyWarn("Could not load versions: " + err.message); }
    const fingerprint = local && local.fingerprint || {};
    const forceFallback = !!(remote.profile && remote.profile.force_llm_fallback) || !!(local && local.forceLlmFallback);
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<h3 style="font-size:14px;font-weight:800">' + escText(remote.customer_name || remote.customer_key) + '</h3>' +
      '<p class="text-[11px]" style="color:var(--text-muted)">GSTIN ' + escText(remote.gstin || "n/a") + ' · key ' + escText(remote.customer_key) + '</p>' +
      '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:10px">' +
      '<div class="card"><h4 style="font-size:12px;font-weight:800">Current fingerprint</h4>' +
      '<textarea id="ops-studio-fingerprint" rows="10" style="font-family:monospace;width:100%">' + escText(JSON.stringify(fingerprint, null, 2)) + '</textarea>' +
      '<label style="display:block;margin-top:6px;font-size:11px"><input type="checkbox" id="ops-studio-force-llm"' + (forceFallback ? " checked" : "") + '/> Force Claude fallback for this customer</label>' +
      '<div class="ops-actions" style="margin-top:6px">' +
      '<button class="btn btn-primary ops-format-mini" id="ops-studio-save">Save as new version</button>' +
      '<button class="btn btn-ghost ops-format-mini" id="ops-studio-dry">Run template dry run</button>' +
      '</div>' +
      '</div>' +
      '<div class="card"><h4 style="font-size:12px;font-weight:800">Version history</h4>' +
      '<div id="ops-studio-versions" style="max-height:280px;overflow:auto"></div></div>' +
      '<div class="card"><h4 style="font-size:12px;font-weight:800">Golden test docs</h4>' +
      '<input type="file" id="ops-studio-golden" accept=".pdf,.png,.jpg,.jpeg,.xlsx" />' +
      '<div class="text-[11px]" style="color:var(--text-muted);margin-top:4px">Uploads attach to the next saved version. Files go to private storage.</div>' +
      '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">' +
      '<label style="font-size:11px;font-weight:700">Compare new PO to last format</label>' +
      '<input type="file" id="ops-studio-compare" accept=".pdf,.png,.jpg,.jpeg" style="margin-top:4px"/>' +
      '<div id="ops-studio-compare-out" class="text-[11px]" style="color:var(--text-muted);margin-top:4px"></div>' +
      '</div>' +
      '</div>' +
      '<div class="card"><h4 style="font-size:12px;font-weight:800">Drift comparison</h4>' +
      '<div id="ops-studio-drift" class="text-xs" style="color:var(--text-muted)">Save a new version to compare.</div></div>' +
      '</div>' +
      '<div id="ops-studio-status" style="margin-top:10px;font-size:12px;color:var(--text-muted)"></div>' +
      '<div id="ops-studio-dry-out" style="margin-top:8px"></div>' +
      '</div>';
    showOpsModal("Customer Format Profile Studio", html);
    const renderVersions = () => {
      const el = byId("ops-studio-versions");
      if (!el) return;
      if (!versions.length) { setOpsHtml(el, '<p class="text-[11px]" style="color:var(--text-muted)">No saved versions yet.</p>'); return; }
      const rows = versions.map((v) => '<div style="border-bottom:1px solid var(--border);padding:6px 0">' +
        '<div style="display:flex;justify-content:space-between;gap:8px"><strong>v' + v.version + '</strong> <span class="text-[11px]" style="color:var(--text-muted)">' + escText((v.created_at || "").slice(0, 16).replace("T", " ")) + '</span></div>' +
        '<div class="text-[11px]" style="color:var(--text-muted)">' + escText(v.notes || "") + '</div>' +
        '<button class="btn btn-ghost ops-format-mini" data-rollback-version="' + v.id + '">Roll back</button>' +
        '</div>').join("");
      setOpsHtml(el, rows);
      el.querySelectorAll("[data-rollback-version]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Roll back this customer to version " + btn.getAttribute("data-rollback-version") + "?")) return;
          try {
            await window.ObaraBackend.profileVersions.rollback(btn.getAttribute("data-rollback-version"));
            notifySuccess("Rolled back. Reload the SO agent customers tab to refresh.");
          } catch (err) { notifyError(err.message); }
        });
      });
    };
    const renderDrift = () => {
      const el = byId("ops-studio-drift");
      if (!el) return;
      if (versions.length < 2) {
        setOpsHtml(el, '<p class="text-[11px]" style="color:var(--text-muted)">Need at least two versions to show drift.</p>');
        return;
      }
      const current = versions[0] && versions[0].fingerprint || {};
      const prior = versions[1] && versions[1].fingerprint || {};
      const keys = new Set([...Object.keys(current), ...Object.keys(prior)]);
      const items = [];
      keys.forEach((k) => {
        const a = JSON.stringify(current[k] || null);
        const b = JSON.stringify(prior[k] || null);
        if (a === b) return;
        let color = "#92400e", bg = "#fef3c7";
        if (current[k] === undefined) { color = "#991b1b"; bg = "#fee2e2"; }
        else if (prior[k] === undefined) { color = "#065f46"; bg = "#d1fae5"; }
        items.push('<div style="background:' + bg + ';color:' + color + ';padding:4px 6px;border-radius:4px;margin:2px 0;font-size:11px"><strong>' + escText(k) + '</strong>: ' + escText(b) + ' &rarr; ' + escText(a) + '</div>');
      });
      if (!items.length) { setOpsHtml(el, '<p class="text-[11px]" style="color:var(--text-muted)">No drift between v' + versions[1].version + ' and v' + versions[0].version + '.</p>'); return; }
      setOpsHtml(el, '<p class="text-[11px]" style="color:var(--text-muted)">v' + versions[1].version + ' &rarr; v' + versions[0].version + '</p>' + items.join(""));
    };
    renderVersions();
    renderDrift();
    setTimeout(() => {
      const saveBtn = byId("ops-studio-save");
      if (saveBtn) saveBtn.addEventListener("click", async () => {
        const status = byId("ops-studio-status");
        const text = (byId("ops-studio-fingerprint") || {}).value || "{}";
        const forceLlm = !!(byId("ops-studio-force-llm") && byId("ops-studio-force-llm").checked);
        try {
          const parsed = JSON.parse(text);
          await window.ObaraBackend.customers.upsert({
            customer_key: remote.customer_key,
            customer_name: remote.customer_name,
            gstin: remote.gstin,
            profile: {
              fingerprint: parsed,
              orders_processed: local && local.ordersProcessed || 0,
              trusted: !!(local && local.trusted),
              learned_rules: local && local.learnedRules || {},
              force_llm_fallback: forceLlm,
            },
          });
          if (status) status.textContent = "Saved. The SO agent will pick up the new fingerprint on next reload.";
          notifySuccess("Profile saved");
          const refreshed = await window.ObaraBackend.profileVersions.list(remote.id);
          versions = refreshed.versions || [];
          renderVersions();
          renderDrift();
        } catch (err) {
          if (status) status.textContent = "Save failed: " + err.message;
          notifyError(err.message);
        }
      });
      const golden = byId("ops-studio-golden");
      if (golden) golden.addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const meta = await window.ObaraBackend.documents.upload(file, "golden_example");
          const docId = meta && (meta.documentId || meta.id);
          // Persist the document id onto the customer profile so dry-run can find it.
          const existing = (remote.profile && remote.profile.golden_examples) || [];
          const next = docId ? Array.from(new Set([...existing, docId])) : existing;
          await window.ObaraBackend.customers.upsert({
            customer_key: remote.customer_key,
            customer_name: remote.customer_name,
            gstin: remote.gstin,
            profile: {
              fingerprint: (local && local.fingerprint) || (remote.profile && remote.profile.fingerprint) || {},
              orders_processed: (local && local.ordersProcessed) || 0,
              trusted: !!(local && local.trusted),
              learned_rules: (local && local.learnedRules) || {},
              force_llm_fallback: !!(remote.profile && remote.profile.force_llm_fallback),
              golden_examples: next,
            },
          });
          remote.profile = remote.profile || {};
          remote.profile.golden_examples = next;
          notifySuccess("Golden example uploaded and attached to profile (" + next.length + " on file).");
        } catch (err) { notifyError(err.message); }
      });
      const compare = byId("ops-studio-compare");
      if (compare) compare.addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const out = byId("ops-studio-compare-out");
        if (out) out.textContent = "Uploading and OCR running...";
        try {
          const meta = await window.ObaraBackend.documents.upload(file, "purchase_order");
          const ocrResult = await window.ObaraBackend.ocr.run(meta.documentId);
          const detectedKeys = (ocrResult && ocrResult.fingerprint && Object.keys(ocrResult.fingerprint)) || [];
          const currentKeys = Object.keys(fingerprint);
          const overlap = detectedKeys.filter((k) => currentKeys.includes(k)).length;
          const score = currentKeys.length ? Math.round((overlap / currentKeys.length) * 100) : 0;
          let verdict = "Drifted";
          if (score >= 90) verdict = "Matches current";
          else if (versions.length > 1 && score >= 60) verdict = "Closer to v" + (versions[1].version || "prior");
          if (out) out.textContent = verdict + " (overlap " + score + "%, " + detectedKeys.length + " keys detected).";
        } catch (err) {
          if (out) out.textContent = "Compare failed: " + err.message;
        }
      });
      const dryBtn = byId("ops-studio-dry");
      if (dryBtn) dryBtn.addEventListener("click", async () => {
        const out = byId("ops-studio-dry-out");
        const goldenList = (remote.profile && remote.profile.golden_examples) || [];
        if (!goldenList.length) {
          if (out) setOpsHtml(out, '<p class="text-[11px]" style="color:var(--text-muted)">No golden examples attached. Upload one above first.</p>');
          return;
        }
        if (out) setOpsHtml(out, "Running template dry run...");
        try {
          const docId = goldenList[goldenList.length - 1];
          const ocrResult = await window.ObaraBackend.ocr.run(docId);
          const fields = (ocrResult && ocrResult.extractedFields) || {};
          const expected = (local && local.expectedFields) || Object.keys(fingerprint);
          const rows = expected.map((k) => {
            const got = fields[k];
            const ok = got != null && got !== "";
            return '<tr><td>' + escText(k) + '</td><td><span class="ops-pill" style="background:' + (ok ? "#d1fae5" : "#fee2e2") + ';color:' + (ok ? "#065f46" : "#991b1b") + '">' + (ok ? "PASS" : "FAIL") + '</span></td><td>' + escText(String(got || "")) + '</td></tr>';
          }).join("");
          if (out) setOpsHtml(out, '<table><thead><tr><th>Field</th><th>Result</th><th>Value</th></tr></thead><tbody>' + rows + '</tbody></table>');
        } catch (err) {
          if (out) setOpsHtml(out, '<p style="color:var(--err)">' + escText(err.message) + '</p>');
        }
      });
    }, 0);
  }

  function showRoleQueues() {
    const orders = localOrders();
    const role = localStorage.getItem("obara:role") || "sales_engineer";
    const ownerByRole = {
      sales_engineer: ["sales_engineer"],
      sales_manager: ["sales_manager"],
      procurement: ["procurement"],
      finance: ["finance"],
      admin: ["sales_engineer", "sales_manager", "procurement", "finance", "admin"],
      explore: ["sales_engineer", "sales_manager", "procurement", "finance", "admin"],
    };
    const owners = ownerByRole[role] || ["sales_engineer"];
    const filtered = orders.filter((o) => {
      if (!o) return false;
      if (o.status === "PENDING_REVIEW") return true;
      const findings = (o.ruleFindings || []).filter((f) => f && owners.includes(f.owner));
      return findings.length > 0;
    });
    const rows = filtered.length
      ? filtered.slice(0, 30).map((o) => {
          const findings = (o.ruleFindings || []).filter((f) => f && owners.includes(f.owner));
          const ageDays = o.createdAt ? Math.round((Date.now() - new Date(o.createdAt).getTime()) / 86400000) : 0;
          const codeSummary = findings.map((f) => f.code).slice(0, 3).join(", ") || o.status;
          return '<tr><td>' + escText(o.preflightPONumber || o.id) + '</td><td>' + escText(o.preflightCustomer || "") + '</td><td>' + ageDays + 'd</td><td>' + escText(codeSummary) + '</td><td><button class="btn btn-ghost ops-format-mini" onclick="showCommunicationTimelineFor(\\'' + o.id + '\\')">Timeline</button></td></tr>';
        }).join("")
      : '<tr><td colspan="5" style="color:var(--text-muted)">Nothing on your queue. Either everything is approved or no findings match your role.</td></tr>';
    const html = '<div class="ops-modal-body"><p>Filtered for role <strong>' + escText(role) + '</strong>. Switch role via the Choose Role command.</p><table><thead><tr><th>PO</th><th>Customer</th><th>Age</th><th>Issues</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    showOpsModal("My Queue", html);
  }

  function showAuditLogModal() {
    const log = readJsonKey("so_agent:audit_log", []);
    const filterId = "ops-audit-filter";
    const html = '<div class="ops-modal-body">' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">' +
      '<input id="' + filterId + '" placeholder="Filter by action or detail..." style="flex:1;min-width:180px" oninput="renderAuditLogTable()"/>' +
      '<button class="btn btn-ghost" onclick="exportAuditLogCsv()">Export CSV</button>' +
      '<button class="btn btn-ghost" onclick="exportAuditLogJson()">Export JSON</button>' +
      '</div>' +
      '<div id="ops-audit-table"></div>' +
      '<p style="color:var(--text-muted);font-size:11px;margin-top:6px">Showing newest 200 entries. Audit log holds up to 500 entries before older ones rotate out.</p>' +
      '</div>';
    showOpsModal("Audit Log", html);
    renderAuditLogTable();
  }
  function renderAuditLogTable() {
    const el = byId("ops-audit-table");
    if (!el) return;
    const filterEl = byId("ops-audit-filter");
    const q = filterEl ? String(filterEl.value || "").toLowerCase() : "";
    const log = readJsonKey("so_agent:audit_log", []);
    const filtered = log.filter((a) => {
      if (!q) return true;
      const hay = ((a.action || "") + " " + (a.detail || "") + " " + (a.refId || "")).toLowerCase();
      return hay.includes(q);
    }).slice(0, 200);
    if (!filtered.length) {
      setOpsHtml(el, '<p style="color:var(--text-muted)">' + (log.length ? "No matches for that filter." : "No audit entries yet.") + '</p>');
      return;
    }
    const rows = filtered.map((a) => '<tr><td style="font-family:monospace">' + escText(((a.at || "")).slice(0, 19).replace("T", " ")) + '</td><td><strong>' + escText(a.action) + '</strong></td><td>' + escText(a.detail || "") + '</td></tr>').join("");
    setOpsHtml(el, '<table><thead><tr><th>When</th><th>Action</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table>');
  }

  // ── BACKEND CONNECTION ──
  function showBackendModal() {
    const cfg = (window.ObaraBackend && window.ObaraBackend.getConfig && window.ObaraBackend.getConfig()) || {};
    const session = (window.ObaraBackend && window.ObaraBackend.getSession && window.ObaraBackend.getSession()) || {};
    const profile = readJsonKey("obara:auth_profile", null);
    const tabBtn = (id, label) => '<button class="btn btn-ghost ops-format-mini" data-auth-tab="' + id + '">' + label + '</button>';
    const profileBlock = profile && profile.user ? '<div class="p-2 bg-emerald-50 border border-emerald-200 rounded-xl text-xs"><strong>Signed in as ' + escText(profile.user.email || profile.user.id) + '</strong>' + (profile.memberships ? ' &middot; ' + profile.memberships.length + ' tenant(s)' : '') + ' <button id="ops-backend-signout" class="btn btn-ghost ops-format-mini" style="margin-left:8px">Sign out</button></div>' : '';
    const html = '<div class="ops-modal-body">' +
      '<p>Connect to the Vercel + Supabase backend. Sales engineers and managers should use the magic link. Dev token is for headless testing.</p>' +
      '<label class="text-xs font-bold">Backend URL <input id="ops-backend-url" placeholder="https://obara-ops.vercel.app" value="' + escText(cfg.url || "") + '" /></label>' +
      '<label class="text-xs font-bold">Tenant ID <input id="ops-backend-tenant" placeholder="00000000-0000-0000-0000-000000000001" value="' + escText(cfg.tenantId || "") + '" /></label>' +
      profileBlock +
      '<div class="ops-actions" style="margin-top:8px;gap:6px">' +
      tabBtn("magic", "Magic link") +
      tabBtn("dev", "Dev token") +
      '</div>' +
      '<div id="ops-auth-magic" class="ops-auth-pane">' +
      '<label class="text-xs font-bold mt-2">Email <input id="ops-auth-email" type="email" placeholder="you@example.com" /></label>' +
      '<div class="ops-actions" style="margin-top:8px"><button class="btn btn-primary" id="ops-auth-send">Send magic link</button></div>' +
      '<p class="text-[11px] text-slate-500 mt-2">Click the link in the email. Your browser opens auth/callback.html which stashes the session in this app via localStorage.</p>' +
      '</div>' +
      '<div id="ops-auth-dev" class="ops-auth-pane" style="display:none">' +
      '<label class="text-xs font-bold mt-2">Access token <textarea id="ops-backend-token" rows="3" placeholder="Paste a Supabase access token">' + escText(session.access_token || "") + '</textarea></label>' +
      '<div class="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mt-1">Dev only. Production users sign in via magic link.</div>' +
      '</div>' +
      '<div class="ops-actions" style="margin-top:12px">' +
      '<button class="btn btn-primary" id="ops-backend-save">Save and test</button>' +
      '<button class="btn btn-ghost" id="ops-backend-clear">Disconnect</button>' +
      '</div>' +
      '<div id="ops-backend-status" style="margin-top:10px;font-size:12px;color:var(--text-muted)"></div>' +
      '</div>';
    showOpsModal("Backend Connection", html);
    setTimeout(() => {
      const saveBtn = byId("ops-backend-save");
      const clearBtn = byId("ops-backend-clear");
      const sendBtn = byId("ops-auth-send");
      const signoutBtn = byId("ops-backend-signout");
      const setActiveTab = (id) => {
        document.querySelectorAll(".ops-auth-pane").forEach((pane) => { pane.style.display = pane.id === "ops-auth-" + id ? "block" : "none"; });
        document.querySelectorAll("[data-auth-tab]").forEach((btn) => { btn.classList.toggle("btn-primary", btn.getAttribute("data-auth-tab") === id); });
      };
      document.querySelectorAll("[data-auth-tab]").forEach((btn) => {
        btn.addEventListener("click", () => setActiveTab(btn.getAttribute("data-auth-tab")));
      });
      setActiveTab("magic");
      if (saveBtn) saveBtn.addEventListener("click", async () => {
        const url = (byId("ops-backend-url") || {}).value || "";
        const tenant = (byId("ops-backend-tenant") || {}).value || "";
        const token = (byId("ops-backend-token") || {}).value || "";
        if (!url) { notifyError("Backend URL required"); return; }
        window.ObaraBackend.setConfig({ url: url.trim(), tenantId: tenant.trim() || null });
        const statusEl = byId("ops-backend-status");
        if (token) {
          window.ObaraBackend.setSession({ access_token: token.trim() });
          if (statusEl) statusEl.textContent = "Verifying token...";
          try {
            const verified = await window.ObaraBackend.auth.verifyToken(token.trim());
            localStorage.setItem("obara:auth_profile", JSON.stringify(verified));
            if (statusEl) statusEl.textContent = "Signed in as " + (verified.user && verified.user.email || verified.user && verified.user.id);
            notifySuccess("Backend connected");
          } catch (err) {
            if (statusEl) statusEl.textContent = "Verify failed: " + err.message;
            notifyError("Token verify failed: " + err.message);
          }
        } else {
          if (statusEl) statusEl.textContent = "Testing connection...";
          try { await window.ObaraBackend.ping(); if (statusEl) statusEl.textContent = "Anonymous mode connected."; notifySuccess("Backend connected"); }
          catch (err) { if (statusEl) statusEl.textContent = "Failed: " + err.message; notifyError("Ping failed: " + err.message); }
        }
      });
      if (clearBtn) clearBtn.addEventListener("click", () => {
        window.ObaraBackend.setConfig(null);
        window.ObaraBackend.setSession(null);
        localStorage.removeItem("obara:auth_profile");
        notify("Backend disconnected. Falling back to local storage.");
        closeOpsModal();
      });
      if (sendBtn) sendBtn.addEventListener("click", async () => {
        const email = (byId("ops-auth-email") || {}).value || "";
        const url = (byId("ops-backend-url") || {}).value || "";
        const tenant = (byId("ops-backend-tenant") || {}).value || "";
        if (!email) { notifyError("Email required"); return; }
        if (!url) { notifyError("Set backend URL first"); return; }
        window.ObaraBackend.setConfig({ url: url.trim(), tenantId: tenant.trim() || null });
        const statusEl = byId("ops-backend-status");
        if (statusEl) statusEl.textContent = "Sending magic link...";
        try {
          await window.ObaraBackend.auth.requestMagicLink(email.trim(), url.trim().replace(/\\/+$/, "") + "/auth/callback.html");
          if (statusEl) statusEl.textContent = "Magic link sent to " + email.trim() + ". Check your inbox.";
          notifySuccess("Magic link sent");
        } catch (err) {
          if (statusEl) statusEl.textContent = "Magic link failed: " + err.message;
          notifyError(err.message);
        }
      });
      if (signoutBtn) signoutBtn.addEventListener("click", () => {
        window.ObaraBackend.setSession(null);
        localStorage.removeItem("obara:auth_profile");
        notify("Signed out");
        showBackendModal();
      });
    }, 0);
  }

  function showAliasManager() {
    if (!window.ObaraBackend || !window.ObaraBackend.isReady()) {
      notifyWarn("Backend not connected. Configure it first via Backend Connection.");
      showBackendModal();
      return;
    }
    const html = '<div class="ops-modal-body">' +
      '<p>Customer part aliases let the SO agent map customer-specific part numbers to your Obara/Tally part numbers without re-asking the model. New aliases captured during reviews appear here.</p>' +
      '<div id="ops-alias-table">Loading...</div>' +
      '</div>';
    showOpsModal("Customer Part Aliases", html);
    window.ObaraBackend.aliases.list().then(({ aliases }) => {
      const el = byId("ops-alias-table");
      if (!el) return;
      if (!aliases || !aliases.length) { setOpsHtml(el, '<p style="color:var(--text-muted)">No aliases stored yet.</p>'); return; }
      const rows = aliases.map((a) => '<tr><td style="font-family:monospace">' + escText(a.customer_part_no) + '</td><td>' + escText(a.customer_description || "") + '</td><td style="font-family:monospace">' + escText(a.obara_part_no) + '</td><td>' + escText(a.status) + '</td><td>' + escText(((a.last_seen_po || a.first_seen_po) || "")) + '</td></tr>').join("");
      setOpsHtml(el, '<table><thead><tr><th>Customer P/N</th><th>Description</th><th>Obara P/N</th><th>Status</th><th>Last seen</th></tr></thead><tbody>' + rows + '</tbody></table>');
    }).catch((err) => {
      const el = byId("ops-alias-table");
      if (el) setOpsHtml(el, '<p style="color:var(--err)">Failed: ' + escText(err.message) + '</p>');
    });
  }

  function showTallyMasterImport() {
    if (!window.ObaraBackend || !window.ObaraBackend.isReady()) {
      notifyWarn("Backend not connected. Configure it first via Backend Connection.");
      showBackendModal();
      return;
    }
    const html = '<div class="ops-modal-body">' +
      '<p>Drop a CSV/TSV/XLSX export of your Tally masters here so the SO agent can validate stock items, ledgers, GST ledgers, and UOMs before export. The first column should be the master name.</p>' +
      '<label class="text-xs font-bold">Master type <select id="ops-tally-master-type"><option value="stock_item">Stock items</option><option value="ledger">Ledgers</option><option value="gst_ledger">GST ledgers</option><option value="uom">UOMs</option><option value="voucher_type">Voucher types</option></select></label>' +
      '<label class="text-xs font-bold mt-3"><input type="file" id="ops-tally-master-file" accept=".csv,.tsv,.txt,.xlsx,.xls"/></label>' +
      '<label class="text-xs font-bold"><input id="ops-tally-master-replace" type="checkbox"/> Replace existing entries of this type</label>' +
      '<div class="ops-actions" style="margin-top:12px">' +
      '<button class="btn btn-primary" id="ops-tally-master-upload">Upload</button>' +
      '</div>' +
      '<div id="ops-tally-master-status" style="margin-top:10px;font-size:12px;color:var(--text-muted)"></div>' +
      '</div>';
    showOpsModal("Tally Master Sync", html);
    setTimeout(() => {
      const btn = byId("ops-tally-master-upload");
      if (!btn) return;
      btn.addEventListener("click", async () => {
        const fileInput = byId("ops-tally-master-file");
        const file = fileInput && fileInput.files && fileInput.files[0];
        if (!file) { notifyError("Pick a file first"); return; }
        const masterType = (byId("ops-tally-master-type") || {}).value || "stock_item";
        const replace = !!(byId("ops-tally-master-replace") || {}).checked;
        const status = byId("ops-tally-master-status");
        if (status) status.textContent = "Reading file...";
        try {
          const ext = (file.name.split(".").pop() || "").toLowerCase();
          let rows = [];
          if (ext === "csv" || ext === "tsv" || ext === "txt") {
            const text = await file.text();
            const delim = ext === "tsv" ? "\\t" : detectDelimiter(text.split(/\\r?\\n/)[0] || "");
            rows = text.split(/\\r?\\n/).map((line) => line.split(delim));
          } else if (window.XLSX) {
            const buf = await file.arrayBuffer();
            const wb = XLSX.read(buf, { type: "array" });
            rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
          } else {
            throw new Error("XLSX library not loaded");
          }
          if (rows.length && Array.isArray(rows[0]) && rows[0].length && /name/i.test(String(rows[0][0]))) rows = rows.slice(1);
          const records = rows.map((r) => ({ name: String(r[0] || "").trim(), payload: r.length > 1 ? { row: r.slice(1) } : {} })).filter((r) => r.name);
          if (status) status.textContent = "Uploading " + records.length + " rows...";
          const result = await window.ObaraBackend.tally.syncMasters(masterType, records, replace);
          if (status) status.textContent = "Synced " + result.count + " " + masterType + " records.";
          notifySuccess("Tally masters synced: " + result.count);
        } catch (err) {
          if (status) status.textContent = "Failed: " + err.message;
          notifyError(err.message);
        }
      });
    }, 0);
  }

  // ── SOURCE PO PROCUREMENT ──
  function fmtDate(s) { return s ? String(s).slice(0, 10) : ""; }
  function fmtNum(n, d = 2) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(d) : ""; }
  function ensureBackend() {
    if (!window.ObaraBackend || !window.ObaraBackend.isReady()) {
      notifyWarn("Backend not connected. Configure it via Backend Connection.");
      showBackendModal();
      return false;
    }
    return true;
  }

  async function showSourcePoProcurement(initialId) {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body">' +
      '<div class="ops-tab-strip" id="ops-spo-tabs">' +
      '<button class="ops-tab-btn active" data-spo-tab="open">Open</button>' +
      '<button class="ops-tab-btn" data-spo-tab="awaiting">Awaiting ack</button>' +
      '<button class="ops-tab-btn" data-spo-tab="live">Live</button>' +
      '<button class="ops-tab-btn" data-spo-tab="scorecards">Scorecards</button>' +
      '</div>' +
      '<div id="ops-spo-body" style="margin-top:12px">Loading...</div>' +
      '</div>';
    showOpsModal("Source PO Procurement", html);
    setTimeout(() => {
      const tabs = document.querySelectorAll('#ops-spo-tabs [data-spo-tab]');
      tabs.forEach((t) => t.addEventListener("click", () => {
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        loadSourcePoTab(t.getAttribute("data-spo-tab"));
      }));
      loadSourcePoTab(initialId ? "live" : "open");
    }, 0);
  }

  async function loadSourcePoTab(tab) {
    const body = byId("ops-spo-body");
    if (!body) return;
    setOpsHtml(body, "Loading...");
    try {
      if (tab === "scorecards") {
        const res = await window.ObaraBackend.sourcePos.scorecard();
        const rows = (res.scorecards || []).map((s) =>
          '<tr><td>' + escText(s.supplier || "") + '</td><td>' + escText(s.country || "") + '</td>' +
          '<td style="text-align:right">' + fmtNum(s.on_time_pct) + '%</td>' +
          '<td style="text-align:right">' + fmtNum(s.price_accuracy_pct) + '%</td>' +
          '<td style="text-align:right">' + (s.total_pos || 0) + '</td></tr>'
        ).join("");
        setOpsHtml(body, '<table><thead><tr><th>Supplier</th><th>Country</th><th>On-time %</th><th>Price accuracy %</th><th>Total POs</th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="5" style="color:var(--text-muted)">No scorecards yet.</td></tr>') + '</tbody></table>');
        return;
      }
      const filter = tab === "open" ? "DRAFT,PENDING_INTERNAL_APPROVAL,SENT_TO_SUPPLIER" :
                     tab === "awaiting" ? "SENT_TO_SUPPLIER" :
                     "SUPPLIER_ACK,ETA_CONFIRMED,DELAYED,PRICE_CHANGED,RECEIVED";
      const res = await window.ObaraBackend.sourcePos.list({ status: filter, limit: 200 });
      const items = res.sourcePos || [];
      if (!items.length) { setOpsHtml(body, '<p style="color:var(--text-muted)">No source POs in this state.</p>'); return; }
      const rows = items.map((spo) => {
        const seller = (spo.payload && spo.payload.seller && spo.payload.seller.name) || spo.supplier || "?";
        const country = (spo.payload && spo.payload.seller && spo.payload.seller.country) || spo.country || "";
        const eta = spo.expected_delivery_date || (spo.payload && spo.payload.expectedDeliveryDate) || "";
        const action = tab === "awaiting" || tab === "open" ?
          '<button class="btn btn-ghost ops-spo-ack" data-id="' + escText(spo.id) + '">Record ack</button>' :
          '<button class="btn btn-ghost ops-spo-update" data-id="' + escText(spo.id) + '">Update</button>';
        return '<tr><td style="font-family:monospace">' + escText(spo.id.slice(0, 8)) + '</td>' +
          '<td>' + escText(seller) + '</td><td>' + escText(country) + '</td>' +
          '<td>' + escText(fmtDate(eta)) + '</td>' +
          '<td><span class="ops-pill">' + escText(spo.status) + '</span></td>' +
          '<td>' + action + '</td></tr>';
      }).join("");
      setOpsHtml(body, '<table><thead><tr><th>Id</th><th>Supplier</th><th>Country</th><th>ETA</th><th>Status</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table>');
      document.querySelectorAll(".ops-spo-ack").forEach((btn) => btn.addEventListener("click", () => openSourcePoAck(btn.getAttribute("data-id"))));
      document.querySelectorAll(".ops-spo-update").forEach((btn) => btn.addEventListener("click", () => openSourcePoUpdate(btn.getAttribute("data-id"))));
    } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">Failed: ' + escText(err.message) + '</p>'); }
  }

  function openSourcePoAck(id) {
    const html = '<div class="ops-modal-body">' +
      '<p>Record supplier acknowledgement for source PO <code>' + escText(id) + '</code>.</p>' +
      '<label>Acked unit price <input id="ops-ack-price" type="number" step="0.01"/></label>' +
      '<label>Acked ETA <input id="ops-ack-eta" type="date"/></label>' +
      '<label>Acked qty <input id="ops-ack-qty" type="number" step="1"/></label>' +
      '<label>Notes <textarea id="ops-ack-notes" rows="2"></textarea></label>' +
      '<div class="ops-actions"><button class="btn btn-primary" id="ops-ack-submit">Submit</button></div>' +
      '<div id="ops-ack-status" style="margin-top:6px;font-size:12px"></div>' +
      '</div>';
    showOpsModal("Record Acknowledgement", html);
    setTimeout(() => {
      const btn = byId("ops-ack-submit");
      if (!btn) return;
      btn.addEventListener("click", async () => {
        try {
          const ack = {
            acked_unit_price: Number(byId("ops-ack-price").value) || null,
            acked_eta_date: byId("ops-ack-eta").value || null,
            acked_qty: Number(byId("ops-ack-qty").value) || null,
            notes: byId("ops-ack-notes").value || "",
          };
          const result = await window.ObaraBackend.sourcePos.ack(id, ack);
          notifySuccess("Ack recorded. Variance " + fmtNum(result.priceVariancePct) + "%, ETA delta " + (result.etaVarianceDays || 0) + "d. Status: " + result.status);
          closeOpsModal();
          showSourcePoProcurement();
        } catch (err) {
          const status = byId("ops-ack-status");
          if (status) status.textContent = "Failed: " + err.message;
          notifyError(err.message);
        }
      });
    }, 0);
  }

  function openSourcePoUpdate(id) {
    const html = '<div class="ops-modal-body">' +
      '<p>Update source PO <code>' + escText(id) + '</code>.</p>' +
      '<label>Status <select id="ops-spo-status">' +
      ["SUPPLIER_ACK","PRICE_CHANGED","ETA_CONFIRMED","DELAYED","RECEIVED","CLOSED","CANCELLED"]
        .map((s) => '<option value="' + s + '">' + s + '</option>').join("") +
      '</select></label>' +
      '<label>Reason <textarea id="ops-spo-reason" rows="2"></textarea></label>' +
      '<div class="ops-actions"><button class="btn btn-primary" id="ops-spo-update-submit">Update</button></div>' +
      '</div>';
    showOpsModal("Update Source PO", html);
    setTimeout(() => {
      const btn = byId("ops-spo-update-submit");
      if (!btn) return;
      btn.addEventListener("click", async () => {
        try {
          await window.ObaraBackend.sourcePos.update(id, {
            status: byId("ops-spo-status").value,
            reason: byId("ops-spo-reason").value || "",
          });
          notifySuccess("Source PO updated");
          closeOpsModal();
          showSourcePoProcurement();
        } catch (err) { notifyError(err.message); }
      });
    }, 0);
  }

  // ── EVAL DASHBOARD ──
  async function showEvalDashboard() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body">' +
      '<div class="ops-tab-strip" id="ops-eval-tabs">' +
      '<button class="ops-tab-btn active" data-eval-tab="summary">Summary</button>' +
      '<button class="ops-tab-btn" data-eval-tab="fields">Field heatmap</button>' +
      '<button class="ops-tab-btn" data-eval-tab="runs">Latest runs</button>' +
      '<button class="ops-tab-btn" data-eval-tab="cases">Cases editor</button>' +
      '</div>' +
      '<div id="ops-eval-body" style="margin-top:12px">Loading...</div>' +
      '</div>';
    showOpsModal("Eval Dashboard", html);
    let cache = null;
    async function fetchCache() {
      if (cache) return cache;
      cache = await window.ObaraBackend.eval.dashboard();
      return cache;
    }
    function sparkline(values) {
      if (!values || !values.length) return "";
      const max = Math.max(...values, 1);
      const w = 160, h = 28, step = w / Math.max(values.length - 1, 1);
      const pts = values.map((v, i) => i * step + "," + (h - (v / max) * h)).join(" ");
      return '<svg width="' + w + '" height="' + h + '" style="display:block"><polyline fill="none" stroke="#0ea5e9" stroke-width="1.5" points="' + pts + '"/></svg>';
    }
    async function loadTab(tab) {
      const body = byId("ops-eval-body");
      if (!body) return;
      setOpsHtml(body, "Loading...");
      try {
        const data = await fetchCache();
        if (tab === "summary") {
          const sum = data.suiteSummary || {};
          const rows = Object.keys(sum).map((suite) => {
            const s = sum[suite];
            const passPct = s.total ? Math.round((s.pass / s.total) * 100) : 0;
            return '<tr><td><strong>' + escText(suite) + '</strong></td><td style="text-align:right">' + s.total + '</td><td style="text-align:right">' + s.pass + '</td><td style="text-align:right">' + passPct + '%</td><td>' + sparkline((data.trend && data.trend[suite]) || []) + '</td></tr>';
          }).join("");
          setOpsHtml(body, '<table><thead><tr><th>Suite</th><th>Total</th><th>Pass</th><th>Pass %</th><th>Last 30 runs</th></tr></thead><tbody>' +
            (rows || '<tr><td colspan="5" style="color:var(--text-muted)">No runs recorded.</td></tr>') + '</tbody></table>');
        } else if (tab === "fields") {
          const rows = (data.fieldStats || []).slice(0, 20).map((f) =>
            '<tr><td>' + escText(f.name || f.field) + '</td><td style="text-align:right">' + (f.fail || 0) + '</td><td style="text-align:right">' + (f.total || 0) + '</td><td style="text-align:right">' + (f.total ? Math.round((f.fail / f.total) * 100) : 0) + '%</td></tr>'
          ).join("");
          setOpsHtml(body, '<table><thead><tr><th>Field</th><th>Failures</th><th>Total</th><th>Failure rate</th></tr></thead><tbody>' +
            (rows || '<tr><td colspan="4" style="color:var(--text-muted)">No field data.</td></tr>') + '</tbody></table>');
        } else if (tab === "runs") {
          const rows = (data.runs || []).slice(0, 50).map((r) =>
            '<tr><td style="font-family:monospace">' + escText(String(r.id || "").slice(0, 8)) + '</td>' +
            '<td>' + escText(r.suite || "") + '</td>' +
            '<td>' + escText(fmtDate(r.started_at)) + '</td>' +
            '<td><span class="ops-pill">' + escText(r.status || "") + '</span></td>' +
            '<td style="text-align:right">' + (r.duration_ms || 0) + 'ms</td></tr>'
          ).join("");
          setOpsHtml(body, '<table><thead><tr><th>Id</th><th>Suite</th><th>Started</th><th>Status</th><th>Duration</th></tr></thead><tbody>' +
            (rows || '<tr><td colspan="5" style="color:var(--text-muted)">No runs.</td></tr>') + '</tbody></table>');
        } else if (tab === "cases") {
          const cases = await window.ObaraBackend.eval.listCases();
          const rows = (cases.cases || []).map((c) =>
            '<tr><td>' + escText(c.suite) + '</td><td>' + escText(c.case_id) + '</td>' +
            '<td><pre style="white-space:pre-wrap;max-width:280px;font-size:11px">' + escText(JSON.stringify(c.expected || {})) + '</pre></td>' +
            '<td><button class="btn btn-ghost ops-eval-run" data-suite="' + escText(c.suite) + '" data-case="' + escText(c.case_id) + '" data-expected="' + escText(JSON.stringify(c.expected || {})) + '">Run</button>' +
            '<button class="btn btn-ghost ops-eval-del" data-id="' + escText(c.id) + '">Delete</button></td></tr>'
          ).join("");
          setOpsHtml(body, '<p class="text-[11px]" style="color:var(--text-muted)">Click Run to score a case against extracted output. Paste actual JSON when prompted.</p>' +
            '<div style="margin-bottom:8px">' +
            '<input id="ops-eval-suite" placeholder="suite" style="width:120px"/>' +
            '<input id="ops-eval-case" placeholder="case_id" style="width:160px"/>' +
            '<textarea id="ops-eval-expected" placeholder="expected json" style="width:320px;min-height:48px;font-family:monospace;font-size:11px"></textarea>' +
            '<button class="btn btn-primary" id="ops-eval-add">Add</button>' +
            '</div>' +
            '<table><thead><tr><th>Suite</th><th>Case</th><th>Expected</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>');
          document.querySelectorAll(".ops-eval-run").forEach((b) => b.addEventListener("click", async () => {
            const suite = b.getAttribute("data-suite");
            const caseId = b.getAttribute("data-case");
            const expected = JSON.parse(b.getAttribute("data-expected") || "{}");
            const actualRaw = prompt("Paste actual extraction JSON for case " + caseId + " (must match the expected schema). Leave blank to abort.");
            if (!actualRaw) return;
            try {
              const actual = JSON.parse(actualRaw);
              const out = await window.ObaraBackend.eval.run(suite, [{ id: caseId, expected, actual }]);
              const verdict = out && out.totals ? "pass=" + out.totals.pass + " fail=" + out.totals.fail + " score=" + (out.totals.score || 0).toFixed(2) : "no_score";
              notifySuccess("Eval " + caseId + ": " + verdict);
              cache = null;
              loadTab("cases");
            } catch (err) { notifyError(err.message); }
          }));
          const addBtn = byId("ops-eval-add");
          if (addBtn) addBtn.addEventListener("click", async () => {
            try {
              const expectedRaw = byId("ops-eval-expected").value || "{}";
              const expected = JSON.parse(expectedRaw);
              await window.ObaraBackend.eval.upsertCase({ suite: byId("ops-eval-suite").value, case_id: byId("ops-eval-case").value, expected });
              cache = null;
              loadTab("cases");
            } catch (err) { notifyError(err.message); }
          });
          document.querySelectorAll(".ops-eval-del").forEach((b) => b.addEventListener("click", async () => {
            try { await window.ObaraBackend.eval.deleteCase(b.getAttribute("data-id")); cache = null; loadTab("cases"); }
            catch (err) { notifyError(err.message); }
          }));
        }
      } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">Failed: ' + escText(err.message) + '</p>'); }
    }
    setTimeout(() => {
      const tabs = document.querySelectorAll('#ops-eval-tabs [data-eval-tab]');
      tabs.forEach((t) => t.addEventListener("click", () => {
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        loadTab(t.getAttribute("data-eval-tab"));
      }));
      loadTab("summary");
    }, 0);
  }

  // ── EMAIL TRIAGE ──
  async function showEmailTriage() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body">' +
      '<p>Inbound emails captured by the connector pipeline. Promote drafts to orders or request a missing document.</p>' +
      '<div id="ops-email-list" style="display:flex;gap:12px">' +
      '<div id="ops-email-left" style="flex:0 0 320px;max-height:60vh;overflow:auto">Loading...</div>' +
      '<div id="ops-email-right" style="flex:1;border-left:1px solid var(--border);padding-left:12px;color:var(--text-muted)">Select an email to view details.</div>' +
      '</div>' +
      '</div>';
    showOpsModal("Email Triage", html);
    try {
      const orders = await window.ObaraBackend.orders.list({ limit: 50 });
      const drafts = (orders.orders || []).filter((o) => o.status === "DRAFT");
      const left = byId("ops-email-left");
      if (!drafts.length) { setOpsHtml(left, '<p style="color:var(--text-muted)">No DRAFT inbound orders.</p>'); return; }
      const items = drafts.map((o) => {
        const subject = (o.preflight_payload && o.preflight_payload.email_subject) || (o.result && o.result.subject) || (o.po_number || o.id.slice(0, 8));
        const role = (o.preflight_payload && o.preflight_payload.subject_role) || "intake";
        const bundled = (o.preflight_payload && o.preflight_payload.bundled_order_id) ? '<span class="ops-pill" style="background:#dbeafe;color:#1e3a8a;margin-left:4px">Bundled</span>' : "";
        return '<div class="ops-email-row" data-order-id="' + escText(o.id) + '" style="padding:6px;border-bottom:1px solid var(--border);cursor:pointer">' +
          '<div style="font-weight:600;font-size:12px">' + escText(subject) + bundled + '</div>' +
          '<div style="color:var(--text-muted);font-size:11px">' + escText(role) + ' - ' + escText(fmtDate(o.created_at)) + '</div>' +
          '</div>';
      }).join("");
      setOpsHtml(left, items);
      document.querySelectorAll(".ops-email-row").forEach((row) => {
        row.addEventListener("click", () => loadEmailDetail(row.getAttribute("data-order-id")));
      });
    } catch (err) { notifyError(err.message); }
  }

  async function loadEmailDetail(orderId) {
    const right = byId("ops-email-right");
    if (!right) return;
    setOpsHtml(right, "Loading...");
    try {
      const result = await window.ObaraBackend.orders.get(orderId);
      const order = result && result.order;
      if (!order) { setOpsHtml(right, '<p style="color:var(--err)">Order not found.</p>'); return; }
      const subject = (order.preflight_payload && order.preflight_payload.email_subject) || order.po_number || order.id;
      const docsCount = (result.documents || []).length;
      const html = '<h3 style="margin:0 0 6px 0">' + escText(subject) + '</h3>' +
        '<div style="font-size:11px;color:var(--text-muted)">Order id: <code>' + escText(order.id) + '</code></div>' +
        '<p style="font-size:12px;margin:8px 0">Documents attached: ' + docsCount + '</p>' +
        '<div class="ops-actions">' +
        '<button class="btn btn-primary" id="ops-email-promote">Promote to order</button>' +
        '<button class="btn btn-ghost" id="ops-email-missing">Request missing doc</button>' +
        '</div>' +
        '<div id="ops-email-status" style="margin-top:8px;font-size:12px"></div>';
      setOpsHtml(right, html);
      const promote = byId("ops-email-promote");
      const missing = byId("ops-email-missing");
      if (promote) promote.addEventListener("click", async () => {
        try {
          await window.ObaraBackend.orders.update(order.id, { status: "PENDING_REVIEW" });
          notifySuccess("Order promoted to PENDING_REVIEW");
        } catch (err) { notifyError(err.message); }
      });
      if (missing) missing.addEventListener("click", async () => {
        try {
          const draft = await window.ObaraBackend.communications.missingDoc(order.id);
          showOpsModal("Missing-Doc Drafts", buildMissingDocHtml(draft.drafts || []));
          setTimeout(() => bindMissingDocActions(), 0);
        } catch (err) { notifyError(err.message); }
      });
    } catch (err) { setOpsHtml(right, '<p style="color:var(--err)">' + escText(err.message) + '</p>'); }
  }

  function buildMissingDocHtml(drafts) {
    if (!drafts.length) return '<div class="ops-modal-body"><p>Nothing missing.</p></div>';
    const rows = drafts.map((d) =>
      '<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">' +
      '<div style="font-weight:600">' + escText(d.template_code) + '</div>' +
      '<pre style="white-space:pre-wrap;font-size:12px;background:var(--bg-mute);padding:6px;border-radius:4px">' + escText(d.body || "") + '</pre>' +
      '<button class="btn btn-primary ops-missing-send" data-id="' + escText(d.id) + '">Send</button>' +
      '<button class="btn btn-ghost ops-missing-discard" data-id="' + escText(d.id) + '">Discard</button>' +
      '</div>'
    ).join("");
    return '<div class="ops-modal-body">' + rows + '</div>';
  }

  function bindMissingDocActions() {
    document.querySelectorAll(".ops-missing-send").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.communications.send(b.getAttribute("data-id")); notifySuccess("Sent"); }
      catch (err) { notifyError(err.message); }
    }));
    document.querySelectorAll(".ops-missing-discard").forEach((b) => b.addEventListener("click", () => {
      const card = b.closest("div");
      if (card) card.remove();
    }));
  }

  // ── SPARE MATRIX INTELLIGENCE ──
  async function showSpareMatrixIntelligence() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body">' +
      '<div class="ops-tab-strip" id="ops-spm-tabs">' +
      '<button class="ops-tab-btn active" data-spm-tab="recommend">Recommend</button>' +
      '<button class="ops-tab-btn" data-spm-tab="kit">Kit</button>' +
      '<button class="ops-tab-btn" data-spm-tab="opportunities">Opportunities</button>' +
      '<button class="ops-tab-btn" data-spm-tab="obsolete">Obsolete</button>' +
      '</div>' +
      '<div id="ops-spm-body" style="margin-top:12px">Loading...</div>' +
      '</div>';
    showOpsModal("Spare Matrix Intelligence", html);
    let customerCache = null;
    async function getCustomers() {
      if (customerCache) return customerCache;
      const res = await window.ObaraBackend.customers.list();
      customerCache = res.customers || [];
      return customerCache;
    }
    function customerSelect(idAttr) {
      return getCustomers().then((cs) =>
        '<select id="' + idAttr + '"><option value="">(pick customer)</option>' +
        cs.map((c) => '<option value="' + escText(c.id) + '">' + escText(c.customer_name || c.customer_key) + '</option>').join("") +
        '</select>'
      );
    }
    async function loadTab(tab) {
      const body = byId("ops-spm-body");
      if (!body) return;
      setOpsHtml(body, "Loading...");
      try {
        if (tab === "recommend") {
          const sel = await customerSelect("ops-spm-cust");
          setOpsHtml(body, '<div style="margin-bottom:8px">' + sel + '<button class="btn btn-primary" id="ops-spm-regen">Regenerate</button></div><div id="ops-spm-recs"></div>');
          byId("ops-spm-regen").addEventListener("click", async () => {
            const customerId = byId("ops-spm-cust").value;
            if (!customerId) { notifyWarn("Pick a customer first"); return; }
            try {
              const out = await window.ObaraBackend.spareMatrix.recommend({ customerId });
              const rows = (out.recommendations || []).map((r) =>
                '<tr><td>' + escText(r.part_no) + '</td><td>' + escText(r.recommended_qty || "") + '</td><td title="usage ' + (r.usage_score || 0) + ', bom ' + (r.bom_score || 0) + ', recency ' + (r.recency_score || 0) + ', lead ' + (r.lead_score || 0) + '">' + escText(r.criticality_score || 0) + '</td></tr>'
              ).join("");
              setOpsHtml(byId("ops-spm-recs"), '<table><thead><tr><th>Part</th><th>Rec qty</th><th>Score (hover for breakdown)</th></tr></thead><tbody>' +
                (rows || '<tr><td colspan="3" style="color:var(--text-muted)">No recommendations.</td></tr>') + '</tbody></table>');
            } catch (err) { notifyError(err.message); }
          });
        } else if (tab === "kit") {
          const sel = await customerSelect("ops-spm-kit-cust");
          setOpsHtml(body, '<div style="margin-bottom:8px">' + sel + '<input id="ops-spm-kit-months" type="number" value="6" style="width:60px"/> months <button class="btn btn-primary" id="ops-spm-kit-go">Build</button></div><div id="ops-spm-kit-out"></div>');
          byId("ops-spm-kit-go").addEventListener("click", async () => {
            const customerId = byId("ops-spm-kit-cust").value;
            const months = Number(byId("ops-spm-kit-months").value) || 6;
            try {
              const out = await window.ObaraBackend.spareMatrix.kit({ customerId, months });
              const rows = (out.kit || []).map((k) => '<tr><td>' + escText(k.part_no) + '</td><td>' + escText(k.target_qty) + '</td></tr>').join("");
              setOpsHtml(byId("ops-spm-kit-out"), '<table><thead><tr><th>Part</th><th>Target qty</th></tr></thead><tbody>' +
                (rows || '<tr><td colspan="2" style="color:var(--text-muted)">No kit yet.</td></tr>') + '</tbody></table>');
            } catch (err) { notifyError(err.message); }
          });
        } else if (tab === "opportunities") {
          const sel = await customerSelect("ops-spm-opp-cust");
          setOpsHtml(body, '<div style="margin-bottom:8px">' + sel + '<button class="btn btn-primary" id="ops-spm-opp-go">Find</button></div><div id="ops-spm-opp-out"></div>');
          byId("ops-spm-opp-go").addEventListener("click", async () => {
            const customerId = byId("ops-spm-opp-cust").value;
            try {
              const out = await window.ObaraBackend.spareMatrix.opportunities(customerId);
              const rows = (out.opportunities || []).map((o) => '<tr><td>' + escText(o.part_no) + '</td><td>' + escText(o.criticality_score || 0) + '</td></tr>').join("");
              setOpsHtml(byId("ops-spm-opp-out"), '<table><thead><tr><th>Part</th><th>Score</th></tr></thead><tbody>' +
                (rows || '<tr><td colspan="2" style="color:var(--text-muted)">No opportunities.</td></tr>') + '</tbody></table>');
            } catch (err) { notifyError(err.message); }
          });
        } else if (tab === "obsolete") {
          setOpsHtml(body, '<div style="margin-bottom:8px"><input id="ops-spm-obs-months" type="number" value="18" style="width:60px"/> months <button class="btn btn-primary" id="ops-spm-obs-go">Find obsolete</button></div><div id="ops-spm-obs-out"></div>');
          byId("ops-spm-obs-go").addEventListener("click", async () => {
            const months = Number(byId("ops-spm-obs-months").value) || 18;
            try {
              const out = await window.ObaraBackend.spareMatrix.obsolete(months);
              const rows = (out.obsolete || []).map((p) => '<tr><td>' + escText(p) + '</td></tr>').join("");
              setOpsHtml(byId("ops-spm-obs-out"), '<p style="color:var(--text-muted)">Threshold: ' + months + ' months. Sampled ' + (out.sampled || 0) + ' orders.</p>' +
                '<table><thead><tr><th>Part</th></tr></thead><tbody>' +
                (rows || '<tr><td style="color:var(--text-muted)">None.</td></tr>') + '</tbody></table>');
            } catch (err) { notifyError(err.message); }
          });
        }
      } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">Failed: ' + escText(err.message) + '</p>'); }
    }
    setTimeout(() => {
      const tabs = document.querySelectorAll('#ops-spm-tabs [data-spm-tab]');
      tabs.forEach((t) => t.addEventListener("click", () => {
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        loadTab(t.getAttribute("data-spm-tab"));
      }));
      loadTab("recommend");
    }, 0);
  }

  // ── SECURITY CENTER ──
  async function showSecurityCenter() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body">' +
      '<div class="ops-tab-strip" id="ops-sec-tabs">' +
      '<button class="ops-tab-btn active" data-sec-tab="redact">Redaction rules</button>' +
      '<button class="ops-tab-btn" data-sec-tab="inject">Injection tests</button>' +
      '<button class="ops-tab-btn" data-sec-tab="routing">Routing log</button>' +
      '</div>' +
      '<div id="ops-sec-body" style="margin-top:12px">Loading...</div>' +
      '</div>';
    showOpsModal("Security Center", html);
    async function loadTab(tab) {
      const body = byId("ops-sec-body");
      if (!body) return;
      setOpsHtml(body, "Loading...");
      try {
        if (tab === "redact") {
          const out = await window.ObaraBackend.security.listRedactions();
          const rows = (out.rules || []).map((r) =>
            '<tr><td>' + escText(r.name) + '</td><td><code>' + escText(r.pattern) + '</code></td>' +
            '<td>' + escText(r.replacement || "") + '</td><td>' + escText(r.scope || "") + '</td>' +
            '<td><button class="btn btn-ghost ops-sec-del" data-id="' + escText(r.id) + '">Delete</button></td></tr>'
          ).join("");
          setOpsHtml(body, '<div style="margin-bottom:8px">' +
            '<input id="ops-sec-name" placeholder="name" style="width:120px"/>' +
            '<input id="ops-sec-pattern" placeholder="regex pattern" style="width:200px"/>' +
            '<input id="ops-sec-replace" placeholder="replacement" style="width:120px"/>' +
            '<input id="ops-sec-scope" placeholder="scope" style="width:120px"/>' +
            '<button class="btn btn-primary" id="ops-sec-add">Add</button>' +
            '</div>' +
            '<table><thead><tr><th>Name</th><th>Pattern</th><th>Replacement</th><th>Scope</th><th></th></tr></thead><tbody>' +
            (rows || '<tr><td colspan="5" style="color:var(--text-muted)">No rules yet.</td></tr>') + '</tbody></table>');
          const addBtn = byId("ops-sec-add");
          if (addBtn) addBtn.addEventListener("click", async () => {
            try {
              await window.ObaraBackend.security.upsertRedaction({
                name: byId("ops-sec-name").value,
                pattern: byId("ops-sec-pattern").value,
                replacement: byId("ops-sec-replace").value,
                scope: byId("ops-sec-scope").value || "all",
              });
              loadTab("redact");
            } catch (err) { notifyError(err.message); }
          });
          document.querySelectorAll(".ops-sec-del").forEach((b) => b.addEventListener("click", async () => {
            try { await window.ObaraBackend.security.deleteRedaction(b.getAttribute("data-id")); loadTab("redact"); }
            catch (err) { notifyError(err.message); }
          }));
        } else if (tab === "inject") {
          setOpsHtml(body, '<div style="margin-bottom:8px"><button class="btn btn-primary" id="ops-sec-run">Run all injection tests</button></div><div id="ops-sec-results">Click run to start.</div>');
          byId("ops-sec-run").addEventListener("click", async () => {
            const out = byId("ops-sec-results");
            if (out) setOpsHtml(out, "Running...");
            try {
              const result = await window.ObaraBackend.security.runInjectionTest();
              const rows = (result.cases || []).map((c) =>
                '<tr><td>' + escText(c.name) + '</td>' +
                '<td><span class="ops-pill" style="background:' + (c.passed ? '#d1fae5' : '#fee2e2') + ';color:' + (c.passed ? '#065f46' : '#991b1b') + '">' + (c.passed ? "PASS" : "FAIL") + '</span></td>' +
                '<td><pre style="white-space:pre-wrap;font-size:11px;max-width:360px">' + escText((c.snippet || "").slice(0, 240)) + '</pre></td></tr>'
              ).join("");
              setOpsHtml(out, '<p style="font-size:12px">Run id: <code>' + escText(result.runId || "") + '</code></p>' +
                '<table><thead><tr><th>Case</th><th>Result</th><th>Snippet</th></tr></thead><tbody>' + rows + '</tbody></table>');
            } catch (err) { if (out) setOpsHtml(out, '<p style="color:var(--err)">' + escText(err.message) + '</p>'); }
          });
        } else if (tab === "routing") {
          try {
            const out = await window.ObaraBackend.security.routingLog(100);
            const log = (out && out.log) || [];
            const rows = log.map((r) =>
              '<tr><td>' + escText(fmtDate(r.created_at)) + '</td>' +
              '<td>' + escText(r.primary_model || "") + '</td>' +
              '<td><span class="ops-pill">' + escText(r.primary_status || "") + '</span></td>' +
              '<td>' + escText(r.primary_confidence || "") + '</td>' +
              '<td>' + escText(r.fallback_model || "") + '</td>' +
              '<td>' + escText(r.fallback_reason || "") + '</td></tr>'
            ).join("");
            setOpsHtml(body, '<table><thead><tr><th>When</th><th>Primary model</th><th>Status</th><th>Confidence</th><th>Fallback</th><th>Reason</th></tr></thead><tbody>' +
              (rows || '<tr><td colspan="6" style="color:var(--text-muted)">No routing entries.</td></tr>') + '</tbody></table>');
          } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">' + escText(err.message) + '</p>'); }
        }
      } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">Failed: ' + escText(err.message) + '</p>'); }
    }
    setTimeout(() => {
      const tabs = document.querySelectorAll('#ops-sec-tabs [data-sec-tab]');
      tabs.forEach((t) => t.addEventListener("click", () => {
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        loadTab(t.getAttribute("data-sec-tab"));
      }));
      loadTab("redact");
    }, 0);
  }

  // ── COST ANALYTICS DEEP ──
  async function showCostAnalyticsDeep() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body">' +
      '<div class="ops-tab-strip" id="ops-cad-tabs">' +
      '<button class="ops-tab-btn active" data-cad-tab="breakdown">Breakdown</button>' +
      '<button class="ops-tab-btn" data-cad-tab="simulator">Simulator</button>' +
      '<button class="ops-tab-btn" data-cad-tab="margin">Margin history</button>' +
      '</div>' +
      '<div id="ops-cad-body" style="margin-top:12px">Loading...</div>' +
      '</div>';
    showOpsModal("Cost Analytics Deep", html);
    function bars(byMonth) {
      const months = Object.keys(byMonth || {}).sort();
      if (!months.length) return '<p style="color:var(--text-muted)">No spend recorded yet.</p>';
      const max = Math.max(...months.map((m) => Number(byMonth[m]) || 0), 0.0001);
      const w = 480, h = 100, barW = (w / months.length) - 4;
      const svgBars = months.map((m, i) => {
        const v = Number(byMonth[m]) || 0;
        const bh = (v / max) * h;
        return '<rect x="' + (i * (barW + 4)) + '" y="' + (h - bh) + '" width="' + barW + '" height="' + bh + '" fill="#0ea5e9"><title>' + m + ': USD ' + v.toFixed(4) + '</title></rect>';
      }).join("");
      return '<svg width="' + w + '" height="' + h + '" style="display:block;margin:8px 0">' + svgBars + '</svg>' +
        '<div style="font-size:10px;color:var(--text-muted)">' + months.join(" / ") + '</div>';
    }
    async function loadTab(tab) {
      const body = byId("ops-cad-body");
      if (!body) return;
      setOpsHtml(body, "Loading...");
      try {
        if (tab === "breakdown") {
          const data = await window.ObaraBackend.cost.breakdown();
          const customerRows = Object.values(data.byCustomer || {}).sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, 12).map((c) =>
            '<tr><td>' + escText(c.name || c.id || "?") + '</td><td style="text-align:right">' + (c.count || 0) + '</td>' +
            '<td style="text-align:right;font-family:monospace">' + Number(c.usd || 0).toFixed(4) + '</td></tr>'
          ).join("");
          setOpsHtml(body, '<div class="ops-cost-grid">' +
            '<div class="ops-cost-card"><div class="label">Cost / success</div><div class="value">USD ' + Number(data.costPerSuccess || 0).toFixed(4) + '</div><div class="sub">' + (data.totalSuccess || 0) + ' successful orders</div></div>' +
            '<div class="ops-cost-card"><div class="label">Cost / field</div><div class="value">USD ' + Number(data.costPerField || 0).toFixed(4) + '</div><div class="sub">' + (data.totalFields || 0) + ' fields extracted</div></div>' +
            '</div>' +
            '<h4 style="font-size:13px;font-weight:800;margin-top:14px;margin-bottom:6px">Spend by month</h4>' +
            bars(data.byMonth || {}) +
            '<h4 style="font-size:13px;font-weight:800;margin-top:14px;margin-bottom:6px">Top customers</h4>' +
            '<table><thead><tr><th>Customer</th><th>Orders</th><th style="text-align:right">USD</th></tr></thead><tbody>' +
            (customerRows || '<tr><td colspan="3" style="color:var(--text-muted)">No customer data.</td></tr>') + '</tbody></table>');
        } else if (tab === "simulator") {
          setOpsHtml(body, '<div style="margin-bottom:8px"><label>Scenario <select id="ops-cad-scen">' +
            ["full_sonnet","haiku_pf_sonnet_gen","template_dry_run","cached_duplicate","opus_complex"].map((s) => '<option value="' + s + '">' + s + '</option>').join("") +
            '</select></label><button class="btn btn-primary" id="ops-cad-run">Project</button></div><div id="ops-cad-out"></div>');
          byId("ops-cad-run").addEventListener("click", async () => {
            try {
              const out = await window.ObaraBackend.cost.simulator({ scenario: byId("ops-cad-scen").value });
              setOpsHtml(byId("ops-cad-out"), '<p>Projected USD: <strong>' + Number(out.projectedUsd || 0).toFixed(4) + '</strong></p>' +
                '<p>Current spend baseline: USD ' + Number(out.baselineUsd || 0).toFixed(4) + '</p>' +
                '<p>Delta: <strong>' + Number(out.deltaPct || 0).toFixed(2) + '%</strong></p>' +
                '<p style="color:var(--text-muted);font-size:12px">' + escText(out.note || "") + '</p>');
            } catch (err) { notifyError(err.message); }
          });
        } else if (tab === "margin") {
          const customers = (await window.ObaraBackend.customers.list()).customers || [];
          const sel = '<select id="ops-cad-margin-cust"><option value="">(pick customer)</option>' +
            customers.map((c) => '<option value="' + escText(c.id) + '">' + escText(c.customer_name || c.customer_key) + '</option>').join("") + '</select>';
          setOpsHtml(body, '<div style="margin-bottom:8px">' + sel + '<button class="btn btn-primary" id="ops-cad-margin-go">Load</button></div><div id="ops-cad-margin-out"></div>');
          byId("ops-cad-margin-go").addEventListener("click", async () => {
            const customerId = byId("ops-cad-margin-cust").value;
            if (!customerId) { notifyWarn("Pick a customer first"); return; }
            try {
              const out = await window.ObaraBackend.cost.marginHistory(customerId);
              const rows = (out.orders || []).map((o) =>
                '<tr><td style="font-family:monospace">' + escText(String(o.id || "").slice(0, 8)) + '</td>' +
                '<td>' + escText(fmtDate(o.created_at)) + '</td>' +
                '<td style="text-align:right">' + fmtNum(o.marginPct) + '%</td></tr>'
              ).join("");
              setOpsHtml(byId("ops-cad-margin-out"), '<p>Median: ' + fmtNum(out.medianMarginPct) + '% &nbsp; Low: ' + fmtNum(out.low) + '% &nbsp; High: ' + fmtNum(out.high) + '%</p>' +
                '<table><thead><tr><th>Order</th><th>Date</th><th style="text-align:right">Margin %</th></tr></thead><tbody>' +
                (rows || '<tr><td colspan="3" style="color:var(--text-muted)">No history.</td></tr>') + '</tbody></table>');
            } catch (err) { notifyError(err.message); }
          });
        }
      } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">Failed: ' + escText(err.message) + '</p>'); }
    }
    setTimeout(() => {
      const tabs = document.querySelectorAll('#ops-cad-tabs [data-cad-tab]');
      tabs.forEach((t) => t.addEventListener("click", () => {
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        loadTab(t.getAttribute("data-cad-tab"));
      }));
      loadTab("breakdown");
    }, 0);
  }

  // ── SALES PIPELINE (Leads + Opportunities) ──
  // Source: Sales Object Model WIP V1.0.xlsx (Pre-Lead, Lead, Opportunity sheets).
  async function showSalesPipeline() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<div class="ops-tab-strip" id="ops-pipe-tabs">' +
      '<button class="ops-tab-btn active" data-pipe-tab="leads">Leads</button>' +
      '<button class="ops-tab-btn" data-pipe-tab="opps">Opportunities</button>' +
      '<button class="ops-tab-btn" data-pipe-tab="lost">Lost reasons</button>' +
      '</div>' +
      '<div id="ops-pipe-body" style="margin-top:12px">Loading...</div>' +
      '</div>';
    showOpsModal("Sales Pipeline", html);
    setTimeout(() => {
      const tabs = document.querySelectorAll('#ops-pipe-tabs [data-pipe-tab]');
      tabs.forEach((t) => t.addEventListener("click", () => {
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        loadPipelineTab(t.getAttribute("data-pipe-tab"));
      }));
      loadPipelineTab("leads");
    }, 0);
  }
  async function loadPipelineTab(tab) {
    const body = byId("ops-pipe-body");
    if (!body) return;
    setOpsHtml(body, "Loading...");
    try {
      if (tab === "leads") return renderLeads(body);
      if (tab === "opps") return renderOpps(body);
      if (tab === "lost") return renderLostReasons(body);
    } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">' + escText(err.message) + '</p>'); }
  }

  async function renderLeads(body) {
    const out = await window.ObaraBackend.sales.listLeads({ limit: 200 });
    const customers = (await window.ObaraBackend.customers.list()).customers || [];
    const customerOptions = '<option value="">(no account)</option>' + customers.map((c) => '<option value="' + escText(c.id) + '">' + escText(c.customer_name || c.customer_key) + '</option>').join("");
    const rows = (out.leads || []).map((l) =>
      '<tr><td>' + escText(l.company_name) + '</td>' +
      '<td>' + escText(l.contact_name || "") + '<br/><span class="text-[11px]" style="color:var(--text-muted)">' + escText(l.contact_email || "") + '</span></td>' +
      '<td><span class="ops-pill">' + escText(l.status) + '</span></td>' +
      '<td>' + escText(l.lead_type || "") + ' / ' + escText(l.customer_segment || "") + '</td>' +
      '<td>' + escText(l.region || "") + '</td>' +
      '<td>' + (l.budget_estimate ? Number(l.budget_estimate).toLocaleString() : "") + '</td>' +
      '<td>' +
        (l.status !== "CONVERTED" ? '<button class="btn btn-primary ops-lead-convert" data-id="' + escText(l.id) + '" data-account="' + escText(l.account_id || "") + '" data-name="' + escText(l.company_name) + '">Convert</button>' : '') +
        '<button class="btn btn-ghost ops-lead-del" data-id="' + escText(l.id) + '">Delete</button>' +
      '</td></tr>'
    ).join("");
    setOpsHtml(body, '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<input id="ops-lead-company" placeholder="Company" style="width:140px"/>' +
      '<input id="ops-lead-contact" placeholder="Contact name" style="width:140px"/>' +
      '<input id="ops-lead-email" placeholder="Email" style="width:160px"/>' +
      '<select id="ops-lead-account">' + customerOptions + '</select>' +
      '<select id="ops-lead-segment"><option value="">(segment)</option><option value="AUTO_OEM">Auto OEM</option><option value="TIER_ONE">Tier-1</option><option value="LINE_BUILDER">Line builder</option><option value="OTHER">Other</option></select>' +
      '<select id="ops-lead-type"><option value="">(type)</option><option value="Project">Project</option><option value="Spare">Spare</option></select>' +
      '<input id="ops-lead-region" placeholder="Region" style="width:100px"/>' +
      '<input id="ops-lead-budget" type="number" placeholder="Budget INR" style="width:120px"/>' +
      '<button class="btn btn-primary" id="ops-lead-add">Add lead</button>' +
      '</div>' +
      '<table><thead><tr><th>Company</th><th>Contact</th><th>Status</th><th>Type/Segment</th><th>Region</th><th>Budget</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="7" style="color:var(--text-muted)">No leads.</td></tr>') + '</tbody></table>');
    byId("ops-lead-add").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.sales.createLead({
          company_name: byId("ops-lead-company").value,
          contact_name: byId("ops-lead-contact").value,
          contact_email: byId("ops-lead-email").value,
          account_id: byId("ops-lead-account").value || null,
          customer_segment: byId("ops-lead-segment").value || null,
          lead_type: byId("ops-lead-type").value || null,
          region: byId("ops-lead-region").value,
          budget_estimate: Number(byId("ops-lead-budget").value) || null,
        });
        notifySuccess("Lead added");
        renderLeads(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-lead-convert").forEach((b) => b.addEventListener("click", async () => {
      try {
        await window.ObaraBackend.sales.updateLead({
          id: b.getAttribute("data-id"),
          convert_to_opportunity: true,
          account_id: b.getAttribute("data-account") || null,
          company_name: b.getAttribute("data-name"),
        });
        notifySuccess("Lead converted to opportunity");
        renderLeads(body);
      } catch (err) { notifyError(err.message); }
    }));
    document.querySelectorAll(".ops-lead-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.sales.deleteLead(b.getAttribute("data-id")); renderLeads(body); }
      catch (err) { notifyError(err.message); }
    }));
  }

  async function renderOpps(body) {
    const out = await window.ObaraBackend.sales.listOpportunities({ limit: 200 });
    const customers = (await window.ObaraBackend.customers.list()).customers || [];
    const customerMap = {}; customers.forEach((c) => { customerMap[c.id] = c.customer_name || c.customer_key; });
    const stages = ["QUALIFICATION","STRATEGY_CHECK","NEEDS_ANALYSIS","FOLLOW_UP","RFQ","INTERNAL_PROPOSAL","PROPOSAL_PRICE_QUOTE","NEGOTIATION_REVIEW","CLOSE_WON","CLOSE_LOST","REGRETTED"];
    const modes = ["SPARES","SPARES_ASSEMBLY","PROJECT_FOR","PROJECT_HSS","INTERNAL"];
    const rows = (out.opportunities || []).map((o) =>
      '<tr><td>' + escText(o.opportunity_name) + '</td>' +
      '<td>' + escText(customerMap[o.customer_id] || "") + '</td>' +
      '<td><select class="ops-opp-stage" data-id="' + escText(o.id) + '">' +
        stages.map((s) => '<option value="' + s + '"' + (s === o.stage ? ' selected' : '') + '>' + s + '</option>').join("") +
      '</select></td>' +
      '<td>' + escText(o.order_mode || "") + '</td>' +
      '<td>' + (o.amount_inr ? Number(o.amount_inr).toLocaleString() : "") + '</td>' +
      '<td>' + escText(o.close_date || "") + '</td>' +
      '<td>' + (o.probability != null ? o.probability + "%" : "") + '</td>' +
      '<td>' +
        (o.stage === "CLOSE_LOST" ? '<button class="btn btn-ghost ops-opp-lost" data-id="' + escText(o.id) + '">Loss reason</button>' : '') +
        '<button class="btn btn-ghost ops-opp-del" data-id="' + escText(o.id) + '">Delete</button>' +
      '</td></tr>'
    ).join("");
    const customerOpts = '<option value="">(customer)</option>' + customers.map((c) => '<option value="' + escText(c.id) + '">' + escText(c.customer_name || c.customer_key) + '</option>').join("");
    setOpsHtml(body, '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<input id="ops-opp-name" placeholder="Opportunity name" style="width:200px"/>' +
      '<select id="ops-opp-customer">' + customerOpts + '</select>' +
      '<select id="ops-opp-mode"><option value="">(mode)</option>' + modes.map((m) => '<option value="' + m + '">' + m + '</option>').join("") + '</select>' +
      '<input id="ops-opp-amt" type="number" placeholder="Amount INR" style="width:120px"/>' +
      '<input id="ops-opp-close" type="date"/>' +
      '<button class="btn btn-primary" id="ops-opp-add">Add</button>' +
      '</div>' +
      '<table><thead><tr><th>Name</th><th>Customer</th><th>Stage</th><th>Mode</th><th>Amount</th><th>Close</th><th>Prob</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8" style="color:var(--text-muted)">No opportunities.</td></tr>') + '</tbody></table>');
    byId("ops-opp-add").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.sales.createOpportunity({
          opportunity_name: byId("ops-opp-name").value,
          customer_id: byId("ops-opp-customer").value,
          order_mode: byId("ops-opp-mode").value || null,
          amount_inr: Number(byId("ops-opp-amt").value) || null,
          close_date: byId("ops-opp-close").value || null,
        });
        notifySuccess("Opportunity added");
        renderOpps(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-opp-stage").forEach((sel) => sel.addEventListener("change", async () => {
      try { await window.ObaraBackend.sales.updateOpportunity({ id: sel.getAttribute("data-id"), stage: sel.value }); notifySuccess("Stage updated"); }
      catch (err) { notifyError(err.message); }
    }));
    document.querySelectorAll(".ops-opp-lost").forEach((b) => b.addEventListener("click", async () => {
      const reasons = await window.ObaraBackend.admin.listLostReasons();
      const opts = (reasons.reasons || []).filter((r) => r.active).map((r) => '<option value="' + escText(r.code) + '">' + escText(r.label) + '</option>').join("");
      const reason = prompt("Loss reason code (one of):\\n" + (reasons.reasons || []).map((r) => r.code).join(", "));
      if (!reason) return;
      const competitor = prompt("Competitor name (optional)") || null;
      try {
        await window.ObaraBackend.sales.updateOpportunity({ id: b.getAttribute("data-id"), lost_reason: reason, competitor_name: competitor });
        notifySuccess("Loss recorded");
        renderOpps(body);
      } catch (err) { notifyError(err.message); }
    }));
    document.querySelectorAll(".ops-opp-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.sales.deleteOpportunity(b.getAttribute("data-id")); renderOpps(body); }
      catch (err) { notifyError(err.message); }
    }));
  }

  async function renderLostReasons(body) {
    const out = await window.ObaraBackend.admin.listLostReasons();
    const rows = (out.reasons || []).map((r) =>
      '<tr><td><code>' + escText(r.code) + '</code></td><td>' + escText(r.label) + '</td><td>' + escText(r.category || "") + '</td>' +
      '<td>' + (r.active ? "active" : "inactive") + '</td>' +
      '<td>' + (r.tenant_id ? '<button class="btn btn-ghost ops-loss-del" data-id="' + escText(r.id) + '">Delete</button>' : '<span class="text-[11px]" style="color:var(--text-muted)">global</span>') + '</td></tr>'
    ).join("");
    setOpsHtml(body, '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<input id="ops-loss-code" placeholder="CODE" style="width:120px;text-transform:uppercase"/>' +
      '<input id="ops-loss-label" placeholder="Label" style="width:240px"/>' +
      '<input id="ops-loss-cat" placeholder="Category" style="width:120px"/>' +
      '<button class="btn btn-primary" id="ops-loss-add">Add</button>' +
      '</div>' +
      '<table><thead><tr><th>Code</th><th>Label</th><th>Category</th><th>Active</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>');
    byId("ops-loss-add").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.admin.upsertLostReason({
          code: byId("ops-loss-code").value,
          label: byId("ops-loss-label").value,
          category: byId("ops-loss-cat").value || null,
        });
        renderLostReasons(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-loss-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.admin.deleteLostReason(b.getAttribute("data-id")); renderLostReasons(body); }
      catch (err) { notifyError(err.message); }
    }));
  }

  // ── INTERNAL SALES ORDERS (FOC / Warranty / Trial / Expected PO / Transfer) ──
  // Source: INternal Sales order/ folder with three template variants.
  async function showInternalSoModal() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<div class="ops-tab-strip" id="ops-iso-tabs">' +
      ['FOC_SUPPLY','WARRANTY_REPLACEMENT','PRODUCT_TRIAL','EXPECTED_PO','INTERNAL_TRANSFER'].map((t, i) =>
        '<button class="ops-tab-btn' + (i === 0 ? ' active' : '') + '" data-iso-tab="' + t + '">' + t.replace(/_/g, ' ') + '</button>'
      ).join("") +
      '</div>' +
      '<div id="ops-iso-body" style="margin-top:12px">Loading...</div>' +
      '</div>';
    showOpsModal("Internal Sales Orders", html);
    setTimeout(() => {
      const tabs = document.querySelectorAll('#ops-iso-tabs [data-iso-tab]');
      tabs.forEach((t) => t.addEventListener("click", () => {
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        loadIsoTab(t.getAttribute("data-iso-tab"));
      }));
      loadIsoTab("FOC_SUPPLY");
    }, 0);
  }
  function nextIsoNumber(existing, type) {
    const year = new Date().getFullYear();
    const prefix = type.split("_")[0].slice(0, 3) + "-" + year + "-";
    const taken = new Set((existing || []).map((r) => String(r.iso_number || "")));
    for (let i = 1; i < 9999; i++) {
      const cand = prefix + String(i).padStart(4, "0");
      if (!taken.has(cand)) return cand;
    }
    return prefix + Date.now();
  }

  async function loadIsoTab(type) {
    const body = byId("ops-iso-body");
    if (!body) return;
    setOpsHtml(body, "Loading...");
    try {
      const out = await window.ObaraBackend.sales.listInternalSos({ type });
      const rows = (out.internalSos || []).map((iso) =>
        '<tr><td><strong>' + escText(iso.iso_number) + '</strong></td>' +
        '<td>' + escText(iso.purpose || "") + '</td>' +
        '<td>' + escText(iso.requested_person || "") + '</td>' +
        '<td>' + escText(iso.requested_date || "") + '</td>' +
        '<td>' + (iso.approximate_cost_inr ? Number(iso.approximate_cost_inr).toLocaleString() : "") + '</td>' +
        '<td><span class="ops-pill">' + escText(iso.status) + '</span></td>' +
        '<td><button class="btn btn-ghost ops-iso-del" data-id="' + escText(iso.id) + '">Delete</button></td></tr>'
      ).join("");
      setOpsHtml(body, '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<input id="ops-iso-num" placeholder="ISO number" style="width:140px" value="' + escText(nextIsoNumber(out.internalSos, type)) + '"/>' +
        '<input id="ops-iso-purpose" placeholder="Purpose" style="width:200px"/>' +
        '<input id="ops-iso-person" placeholder="Requested by" style="width:140px"/>' +
        '<input id="ops-iso-date" type="date"/>' +
        '<input id="ops-iso-cost" type="number" placeholder="Approx cost INR" style="width:140px"/>' +
        (type === "WARRANTY_REPLACEMENT" ? '<input id="ops-iso-ref" placeholder="Original SO #" style="width:140px"/>' : '') +
        (type === "EXPECTED_PO" ? '<input id="ops-iso-ref" placeholder="Expected PO ref" style="width:160px"/>' : '') +
        (type === "INTERNAL_TRANSFER" ? '<input id="ops-iso-from" placeholder="From store" style="width:120px"/><input id="ops-iso-to" placeholder="To store" style="width:120px"/>' : '') +
        '<button class="btn btn-primary" id="ops-iso-add">Create</button>' +
        '</div>' +
        '<table><thead><tr><th>ISO #</th><th>Purpose</th><th>Requested by</th><th>Date</th><th>Approx cost</th><th>Status</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="7" style="color:var(--text-muted)">No entries.</td></tr>') + '</tbody></table>');
      byId("ops-iso-add").addEventListener("click", async () => {
        try {
          const payload = {
            iso_type: type,
            iso_number: byId("ops-iso-num").value,
            purpose: byId("ops-iso-purpose").value || null,
            requested_person: byId("ops-iso-person").value || null,
            requested_date: byId("ops-iso-date").value || null,
            approximate_cost_inr: Number(byId("ops-iso-cost").value) || null,
          };
          if (type === "WARRANTY_REPLACEMENT") payload.warranty_reference = (byId("ops-iso-ref") || {}).value || null;
          if (type === "EXPECTED_PO") payload.expected_po_reference = (byId("ops-iso-ref") || {}).value || null;
          if (type === "INTERNAL_TRANSFER") {
            payload.from_store = (byId("ops-iso-from") || {}).value || null;
            payload.to_store = (byId("ops-iso-to") || {}).value || null;
          }
          await window.ObaraBackend.sales.createInternalSo(payload);
          notifySuccess("Internal SO created");
          loadIsoTab(type);
        } catch (err) { notifyError(err.message); }
      });
      document.querySelectorAll(".ops-iso-del").forEach((b) => b.addEventListener("click", async () => {
        try { await window.ObaraBackend.sales.deleteInternalSo(b.getAttribute("data-id")); loadIsoTab(type); }
        catch (err) { notifyError(err.message); }
      }));
    } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">' + escText(err.message) + '</p>'); }
  }

  // ── PROJECT TRACKER ──
  // Source: 2. Project- Info and activity Rev1.xlsx with 14 named phases.
  async function showProjectTracker() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<p>Project lifecycle phases derived from "Project Info and activity" tracker. Advance phases to log timestamps and SLA.</p>' +
      '<div id="ops-proj-body">Loading...</div>' +
      '</div>';
    showOpsModal("Project Tracker", html);
    renderProjectList();
  }
  async function renderProjectList() {
    const body = byId("ops-proj-body");
    if (!body) return;
    try {
      const out = await window.ObaraBackend.sales.listProjects({ limit: 200 });
      const customers = (await window.ObaraBackend.customers.list()).customers || [];
      const customerMap = {}; customers.forEach((c) => { customerMap[c.id] = c.customer_name || c.customer_key; });
      const phases = ["INITIAL_INFO","STRATEGY","PROMOTIONAL","RFQ_PREP","BUDGETARY_QUOTATION","PRICE_NEGOTIATION","LB_FINALIZATION","KICKOFF","DESIGN","APPROVAL_PROCESSING","MANUFACTURING","SHIPPING","INSTALLATION_COMMISSIONING","PAYMENT_FOLLOWUP","CLOSED"];
      const rows = (out.projects || []).map((p) =>
        '<tr><td><strong>' + escText(p.project_code) + '</strong><br/><span class="text-[11px]" style="color:var(--text-muted)">' + escText(p.project_name) + '</span></td>' +
        '<td>' + escText(customerMap[p.customer_id] || "") + '</td>' +
        '<td><select class="ops-proj-phase" data-id="' + escText(p.id) + '">' +
          phases.map((ph) => '<option value="' + ph + '"' + (ph === p.current_phase ? ' selected' : '') + '>' + ph + '</option>').join("") +
        '</select></td>' +
        '<td>' + (p.total_value_inr ? Number(p.total_value_inr).toLocaleString() : "") + '</td>' +
        '<td>' + escText(p.expected_delivery_date || "") + '</td>' +
        '<td>' + escText(p.status) + '</td>' +
        '<td><button class="btn btn-ghost ops-proj-del" data-id="' + escText(p.id) + '">Delete</button></td></tr>'
      ).join("");
      const customerOpts = '<option value="">(customer)</option>' + customers.map((c) => '<option value="' + escText(c.id) + '">' + escText(c.customer_name || c.customer_key) + '</option>').join("");
      setOpsHtml(body, '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<input id="ops-proj-code" placeholder="Project code" style="width:140px"/>' +
        '<input id="ops-proj-name" placeholder="Project name" style="width:200px"/>' +
        '<select id="ops-proj-customer">' + customerOpts + '</select>' +
        '<input id="ops-proj-value" type="number" placeholder="Value INR" style="width:120px"/>' +
        '<input id="ops-proj-eta" type="date" title="Expected delivery"/>' +
        '<button class="btn btn-primary" id="ops-proj-add">Create</button>' +
        '</div>' +
        '<table><thead><tr><th>Project</th><th>Customer</th><th>Phase</th><th>Value</th><th>Expected delivery</th><th>Status</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="7" style="color:var(--text-muted)">No projects.</td></tr>') + '</tbody></table>');
      byId("ops-proj-add").addEventListener("click", async () => {
        try {
          await window.ObaraBackend.sales.createProject({
            project_code: byId("ops-proj-code").value,
            project_name: byId("ops-proj-name").value,
            customer_id: byId("ops-proj-customer").value || null,
            total_value_inr: Number(byId("ops-proj-value").value) || null,
            expected_delivery_date: byId("ops-proj-eta").value || null,
          });
          notifySuccess("Project created");
          renderProjectList();
        } catch (err) { notifyError(err.message); }
      });
      document.querySelectorAll(".ops-proj-phase").forEach((sel) => sel.addEventListener("change", async () => {
        try { await window.ObaraBackend.sales.updateProject({ id: sel.getAttribute("data-id"), current_phase: sel.value }); notifySuccess("Phase advanced"); }
        catch (err) { notifyError(err.message); }
      }));
      document.querySelectorAll(".ops-proj-del").forEach((b) => b.addEventListener("click", async () => {
        try { await window.ObaraBackend.sales.deleteProject(b.getAttribute("data-id")); renderProjectList(); }
        catch (err) { notifyError(err.message); }
      }));
    } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">' + escText(err.message) + '</p>'); }
  }

  // ── SHIPMENTS + POD ──
  // Source: Pending Sales Order tracker columns (Mode, Vessel/flight, Port arrival, Warehouse receipt, POD).
  async function showShipmentsModal() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<p>Shipment + POD tracking derived from the Pending Sales Order spreadsheet columns.</p>' +
      '<div id="ops-ship-body">Loading...</div>' +
      '</div>';
    showOpsModal("Shipments and POD", html);
    renderShipmentsList();
  }
  async function renderShipmentsList() {
    const body = byId("ops-ship-body");
    if (!body) return;
    try {
      const out = await window.ObaraBackend.sales.listShipments({ limit: 200 });
      const statuses = ["PLANNED","READY","IN_TRANSIT","AT_PORT","CLEARED","DELIVERED","POD_RECEIVED","EXCEPTION"];
      const rows = (out.shipments || []).map((s) =>
        '<tr><td>' + escText(s.shipment_number || s.id.slice(0, 8)) + '</td>' +
        '<td>' + escText(s.mode || "") + '</td>' +
        '<td>' + escText(s.vessel_or_flight || "") + '</td>' +
        '<td>' + escText(s.shipper_invoice_no || "") + '</td>' +
        '<td>' + escText(s.port_arrival_date || "") + '</td>' +
        '<td>' + escText(s.warehouse_receipt_date || "") + '</td>' +
        '<td><select class="ops-ship-status" data-id="' + escText(s.id) + '">' +
          statuses.map((st) => '<option value="' + st + '"' + (st === s.status ? ' selected' : '') + '>' + st + '</option>').join("") +
        '</select></td>' +
        '<td>' + (s.pod_received ? "yes" : "no") + '</td>' +
        '<td><button class="btn btn-ghost ops-ship-del" data-id="' + escText(s.id) + '">Delete</button></td></tr>'
      ).join("");
      setOpsHtml(body, '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<input id="ops-ship-num" placeholder="Shipment #" style="width:140px"/>' +
        '<select id="ops-ship-mode"><option value="SEA">SEA</option><option value="AIR">AIR</option><option value="ROAD">ROAD</option><option value="COURIER">COURIER</option></select>' +
        '<input id="ops-ship-vessel" placeholder="Vessel/Flight" style="width:120px"/>' +
        '<input id="ops-ship-inv" placeholder="Shipper inv #" style="width:120px"/>' +
        '<input id="ops-ship-arrival" type="date" title="Port arrival"/>' +
        '<input id="ops-ship-warehouse" type="date" title="Warehouse receipt"/>' +
        '<input id="ops-ship-order" placeholder="Order id (optional)" style="width:200px"/>' +
        '<button class="btn btn-primary" id="ops-ship-add">Add</button>' +
        '</div>' +
        '<table><thead><tr><th>Shipment</th><th>Mode</th><th>Vessel/Flight</th><th>Inv #</th><th>Port arrival</th><th>Warehouse</th><th>Status</th><th>POD</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="9" style="color:var(--text-muted)">No shipments.</td></tr>') + '</tbody></table>');
      byId("ops-ship-add").addEventListener("click", async () => {
        try {
          await window.ObaraBackend.sales.createShipment({
            shipment_number: byId("ops-ship-num").value,
            mode: byId("ops-ship-mode").value,
            vessel_or_flight: byId("ops-ship-vessel").value || null,
            shipper_invoice_no: byId("ops-ship-inv").value || null,
            port_arrival_date: byId("ops-ship-arrival").value || null,
            warehouse_receipt_date: byId("ops-ship-warehouse").value || null,
            order_id: byId("ops-ship-order").value || null,
          });
          notifySuccess("Shipment added");
          renderShipmentsList();
        } catch (err) { notifyError(err.message); }
      });
      document.querySelectorAll(".ops-ship-status").forEach((sel) => sel.addEventListener("change", async () => {
        try {
          const patch = { id: sel.getAttribute("data-id"), status: sel.value };
          if (sel.value === "POD_RECEIVED") patch.pod_received = true;
          await window.ObaraBackend.sales.updateShipment(patch);
          notifySuccess("Status updated");
        } catch (err) { notifyError(err.message); }
      }));
      document.querySelectorAll(".ops-ship-del").forEach((b) => b.addEventListener("click", async () => {
        try { await window.ObaraBackend.sales.deleteShipment(b.getAttribute("data-id")); renderShipmentsList(); }
        catch (err) { notifyError(err.message); }
      }));
    } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">' + escText(err.message) + '</p>'); }
  }

  // ── SERVICE VISITS + CAR REPORTS ──
  async function showServiceModal() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<div class="ops-tab-strip" id="ops-svc-tabs">' +
      '<button class="ops-tab-btn active" data-svc-tab="visits">Visits</button>' +
      '<button class="ops-tab-btn" data-svc-tab="car">CAR reports</button>' +
      '<button class="ops-tab-btn" data-svc-tab="closure">Closure reports</button>' +
      '</div>' +
      '<div id="ops-svc-body" style="margin-top:12px">Loading...</div>' +
      '</div>';
    showOpsModal("Service", html);
    setTimeout(() => {
      const tabs = document.querySelectorAll('#ops-svc-tabs [data-svc-tab]');
      tabs.forEach((t) => t.addEventListener("click", () => {
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        loadServiceTab(t.getAttribute("data-svc-tab"));
      }));
      loadServiceTab("visits");
    }, 0);
  }
  async function loadServiceTab(tab) {
    const body = byId("ops-svc-body");
    if (!body) return;
    setOpsHtml(body, "Loading...");
    try {
      if (tab === "visits") {
        const out = await window.ObaraBackend.service.listVisits({ limit: 100 });
        const rows = (out.visits || []).map((v) =>
          '<tr><td>' + escText(v.visit_date) + '</td><td>' + escText(v.line_or_station || "") + '</td>' +
          '<td>' + escText(v.purpose || "") + '</td>' +
          '<td><span class="ops-pill">' + escText(v.status) + '</span></td>' +
          '<td>' + escText((v.check_in_at || "").slice(0, 16).replace("T", " ")) + '</td>' +
          '<td>' + escText((v.check_out_at || "").slice(0, 16).replace("T", " ")) + '</td>' +
          '<td>' +
            (v.status === "PLANNED" ? '<button class="btn btn-ghost ops-visit-in" data-id="' + escText(v.id) + '">Check in</button>' : "") +
            (v.status === "CHECKED_IN" ? '<button class="btn btn-ghost ops-visit-out" data-id="' + escText(v.id) + '">Check out</button>' : "") +
            '<button class="btn btn-ghost ops-visit-del" data-id="' + escText(v.id) + '">Delete</button>' +
          '</td></tr>'
        ).join("");
        setOpsHtml(body, '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<input id="ops-visit-date" type="date"/>' +
          '<input id="ops-visit-line" placeholder="Line/station" style="width:140px"/>' +
          '<input id="ops-visit-purpose" placeholder="Purpose" style="width:200px"/>' +
          '<button class="btn btn-primary" id="ops-visit-add">Plan visit</button>' +
          '</div>' +
          '<table><thead><tr><th>Date</th><th>Line/Station</th><th>Purpose</th><th>Status</th><th>Check in</th><th>Check out</th><th></th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="7" style="color:var(--text-muted)">No visits.</td></tr>') + '</tbody></table>');
        byId("ops-visit-add").addEventListener("click", async () => {
          try {
            await window.ObaraBackend.service.createVisit({
              visit_date: byId("ops-visit-date").value,
              line_or_station: byId("ops-visit-line").value || null,
              purpose: byId("ops-visit-purpose").value || null,
            });
            loadServiceTab("visits");
          } catch (err) { notifyError(err.message); }
        });
        document.querySelectorAll(".ops-visit-in").forEach((b) => b.addEventListener("click", async () => {
          try { await window.ObaraBackend.service.updateVisit({ id: b.getAttribute("data-id"), checkin: true }); loadServiceTab("visits"); }
          catch (err) { notifyError(err.message); }
        }));
        document.querySelectorAll(".ops-visit-out").forEach((b) => b.addEventListener("click", async () => {
          try { await window.ObaraBackend.service.updateVisit({ id: b.getAttribute("data-id"), checkout: true }); loadServiceTab("visits"); }
          catch (err) { notifyError(err.message); }
        }));
        document.querySelectorAll(".ops-visit-del").forEach((b) => b.addEventListener("click", async () => {
          try { await window.ObaraBackend.service.deleteVisit(b.getAttribute("data-id")); loadServiceTab("visits"); }
          catch (err) { notifyError(err.message); }
        }));
      } else if (tab === "car") {
        const out = await window.ObaraBackend.service.listCarReports({ limit: 100 });
        const rows = (out.car_reports || []).map((c) =>
          '<tr><td>' + escText(c.original_so_no || c.original_po_no || "") + '</td><td>' + escText(c.part_no || "") + '</td>' +
          '<td>' + escText(c.qty_rejected || "") + '</td>' +
          '<td>' + escText(c.root_cause || "").slice(0, 80) + '</td>' +
          '<td><span class="ops-pill">' + escText(c.status) + '</span></td></tr>'
        ).join("");
        setOpsHtml(body, '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<input id="ops-car-so" placeholder="SO #" style="width:120px"/>' +
          '<input id="ops-car-part" placeholder="Part #" style="width:140px"/>' +
          '<input id="ops-car-qty" type="number" placeholder="Rejected qty" style="width:120px"/>' +
          '<input id="ops-car-root" placeholder="Root cause" style="width:240px"/>' +
          '<button class="btn btn-primary" id="ops-car-add">Add CAR</button>' +
          '</div>' +
          '<table><thead><tr><th>SO/PO</th><th>Part</th><th>Qty</th><th>Root cause</th><th>Status</th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="5" style="color:var(--text-muted)">No CAR reports.</td></tr>') + '</tbody></table>');
        byId("ops-car-add").addEventListener("click", async () => {
          try {
            await window.ObaraBackend.service.createCarReport({
              original_so_no: byId("ops-car-so").value || null,
              part_no: byId("ops-car-part").value || null,
              qty_rejected: Number(byId("ops-car-qty").value) || null,
              root_cause: byId("ops-car-root").value || null,
            });
            loadServiceTab("car");
          } catch (err) { notifyError(err.message); }
        });
      } else if (tab === "closure") {
        const out = await window.ObaraBackend.service.listClosureReports({ limit: 100 });
        const cars = (await window.ObaraBackend.service.listCarReports({ limit: 100 })).car_reports || [];
        const carOpts = '<option value="">(link to CAR, optional)</option>' + cars.map((c) => '<option value="' + escText(c.id) + '">' + escText(c.original_so_no || c.original_po_no || c.id.slice(0, 8)) + '</option>').join("");
        const rows = (out.closure_reports || []).map((c) =>
          '<tr><td>' + escText((c.issue_date || "").slice(0, 10)) + '</td>' +
          '<td>' + escText(c.equipment_part_no || "") + '</td>' +
          '<td>' + escText((c.root_cause || "").slice(0, 80)) + '</td>' +
          '<td>' + (c.closed_at ? "closed " + (c.closed_at || "").slice(0, 10) : "open") + '</td></tr>'
        ).join("");
        setOpsHtml(body, '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
          '<select id="ops-cls-car">' + carOpts + '</select>' +
          '<input id="ops-cls-issue" type="date" title="Issue date"/>' +
          '<input id="ops-cls-part" placeholder="Equipment part #" style="width:140px"/>' +
          '<input id="ops-cls-root" placeholder="Root cause" style="width:240px"/>' +
          '<input id="ops-cls-perm" placeholder="Permanent countermeasure" style="width:240px"/>' +
          '<label><input id="ops-cls-signed" type="checkbox"/> sign off</label>' +
          '<button class="btn btn-primary" id="ops-cls-add">Add</button>' +
          '</div>' +
          '<table><thead><tr><th>Issue date</th><th>Part</th><th>Root cause</th><th>Status</th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="4" style="color:var(--text-muted)">No closure reports.</td></tr>') + '</tbody></table>');
        byId("ops-cls-add").addEventListener("click", async () => {
          try {
            await window.ObaraBackend.service.createClosureReport({
              car_report_id: byId("ops-cls-car").value || null,
              issue_date: byId("ops-cls-issue").value || null,
              equipment_part_no: byId("ops-cls-part").value || null,
              root_cause: byId("ops-cls-root").value || null,
              permanent_countermeasure: byId("ops-cls-perm").value || null,
              signed_off: byId("ops-cls-signed").checked,
            });
            loadServiceTab("closure");
          } catch (err) { notifyError(err.message); }
        });
      }
    } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">' + escText(err.message) + '</p>'); }
  }

  // ── ADMIN CENTER ──
  async function showAdminCenter() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<p>Manage tenant data without SQL. All changes are audited.</p>' +
      '<div class="ops-tab-strip" id="ops-admin-tabs">' +
      '<button class="ops-tab-btn active" data-admin-tab="holidays">Holidays</button>' +
      '<button class="ops-tab-btn" data-admin-tab="cust-lead">Customer lead times</button>' +
      '<button class="ops-tab-btn" data-admin-tab="supp-lead">Supplier lead times</button>' +
      '<button class="ops-tab-btn" data-admin-tab="bom">BOM</button>' +
      '<button class="ops-tab-btn" data-admin-tab="inventory">Inventory</button>' +
      '<button class="ops-tab-btn" data-admin-tab="fx">FX rates</button>' +
      '<button class="ops-tab-btn" data-admin-tab="members">Members and roles</button>' +
      '<button class="ops-tab-btn" data-admin-tab="locations">Customer locations</button>' +
      '<button class="ops-tab-btn" data-admin-tab="items">Item master</button>' +
      '<button class="ops-tab-btn" data-admin-tab="contracts">Contracts (ARC/Blanket/AMC)</button>' +
      '<button class="ops-tab-btn" data-admin-tab="equipment">Equipment hierarchy</button>' +
      '<button class="ops-tab-btn" data-admin-tab="approvals">Quote approvals</button>' +
      '<button class="ops-tab-btn" data-admin-tab="csv-import">CSV import</button>' +
      '</div>' +
      '<div id="ops-admin-body" style="margin-top:12px">Loading...</div>' +
      '</div>';
    showOpsModal("Admin Center", html);
    setTimeout(() => {
      const tabs = document.querySelectorAll('#ops-admin-tabs [data-admin-tab]');
      tabs.forEach((t) => t.addEventListener("click", () => {
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        loadAdminTab(t.getAttribute("data-admin-tab"));
      }));
      loadAdminTab("holidays");
    }, 0);
  }

  async function loadAdminTab(tab) {
    const body = byId("ops-admin-body");
    if (!body) return;
    setOpsHtml(body, "Loading...");
    try {
      if (tab === "holidays") return renderHolidays(body);
      if (tab === "cust-lead") return renderLeadTimes(body, "customer");
      if (tab === "supp-lead") return renderLeadTimes(body, "supplier");
      if (tab === "bom") return renderBom(body);
      if (tab === "inventory") return renderInventory(body);
      if (tab === "fx") return renderFxAdmin(body);
      if (tab === "members") return renderMembers(body);
      if (tab === "locations") return renderCustomerLocations(body);
      if (tab === "items") return renderItemMaster(body);
      if (tab === "contracts") return renderContracts(body);
      if (tab === "equipment") return renderEquipmentHierarchy(body);
      if (tab === "approvals") return renderQuoteApprovals(body);
      if (tab === "csv-import") return renderCsvImportWizard(body);
    } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">Failed: ' + escText(err.message) + '</p>'); }
  }

  async function renderQuoteApprovals(body) {
    const [thresholds, approvals] = await Promise.all([
      window.ObaraBackend.admin.listApprovalThresholds(),
      window.ObaraBackend.admin.listApprovalRequests(),
    ]);
    const roles = ["sales_engineer","sales_manager","procurement","finance","admin","viewer"];
    const tRows = (thresholds.thresholds || []).map((t) =>
      '<tr><td>' + escText(t.approver_role) + '</td>' +
      '<td>' + escText(Number(t.min_amount_inr).toLocaleString()) + '</td>' +
      '<td>' + (t.max_amount_inr != null ? Number(t.max_amount_inr).toLocaleString() : "open") + '</td>' +
      '<td>' + escText((t.required_for_modes || []).join(",") || "all") + '</td>' +
      '<td>' + (t.margin_below_pct != null ? (Number(t.margin_below_pct) * 100).toFixed(1) + "%" : "any") + '</td>' +
      '<td>' + (t.active ? "yes" : "no") + '</td>' +
      '<td><button class="btn btn-ghost ops-thresh-del" data-id="' + escText(t.id) + '">Delete</button></td></tr>'
    ).join("");
    const aRows = (approvals.approvals || []).map((a) =>
      '<tr><td>' + escText(String(a.order_id || "").slice(0, 8)) + '</td>' +
      '<td>' + escText(a.approver_role) + '</td>' +
      '<td><span class="ops-pill">' + escText(a.status) + '</span></td>' +
      '<td>' + escText((a.created_at || "").slice(0, 16).replace("T", " ")) + '</td>' +
      '<td>' +
        (a.status === "PENDING" ? '<button class="btn btn-primary ops-approve" data-id="' + escText(a.id) + '">Approve</button>' +
          '<button class="btn btn-ghost ops-reject" data-id="' + escText(a.id) + '">Reject</button>' : "") +
      '</td></tr>'
    ).join("");
    setOpsHtml(body, '<h4 style="font-size:12px;font-weight:800;margin-bottom:6px">Approval thresholds</h4>' +
      '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<select id="ops-thresh-role">' + roles.map((r) => '<option value="' + r + '">' + r + '</option>').join("") + '</select>' +
      '<input id="ops-thresh-min" type="number" placeholder="Min INR" style="width:120px"/>' +
      '<input id="ops-thresh-max" type="number" placeholder="Max INR (blank=open)" style="width:160px"/>' +
      '<input id="ops-thresh-margin" type="number" step="0.01" placeholder="Margin below (e.g. 0.15)" style="width:160px"/>' +
      '<button class="btn btn-primary" id="ops-thresh-add">Add</button>' +
      '</div>' +
      '<table><thead><tr><th>Role</th><th>Min</th><th>Max</th><th>Modes</th><th>Margin</th><th>Active</th><th></th></tr></thead><tbody>' +
      (tRows || '<tr><td colspan="7" style="color:var(--text-muted)">No thresholds defined.</td></tr>') + '</tbody></table>' +
      '<h4 style="font-size:12px;font-weight:800;margin-top:14px;margin-bottom:6px">Pending approvals</h4>' +
      '<table><thead><tr><th>Order</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>' +
      (aRows || '<tr><td colspan="5" style="color:var(--text-muted)">No approval requests.</td></tr>') + '</tbody></table>');
    byId("ops-thresh-add").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.admin.upsertApprovalThreshold({
          approver_role: byId("ops-thresh-role").value,
          min_amount_inr: Number(byId("ops-thresh-min").value) || 0,
          max_amount_inr: byId("ops-thresh-max").value ? Number(byId("ops-thresh-max").value) : null,
          margin_below_pct: byId("ops-thresh-margin").value ? Number(byId("ops-thresh-margin").value) : null,
        });
        renderQuoteApprovals(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-thresh-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.admin.deleteApprovalThreshold(b.getAttribute("data-id")); renderQuoteApprovals(body); }
      catch (err) { notifyError(err.message); }
    }));
    document.querySelectorAll(".ops-approve").forEach((b) => b.addEventListener("click", async () => {
      const comment = prompt("Approval comment (optional):") || "";
      try {
        await window.ObaraBackend.admin.decideApprovalRequest({ id: b.getAttribute("data-id"), order_id: "x", approver_role: "x", status: "APPROVED", comments: comment });
        renderQuoteApprovals(body);
      } catch (err) { notifyError(err.message); }
    }));
    document.querySelectorAll(".ops-reject").forEach((b) => b.addEventListener("click", async () => {
      const comment = prompt("Rejection reason:") || "";
      if (!comment) return;
      try {
        await window.ObaraBackend.admin.decideApprovalRequest({ id: b.getAttribute("data-id"), order_id: "x", approver_role: "x", status: "REJECTED", comments: comment });
        renderQuoteApprovals(body);
      } catch (err) { notifyError(err.message); }
    }));
  }

  // CSV bulk import wizard for item master, BOM, and lead times.
  // Source: pending feature "Bulk import wizards - Item Master CSV import endpoint
  // exists; the UI button to trigger a CSV upload is the next 30-minute add."
  async function renderCsvImportWizard(body) {
    setOpsHtml(body, '<p>Paste tab- or comma-separated rows. The first row must be the header.</p>' +
      '<label>Target <select id="ops-csv-target">' +
        '<option value="item_master">Item Master</option>' +
        '<option value="bom">Bill of Materials</option>' +
        '<option value="lead_times_supplier">Supplier lead times</option>' +
        '<option value="lead_times_customer">Customer lead times</option>' +
        '<option value="holidays">Holidays</option>' +
      '</select></label>' +
      '<div id="ops-csv-help" class="text-[11px]" style="color:var(--text-muted);margin:6px 0"></div>' +
      '<textarea id="ops-csv-input" rows="14" style="width:100%;font-family:monospace;font-size:12px"></textarea>' +
      '<div class="ops-actions" style="margin-top:8px"><button class="btn btn-primary" id="ops-csv-import">Import</button>' +
      '<button class="btn btn-ghost" id="ops-csv-template">Insert template</button></div>' +
      '<div id="ops-csv-status" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div>');
    const TEMPLATES = {
      item_master: "part_no\\tdescription\\tdrawing_no\\tuom\\tsource_country\\tsource_currency\\tpurchase_price\\thsn_sac\\tsgst_rate\\tcgst_rate\\tigst_rate\\tlifecycle\\nC007011\\tNIPPLE\\tC007011\\tNos\\tO-INDIA\\tINR\\t150\\t85159000\\t0.09\\t0.09\\t0.18\\tACTIVE",
      bom: "parent_part_no\\tchild_part_no\\tqty\\tuom\\nIN0-0133\\tCT-16-D-1-FS\\t2\\tNos",
      lead_times_supplier: "supplier\\tcountry\\tproduct_category\\tlead_days\\tnotes\\tO-KOREA\\tKR\\tspare\\t14\\tdefault",
      lead_times_customer: "customer_id\\tproduct_category\\tlead_days\\tnotes\\n00000000-0000-0000-0000-000000000001\\tspare\\t7\\tdefault",
      holidays: "country\\tdate\\tname\\nIN\\t2026-01-26\\tRepublic Day",
    };
    const HELP = {
      item_master: "Required: part_no. Optional: description, drawing_no, uom, source_country (O-KOREA/O-JAPAN/O-CHINA/O-INDIA), source_currency (USD/JPY/CNY/INR), purchase_price, hsn_sac, sgst_rate, cgst_rate, igst_rate, lifecycle (ACTIVE/OBSOLETE/DISCONTINUED/NEW/TRIAL), is_assembly (true/false).",
      bom: "Required: parent_part_no, child_part_no. Optional: qty (default 1), uom, notes. Upserts on (parent, child).",
      lead_times_supplier: "Required: country (ISO-2), lead_days (0-365). Optional: supplier, product_category, notes.",
      lead_times_customer: "Required: lead_days (0-365). Optional: customer_id (uuid), product_category, notes.",
      holidays: "Required: country (ISO-2), date (YYYY-MM-DD). Optional: name.",
    };
    const refreshHelp = () => {
      const t = byId("ops-csv-target").value;
      const help = byId("ops-csv-help");
      if (help) help.textContent = HELP[t] || "";
    };
    refreshHelp();
    byId("ops-csv-target").addEventListener("change", refreshHelp);
    byId("ops-csv-template").addEventListener("click", () => {
      const t = byId("ops-csv-target").value;
      byId("ops-csv-input").value = TEMPLATES[t] || "";
    });
    byId("ops-csv-import").addEventListener("click", async () => {
      const text = byId("ops-csv-input").value || "";
      const status = byId("ops-csv-status");
      const lines = text.split(/\\r?\\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) { if (status) status.textContent = "Need at least a header row plus one data row."; return; }
      const delim = lines[0].includes("\t") ? "\t" : ",";
      const headers = lines[0].split(delim).map((h) => h.trim());
      const rows = lines.slice(1).map((line) => {
        const cells = line.split(delim);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = cells[i] != null ? cells[i].trim() : ""; });
        return obj;
      });
      const target = byId("ops-csv-target").value;
      try {
        if (status) status.textContent = "Sending " + rows.length + " rows...";
        if (target === "item_master") {
          const out = await window.ObaraBackend.admin.bulkItemMaster(rows.map((r) => ({
            ...r,
            purchase_price: r.purchase_price ? Number(r.purchase_price) : null,
            sgst_rate: r.sgst_rate ? Number(r.sgst_rate) : null,
            cgst_rate: r.cgst_rate ? Number(r.cgst_rate) : null,
            igst_rate: r.igst_rate ? Number(r.igst_rate) : null,
            is_assembly: String(r.is_assembly || "").toLowerCase() === "true",
          })));
          if (status) status.textContent = "Imported " + (out.rows || 0) + " item master rows.";
        } else if (target === "bom") {
          let okCount = 0;
          for (const r of rows) {
            try {
              await window.ObaraBackend.bom.upsert({
                parent_part_no: r.parent_part_no, child_part_no: r.child_part_no,
                qty: r.qty ? Number(r.qty) : 1, uom: r.uom || null, notes: r.notes || null,
              });
              okCount++;
            } catch (_) {}
          }
          if (status) status.textContent = "Imported " + okCount + "/" + rows.length + " BOM rows.";
        } else if (target === "lead_times_supplier" || target === "lead_times_customer") {
          const ltType = target === "lead_times_supplier" ? "supplier" : "customer";
          let okCount = 0;
          for (const r of rows) {
            try {
              await window.ObaraBackend.admin.upsertLeadTime(ltType, {
                ...r,
                lead_days: r.lead_days ? Number(r.lead_days) : 0,
              });
              okCount++;
            } catch (_) {}
          }
          if (status) status.textContent = "Imported " + okCount + "/" + rows.length + " " + ltType + " lead-time rows.";
        } else if (target === "holidays") {
          let okCount = 0;
          for (const r of rows) {
            try {
              await window.ObaraBackend.admin.upsertHoliday({ country: r.country, date: r.date, name: r.name || null });
              okCount++;
            } catch (_) {}
          }
          if (status) status.textContent = "Imported " + okCount + "/" + rows.length + " holiday rows.";
        }
        notifySuccess("CSV import complete");
      } catch (err) {
        if (status) status.textContent = "Import failed: " + err.message;
        notifyError(err.message);
      }
    });
  }

  async function renderCustomerLocations(body) {
    const customers = (await window.ObaraBackend.customers.list()).customers || [];
    const customerMap = {}; customers.forEach((c) => { customerMap[c.id] = c.customer_name || c.customer_key; });
    const customerOpts = '<option value="">(customer)</option>' + customers.map((c) => '<option value="' + escText(c.id) + '">' + escText(c.customer_name || c.customer_key) + '</option>').join("");
    const out = await window.ObaraBackend.admin.listCustomerLocations();
    const rows = (out.locations || []).map((l) =>
      '<tr><td>' + escText(customerMap[l.customer_id] || l.customer_id.slice(0, 8)) + '</td>' +
      '<td>' + escText(l.location_code) + '</td>' +
      '<td>' + escText(l.plant_name || "") + '</td>' +
      '<td>' + escText(l.gstin || "") + '</td>' +
      '<td>' + escText(l.state_code || "") + '</td>' +
      '<td>' + escText(l.city || "") + ' ' + escText(l.pincode || "") + '</td>' +
      '<td>' + (l.is_default ? "default" : "") + '</td>' +
      '<td><button class="btn btn-ghost ops-loc-del" data-id="' + escText(l.id) + '">Delete</button></td></tr>'
    ).join("");
    setOpsHtml(body, '<p class="text-[11px]" style="color:var(--text-muted)">Multi-GSTIN per customer. Real example: MG Motor Halol (24AAKCM8110E1ZR Gujarat) and MG Motor Haryana (06AAKCM8110E1ZP).</p>' +
      '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<select id="ops-loc-customer">' + customerOpts + '</select>' +
      '<input id="ops-loc-code" placeholder="HALOL" style="width:100px;text-transform:uppercase"/>' +
      '<input id="ops-loc-plant" placeholder="Plant name" style="width:160px"/>' +
      '<input id="ops-loc-gstin" placeholder="GSTIN" style="width:160px"/>' +
      '<input id="ops-loc-state" placeholder="State code (24)" style="width:100px"/>' +
      '<input id="ops-loc-city" placeholder="City" style="width:120px"/>' +
      '<input id="ops-loc-pin" placeholder="Pincode" style="width:90px"/>' +
      '<label><input id="ops-loc-default" type="checkbox"/> default</label>' +
      '<button class="btn btn-primary" id="ops-loc-add">Add</button>' +
      '</div>' +
      '<table><thead><tr><th>Customer</th><th>Code</th><th>Plant</th><th>GSTIN</th><th>State</th><th>Address</th><th>Default</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8" style="color:var(--text-muted)">No locations.</td></tr>') + '</tbody></table>');
    byId("ops-loc-add").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.admin.upsertCustomerLocation({
          customer_id: byId("ops-loc-customer").value,
          location_code: byId("ops-loc-code").value,
          plant_name: byId("ops-loc-plant").value || null,
          gstin: byId("ops-loc-gstin").value || null,
          state_code: byId("ops-loc-state").value || null,
          city: byId("ops-loc-city").value || null,
          pincode: byId("ops-loc-pin").value || null,
          is_default: byId("ops-loc-default").checked,
        });
        renderCustomerLocations(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-loc-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.admin.deleteCustomerLocation(b.getAttribute("data-id")); renderCustomerLocations(body); }
      catch (err) { notifyError(err.message); }
    }));
  }

  async function renderItemMaster(body) {
    const out = await window.ObaraBackend.admin.listItemMaster({ limit: 200 });
    const rows = (out.items || []).slice(0, 200).map((it) =>
      '<tr><td><strong>' + escText(it.part_no) + '</strong><br/><span class="text-[11px]" style="color:var(--text-muted)">' + escText(it.description || "") + '</span></td>' +
      '<td>' + escText(it.drawing_no || "") + '</td>' +
      '<td>' + escText(it.uom || "") + '</td>' +
      '<td>' + escText(it.source_country || "") + '</td>' +
      '<td>' + escText(it.source_currency || "") + '</td>' +
      '<td>' + escText(it.purchase_price || "") + '</td>' +
      '<td>' + escText(it.hsn_sac || "") + '</td>' +
      '<td>' + escText(it.lifecycle) + '</td>' +
      '<td><button class="btn btn-ghost ops-item-del" data-id="' + escText(it.id) + '">Delete</button></td></tr>'
    ).join("");
    setOpsHtml(body, '<p class="text-[11px]" style="color:var(--text-muted)">Source: Item Master Template-FEB-2024.xlsx columns. ' + (out.items || []).length + ' rows shown.</p>' +
      '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<input id="ops-item-part" placeholder="Part No" style="width:140px"/>' +
      '<input id="ops-item-desc" placeholder="Description" style="width:200px"/>' +
      '<input id="ops-item-drawing" placeholder="Drawing No" style="width:140px"/>' +
      '<input id="ops-item-uom" placeholder="UOM" style="width:60px"/>' +
      '<select id="ops-item-source"><option value="">(source)</option><option value="O-KOREA">O-KOREA</option><option value="O-JAPAN">O-JAPAN</option><option value="O-CHINA">O-CHINA</option><option value="O-INDIA">O-INDIA</option><option value="O-THAILAND">O-THAILAND</option></select>' +
      '<select id="ops-item-curr"><option value="">(curr)</option><option value="USD">USD</option><option value="JPY">JPY</option><option value="CNY">CNY</option><option value="INR">INR</option><option value="THB">THB</option><option value="EUR">EUR</option></select>' +
      '<input id="ops-item-price" type="number" step="0.0001" placeholder="Purchase price" style="width:120px"/>' +
      '<input id="ops-item-hsn" placeholder="HSN/SAC" style="width:100px"/>' +
      '<button class="btn btn-primary" id="ops-item-add">Add/Update</button>' +
      '</div>' +
      '<table><thead><tr><th>Part</th><th>Drawing</th><th>UOM</th><th>Source</th><th>Curr</th><th>Price</th><th>HSN</th><th>Lifecycle</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="9" style="color:var(--text-muted)">No items.</td></tr>') + '</tbody></table>');
    byId("ops-item-add").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.admin.upsertItemMaster({
          part_no: byId("ops-item-part").value,
          description: byId("ops-item-desc").value || null,
          drawing_no: byId("ops-item-drawing").value || null,
          uom: byId("ops-item-uom").value || null,
          source_country: byId("ops-item-source").value || null,
          source_currency: byId("ops-item-curr").value || null,
          purchase_price: Number(byId("ops-item-price").value) || null,
          hsn_sac: byId("ops-item-hsn").value || null,
        });
        renderItemMaster(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-item-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.admin.deleteItemMaster(b.getAttribute("data-id")); renderItemMaster(body); }
      catch (err) { notifyError(err.message); }
    }));
  }

  async function renderContracts(body) {
    const out = await window.ObaraBackend.admin.listContracts();
    const customers = (await window.ObaraBackend.customers.list()).customers || [];
    const customerMap = {}; customers.forEach((c) => { customerMap[c.id] = c.customer_name || c.customer_key; });
    const customerOpts = '<option value="">(customer)</option>' + customers.map((c) => '<option value="' + escText(c.id) + '">' + escText(c.customer_name || c.customer_key) + '</option>').join("");
    const types = ["ARC","BLANKET_PO","AMC","ONE_OFF"];
    const rows = (out.contracts || []).map((c) =>
      '<tr><td><strong>' + escText(c.contract_number) + '</strong></td>' +
      '<td>' + escText(c.contract_type) + '</td>' +
      '<td>' + escText(customerMap[c.customer_id] || "") + '</td>' +
      '<td>' + escText(c.start_date) + ' to ' + escText(c.end_date || "open") + '</td>' +
      '<td>' + (c.total_value_inr ? Number(c.total_value_inr).toLocaleString() : "") + '</td>' +
      '<td><span class="ops-pill">' + escText(c.status) + '</span></td>' +
      '<td>' + (c.lines || []).length + ' lines</td>' +
      '<td><button class="btn btn-ghost ops-contract-del" data-id="' + escText(c.id) + '">Delete</button></td></tr>'
    ).join("");
    setOpsHtml(body, '<p class="text-[11px]" style="color:var(--text-muted)">ARC = Annual Rate Contract. BLANKET_PO covers multi-release orders (real example: MG OIQTLC-240123-MG-CONSUMABLES with 11 release POs).</p>' +
      '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<input id="ops-contract-num" placeholder="Contract #" style="width:140px"/>' +
      '<select id="ops-contract-type">' + types.map((t) => '<option value="' + t + '">' + t + '</option>').join("") + '</select>' +
      '<select id="ops-contract-customer">' + customerOpts + '</select>' +
      '<input id="ops-contract-start" type="date"/>' +
      '<input id="ops-contract-end" type="date"/>' +
      '<input id="ops-contract-value" type="number" placeholder="Total INR" style="width:140px"/>' +
      '<button class="btn btn-primary" id="ops-contract-add">Add</button>' +
      '</div>' +
      '<table><thead><tr><th>Contract</th><th>Type</th><th>Customer</th><th>Validity</th><th>Value</th><th>Status</th><th>Lines</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8" style="color:var(--text-muted)">No contracts.</td></tr>') + '</tbody></table>');
    byId("ops-contract-add").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.admin.upsertContract({
          contract_number: byId("ops-contract-num").value,
          contract_type: byId("ops-contract-type").value,
          customer_id: byId("ops-contract-customer").value,
          start_date: byId("ops-contract-start").value,
          end_date: byId("ops-contract-end").value || null,
          total_value_inr: Number(byId("ops-contract-value").value) || null,
        });
        renderContracts(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-contract-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.admin.deleteContract(b.getAttribute("data-id")); renderContracts(body); }
      catch (err) { notifyError(err.message); }
    }));
  }

  async function renderEquipmentHierarchy(body) {
    const customers = (await window.ObaraBackend.customers.list()).customers || [];
    const customerMap = {}; customers.forEach((c) => { customerMap[c.id] = c.customer_name || c.customer_key; });
    const customerOpts = '<option value="">(customer)</option>' + customers.map((c) => '<option value="' + escText(c.id) + '">' + escText(c.customer_name || c.customer_key) + '</option>').join("");
    const out = await window.ObaraBackend.admin.listEquipment();
    const rows = (out.equipment || []).slice(0, 200).map((e) =>
      '<tr><td>' + escText(customerMap[e.customer_id] || "") + '</td>' +
      '<td>' + escText(e.plant_name || "") + '</td>' +
      '<td>' + escText(e.line_name || "") + ' / ' + escText(e.zone_name || "") + '</td>' +
      '<td>' + escText(e.station_name || "") + '</td>' +
      '<td>' + escText(e.gun_no || "") + '</td>' +
      '<td>' + escText(e.gun_type || "") + '</td>' +
      '<td>' + escText(e.timer_model || "") + '</td>' +
      '<td>' + escText(e.atd_model || "") + '</td>' +
      '<td>' + (e.installed_parts || []).length + '</td>' +
      '<td><button class="btn btn-ghost ops-eq-del" data-id="' + escText(e.id) + '">Delete</button></td></tr>'
    ).join("");
    setOpsHtml(body, '<p class="text-[11px]" style="color:var(--text-muted)">Plant -&gt; Line -&gt; Zone -&gt; Station -&gt; Gun. Real example: JBM Plant 1, line names, gun nos like SRTX-S2C7117L. Use this to attach installed parts list per gun.</p>' +
      '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<select id="ops-eq-customer">' + customerOpts + '</select>' +
      '<input id="ops-eq-plant" placeholder="Plant" style="width:120px"/>' +
      '<input id="ops-eq-line" placeholder="Line" style="width:100px"/>' +
      '<input id="ops-eq-zone" placeholder="Zone" style="width:100px"/>' +
      '<input id="ops-eq-station" placeholder="Station" style="width:120px"/>' +
      '<input id="ops-eq-gun" placeholder="Gun No" style="width:140px"/>' +
      '<input id="ops-eq-type" placeholder="Gun type" style="width:100px"/>' +
      '<input id="ops-eq-timer" placeholder="Timer model" style="width:120px"/>' +
      '<input id="ops-eq-atd" placeholder="ATD model" style="width:120px"/>' +
      '<button class="btn btn-primary" id="ops-eq-add">Add</button>' +
      '</div>' +
      '<table><thead><tr><th>Customer</th><th>Plant</th><th>Line/Zone</th><th>Station</th><th>Gun</th><th>Type</th><th>Timer</th><th>ATD</th><th>Parts</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="10" style="color:var(--text-muted)">No equipment.</td></tr>') + '</tbody></table>');
    byId("ops-eq-add").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.admin.upsertEquipment({
          customer_id: byId("ops-eq-customer").value,
          plant_name: byId("ops-eq-plant").value || null,
          line_name: byId("ops-eq-line").value || null,
          zone_name: byId("ops-eq-zone").value || null,
          station_name: byId("ops-eq-station").value || null,
          gun_no: byId("ops-eq-gun").value || null,
          gun_type: byId("ops-eq-type").value || null,
          timer_model: byId("ops-eq-timer").value || null,
          atd_model: byId("ops-eq-atd").value || null,
        });
        renderEquipmentHierarchy(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-eq-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.admin.deleteEquipment(b.getAttribute("data-id")); renderEquipmentHierarchy(body); }
      catch (err) { notifyError(err.message); }
    }));
  }

  async function renderHolidays(body) {
    const out = await window.ObaraBackend.admin.listHolidays();
    const rows = (out.holidays || []).map((h) =>
      '<tr><td>' + escText(h.country) + '</td><td>' + escText(h.date) + '</td><td>' + escText(h.name || "") + '</td>' +
      '<td>' + (h.tenant_id ? '<button class="btn btn-ghost ops-admin-hol-del" data-id="' + escText(h.id) + '">Delete</button>' : '<span class="text-[11px]" style="color:var(--text-muted)">global seed</span>') + '</td></tr>'
    ).join("");
    setOpsHtml(body, '<div style="margin-bottom:8px">' +
      '<input id="ops-admin-hol-country" placeholder="IN" style="width:60px;text-transform:uppercase"/>' +
      '<input id="ops-admin-hol-date" type="date" style="width:140px"/>' +
      '<input id="ops-admin-hol-name" placeholder="name" style="width:160px"/>' +
      '<button class="btn btn-primary" id="ops-admin-hol-add">Add</button>' +
      '</div>' +
      '<table><thead><tr><th>Country</th><th>Date</th><th>Name</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4" style="color:var(--text-muted)">No holidays.</td></tr>') + '</tbody></table>');
    byId("ops-admin-hol-add").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.admin.upsertHoliday({
          country: byId("ops-admin-hol-country").value,
          date: byId("ops-admin-hol-date").value,
          name: byId("ops-admin-hol-name").value,
        });
        notifySuccess("Holiday saved");
        renderHolidays(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-admin-hol-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.admin.deleteHoliday(b.getAttribute("data-id")); renderHolidays(body); }
      catch (err) { notifyError(err.message); }
    }));
  }

  async function renderLeadTimes(body, type) {
    const out = await window.ObaraBackend.admin.listLeadTimes(type);
    const customersList = (await window.ObaraBackend.customers.list()).customers || [];
    const customerOptions = customersList.map((c) => '<option value="' + escText(c.id) + '">' + escText(c.customer_name || c.customer_key) + '</option>').join("");
    const fields = type === "customer"
      ? '<select id="ops-admin-lt-customer"><option value="">(any customer)</option>' + customerOptions + '</select>' +
        '<input id="ops-admin-lt-cat" placeholder="product category (optional)" style="width:160px"/>'
      : '<input id="ops-admin-lt-supplier" placeholder="supplier (optional)" style="width:140px"/>' +
        '<input id="ops-admin-lt-country" placeholder="country" style="width:80px;text-transform:uppercase"/>' +
        '<input id="ops-admin-lt-cat" placeholder="product category (optional)" style="width:160px"/>';
    const rows = (out.rows || []).map((r) => {
      const subject = type === "customer"
        ? (customersList.find((c) => c.id === r.customer_id) ? (customersList.find((c) => c.id === r.customer_id).customer_name || r.customer_id) : (r.customer_id || "any"))
        : (r.supplier || r.country || "?");
      return '<tr><td>' + escText(subject) + '</td>' +
        (type === "customer" ? '' : '<td>' + escText(r.country || "") + '</td>') +
        '<td>' + escText(r.product_category || "") + '</td>' +
        '<td>' + escText(r.lead_days) + '</td>' +
        '<td>' + escText(r.notes || "") + '</td>' +
        '<td><button class="btn btn-ghost ops-admin-lt-del" data-id="' + escText(r.id) + '">Delete</button></td></tr>';
    }).join("");
    const headSubject = type === "customer" ? "Customer" : "Supplier";
    const headCols = type === "customer"
      ? '<th>Customer</th><th>Category</th><th>Days</th><th>Notes</th><th></th>'
      : '<th>Supplier</th><th>Country</th><th>Category</th><th>Days</th><th>Notes</th><th></th>';
    setOpsHtml(body, '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      fields +
      '<input id="ops-admin-lt-days" type="number" placeholder="days" style="width:80px"/>' +
      '<input id="ops-admin-lt-notes" placeholder="notes" style="width:200px"/>' +
      '<button class="btn btn-primary" id="ops-admin-lt-add">Add</button>' +
      '</div>' +
      '<table><thead><tr>' + headCols + '</tr></thead><tbody>' +
      (rows || '<tr><td colspan="6" style="color:var(--text-muted)">No entries.</td></tr>') + '</tbody></table>');
    byId("ops-admin-lt-add").addEventListener("click", async () => {
      try {
        const payload = {
          product_category: byId("ops-admin-lt-cat").value || null,
          lead_days: Number(byId("ops-admin-lt-days").value) || 0,
          notes: byId("ops-admin-lt-notes").value || null,
        };
        if (type === "customer") payload.customer_id = byId("ops-admin-lt-customer").value || null;
        else { payload.supplier = byId("ops-admin-lt-supplier").value || null; payload.country = byId("ops-admin-lt-country").value; }
        await window.ObaraBackend.admin.upsertLeadTime(type, payload);
        notifySuccess("Lead time saved");
        renderLeadTimes(body, type);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-admin-lt-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.admin.deleteLeadTime(type, b.getAttribute("data-id")); renderLeadTimes(body, type); }
      catch (err) { notifyError(err.message); }
    }));
  }

  async function renderBom(body) {
    const out = await window.ObaraBackend.bom.list();
    const rows = (out.bom || out.rows || []).map((r) =>
      '<tr><td>' + escText(r.parent_part_no) + '</td><td>' + escText(r.child_part_no) + '</td>' +
      '<td>' + escText(r.qty) + '</td><td>' + escText(r.uom || "") + '</td>' +
      '<td><button class="btn btn-ghost ops-admin-bom-del" data-id="' + escText(r.id) + '">Delete</button></td></tr>'
    ).join("");
    setOpsHtml(body, '<div style="margin-bottom:8px">' +
      '<input id="ops-admin-bom-parent" placeholder="parent part" style="width:140px"/>' +
      '<input id="ops-admin-bom-child" placeholder="child part" style="width:140px"/>' +
      '<input id="ops-admin-bom-qty" type="number" step="0.0001" placeholder="qty" style="width:80px"/>' +
      '<input id="ops-admin-bom-uom" placeholder="uom" style="width:80px"/>' +
      '<button class="btn btn-primary" id="ops-admin-bom-add">Add</button>' +
      '</div>' +
      '<table><thead><tr><th>Parent</th><th>Child</th><th>Qty</th><th>UOM</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" style="color:var(--text-muted)">No BOM rows.</td></tr>') + '</tbody></table>');
    byId("ops-admin-bom-add").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.bom.upsert({
          parent_part_no: byId("ops-admin-bom-parent").value,
          child_part_no: byId("ops-admin-bom-child").value,
          qty: Number(byId("ops-admin-bom-qty").value) || 1,
          uom: byId("ops-admin-bom-uom").value || null,
        });
        notifySuccess("BOM row saved");
        renderBom(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-admin-bom-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.bom.remove(b.getAttribute("data-id")); renderBom(body); }
      catch (err) { notifyError(err.message); }
    }));
  }

  async function renderInventory(body) {
    const out = await window.ObaraBackend.admin.listInventory({ limit: 500 });
    const rows = (out.items || []).slice(0, 200).map((it) =>
      '<tr><td>' + escText(it.stock_item_name) + '</td>' +
      '<td>' + escText(it.available_qty) + '</td>' +
      '<td>' + escText(it.reserved_qty) + '</td>' +
      '<td>' + escText(it.reorder_level) + '</td>' +
      '<td>' + escText(it.uom || "") + '</td>' +
      '<td>' + escText((it.last_sync_at || "").slice(0, 16).replace("T", " ")) + '</td>' +
      '<td><button class="btn btn-ghost ops-admin-inv-del" data-id="' + escText(it.id) + '">Delete</button></td></tr>'
    ).join("");
    setOpsHtml(body, '<div style="margin-bottom:8px">' +
      '<input id="ops-admin-inv-name" placeholder="stock item name" style="width:200px"/>' +
      '<input id="ops-admin-inv-avail" type="number" placeholder="available" style="width:90px"/>' +
      '<input id="ops-admin-inv-reserved" type="number" placeholder="reserved" style="width:90px"/>' +
      '<input id="ops-admin-inv-reorder" type="number" placeholder="reorder" style="width:90px"/>' +
      '<input id="ops-admin-inv-uom" placeholder="uom" style="width:60px"/>' +
      '<button class="btn btn-primary" id="ops-admin-inv-add">Upsert</button>' +
      '</div>' +
      '<table><thead><tr><th>Stock item</th><th>Avail</th><th>Reserved</th><th>Reorder</th><th>UOM</th><th>Last sync</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="7" style="color:var(--text-muted)">No inventory rows.</td></tr>') + '</tbody></table>');
    byId("ops-admin-inv-add").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.admin.upsertInventory({
          stock_item_name: byId("ops-admin-inv-name").value,
          available_qty: Number(byId("ops-admin-inv-avail").value) || 0,
          reserved_qty: Number(byId("ops-admin-inv-reserved").value) || 0,
          reorder_level: Number(byId("ops-admin-inv-reorder").value) || 0,
          uom: byId("ops-admin-inv-uom").value || null,
        });
        notifySuccess("Inventory upserted");
        renderInventory(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-admin-inv-del").forEach((b) => b.addEventListener("click", async () => {
      try { await window.ObaraBackend.admin.deleteInventory(b.getAttribute("data-id")); renderInventory(body); }
      catch (err) { notifyError(err.message); }
    }));
  }

  async function renderFxAdmin(body) {
    const out = await window.ObaraBackend.admin.listFxRates({ days: 90 });
    const recent = (out.rates || []).slice(0, 100);
    const rows = recent.map((r) =>
      '<tr><td>' + escText(r.as_of) + '</td><td>' + escText(r.from_ccy) + '</td><td>' + escText(r.to_ccy) + '</td>' +
      '<td>' + escText(Number(r.rate).toFixed(6)) + '</td><td>' + escText(r.source || "") + '</td></tr>'
    ).join("");
    setOpsHtml(body, '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      '<label>As of <input id="ops-admin-fx-asof" type="date" style="width:140px"/></label>' +
      '<label>Bases <input id="ops-admin-fx-bases" placeholder="USD,INR,CNY,JPY,KRW,EUR" style="width:220px"/></label>' +
      '<label>Targets <input id="ops-admin-fx-targets" placeholder="USD,INR,CNY,JPY,KRW,EUR" style="width:220px"/></label>' +
      '<button class="btn btn-primary" id="ops-admin-fx-refresh">Refresh now</button>' +
      '</div>' +
      '<p class="text-[11px]" style="color:var(--text-muted)">Last 100 rates from the past 90 days. The cron also writes daily; this triggers a manual fetch for any historical date.</p>' +
      '<table><thead><tr><th>As of</th><th>From</th><th>To</th><th>Rate</th><th>Source</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" style="color:var(--text-muted)">No rates yet.</td></tr>') + '</tbody></table>');
    byId("ops-admin-fx-refresh").addEventListener("click", async () => {
      try {
        const asOf = byId("ops-admin-fx-asof").value || null;
        const bases = byId("ops-admin-fx-bases").value.split(",").map((s) => s.trim()).filter(Boolean);
        const targets = byId("ops-admin-fx-targets").value.split(",").map((s) => s.trim()).filter(Boolean);
        const result = await window.ObaraBackend.admin.refreshFxRates({ asOf, bases: bases.length ? bases : undefined, targets: targets.length ? targets : undefined });
        notifySuccess("FX refreshed: " + result.rows + " rows for " + result.asOf);
        renderFxAdmin(body);
      } catch (err) { notifyError(err.message); }
    });
  }

  async function renderMembers(body) {
    const out = await window.ObaraBackend.admin.listMembers();
    const roles = ["sales_engineer","sales_manager","approver","viewer","admin","operator","finance"];
    const rows = (out.members || []).map((m) =>
      '<tr><td>' + escText(m.email || "") + '</td>' +
      '<td><select class="ops-admin-mem-role" data-user="' + escText(m.user_id) + '">' +
        roles.map((r) => '<option value="' + r + '"' + (r === m.role ? ' selected' : '') + '>' + r + '</option>').join("") +
      '</select></td>' +
      '<td>' + escText((m.last_sign_in_at || "").slice(0, 16).replace("T", " ")) + '</td>' +
      '<td><button class="btn btn-ghost ops-admin-mem-del" data-user="' + escText(m.user_id) + '">Revoke</button></td></tr>'
    ).join("");
    setOpsHtml(body, '<div style="margin-bottom:8px">' +
      '<input id="ops-admin-mem-email" type="email" placeholder="email" style="width:200px"/>' +
      '<select id="ops-admin-mem-role-new">' + roles.map((r) => '<option value="' + r + '">' + r + '</option>').join("") + '</select>' +
      '<button class="btn btn-primary" id="ops-admin-mem-invite">Invite (sends magic link)</button>' +
      '</div>' +
      '<table><thead><tr><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4" style="color:var(--text-muted)">No members.</td></tr>') + '</tbody></table>');
    byId("ops-admin-mem-invite").addEventListener("click", async () => {
      try {
        await window.ObaraBackend.admin.inviteMember({
          email: byId("ops-admin-mem-email").value,
          role: byId("ops-admin-mem-role-new").value,
        });
        notifySuccess("Invite sent");
        renderMembers(body);
      } catch (err) { notifyError(err.message); }
    });
    document.querySelectorAll(".ops-admin-mem-role").forEach((sel) => sel.addEventListener("change", async () => {
      try {
        await window.ObaraBackend.admin.updateMemberRole({ user_id: sel.getAttribute("data-user"), role: sel.value });
        notifySuccess("Role updated");
      } catch (err) { notifyError(err.message); }
    }));
    document.querySelectorAll(".ops-admin-mem-del").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Revoke this member?")) return;
      try { await window.ObaraBackend.admin.revokeMember(b.getAttribute("data-user")); renderMembers(body); }
      catch (err) { notifyError(err.message); }
    }));
  }

  // ── E-INVOICE (Indian GST IRN/QR generation against an order) ──
  async function showEinvoiceModal() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<p>Indian GST e-Invoice (IRN + QR). Configure GSTN_API_URL to send to GSTN; without it, drafts persist locally.</p>' +
      '<div id="ops-einv-body">Loading...</div></div>';
    showOpsModal("e-Invoice", html);
    await renderEinvoices();
  }
  async function renderEinvoices() {
    const body = byId("ops-einv-body");
    if (!body) return;
    try {
      const out = await window.ObaraBackend.einvoice.list({ limit: 200 });
      const orders = (await window.ObaraBackend.orders.list({ limit: 50, status: "APPROVED" })).orders || [];
      const orderOpts = '<option value="">(approved order)</option>' + orders.map((o) => '<option value="' + escText(o.id) + '">' + escText(o.po_number || o.id.slice(0, 8)) + '</option>').join("");
      const banner = out.gstn_configured
        ? '<p class="text-[11px]" style="color:var(--text-muted)">GSTN_API_URL is configured. "Send to GSTN" calls the production API.</p>'
        : '<p class="text-[11px]" style="color:#92400e">GSTN_API_URL not configured. "Send to GSTN" parks rows in PENDING_GSTN until you set the env var.</p>';
      const rows = (out.einvoices || []).map((ei) =>
        '<tr><td><strong>' + escText(ei.invoice_number) + '</strong><br/><span class="text-[11px]" style="color:var(--text-muted)">' + escText(ei.invoice_date) + '</span></td>' +
        '<td>' + escText(String(ei.order_id || "").slice(0, 8)) + '</td>' +
        '<td><span class="ops-pill">' + escText(ei.status) + '</span></td>' +
        '<td>' + (ei.taxable_value != null ? Number(ei.taxable_value).toLocaleString() : "") + '</td>' +
        '<td>' + escText(ei.irn || "") + '</td>' +
        '<td>' +
          (ei.status === "DRAFT" ? '<button class="btn btn-primary ops-einv-send" data-id="' + escText(ei.id) + '">Send to GSTN</button>' : '') +
          (ei.status === "GENERATED" ? '<button class="btn btn-ghost ops-einv-cancel" data-id="' + escText(ei.id) + '">Cancel</button>' : '') +
          (ei.status === "DRAFT" || ei.status === "REJECTED" ? '<button class="btn btn-ghost ops-einv-del" data-id="' + escText(ei.id) + '">Delete</button>' : '') +
        '</td></tr>'
      ).join("");
      setOpsHtml(body, banner +
        '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
        '<select id="ops-einv-order">' + orderOpts + '</select>' +
        '<input id="ops-einv-num" placeholder="Invoice #" style="width:140px"/>' +
        '<input id="ops-einv-date" type="date"/>' +
        '<input id="ops-einv-seller" placeholder="Seller GSTIN" style="width:160px" value="27AAACO8335K1Z5"/>' +
        '<button class="btn btn-primary" id="ops-einv-add">Compose draft</button>' +
        '</div>' +
        '<table><thead><tr><th>Invoice</th><th>Order</th><th>Status</th><th>Taxable</th><th>IRN</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="6" style="color:var(--text-muted)">No e-invoices.</td></tr>') + '</tbody></table>');
      byId("ops-einv-add").addEventListener("click", async () => {
        try {
          await window.ObaraBackend.einvoice.createDraft({
            order_id: byId("ops-einv-order").value,
            invoice_number: byId("ops-einv-num").value,
            invoice_date: byId("ops-einv-date").value,
            seller_gstin: byId("ops-einv-seller").value || null,
          });
          renderEinvoices();
        } catch (err) { notifyError(err.message); }
      });
      document.querySelectorAll(".ops-einv-send").forEach((b) => b.addEventListener("click", async () => {
        try { const r = await window.ObaraBackend.einvoice.sendToGstn(b.getAttribute("data-id")); notifySuccess("Status: " + ((r.einvoice && r.einvoice.status) || "?")); renderEinvoices(); }
        catch (err) { notifyError(err.message); }
      }));
      document.querySelectorAll(".ops-einv-cancel").forEach((b) => b.addEventListener("click", async () => {
        const reason = prompt("Cancel reason (1=duplicate, 2=data entry, 3=order cancelled, 4=other):"); if (!reason) return;
        const remarks = prompt("Cancel remarks:") || "";
        try { await window.ObaraBackend.einvoice.cancel({ id: b.getAttribute("data-id"), cancel_reason: reason, cancel_remarks: remarks }); renderEinvoices(); }
        catch (err) { notifyError(err.message); }
      }));
      document.querySelectorAll(".ops-einv-del").forEach((b) => b.addEventListener("click", async () => {
        try { await window.ObaraBackend.einvoice.remove(b.getAttribute("data-id")); renderEinvoices(); }
        catch (err) { notifyError(err.message); }
      }));
    } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">' + escText(err.message) + '</p>'); }
  }

  // ── FORECASTING DASHBOARD ──
  async function showForecastingModal() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">' +
      '<label>Segment <select id="ops-fc-dim">' +
        '<option value="overall">Overall</option>' +
        '<option value="customer_type">Customer type</option>' +
        '<option value="territory">Territory (state)</option>' +
        '<option value="order_mode">Order mode</option>' +
      '</select></label>' +
      '<label><input id="ops-fc-fresh" type="checkbox"/> Real-time (skip cached snapshot)</label>' +
      '<button class="btn btn-primary" id="ops-fc-go">Refresh</button>' +
      '<button class="btn btn-ghost" id="ops-fc-snap">Persist nightly snapshot</button>' +
      '</div>' +
      '<div id="ops-fc-body">Loading...</div></div>';
    showOpsModal("Forecasting", html);
    const load = async () => {
      const out = await window.ObaraBackend.forecast.get({ dimension: byId("ops-fc-dim").value, fresh: byId("ops-fc-fresh").checked ? "1" : "0" });
      const buckets = out.buckets || [];
      const rows = buckets.map((b) =>
        '<tr><td>' + escText(b.segment_value) + '</td>' +
        '<td>' + (b.open_count || 0) + '</td>' +
        '<td>' + (b.open_amount_inr ? Number(b.open_amount_inr).toLocaleString() : 0) + '</td>' +
        '<td>' + (b.weighted_amount_inr ? Number(b.weighted_amount_inr).toLocaleString() : 0) + '</td>' +
        '<td>' + (b.next_30_days_amount_inr ? Number(b.next_30_days_amount_inr).toLocaleString() : 0) + '</td>' +
        '<td>' + (b.next_90_days_amount_inr ? Number(b.next_90_days_amount_inr).toLocaleString() : 0) + '</td>' +
        '<td>' + (b.won_count || 0) + ' / ' + (b.lost_count || 0) + '</td>' +
        '</tr>'
      ).join("");
      setOpsHtml(byId("ops-fc-body"), '<p class="text-[11px]" style="color:var(--text-muted)">As of ' + escText(out.as_of || "n/a") + (out.fresh ? " (real-time)" : " (cached snapshot)") + '</p>' +
        '<table><thead><tr><th>Segment</th><th>Open count</th><th>Open INR</th><th>Weighted INR</th><th>Next 30d</th><th>Next 90d</th><th>Won / Lost</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="7" style="color:var(--text-muted)">No data. Add opportunities under Sales Pipeline.</td></tr>') + '</tbody></table>');
    };
    byId("ops-fc-go").addEventListener("click", load);
    byId("ops-fc-snap").addEventListener("click", async () => {
      try { const out = await window.ObaraBackend.forecast.snapshot(); notifySuccess("Snapshot written: " + out.written + " rows for " + out.asOf); load(); }
      catch (err) { notifyError(err.message); }
    });
    byId("ops-fc-dim").addEventListener("change", load);
    byId("ops-fc-fresh").addEventListener("change", load);
    load();
  }

  // ── AMC SCHEDULE (preventive maintenance) ──
  async function showAmcModal() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<p>AMC schedules drive auto-generated service visits. Visits also auto-generate via the daily cron at /api/service/amc_cron.</p>' +
      '<div id="ops-amc-body">Loading...</div></div>';
    showOpsModal("AMC Schedule", html);
    await renderAmc();
  }
  async function renderAmc() {
    const body = byId("ops-amc-body");
    if (!body) return;
    try {
      const out = await window.ObaraBackend.service.listAmcSchedules({ limit: 500 });
      const contracts = (await window.ObaraBackend.admin.listContracts({ type: "AMC" })).contracts || [];
      const contractOpts = '<option value="">(AMC contract)</option>' + contracts.map((c) => '<option value="' + escText(c.id) + '" data-customer="' + escText(c.customer_id || "") + '">' + escText(c.contract_number) + '</option>').join("");
      const rows = (out.amc_schedules || []).map((s) =>
        '<tr><td>' + escText(s.scheduled_date) + '</td>' +
        '<td>' + escText(s.visit_label || "") + '</td>' +
        '<td>' + escText(s.visit_type) + '</td>' +
        '<td><span class="ops-pill">' + escText(s.status) + '</span></td>' +
        '<td>' +
          (s.status === "SCHEDULED" ? '<button class="btn btn-primary ops-amc-gen" data-id="' + escText(s.id) + '">Generate visit</button>' : '') +
          '<button class="btn btn-ghost ops-amc-del" data-id="' + escText(s.id) + '">Delete</button>' +
        '</td></tr>'
      ).join("");
      setOpsHtml(body, '<h4 style="font-size:12px;font-weight:800">Bulk seed from contract</h4>' +
        '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
        '<select id="ops-amc-contract">' + contractOpts + '</select>' +
        '<select id="ops-amc-freq"><option value="QUARTERLY">Quarterly</option><option value="MONTHLY">Monthly</option><option value="BIANNUAL">Bi-annual</option><option value="ANNUAL">Annual</option></select>' +
        '<input id="ops-amc-start" type="date"/>' +
        '<input id="ops-amc-count" type="number" value="4" style="width:60px" placeholder="count"/>' +
        '<input id="ops-amc-label" placeholder="visit label (optional)" style="width:200px"/>' +
        '<button class="btn btn-primary" id="ops-amc-seed">Seed</button>' +
        '</div>' +
        '<table><thead><tr><th>Date</th><th>Label</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5" style="color:var(--text-muted)">No AMC schedules.</td></tr>') + '</tbody></table>');
      byId("ops-amc-seed").addEventListener("click", async () => {
        const sel = byId("ops-amc-contract"); const opt = sel.options[sel.selectedIndex];
        const customer_id = opt && opt.getAttribute("data-customer");
        if (!sel.value || !customer_id) { notifyWarn("Pick an AMC contract"); return; }
        try {
          await window.ObaraBackend.service.bulkSeedAmcSchedule({
            contract_id: sel.value,
            frequency: byId("ops-amc-freq").value,
            start_date: byId("ops-amc-start").value,
            count: Number(byId("ops-amc-count").value) || 4,
            visit_label: byId("ops-amc-label").value || null,
          });
          renderAmc();
        } catch (err) { notifyError(err.message); }
      });
      document.querySelectorAll(".ops-amc-gen").forEach((b) => b.addEventListener("click", async () => {
        try { await window.ObaraBackend.service.generateAmcVisit(b.getAttribute("data-id")); notifySuccess("Visit created"); renderAmc(); }
        catch (err) { notifyError(err.message); }
      }));
      document.querySelectorAll(".ops-amc-del").forEach((b) => b.addEventListener("click", async () => {
        try { await window.ObaraBackend.service.deleteAmcSchedule(b.getAttribute("data-id")); renderAmc(); }
        catch (err) { notifyError(err.message); }
      }));
    } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">' + escText(err.message) + '</p>'); }
  }

  // ── SCHEDULE LINES (delivery schedules attached to a customer PO) ──
  // Source: real MG Motor POs that say "*As per Schedule Lines, to be sent separately".
  async function showScheduleLinesModal(orderId) {
    if (!ensureBackend()) return;
    if (!orderId) {
      const orders = (await window.ObaraBackend.orders.list({ limit: 50 })).orders || [];
      const sel = prompt("Order id (one of):\\n" + orders.slice(0, 8).map((o) => o.id.slice(0, 8) + " " + (o.po_number || "")).join("\\n"));
      if (!sel) return;
      const match = orders.find((o) => o.id.startsWith(sel));
      if (!match) { notifyWarn("No matching order"); return; }
      orderId = match.id;
    }
    showOpsModal("Schedule Lines", '<div class="ops-modal-body" style="max-width:none;width:100%"><p>Order ' + escText(orderId.slice(0, 8)) + '</p><div id="ops-sched-body">Loading...</div></div>');
    await renderScheduleLines(orderId);
  }
  async function renderScheduleLines(orderId) {
    const body = byId("ops-sched-body");
    if (!body) return;
    try {
      const out = await window.ObaraBackend.scheduleLines.list(orderId);
      const rows = (out.schedule_lines || []).map((s) =>
        '<tr><td>' + (s.line_index != null ? s.line_index : "") + '</td>' +
        '<td>' + escText(s.part_no || "") + '</td>' +
        '<td>' + escText(s.scheduled_qty) + '</td>' +
        '<td>' + escText(s.scheduled_date) + '</td>' +
        '<td>' + escText(s.delivery_location || "") + '</td>' +
        '<td>' + escText(s.remark || "") + '</td>' +
        '<td><button class="btn btn-ghost ops-sched-del" data-id="' + escText(s.id) + '">Delete</button></td></tr>'
      ).join("");
      setOpsHtml(body, '<p class="text-[11px]" style="color:var(--text-muted)">Paste schedule rows TSV: part_no\\tqty\\tdate\\tlocation\\tremark</p>' +
        '<textarea id="ops-sched-paste" rows="6" style="width:100%;font-family:monospace;font-size:12px" placeholder="C007011\\t10\\t2026-06-01\\tHALOL\\tFirst dispatch"></textarea>' +
        '<div class="ops-actions"><button class="btn btn-primary" id="ops-sched-import">Import</button>' +
        '<button class="btn btn-ghost" id="ops-sched-clear">Clear all</button></div>' +
        '<table><thead><tr><th>#</th><th>Part</th><th>Qty</th><th>Date</th><th>Location</th><th>Remark</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="7" style="color:var(--text-muted)">No schedule lines.</td></tr>') + '</tbody></table>');
      byId("ops-sched-import").addEventListener("click", async () => {
        const text = byId("ops-sched-paste").value || "";
        const lines = text.split(/\\r?\\n/).filter((l) => l.trim().length > 0);
        const rowsIn = lines.map((l, i) => {
          const c = l.split("\t");
          return { line_index: i + 1, part_no: c[0] || null, scheduled_qty: Number(c[1]) || 0, scheduled_date: c[2] || null, delivery_location: c[3] || null, remark: c[4] || null };
        });
        try { await window.ObaraBackend.scheduleLines.bulkCreate(orderId, rowsIn); renderScheduleLines(orderId); }
        catch (err) { notifyError(err.message); }
      });
      byId("ops-sched-clear").addEventListener("click", async () => {
        if (!confirm("Clear all schedule lines for this order?")) return;
        try { await window.ObaraBackend.scheduleLines.clear(orderId); renderScheduleLines(orderId); }
        catch (err) { notifyError(err.message); }
      });
      document.querySelectorAll(".ops-sched-del").forEach((b) => b.addEventListener("click", async () => {
        try { await window.ObaraBackend.scheduleLines.deleteOne(b.getAttribute("data-id")); renderScheduleLines(orderId); }
        catch (err) { notifyError(err.message); }
      }));
    } catch (err) { setOpsHtml(body, '<p style="color:var(--err)">' + escText(err.message) + '</p>'); }
  }

  // ── JBM SPARE MATRIX IMPORTER ──
  // Source: pending feature "JBM spare matrix one-click import - the 6.5MB JBM file
  // is structured enough to write a custom importer that populates equipment_hierarchy
  // and equipment_installed_parts automatically."
  async function showJbmImporterModal() {
    if (!ensureBackend()) return;
    const html = '<div class="ops-modal-body" style="max-width:none;width:100%">' +
      '<p>Upload a JBM-style spare matrix XLSX. Columns expected: Line, Zone, Station Name, Robot Make, Robot No, GUN NO, GUN TYPE, Timer, ATD, plus part columns. Each row becomes one equipment_hierarchy node; the part columns are exploded into equipment_installed_parts.</p>' +
      '<label>Customer <select id="ops-jbm-customer">Loading...</select></label>' +
      '<label>File <input id="ops-jbm-file" type="file" accept=".xlsx,.xls" /></label>' +
      '<div class="ops-actions"><button class="btn btn-primary" id="ops-jbm-go">Import</button></div>' +
      '<div id="ops-jbm-status" style="margin-top:8px;font-size:12px;color:var(--text-muted)"></div></div>';
    showOpsModal("JBM Spare Matrix Importer", html);
    const customers = (await window.ObaraBackend.customers.list()).customers || [];
    setOpsHtml(byId("ops-jbm-customer"), customers.map((c) => '<option value="' + escText(c.id) + '">' + escText(c.customer_name || c.customer_key) + '</option>').join(""));
    byId("ops-jbm-go").addEventListener("click", async () => {
      const status = byId("ops-jbm-status");
      const file = byId("ops-jbm-file").files[0];
      const customerId = byId("ops-jbm-customer").value;
      if (!file) { if (status) status.textContent = "Pick a file"; return; }
      if (!customerId) { if (status) status.textContent = "Pick a customer"; return; }
      if (!window.XLSX) { if (status) status.textContent = "XLSX library not loaded"; return; }
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        if (aoa.length < 2) { if (status) status.textContent = "Sheet has no rows"; return; }
        const header = aoa[0].map((h) => String(h || "").trim());
        const idxOf = (label) => header.findIndex((h) => h.toLowerCase() === label.toLowerCase());
        const lineIdx = idxOf("Line");
        const zoneIdx = idxOf("Zone");
        const stationIdx = idxOf("Station Name");
        const robotMakeIdx = idxOf("Robot Make");
        const robotNoIdx = idxOf("Robot No");
        const gunIdx = header.findIndex((h) => /gun\s*no/i.test(h));
        const gunTypeIdx = header.findIndex((h) => /gun\s*type/i.test(h));
        const timerIdx = idxOf("Timer");
        const atdIdx = idxOf("ATD");
        const knownCols = new Set([lineIdx, zoneIdx, stationIdx, robotMakeIdx, robotNoIdx, gunIdx, gunTypeIdx, timerIdx, atdIdx, idxOf("SI NO"), idxOf("S NO"), idxOf("Sl No"), idxOf("Qty"), idxOf("QTY")]);
        let nodesCreated = 0;
        let partsCreated = 0;
        for (let r = 1; r < aoa.length; r++) {
          const row = aoa[r];
          if (!row || !row.length) continue;
          const gunNo = gunIdx >= 0 ? String(row[gunIdx] || "").trim() : "";
          const station = stationIdx >= 0 ? String(row[stationIdx] || "").trim() : "";
          if (!gunNo && !station) continue;
          const eq = await window.ObaraBackend.admin.upsertEquipment({
            customer_id: customerId,
            line_name: lineIdx >= 0 ? String(row[lineIdx] || "").trim() : null,
            zone_name: zoneIdx >= 0 ? String(row[zoneIdx] || "").trim() : null,
            station_name: station || null,
            robot_make: robotMakeIdx >= 0 ? String(row[robotMakeIdx] || "").trim() : null,
            robot_no: robotNoIdx >= 0 ? String(row[robotNoIdx] || "").trim() : null,
            gun_no: gunNo || null,
            gun_type: gunTypeIdx >= 0 ? String(row[gunTypeIdx] || "").trim() : null,
            timer_model: timerIdx >= 0 ? String(row[timerIdx] || "").trim() : null,
            atd_model: atdIdx >= 0 ? String(row[atdIdx] || "").trim() : null,
            installed_parts: header.map((h, i) => {
              if (knownCols.has(i)) return null;
              const v = row[i];
              if (v == null || String(v).trim() === "") return null;
              const qty = Number(v);
              return {
                part_no: h,
                description: h,
                installed_qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
                is_critical: false,
              };
            }).filter(Boolean),
          });
          nodesCreated++;
          partsCreated += (eq.equipment && eq.equipment.installed_parts && eq.equipment.installed_parts.length) || 0;
          if (status && r % 5 === 0) status.textContent = "Imported " + nodesCreated + " nodes...";
        }
        if (status) status.textContent = "Done. " + nodesCreated + " equipment nodes imported.";
        notifySuccess("JBM matrix imported: " + nodesCreated + " nodes");
      } catch (err) {
        if (status) status.textContent = "Import failed: " + err.message;
        notifyError(err.message);
      }
    });
  }

  // ── EXTEND ACTION LIST ──
  actionList.push(
    { id:"backend-connect", label:"Connect Backend", detail:"Configure the Vercel API URL and Supabase token", run:showBackendModal, key:"Backend" },
    { id:"alias-manager", label:"Customer Part Aliases", detail:"Browse alias map between customer P/N and Obara P/N", run:showAliasManager, key:"Aliases" },
    { id:"tally-master-import", label:"Sync Tally Masters", detail:"Upload stock/ledger/UOM exports for validation", run:showTallyMasterImport, key:"Tally" },
    { id:"role-queues", label:"My Queue", detail:"Filter orders to those waiting on your role", run:showRoleQueues, key:"Queue" },
    { id:"master-data", label:"Master Data Graph", detail:"Customers, orders, source POs, parts, suppliers, BOM relationships", run:() => showMasterDataTab("table"), key:"Graph" },
    { id:"master-data-graph", label:"Master Data (graph view)", detail:"Cytoscape force-directed view of the same data", run:() => showMasterDataTab("graph"), key:"Graph" },
    { id:"profile-studio", label:"Customer Format Studio", detail:"Edit fingerprint, manage versions, attach golden examples", run:() => showProfileStudio(null), key:"Studio" },
    { id:"process-mining", label:"Process Mining", detail:"Cycle time, blocker frequency, fields with most edits", run:showProcessMining, key:"Process" },
    { id:"audit-pack-latest", label:"Export Audit Pack (latest order)", detail:"Bundle latest order, audit events, and process log into a ZIP", run:() => exportDocumentPackage(), key:"Audit" },
    { id:"audit-pack-pdf", label:"Export Audit Pack (PDF)", detail:"Printable PDF version of the latest order audit pack", run:() => exportDocumentPackage(null, { format: "pdf" }), key:"Audit" },
    { id:"source-po-procurement", label:"Source PO Procurement", detail:"Open POs, ack form, supplier scorecards", run:showSourcePoProcurement, key:"Procurement" },
    { id:"eval-dashboard", label:"Eval Dashboard", detail:"Pass rate, field heatmap, recent runs, case editor", run:showEvalDashboard, key:"Eval" },
    { id:"email-triage", label:"Email Triage", detail:"Inbound classified emails, missing-doc drafts", run:showEmailTriage, key:"Triage" },
    { id:"spare-matrix-intel", label:"Spare Matrix Intelligence", detail:"Recommend, kit, opportunities, obsolete", run:showSpareMatrixIntelligence, key:"Spares" },
    { id:"security-center", label:"Security Center", detail:"Redaction rules, injection tests, model routing log", run:showSecurityCenter, key:"Security" },
    { id:"cost-analytics-deep", label:"Cost Analytics Deep", detail:"Breakdown, simulator, margin history", run:showCostAnalyticsDeep, key:"Cost" },
    { id:"admin-center", label:"Admin Center", detail:"Holidays, lead times, BOM, inventory, FX, members, locations, items, contracts, equipment", run:showAdminCenter, key:"Admin" },
    { id:"sales-pipeline", label:"Sales Pipeline", detail:"Leads, Opportunities, lost reasons", run:showSalesPipeline, key:"Sales" },
    { id:"internal-so", label:"Internal Sales Orders", detail:"FOC supply, warranty replacement, product trial, expected PO, internal transfer", run:showInternalSoModal, key:"InternalSO" },
    { id:"project-tracker", label:"Project Tracker", detail:"14-phase project lifecycle from corpus tracker", run:showProjectTracker, key:"Project" },
    { id:"shipments-pod", label:"Shipments and POD", detail:"Mode (SEA/AIR), vessel, port arrival, warehouse receipt, POD", run:showShipmentsModal, key:"Shipping" },
    { id:"service-module", label:"Service (Visits, CAR)", detail:"Field visits with check-in/out and Concern Analysis Reports", run:showServiceModal, key:"Service" },
    { id:"einvoice", label:"e-Invoice (GST IRN)", detail:"Compose, send to GSTN, view IRN/QR, cancel within 24h", run:showEinvoiceModal, key:"einvoice" },
    { id:"forecasting", label:"Forecasting", detail:"Pipeline by territory, customer type, order mode", run:showForecastingModal, key:"Forecast" },
    { id:"amc-schedule", label:"AMC Schedule", detail:"Bulk-seed preventive visits from contracts; auto-generate visits via cron", run:showAmcModal, key:"AMC" },
    { id:"schedule-lines", label:"Schedule Lines", detail:"Customer delivery schedules attached to a PO", run:() => showScheduleLinesModal(null), key:"Schedule" },
    { id:"jbm-importer", label:"JBM Spare Matrix Importer", detail:"One-click XLSX import to equipment_hierarchy + installed_parts", run:showJbmImporterModal, key:"Importer" },
    { id:"theme-toggle", label:"Toggle Theme", detail:"Switch between light and dark mode", run:toggleTheme, key:"Theme" },
    { id:"sample-load", label:"Load Sample Data", detail:"Seed a demo customer profile and order so you can explore without uploads", run:seedSampleDataIntoStorage, key:"Demo" },
    { id:"sample-clear", label:"Clear Sample Data", detail:"Remove the demo profile and order", run:clearSampleDataFromStorage, key:"Demo" },
    { id:"cost-analytics", label:"Show Cost Analytics", detail:"Lifetime spend, monthly trend, avoided calls, top customers", run:showCostAnalyticsModal, key:"Cost" },
    { id:"audit-log", label:"Show Audit Log", detail:"Filter, export, and review recent SO agent actions", run:showAuditLogModal, key:"Audit" },
    { id:"start-tour", label:"Start Guided Tour", detail:"Walk through the main features with overlay highlights", run:startTour, key:"Tour" },
    { id:"choose-role", label:"Choose Role", detail:"Sales engineer, manager, IT, or just exploring", run:chooseRole, key:"Role" },
    { id:"storage-status", label:"Show Storage Status", detail:"How much localStorage is in use and how to compact it", run:showStorageStatusModal, key:"Storage" },
    { id:"audit-export-csv", label:"Export Audit Log CSV", detail:"Download the full SO agent audit trail as a CSV", run:exportAuditLogCsv, key:"CSV" },
    { id:"audit-export-json", label:"Export Audit Log JSON", detail:"Download the full SO agent audit trail as JSON", run:exportAuditLogJson, key:"JSON" },
  );

  window.openOpsPalette = openOpsPalette;
  window.runOpsAction = runOpsAction;
  window.runOpsHealthCheck = runOpsHealthCheck;
  window.exportOpsBackup = exportOpsBackup;
  window.copyOpsDiagnostics = copyOpsDiagnostics;
  window.showOpsShortcuts = showOpsShortcuts;
  window.showSoIntakeChecklist = showSoIntakeChecklist;
  window.showOnboardingFlow = showOnboardingFlow;
  window.markOnboardingDone = markOnboardingDone;
  window.skipOnboarding = skipOnboarding;
  window.showProcessImprovements = showProcessImprovements;
  window.showIntegrationReport = showIntegrationReport;
  window.showFormatGuide = showFormatGuide;
  window.exportMatrixData = exportMatrixData;
  window.exportRecommendedSparesData = exportRecommendedSparesData;
  window.exportSoHistoryData = exportSoHistoryData;
  window.exportSoAgentHistory = exportSoAgentHistory;
  window.downloadMatrixTemplateAs = downloadMatrixTemplateAs;
  window.toggleOpsTheme = toggleTheme;
  window.cycleOpsTip = cycleOpsTip;
  window.startOpsTour = startTour;
  window.nextOpsTourStep = nextOpsTourStep;
  window.prevOpsTourStep = prevOpsTourStep;
  window.endOpsTour = endTour;
  window.setRole = setRole;
  window.showCostAnalyticsModal = showCostAnalyticsModal;
  window.showAuditLogModal = showAuditLogModal;
  window.seedSampleDataIntoStorage = seedSampleDataIntoStorage;
  window.clearSampleDataFromStorage = clearSampleDataFromStorage;
  window.importJsonOrZipForBom = importJsonOrZipForBom;
  window.expandZipFile = expandZipFile;
  window.ocrPdfOrImage = ocrPdfOrImage;
  window.detectOpsDelimiter = detectDelimiter;
  window.parseJsonOrJsonl = parseJsonOrJsonl;
  window.routeBomFiles = routeBomFiles;
  window.routeSoHistoryFiles = routeSoHistoryFiles;
  window.routeMatrixImport = routeMatrixImport;
  window.importJsonForActiveTab = importJsonForActiveTab;
  window.updateNavBadges = updateNavBadges;
  window.showBackendModal = showBackendModal;
  window.showAliasManager = showAliasManager;
  window.showTallyMasterImport = showTallyMasterImport;
  window.showCommunicationTimelineFor = (id) => showCommunicationTimeline(id);
  window.showProcessMining = showProcessMining;
  window.showRoleQueues = showRoleQueues;
  window.exportDocumentPackage = exportDocumentPackage;
  window.showMasterDataTab = showMasterDataTab;
  window.showProfileStudio = showProfileStudio;
  window.showSourcePoProcurement = showSourcePoProcurement;
  window.showEvalDashboard = showEvalDashboard;
  window.showEmailTriage = showEmailTriage;
  window.showSpareMatrixIntelligence = showSpareMatrixIntelligence;
  window.showSecurityCenter = showSecurityCenter;
  window.showCostAnalyticsDeep = showCostAnalyticsDeep;
  window.showAdminCenter = showAdminCenter;
  window.showSalesPipeline = showSalesPipeline;
  window.showInternalSoModal = showInternalSoModal;
  window.showProjectTracker = showProjectTracker;
  window.showShipmentsModal = showShipmentsModal;
  window.showServiceModal = showServiceModal;
  window.showEinvoiceModal = showEinvoiceModal;
  window.showForecastingModal = showForecastingModal;
  window.showAmcModal = showAmcModal;
  window.showScheduleLinesModal = showScheduleLinesModal;
  window.showJbmImporterModal = showJbmImporterModal;
  window.notify = notify;
  window.notifySuccess = notifySuccess;
  window.notifyWarn = notifyWarn;
  window.notifyError = notifyError;
  window.notifyVariant = notifyVariant;
  window.showStorageStatusModal = showStorageStatusModal;
  window.compactSoStorage = compactSoStorage;
  window.exportAuditLogCsv = exportAuditLogCsv;
  window.exportAuditLogJson = exportAuditLogJson;
  window.renderAuditLogTable = renderAuditLogTable;

  actionList.push(
    { id:"json-import", label:"Import JSON Rows", detail:"Pick a JSON or JSONL file to stash for downstream mapping", run:importJsonForActiveTab, key:"JSON" },
  );

  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName || "").toLowerCase();
    const typing = ["input", "textarea", "select"].includes(tag) || (e.target && e.target.isContentEditable);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openOpsPalette();
      return;
    }
    if (!typing && e.key === "/") {
      if (focusContextSearch()) e.preventDefault();
      return;
    }
    if (!typing && e.key === "?") {
      e.preventDefault();
      showOpsShortcuts();
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    applyTheme(getPreferredTheme());
    ensureTour();
    ensureOpsUi();
    ensureFormatButtons();
    renderOverview();
    refreshDockButtons();
    setTimeout(restoreLastTab, 90);
    setTimeout(() => {
      if (!localStorage.getItem("obara:onboarding_done") && !localStorage.getItem("obara:onboarding_seen")) {
        if (!localStorage.getItem(ROLE_KEY)) {
          chooseRole();
        } else {
          showOnboardingFlow();
        }
      }
    }, 220);
    setInterval(updateNavBadges, 6000);
    window.addEventListener("message", async (event) => {
      const data = event && event.data;
      if (!data || data.source !== "obara-auth-callback" || !data.session) return;
      if (window.ObaraBackend && window.ObaraBackend.setSession) {
        window.ObaraBackend.setSession(data.session);
        try {
          if (data.session.access_token) {
            const verified = await window.ObaraBackend.auth.verifyToken(data.session.access_token);
            localStorage.setItem("obara:auth_profile", JSON.stringify(verified));
            notifySuccess("Signed in as " + (verified.user && verified.user.email || verified.user && verified.user.id));
          }
        } catch (err) {
          notifyWarn("Magic link received, token verify failed: " + err.message);
        }
      }
    });
    window.addEventListener("storage", (event) => {
      if (event.key !== "obara:backend_session") return;
      try {
        const next = event.newValue ? JSON.parse(event.newValue) : null;
        if (window.ObaraBackend && window.ObaraBackend.setSession) {
          window.ObaraBackend.setSession(next);
          if (next && next.access_token) notifySuccess("Backend session updated from another tab");
        }
      } catch (_) {}
    });
  });
})();
</script>`;

const salesTab = `<!-- SALES ORDERS: inline React SO Processing Agent -->
<div id="tab-sales" class="tab-content">
  <div id="so-agent-root" class="so-agent-root"></div>
</div>`;

const soIframeBlock =
  /<!-- ══ SALES ORDERS — SO Processing Agent ═══════════════════════════════════ -->[\s\S]*?<!-- ══ SALES ORDER HISTORY ═════════════════════════════════════════════════ -->/;

const iframeInitBlock =
  /\/\/ ═{10,}\n\/\/ SO AGENT IFRAME INIT\n\/\/ ═{10,}[\s\S]*?(?=\/\/ ── Init)/;

// v3 feature-flag shim. v3 is now the default UI; this script
// runs at the very top of the legacy unified app and redirects
// the user to /v3-app/ unless they explicitly opt out with
// `?v3=0` (or have `obara:v3_pinned: "0"` from a prior opt-out).
//
// Why a JS shim instead of a server-side rewrite? Some Vercel
// deployments serve `public/index.html` ahead of vercel.json
// rewrites for the root URL. The shim is belt-and-suspenders:
// even when the static file wins, the user is bounced to v3
// before any of the legacy app initializes.
const v3FlagShim = `
<script>
(function(){
  try {
    var qs = new URLSearchParams(window.location.search);
    var pinned = localStorage.getItem("obara:v3_pinned");
    var want = qs.get("v3");
    // Explicit opt-out: ?v3=0. Stay on legacy and persist the choice.
    if (want === "0") {
      localStorage.setItem("obara:v3_pinned", "0");
      return;
    }
    // Sticky opt-out from a prior visit.
    if (pinned === "0") return;
    // Default: send the user to v3 immediately, preserving any
    // remaining query params and hash.
    if (want === "1") {
      localStorage.removeItem("obara:v3_pinned");
      qs.delete("v3");
    }
    var search = qs.toString();
    var hash = window.location.hash || "";
    window.location.replace("/v3-app/" + (search ? "?" + search : "") + hash);
  } catch (_) { /* fall through to legacy */ }
})();
</script>`;

let unified = ops
  .replace("<head>", "<head>" + v3FlagShim)
  .replace(
    '<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>',
    '<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>\n' + vendorScripts,
  )
  .replace("</style>", opsAssistantCss + "\n</style>")
  .replace(
    '<span class="nav-brand">⚙ Obara Ops</span>',
    "<span class=\"nav-brand\">⚙ Obara Ops</span>\n  <button class=\"nav-btn ops-assist-btn\" data-tab=\"overview\" onclick=\"showTab('overview')\" title=\"Status, health checks, backups, and workflow shortcuts\">Ops</button>",
  )
  .replace("Upload BOM Excel files from any Obara source (India, Korea, China, Japan)", "Upload BOM files from any Obara source (India, Korea, China, Japan)")
  .replace("Historical pricing and delivery data — auto-detected from PO-format or Tally-format Excel files.", "Historical pricing and delivery data — auto-detected from PO-format or Tally-format Excel, CSV, TSV, or TXT files.")
  .replace(">📥 Import Excel</button>", ">📥 Import Files</button>")
  .replace("Drop your Sales Order Excel files here", "Drop your Sales Order files here")
  .replace("Format auto-detected: PO delivery tracker or Tally SO export · .xlsx / .xls / .csv", "Format auto-detected: PO delivery tracker or Tally SO export · .xlsx / .xls / .csv / .tsv / .txt")
  .replace("📥 Import Excel BOM", "📥 Import BOM")
  .replace("Upload Bill of Materials Excel files from any Obara source.", "Upload Bill of Materials files from any Obara source.")
  .replace("Drop your Excel files here", "Drop your BOM files here")
  .replace("or click to browse — .xlsx / .xls · multiple files supported", "or click to browse — .xlsx / .xls / .csv / .tsv / .txt · multiple files supported")
  .replace(
    "#tab-sales.active{display:flex;flex:1;min-height:0;overflow:hidden;padding:0}",
    "#tab-sales.active{display:flex;flex:1;min-height:0;overflow:hidden;padding:0}\n.so-agent-root{flex:1;min-height:0;height:100%;overflow:auto;background:#f1f5f9}",
  )
  .replace('accept=".xlsx,.xls" multiple style="display:none" onchange="handleBomFiles(this.files)"', 'accept=".xlsx,.xls,.csv,.tsv,.txt,.zip" multiple style="display:none" onchange="routeBomFiles(this.files)"')
  .replace('accept=".xlsx,.xls,.csv" multiple style="display:none" onchange="handleSoHistoryFiles(this.files)"', 'accept=".xlsx,.xls,.csv,.tsv,.txt,.zip" multiple style="display:none" onchange="routeSoHistoryFiles(this.files)"')
  .replace('accept=".xlsx,.xls,.csv" style="display:none" onchange="handleMatrixImport(this.files[0])"', 'accept=".xlsx,.xls,.csv,.tsv,.txt,.zip" style="display:none" onchange="routeMatrixImport(this.files[0])"')
  .replace("function onDrop(e) { e.preventDefault(); handleBomFiles(e.dataTransfer.files); }", "function onDrop(e) { e.preventDefault(); (window.routeBomFiles || handleBomFiles)(e.dataTransfer.files); }")
  .replace("function onSohDrop(e) { e.preventDefault(); handleSoHistoryFiles(e.dataTransfer.files); }", "function onSohDrop(e) { e.preventDefault(); (window.routeSoHistoryFiles || handleSoHistoryFiles)(e.dataTransfer.files); }")
  .replace("    const gunNumber = file.name.replace(/\\.(xlsx|xls)$/i, '');", "    const isTextSheet = /\\.(csv|tsv|txt)$/i.test(file.name);\n    const isTsv = /\\.(tsv|txt)$/i.test(file.name);\n    const gunNumber = file.name.replace(/\\.(xlsx|xls|csv|tsv|txt)$/i, '');")
  .replace("        const wb = XLSX.read(e.target.result, {type:'array'});", "        const wb = XLSX.read(e.target.result, {type: isTextSheet ? 'string' : 'array', raw:true, FS: isTsv ? '\\t' : undefined});")
  .replace("    reader.readAsArrayBuffer(file);\n  });\n}\n\n// ─────────────────────────────────────────────────────────────────────────────", "    if (isTextSheet) reader.readAsText(file); else reader.readAsArrayBuffer(file);\n  });\n}\n\n// ─────────────────────────────────────────────────────────────────────────────")
  .replace("  const isCsv=file.name.toLowerCase().endsWith('.csv');", "  const isTextSheet=/\\.(csv|tsv|txt)$/i.test(file.name);\n  const isTsv=/\\.(tsv|txt)$/i.test(file.name);")
  .replace("      let rows;\n      if(isCsv){\n        rows=e.target.result.split(/\\r?\\n/).map(l=>l.split(',').map(c=>c.trim().replace(/^\"|\"$/g,'')));\n      }else{\n        const wb=XLSX.read(e.target.result,{type:'array'});\n        rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:''});\n      }", "      const wb=XLSX.read(e.target.result,{type:isTextSheet?'string':'array',raw:true,FS:isTsv?'\\t':undefined});\n      const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:''});")
  .replace("  if(isCsv) reader.readAsText(file); else reader.readAsArrayBuffer(file);", "  if(isTextSheet) reader.readAsText(file); else reader.readAsArrayBuffer(file);")
  .replace("  files.forEach(file => {\n    const reader = new FileReader();", "  files.forEach(file => {\n    const isTextSheet = /\\.(csv|tsv|txt)$/i.test(file.name);\n    const isTsv = /\\.(tsv|txt)$/i.test(file.name);\n    const reader = new FileReader();")
  .replace("        const wb = XLSX.read(e.target.result, {type:'array', cellDates:false});", "        const wb = XLSX.read(e.target.result, {type: isTextSheet ? 'string' : 'array', cellDates:false, raw:true, FS: isTsv ? '\\t' : undefined});")
  .replace("    reader.readAsArrayBuffer(file);\n  });\n}\n\nfunction renderSohPreview()", "    if (isTextSheet) reader.readAsText(file); else reader.readAsArrayBuffer(file);\n  });\n}\n\nfunction renderSohPreview()")
  .replace("\n\n<!-- ══ SALES ORDERS", "\n\n" + overviewTab + "\n\n<!-- ══ SALES ORDERS")
  .replace(soIframeBlock, salesTab + "\n\n<!-- ══ SALES ORDER HISTORY ═════════════════════════════════════════════════ -->")
  .replace("  if (name === 'sales')  initSoAgentFrame();\n", "  if (name === 'sales' && window.mountSoAgent) window.mountSoAgent();\n")
  .replace(iframeInitBlock, "")
  .replace("</body>", (backendClient ? "<script>\n" + backendClient + "\n</script>\n" : "") + soScript + "\n" + opsAssistantScript + "\n</body>");

fs.writeFileSync(outPath, unified);
console.log(outPath);
