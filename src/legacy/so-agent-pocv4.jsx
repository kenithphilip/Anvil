import { useState, useRef, useCallback, useEffect } from "react";

// ─── PROMPTS ──────────────────────────────────────────────────────────────────
const PREFLIGHT_PROMPT = [
  "You are a document intake validator for Obara India Private Limited,",
  "a manufacturer and supplier of welding electrode tips, cap tips, back tips,",
  "and resistance welding consumables. GSTIN: 27AAACO8335K1Z5.",
  "Address: W-17, F-II Block, MIDC, Pimpri, Pune 411018.",
  "",
  "You receive two documents: a Purchase Order (PO) and a Price Quotation (Quote).",
  "Validate them. Do NOT generate a Sales Order.",
  "",
  "PO CHECKS:",
  "P1 VENDOR: Is the PO addressed to Obara India Private Limited?",
  "   Check TO field, vendor name, address, GSTIN 27AAACO8335K1Z5.",
  "   Clearly addressed to a different company -> WRONG_VENDOR.",
  "P2 MATERIAL: Do PO line items match Obara products (electrode tips, cap tips,",
  "   back tips, welding consumables, resistance welding parts)?",
  "   Completely unrelated products -> WRONG_MATERIAL.",
  "P3 DATE: Is PO date within 12 months of today March 2026?",
  "   Before March 2025 -> OUTDATED_PO. No date -> MISSING_DATE.",
  "P4 DUPLICATE: Extract PO number for app-level duplicate checking.",
  "P5 COMPLETENESS: PO must have number, date, at least 1 line item with qty and price,",
  "   and a delivery address. Missing any -> INCOMPLETE_PO.",
  "   NOTE: Some POs (e.g. SAP-generated like FIAT/Stellantis) use a vertical block format",
  "   rather than a table — Item No., Material, Matl.Description, Net Pr/Unit, P.O.Quantity",
  "   each on separate lines. This is valid. Multi-page POs where pages 2+ are T&C boilerplate",
  "   are also valid — extract line items from page 1 only.",
  "",
  "QUOTE CHECKS:",
  "Q1 SOURCE: Is the quote issued BY Obara India Private Limited?",
  "   Different company -> WRONG_QUOTE_SOURCE.",
  "Q2 MATCH: Do quote line items match PO items by description or part number?",
  "   Zero items match -> QUOTE_MISMATCH.",
  "   Some match -> PARTIAL_MATCH.",
  "   All or most match -> QUOTE_MATCHED.",
  "Q3 FRESHNESS: Quote older than 6 months before PO date -> QUOTE_STALE.",
  "   Quote dated more than 7 days after PO date -> QUOTE_POSTDATED.",
  "Q4 COMPLETENESS: Quote should have prices, HSN codes, GST rates, part numbers.",
  "   Missing -> INCOMPLETE_QUOTE.",
  "",
  "RULES:",
  "- valid=false if ANY of P1, P2, Q1, or Q2=QUOTE_MISMATCH fail.",
  "- canProceed=false if valid=false OR P5/Q4 fail critically.",
  "- blockers: human-readable strings for each hard-fail check.",
  "- warnings: soft issues only.",
  "- suggestedAction: one clear instruction to the sales engineer on what to fix.",
  "",
  "Respond ONLY with this JSON, no markdown, no explanation:",
  "{",
  '  "valid": true,',
  '  "canProceed": true,',
  '  "poNumber": "",',
  '  "poDate": "",',
  '  "poVendorName": "",',
  '  "poVendorGSTIN": "",',
  '  "quoteNumber": "",',
  '  "quoteDate": "",',
  '  "quoteIssuer": "",',
  '  "matchSummary": "",',
  '  "checks": {',
  '    "P1_vendorCheck":    { "pass": true, "code": "OK", "detail": "" },',
  '    "P2_materialCheck":  { "pass": true, "code": "OK", "detail": "" },',
  '    "P3_dateCheck":      { "pass": true, "code": "OK", "detail": "" },',
  '    "P4_duplicateCheck": { "pass": true, "code": "OK", "detail": "" },',
  '    "P5_completeness":   { "pass": true, "code": "OK", "detail": "" },',
  '    "Q1_quoteSource":    { "pass": true, "code": "OK", "detail": "" },',
  '    "Q2_quoteMatch":     { "pass": true, "code": "QUOTE_MATCHED", "detail": "" },',
  '    "Q3_quoteFreshness": { "pass": true, "code": "OK", "detail": "" },',
  '    "Q4_quoteComplete":  { "pass": true, "code": "OK", "detail": "" }',
  "  },",
  '  "blockers": [],',
  '  "warnings": [],',
  '  "suggestedAction": ""',
  "}",
].join("\n");

// ─── SO + SOURCE PO PROMPT ────────────────────────────────────────────────────
const SO_PROMPT = [
  "You are an expert Sales Order processing agent for Obara India Private Limited",
  "(welding consumables supplier). GSTIN: 27AAACO8335K1Z5.",
  "",
  "You receive up to FOUR inputs:",
  "  1. Customer Purchase Order (PO) — always present",
  "  2. Obara Price Quotation to customer — always present",
  "  3. Internal Price Composition document — present if uploaded",
  "  4. Sales engineer override note — present if provided",
  "",
  "Produce TWO outputs: (A) customer-facing Sales Order in INR,",
  "and (B) internal Source Purchase Orders grouped by supplier.",
  "",
  "=========================================================",
  "PART A: CUSTOMER-FACING SALES ORDER (existing logic)",
  "=========================================================",
  "",
  "STEP A1 — EXTRACT FROM PO:",
  "   PO Number, Date, Customer, Bill-to, Ship-to, Contact,",
  "   Payment Terms, Incoterms, Delivery Date, Penalty Clause, Warranty, Line Items.",
  "   PO FORMATS — the agent must handle two common layouts:",
  "   A) TABLE FORMAT (Hyundai, Maruti, most OEMs): columns in a grid — Description,",
  "      Part No., Qty, Rate, Amount. Extract row by row.",
  "   B) SAP VERTICAL BLOCK FORMAT (FIAT, Stellantis, some Tata): each field on its own",
  "      line — 'Item No. : 10', 'Material : SJC92956', 'Matl. Description: Bend Adapter',",
  "      'Net Pr/Unit : INR 20491.25/1 NOS', 'P.O.Quantity : 2 NOS'.",
  "      In this format: use Net Pr/Unit as the base price (NOT Gross Price which includes GST).",
  "      Gross Price = Net Pr/Unit * (1 + GST%). If the PO shows CGST/SGST explicitly,",
  "      the price is already structured — use Net Pr/Unit as unitPrice.",
  "   MULTI-PAGE T&C: Many POs have 10+ pages of T&C boilerplate after the order page.",
  "   Extract line items only from the order page(s). Skip T&C pages entirely.",
  "",
  "STEP A2 — EXTRACT FROM QUOTE:",
  "   Quote Number, Date, Payment Terms, Incoterms, Lead Time,",
  "   Warranty, Line Items with HSN codes and GST rates.",
  "",
  "STEP A3 — MATCH LINE ITEMS:",
  "   Match PO to Quote items by description and part number.",
  "   Use fuzzy matching: ignore case, extra spaces, hyphens, brackets.",
  "   If formats differ, set partNameMismatch=true but still match them.",
  "",
  "STEP A4 — TALLY ITEM NAME CANONICALISATION (CRITICAL):",
  "   Always use the exact Obara seller part number from the QUOTE as tallyItemName.",
  "   The Quote comes from Obara systems = same source as Tally stock master.",
  "   Preserve every character: hyphens, brackets, spaces, capitalisation.",
  "   partNameSource = quote_part_number | description_fallback | po_only",
  "   partNameMismatch = true if PO format differs from Quote format for same item.",
  "",
  "STEP A5 — GST-INCLUSIVE PRICE CHECK:",
  "   If PO unit price divided by (1 + GST_rate/100) approximates the Quote unit price,",
  "   then PO price is GST-inclusive. Set poUnitPriceInclGST=true.",
  "   Always use GST-exclusive rate in the Sales Order.",
  "",
  "STEP A6 — DISCREPANCIES:",
  "   CRITICAL: price mismatch more than 1%, po_only item, PO qty exceeds quoted qty,",
  "     early delivery, missing HSN.",
  "   WARNING: partNameMismatch, GST-inclusive PO price, payment/incoterms differ,",
  "     penalty clause, warranty differs, description_fallback used.",
  "   OK: clean match.",
  "",
  "STEP A7 — GENERATE CUSTOMER SO:",
  "   voucherNo = SO: followed by PO number.",
  "   Use tallyItemName as stock item name. Use GST-exclusive rate.",
  "",
  "=========================================================",
  "PART B: INTERNAL SOURCE PURCHASE ORDERS",
  "=========================================================",
  "",
  "STEP B1 — READ THE PRICE COMPOSITION SPREADSHEET:",
  "",
  "   The price comp is an Excel file with the following key columns.",
  "   Row with headers is the data header row (look for Item, Part Name, etc.).",
  "   Data rows follow immediately after the header row.",
  "",
  "   COLUMN REFERENCE (0-indexed, may vary slightly — use header names to locate):",
  "     Col A (0):  Item number (row sequence)",
  "     Col B (1):  Part Name (description)",
  "     Col C (2):  Part Number (Obara seller part number)",
  "     Col D (3):  Drawing / Customer Number (customer part number)",
  "     Col F (5):  HSN Code",
  "     Col G (6):  Qty",
  "     Col H (7):  Unit (UOM)",
  "     Col S (18): Source Country — values like O-KOREA, O-CHINA, O-JAPAN, O-INDIA, EXTERNAL",
  "     Col T (19): Supplier Quote Reference (e.g. O-KOR-240207, WU-240207)",
  "     Col U (20): Supplier Unit Price in FOREIGN CURRENCY (the cost price)",
  "     Col V (21): Supplier Amount in FOREIGN CURRENCY (= col20 * qty)",
  "     Col W (22): Exchange Rate (1 unit of foreign currency = this many INR)",
  "     Col X (23): Unit Price in INR (= col20 * col22)",
  "     Col AH (33): CHA Charges (Customs House Agent)",
  "     Col AI (34): Landed Cost Amount in INR (total cost including customs, CHA, etc.)",
  "     Col AP (41): GP % (Gross Profit percentage)",
  "     Col AV (47): Selling Unit Price in INR (what the customer pays — matches Quote price)",
  "     Col AW (48): Selling Amount in INR",
  "",
  "STEP B2 — DETERMINE SOURCE COUNTRY AND CURRENCY FOR EACH ITEM:",
  "",
  "   Priority order:",
  "   1. ENGINEER OVERRIDE NOTE (highest priority): if the sales engineer explicitly",
  "      assigns items to a source, use that. Set sourceConfidence = engineer_override.",
  "",
  "   2. PRICE COMP SOURCE COUNTRY column (col 18): read the exact value.",
  "      Source country codes and their transaction currencies:",
  "        O-KOREA  -> country=Korea,  currency=USD  (inter-company, priced in USD)",
  "        O-CHINA  -> country=China,  currency=CNY  (inter-company, priced in CNY)",
  "        O-JAPAN  -> country=Japan,  currency=JPY  (inter-company, priced in JPY)",
  "        O-INDIA  -> country=India,  currency=INR  (internal / local manufacture)",
  "        EXTERNAL -> country=Other,  currency=USD  (external supplier)",
  "        Any other value -> read literally, infer currency from exchange rate.",
  "      Set sourceConfidence = price_comp_stated.",
  "",
  "   HOW TO CONFIRM CURRENCY: cross-check exchange rate (col 22).",
  "      Rate ~83-86   -> USD (matches INR/USD in 2024)",
  "      Rate ~11-13   -> CNY (matches INR/CNY in 2024)",
  "      Rate ~0.05-0.06 -> JPY (matches INR/JPY in 2024)",
  "      Rate = 1      -> INR (local)",
  "      Rate ~0.06-0.07 -> KRW (matches INR/KRW in 2024)",
  "",
  "   3. NO PRICE COMP — infer from part number patterns:",
  "        Part numbers ending in (O/K) suffix -> Japan",
  "        Part numbers ending in -I suffix -> India",
  "        Insul Bush, Insul Plate -> India or China",
  "        Glass beading, surface treatment -> India",
  "      Set sourceConfidence = pattern_inferred. Add a WARNING discrepancy for each item.",
  "",
  "STEP B3 — EXTRACT COST DATA FROM PRICE COMP:",
  "   For each line item, read from the price comp row matching by part number or description:",
  "     unitCostForeign = col 20 (Supplier Unit Price in foreign currency)",
  "     amountForeign   = col 21 (Supplier Amount in foreign currency = col20 * qty)",
  "     exchangeRate    = col 22 (1 FCY unit = exchangeRate INR)",
  "     unitCostINR     = col 23 (Unit price in INR after exchange rate)",
  "     landedCostINR   = col 34 (Landed Cost — includes customs, CHA, freight, insurance)",
  "     supplierQuoteRef = col 19 (supplier internal reference)",
  "   If no price comp: set all to null.",
  "",
  "STEP B4 — DETERMINE SUPPLIER NAME AND TYPE:",
  "   Read supplierQuoteRef (col 19) to understand the supplier relationship:",
  "     O-KOR-XXXXXX -> Obara Korea Co., Ltd (inter-company)",
  "     WU-XXXXXX or similar China ref -> Obara China Co., Ltd (inter-company)",
  "     OJ-XXXXXX or similar Japan ref -> Obara Corporation Japan (inter-company)",
  "     No ref and O-INDIA -> Obara India Pvt Ltd - Internal Production (internal)",
  "     Other ref format -> likely external supplier, use ref as supplier hint",
  "   supplierType = inter-company | external | internal",
  "",
  "STEP B5 — GROUP BY SUPPLIER AND GENERATE SOURCE POs:",
  "   Group all line items by their resolved supplier.",
  "   For each supplier group create one Source PO entry.",
  "   source PO reference = SPO: + customer PO number + country code suffix.",
  "   Country codes: -CN=China, -JP=Japan, -KR=Korea, -IN=India, -XX=other.",
  "   Example: SPO: P260231961-CN",
  "",
  "STEP B6 — CALCULATE SOURCE PO TOTALS:",
  "   totalForeign = sum of amountForeign for all items in this source PO.",
  "   totalINR = sum of (unitCostINR * qty) for all items, or null if no price comp.",
  "   totalLandedINR = sum of (landedCostINR * qty) if available.",
  "   hasCostData = true if price comp was provided, false otherwise.",
  "",
  "ADDITIONAL OUTPUT REQUIRED — FORMAT FINGERPRINT:",
  "After completing all 7 steps above, populate the formatFingerprint object:",
  "  documentType:              single-page PDF | multi-page PDF | Excel | other",
  "  poNumberLabel:             the exact label text used for the PO number field",
  "  dateFormat:                e.g. DD-MMM-YY, YYYY-MM-DD, DD/MM/YYYY",
  "  lineItemColumns:           column headers in order, pipe-separated",
  "  partNumberStyle:           describe how customer writes part numbers",
  "  paymentTermsFixed:         if payment terms are always the same value, state it; else empty",
  "  hasGSTOnPO:                true if customer PO shows GST amounts",
  "  hasExplicitDeliveryDate:   true if there is a clear delivery date field on PO",
  "  multiPage:                 true if PO spans multiple pages",
  "  pageMarker:                text used to indicate continuation (e.g. continued...)",
  "  currencyOnPO:              currency used on the PO (usually INR)",
  "  quirks:                    any unusual formatting, missing fields, or noteworthy patterns",
  "  summary:                   one sentence describing this customer PO format overall",
  "",
  "If a KNOWN CUSTOMER FORMAT block was provided at the top of this prompt:",
  "  Compare this PO against that profile.",
  "  If the format matches: set formatChanged=false.",
  "  If something significant differs (new columns, different labels, new page layout):",
  "    set formatChanged=true and describe exactly what changed in formatChangeSummary.",
  "  Minor differences (whitespace, font, logo) are NOT format changes.",
  "",
  "Respond ONLY with valid JSON, no markdown, no code fences:",
  "{",
  '  "po": {',
  '    "number": "", "date": "", "customer": "",',
  '    "billTo": { "name": "", "address": "", "gstin": "", "state": "" },',
  '    "shipTo": { "name": "", "address": "", "gstin": "", "state": "" },',
  '    "contact": { "name": "", "phone": "", "email": "" },',
  '    "paymentTerms": "", "incoterms": "", "deliveryDate": "",',
  '    "penaltyClause": "", "warranty": "",',
  '    "lineItems": [',
  '      { "sno": 1, "description": "", "custPartNo": "", "qty": 0, "uom": "", "unitPrice": 0, "amount": 0 }',
  "    ]",
  "  },",
  '  "quote": {',
  '    "number": "", "date": "", "paymentTerms": "", "incoterms": "",',
  '    "leadTimeDays": "", "warranty": "",',
  '    "lineItems": [',
  '      { "sno": 1, "description": "", "sellerPartNo": "", "hsnCode": "",',
  '        "qty": 0, "uom": "", "unitPrice": 0, "cgst": 9, "sgst": 9, "igst": 0 }',
  "    ]",
  "  },",
  '  "discrepancies": [',
  '    { "severity": "CRITICAL", "field": "", "poValue": "", "quoteValue": "", "message": "" }',
  "  ],",
  '  "salesOrder": {',
  '    "voucherType": "Sales Order", "voucherNo": "", "date": "", "partyName": "",',
  '    "billTo": { "name": "", "address": "", "gstin": "", "state": "" },',
  '    "shipTo": { "name": "", "address": "", "gstin": "", "state": "" },',
  '    "reference": "", "narration": "",',
  '    "lineItems": [{',
  '      "sno": 1, "tallyItemName": "", "itemName": "",',
  '      "hsnCode": "", "custPartNo": "", "sellerPartNo": "",',
  '      "partNameSource": "quote_part_number", "partNameMismatch": false,',
  '      "uom": "", "qty": 0, "rate": 0, "discount": 0, "amount": 0, "dueDate": "",',
  '      "poUnitPriceInclGST": false,',
  '      "cgst": 0, "sgst": 0, "igst": 0,',
  '      "cgstAmt": 0, "sgstAmt": 0, "igstAmt": 0, "totalWithGst": 0',
  "    }],",
  '    "subTotal": 0, "totalCgst": 0, "totalSgst": 0, "totalIgst": 0,',
  '    "grandTotal": 0, "grandTotalWords": ""',
  "  },",
  '  "formatFingerprint": {',
  '    "documentType": "",',
  '    "poNumberLabel": "",',
  '    "dateFormat": "",',
  '    "lineItemColumns": "",',
  '    "partNumberStyle": "",',
  '    "paymentTermsFixed": "",',
  '    "hasGSTOnPO": false,',
  '    "hasExplicitDeliveryDate": false,',
  '    "multiPage": false,',
  '    "pageMarker": "",',
  '    "currencyOnPO": "INR",',
  '    "quirks": "",',
  '    "summary": ""',
  '  },',
  '  "formatChanged": false,',
  '  "formatChangeSummary": "",',
  '  "sourcePOs": [',
  "    {",
  '      "reference": "SPO: P260231961-CN",',
  '      "supplier": "Obara China Co., Ltd",',
  '      "supplierType": "inter-company",',
  '      "country": "China",',
  '      "currency": "CNY",',
  '      "exchangeRate": 11.2,',
  '      "exchangeRateSource": "price_comp_stated",',
  '      "supplierQuoteRef": "",',
  '      "paymentTerms": "",',
  '      "lineItems": [{',
  '        "sno": 1,',
  '        "tallyItemName": "",',
  '        "sellerPartNo": "",',
  '        "description": "",',
  '        "qty": 0,',
  '        "uom": "",',
  '        "unitCostForeign": 0,',
  '        "unitCostINR": 0,',
  '        "amountForeign": 0,',
  '        "amountINR": 0,',
  '        "landedCostINR": 0,',
  '        "sourceConfidence": "price_comp_stated",',
  '        "sourceNote": ""',
  "      }],",
  '      "totalForeign": 0,',
  '      "totalINR": 0,',
  '      "totalLandedINR": 0,',
  '      "hasCostData": true',
  "    }",
  "  ]",
  "}",
].join("\n");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const DARK = "#0f2540";
const MID  = "#1a3a5c";
const SK_ORDERS   = "so_agent:orders";
const SK_METRICS  = "so_agent:metrics";
const SK_FORMATS  = "so_agent:customer_formats";

const CURRENCY_META = {
  CNY: { flag: "🇨🇳", label: "Chinese Yuan",   symbol: "CNY ", country: "China" },
  JPY: { flag: "🇯🇵", label: "Japanese Yen",   symbol: "JPY ", country: "Japan" },
  KRW: { flag: "🇰🇷", label: "Korean Won",     symbol: "KRW ", country: "Korea" },
  USD: { flag: "🇺🇸", label: "US Dollar",      symbol: "USD ", country: "Korea / International" },
  INR: { flag: "🇮🇳", label: "Indian Rupee",   symbol: "₹",   country: "India" },
};

// Source country codes from price comp -> resolved currency
const SOURCE_COUNTRY_CURRENCY = {
  "O-KOREA":  "USD",  // Korea inter-company orders transacted in USD
  "O-CHINA":  "CNY",  // China inter-company orders in CNY
  "O-JAPAN":  "JPY",  // Japan inter-company orders in JPY
  "O-INDIA":  "INR",  // India local/internal, INR
  "EXTERNAL": "USD",  // External international suppliers default USD
};

const SOURCE_CONFIDENCE_META = {
  engineer_override:   { color: "purple", label: "Engineer" },
  price_comp_stated:   { color: "green",  label: "Price Comp" },
  price_comp_inferred: { color: "amber",  label: "Inferred" },
  pattern_inferred:    { color: "orange", label: "Pattern" },
};

const CHECK_META = {
  P1_vendorCheck:    { label: "Vendor Identity",    icon: "🏢", group: "PO",    blocker: true  },
  P2_materialCheck:  { label: "Material Relevance", icon: "🔩", group: "PO",    blocker: true  },
  P3_dateCheck:      { label: "PO Date",            icon: "📅", group: "PO",    blocker: false },
  P4_duplicateCheck: { label: "Duplicate PO",       icon: "🔄", group: "PO",    blocker: true  },
  P5_completeness:   { label: "PO Completeness",    icon: "📋", group: "PO",    blocker: false },
  Q1_quoteSource:    { label: "Quote Issuer",       icon: "📄", group: "Quote", blocker: true  },
  Q2_quoteMatch:     { label: "Quote vs PO Match",  icon: "🔗", group: "Quote", blocker: true  },
  Q3_quoteFreshness: { label: "Quote Freshness",    icon: "⏰", group: "Quote", blocker: false },
  Q4_quoteComplete:  { label: "Quote Completeness", icon: "✅", group: "Quote", blocker: false },
};

const PO_KEYS = ["P1_vendorCheck","P2_materialCheck","P3_dateCheck","P4_duplicateCheck","P5_completeness"];
const Q_KEYS  = ["Q1_quoteSource","Q2_quoteMatch","Q3_quoteFreshness","Q4_quoteComplete"];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmt    = (n) => n != null ? "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2 }) : "—";
const fmtN   = (n) => n != null ? Number(n).toLocaleString("en-IN") : "0";
const fmtFCY = (n, sym) => n != null ? (sym || "") + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2 }) : "—";
const nowISO    = () => new Date().toISOString();
const dateLabel = (iso) => iso ? new Date(iso).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" }) : "—";
const timeLabel = (iso) => iso ? new Date(iso).toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit" }) : "";
const gradStyle = { background: "linear-gradient(135deg," + DARK + "," + MID + ")" };

const fileToBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result.split(",")[1]);
  r.onerror = rej;
  r.readAsDataURL(file);
});

// ─── TOKEN ESTIMATOR ──────────────────────────────────────────────────────────
// Conservative upper-bound estimate: file.size (bytes) * 0.015 tokens/byte.
// Calibrated against real POs — always over-estimates, never under-estimates.
// This is intentional: a false warning is preferable to a silent truncation.
const TOKENS_PER_BYTE      = 0.015;  // conservative upper bound
const PROMPT_TOKENS_PF     = 750;    // PREFLIGHT_PROMPT measured size
const PROMPT_TOKENS_SO     = 3200;   // SO_PROMPT + format context measured size
const OUTPUT_TOKENS_PF     = 400;    // preflight JSON response
const OUTPUT_TOKENS_SO_BASE = 800;   // SO output base (headers, metadata)
const OUTPUT_TOKENS_PER_KB = 0.8;    // SO output scales with PO size
const MAX_OUTPUT_TOKENS    = 16000;  // our max_tokens setting
const MAX_INPUT_TOKENS     = 180000; // claude-sonnet-4 safe input limit

const estimateDocTokens = (fileBytes) => Math.ceil((fileBytes || 0) * TOKENS_PER_BYTE);

const estimateCallTokens = (poBytes, quoteBytes, priceCompBytes, hasFormatCtx) => {
  const poTok    = estimateDocTokens(poBytes);
  const quoteTok = estimateDocTokens(quoteBytes);
  const pcTok    = priceCompBytes ? estimateDocTokens(priceCompBytes) : 0;
  const sysPrompt = hasFormatCtx ? PROMPT_TOKENS_SO : PROMPT_TOKENS_SO - 250;

  const call1Input  = PROMPT_TOKENS_PF + poTok + quoteTok;
  const call1Output = OUTPUT_TOKENS_PF;

  const call2Input  = sysPrompt + poTok + quoteTok + pcTok;
  // Output scales: more PO content = more line items = larger JSON
  const call2Output = Math.ceil(OUTPUT_TOKENS_SO_BASE + (poBytes / 1000) * OUTPUT_TOKENS_PER_KB);

  return {
    poTokens:    poTok,
    quoteTokens: quoteTok,
    pcTokens:    pcTok,
    call1Input,  call1Output,
    call2Input,  call2Output,
    totalInput:  call1Input + call2Input,
    totalOutput: call1Output + call2Output,
    outputRisk:  call2Output / MAX_OUTPUT_TOKENS,  // 0-1 fraction
    inputRisk:   call2Input  / MAX_INPUT_TOKENS,
  };
};

// Risk level: none | low | medium | high | critical
const tokenRiskLevel = (est) => {
  if (est.outputRisk > 0.90 || est.inputRisk > 0.90) return "critical";
  if (est.outputRisk > 0.70 || est.inputRisk > 0.70) return "high";
  if (est.outputRisk > 0.50 || est.inputRisk > 0.50) return "medium";
  if (est.outputRisk > 0.30 || est.inputRisk > 0.30) return "low";
  return "none";
};

const escCSV = (v) => {
  const s = String(v == null ? "" : v);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return "\"" + s.replace(/"/g, "\"\"") + "\"";
  }
  return s;
};

const dlFile = (content, name, mime) => {
  const b64 = btoa(unescape(encodeURIComponent(content)));
  const a = document.createElement("a");
  a.href = "data:" + mime + ";base64," + b64;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

const callClaude = async (systemPrompt, docs) => {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: "user", content: [...docs, { type: "text", text: "Return JSON only. Ensure the JSON is complete and valid — do not truncate." }] }],
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  if (data.stop_reason === "max_tokens") {
    throw new Error("Response was cut off — the document may be too large. Try splitting into fewer line items or contact support.");
  }
  const raw = (data.content || []).map((c) => c.text || "").join("");
  const cleaned = raw.replace(/```json|```/g, "").trim();

  // First attempt: direct parse
  try { return JSON.parse(cleaned); } catch (_) {}

  // Recovery 1: find the outermost { ... } block
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) {}
  }

  // Recovery 2: truncated JSON — attempt to close open structures
  // Walk the string counting brackets; stop at first structure-breaking char
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
    // Close all open structures from the last valid position
    let fragment = s.slice(0, lastValid + 1);
    // Trim trailing comma or incomplete key — using explicit string scan to avoid regex bracket confusion
    let trimEnd = fragment.length - 1;
    while (trimEnd >= 0 && (fragment[trimEnd] === ' ' || fragment[trimEnd] === '\n' || fragment[trimEnd] === '\r')) trimEnd--;
    if (fragment[trimEnd] === ',') fragment = fragment.slice(0, trimEnd);
    // Drop any trailing incomplete "key": pattern (unclosed string after last comma)
    const lastComma = fragment.lastIndexOf(',');
    const lastQuote = fragment.lastIndexOf('"');
    if (lastComma > 0 && lastQuote > lastComma) {
      const afterComma = fragment.slice(lastComma + 1).trim();
      const quoteCount = (afterComma.match(/"/g) || []).length;
      if (quoteCount % 2 !== 0) fragment = fragment.slice(0, lastComma);
    }
    // Re-count and close
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
    parsed._truncated = true; // flag so UI can warn
    return parsed;
  } catch (_) {}

  throw new Error("Could not parse AI response as JSON. Raw response: " + cleaned.slice(0, 200));
};

// ─── STORAGE ──────────────────────────────────────────────────────────────────
const sGet = async (k) => { try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch (_) { return null; } };
const sSet = async (k, v) => { try { await window.storage.set(k, JSON.stringify(v)); } catch (_) {} };
const loadOrders  = async () => (await sGet(SK_ORDERS))  || [];
const saveOrder   = async (o) => {
  const os = await loadOrders();
  const i = os.findIndex((x) => x.id === o.id);
  if (i >= 0) os[i] = o; else os.unshift(o);
  await sSet(SK_ORDERS, os);
};
const emptyMetrics = () => ({
  totalProcessed:0, totalValue:0, criticalsCaught:0, warningsCaught:0,
  processingTimes:[], avgMs:0, blocked:0, duplicatesBlocked:0,
  wrongVendorBlocked:0, wrongQuoteBlocked:0, ordersApproved:0, exportCount:0,
});
const loadMetrics   = async () => (await sGet(SK_METRICS)) || emptyMetrics();
const saveMetrics   = (m) => sSet(SK_METRICS, m);

// ─── CUSTOMER FORMAT MEMORY ───────────────────────────────────────────────────
const loadFormats = async () => (await sGet(SK_FORMATS)) || {};
const saveFormats = (f) => sSet(SK_FORMATS, f);

const normalizeCustomerKey = (gstin, name) => {
  if (gstin && gstin.trim().length > 5) return gstin.trim().toUpperCase();
  return (name || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 40);
};

const buildFormatContextBlock = (profile) => {
  if (!profile || !profile.fingerprint) return null;
  const f = profile.fingerprint;
  const lines = [
    "KNOWN CUSTOMER FORMAT — " + profile.customerName + " (" + profile.ordersProcessed + " previous orders processed)",
    "You have successfully extracted POs from this customer before. Their format is consistent:",
    "  Document type: " + (f.documentType || "PDF"),
    "  PO number field label: " + (f.poNumberLabel || "unknown"),
    "  Date format: " + (f.dateFormat || "unknown"),
    "  Line item columns: " + (f.lineItemColumns || "unknown"),
    "  Part number style: " + (f.partNumberStyle || "standard"),
    "  Payment terms (always): " + (f.paymentTermsFixed || "varies"),
    "  Multi-page: " + (f.multiPage ? "yes — " + (f.pageMarker || "continued marker") : "no"),
    "  GST on PO: " + (f.hasGSTOnPO ? "yes" : "no"),
    "  Explicit delivery date: " + (f.hasExplicitDeliveryDate ? "yes" : "no — check T&C"),
    "  Currency on PO: " + (f.currencyOnPO || "INR"),
  ];
  if (f.quirks) lines.push("  Quirks: " + f.quirks);
  lines.push("Use this known structure for faster, more accurate extraction.");
  lines.push("Compare this PO against the known format. If anything differs significantly,");
  lines.push("set formatChanged=true and describe the difference in formatChangeSummary.");
  return lines.join("\n");
};

// ─── EXPORT BUILDERS ──────────────────────────────────────────────────────────
const buildSalesOrderCSV = (so) => {
  const H = ["Date","Type","Voucher No","PO Ref","Party","Bill To","Bill GSTIN","Ship To","Ship GSTIN",
    "#","Tally Item Name","Item Description","HSN","Cust PN","Seller PN","UOM","Qty","Rate","Disc%","Amt",
    "CGST%","CGST","SGST%","SGST","IGST%","IGST","Total+GST","Due","Part Name Source","Narration"];
  const rows = (so.lineItems || []).map((li) => [
    so.date, so.voucherType, so.voucherNo, so.reference, so.partyName,
    so.billTo && so.billTo.name, so.billTo && so.billTo.gstin,
    so.shipTo && so.shipTo.name, so.shipTo && so.shipTo.gstin,
    li.sno, li.tallyItemName || li.itemName, li.itemName, li.hsnCode, li.custPartNo, li.sellerPartNo,
    li.uom, li.qty, li.rate, li.discount || 0, li.amount,
    li.cgst, li.cgstAmt, li.sgst, li.sgstAmt, li.igst, li.igstAmt,
    li.totalWithGst, li.dueDate, li.partNameSource || "", so.narration,
  ].map(escCSV).join(","));
  return [H.map(escCSV).join(","), ...rows,
    "", "Sub Total,,,,,,,,,,,,,,,,,,," + escCSV(so.subTotal),
    "CGST,,,,,,,,,,,,,,,,,,,,," + escCSV(so.totalCgst),
    "SGST,,,,,,,,,,,,,,,,,,,,," + escCSV(so.totalSgst),
    "IGST,,,,,,,,,,,,,,,,,,,,," + escCSV(so.totalIgst),
    "Grand Total,,,,,,,,,,,,,,,,,,,,," + escCSV(so.grandTotal),
  ].join("\n");
};

const buildSalesOrderXML = (so) => {
  const t = (name, val) => "<" + name + ">" + (val || "") + "</" + name + ">";
  const items = (so.lineItems || []).map((li) => (
    "<ALLINVENTORYENTRIES.LIST>" +
    t("STOCKITEMNAME", li.tallyItemName || li.itemName) +
    t("RATE", li.rate + "/Nos.") +
    t("AMOUNT", "-" + li.amount) +
    t("ACTUALQTY", li.qty + " Nos.") +
    t("BILLEDQTY", li.qty + " Nos.") +
    t("DUEON", li.dueDate) +
    "</ALLINVENTORYENTRIES.LIST>"
  )).join("");
  const d = (so.date || "").replace(/-/g, "");
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    "<ENVELOPE><HEADER>" + t("TALLYREQUEST","Import Data") + "</HEADER><BODY><IMPORTDATA>" +
    "<REQUESTDESC>" + t("REPORTNAME","Vouchers") + "</REQUESTDESC>" +
    "<REQUESTDATA><TALLYMESSAGE>" +
    "<VOUCHER REMOTEID=\"" + so.voucherNo + "\" VCHTYPE=\"Sales Order\" ACTION=\"Create\">" +
    t("DATE",d) + t("NARRATION",so.narration) +
    t("VOUCHERTYPENAME","Sales Order") + t("VOUCHERNUMBER",so.voucherNo) +
    t("PARTYLEDGERNAME",so.partyName) + t("PURCHASEORDERNO",so.reference) +
    "<ALLLEDGERENTRIES.LIST>" + t("LEDGERNAME",so.partyName) + t("AMOUNT","-"+so.grandTotal) + "</ALLLEDGERENTRIES.LIST>" +
    items + "</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>";
};

const buildSourcePOCSV = (spo) => {
  const sym = (CURRENCY_META[spo.currency] || {}).symbol || spo.currency;
  const H = [
    "SPO Reference", "Supplier", "Supplier Type", "Country", "Currency",
    "Exchange Rate (1 FCY = ? INR)", "Supplier Quote Ref",
    "#", "Tally Item Name", "Seller Part No",
    "Description", "UOM", "Qty",
    "Unit Cost (" + spo.currency + ")", "Amount (" + spo.currency + ")",
    "Unit Cost (INR eq.)", "Landed Cost (INR)",
    "Source Confidence", "Source Note"
  ];
  const rows = (spo.lineItems || []).map((li) => [
    spo.reference, spo.supplier, spo.supplierType, spo.country, spo.currency,
    spo.exchangeRate || "N/A",
    spo.supplierQuoteRef || "",
    li.sno, li.tallyItemName || li.sellerPartNo, li.sellerPartNo,
    li.description, li.uom, li.qty,
    li.unitCostForeign != null ? li.unitCostForeign : "N/A",
    li.amountForeign   != null ? li.amountForeign   : "N/A",
    li.unitCostINR     != null ? li.unitCostINR      : "N/A",
    li.landedCostINR   != null ? li.landedCostINR    : "N/A",
    li.sourceConfidence || "", li.sourceNote || "",
  ].map(escCSV).join(","));
  const footer = spo.hasCostData ? [
    "",
    escCSV("Total " + spo.currency) + ",,,,,,,,,,,,," + escCSV(spo.totalForeign),
    escCSV("Total INR equivalent") + ",,,,,,,,,,,,,,,," + escCSV(spo.totalINR),
    escCSV("Total Landed INR") + ",,,,,,,,,,,,,,,,," + escCSV(spo.totalLandedINR),
  ] : ["", "No cost data available in price composition"];
  return [H.map(escCSV).join(","), ...rows, ...footer].join("\n");
};

const makeDataURI = (content, mime) => {
  try {
    return "data:" + mime + ";base64," + btoa(unescape(encodeURIComponent(content)));
  } catch (_) {
    return "data:" + mime + ";charset=utf-8," + encodeURIComponent(content);
  }
};

// ─── UI PRIMITIVES ────────────────────────────────────────────────────────────
const Card = ({ children, className }) => (
  <div className={"bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden " + (className || "")}>
    {children}
  </div>
);

const CardHead = ({ title, sub, right, accent }) => (
  <div
    className={"px-5 py-3 flex items-center justify-between " + (accent ? "" : "border-b border-slate-100")}
    style={accent ? { background: accent } : {}}
  >
    <div>
      <div className={"font-bold text-sm " + (accent ? "text-white tracking-widest uppercase" : "text-slate-800")}>{title}</div>
      {sub && <div className={"text-xs mt-0.5 " + (accent ? "text-white/70" : "text-slate-400")}>{sub}</div>}
    </div>
    {right && <div>{right}</div>}
  </div>
);

const Fld = ({ label, value, mono }) => (
  <div className="mb-3">
    <div className="text-xs text-slate-400 uppercase tracking-wide mb-0.5">{label}</div>
    <div className={"text-sm font-medium text-slate-800 " + (mono ? "font-mono" : "")}>{value || "—"}</div>
  </div>
);

const Tbl = ({ headers, rows }) => (
  <div className="overflow-x-auto rounded-xl border border-slate-100">
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr className="bg-slate-50">
          {headers.map((h, i) => <th key={i} className="text-left px-3 py-2 font-semibold text-slate-500 border-b border-slate-200 whitespace-nowrap">{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-slate-50/50"}>
            {row.map((c, j) => <td key={j} className="px-3 py-2 border-b border-slate-100 text-slate-700 whitespace-nowrap">{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const Btn = ({ onClick, disabled, children, variant, size, full, className }) => {
  const v = variant || "primary";
  const s = size || "md";
  const sizes = { sm: "px-3 py-1.5 text-xs", md: "px-4 py-2 text-sm", lg: "px-5 py-3 text-sm" };
  const base = "rounded-xl font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed";
  let cls = "", st = {};
  if (v === "primary")   { cls = "text-white shadow-md"; st = gradStyle; }
  if (v === "success")   { cls = "text-white bg-emerald-600 hover:bg-emerald-700"; }
  if (v === "danger")    { cls = "text-white bg-red-600 hover:bg-red-700"; }
  if (v === "secondary") { cls = "text-slate-700 bg-white border border-slate-300 hover:bg-slate-50"; }
  if (v === "amber")     { cls = "text-white bg-amber-500 hover:bg-amber-600"; }
  return (
    <button onClick={onClick} disabled={disabled} style={st}
      className={base + " " + sizes[s] + " " + cls + (full ? " w-full" : "") + (className ? " " + className : "")}>
      {children}
    </button>
  );
};

const Pill = ({ label, color }) => {
  const map = {
    amber:  "bg-amber-100 text-amber-800 border-amber-300",
    green:  "bg-emerald-100 text-emerald-800 border-emerald-300",
    red:    "bg-red-100 text-red-800 border-red-300",
    blue:   "bg-blue-100 text-blue-800 border-blue-300",
    slate:  "bg-slate-100 text-slate-600 border-slate-300",
    purple: "bg-purple-100 text-purple-800 border-purple-300",
    orange: "bg-orange-100 text-orange-800 border-orange-300",
  };
  return <span className={"text-xs font-bold px-2 py-0.5 rounded-full border " + (map[color] || map.slate)}>{label}</span>;
};

const StatusPill = ({ status }) => {
  const m = {
    PENDING_REVIEW: { c:"amber",  l:"Pending Review" },
    APPROVED:       { c:"green",  l:"Approved"       },
    REJECTED:       { c:"red",    l:"Rejected"       },
    EXPORTED:       { c:"blue",   l:"Exported"       },
    BLOCKED:        { c:"red",    l:"Blocked"        },
    DUPLICATE:      { c:"purple", l:"Duplicate"      },
  };
  const s = m[status] || { c:"slate", l:"Draft" };
  return <Pill label={s.l} color={s.c} />;
};

const SevBadge = ({ sev }) => {
  const m = {
    CRITICAL: "bg-red-100 text-red-700 border-red-300",
    WARNING:  "bg-amber-100 text-amber-700 border-amber-300",
    OK:       "bg-emerald-100 text-emerald-700 border-emerald-300",
  };
  return <span className={"text-xs font-bold px-2 py-0.5 rounded-full border " + (m[sev] || m.OK)}>{sev}</span>;
};

const ConfidencePill = ({ confidence }) => {
  const meta = SOURCE_CONFIDENCE_META[confidence] || { color: "slate", label: confidence || "Unknown" };
  return <Pill label={meta.label} color={meta.color} />;
};

// ─── CHECKROW ─────────────────────────────────────────────────────────────────
const CheckRow = ({ k, checks, isDup, pf, dupOrder, onViewDup }) => {
  const meta = CHECK_META[k];
  const chk = (checks && checks[k]) || {};
  const isDupRow = k === "P4_duplicateCheck" && isDup;
  const pass   = isDupRow ? false : !!chk.pass;
  const code   = isDupRow ? "DUPLICATE_PO" : (chk.code || "");
  const detail = isDupRow
    ? "PO " + (pf && pf.poNumber) + " already processed on " + dateLabel(dupOrder && dupOrder.createdAt)
    : (chk.detail || "");
  return (
    <div className={"flex items-start gap-3 p-3 rounded-xl border mb-2 " + (pass ? "bg-slate-50 border-slate-200" : "bg-red-50 border-red-200")}>
      <span className="text-base flex-shrink-0 mt-0.5">{pass ? "✅" : "❌"}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm text-slate-800">{meta.icon} {meta.label}</span>
          <code className={"text-xs px-1.5 py-0.5 rounded font-bold " + (pass ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700")}>{code}</code>
          {!pass && meta.blocker && <span className="text-xs bg-red-600 text-white px-1.5 py-0.5 rounded font-bold">BLOCKER</span>}
        </div>
        {detail && <p className="text-xs text-slate-500 mt-1 leading-relaxed">{detail}</p>}
        {isDupRow && dupOrder && (
          <button onClick={onViewDup} className="mt-1.5 text-xs font-bold text-purple-700 bg-purple-100 border border-purple-300 px-2 py-1 rounded-lg hover:bg-purple-200">
            View Existing SO
          </button>
        )}
      </div>
    </div>
  );
};

// ─── PREFLIGHT PANEL ──────────────────────────────────────────────────────────
const PreflightPanel = ({ pf, isDup, dupOrder, onProceed, onReset, onViewDup }) => {
  const checks = (pf && pf.checks) || {};
  const hasBlockers = (pf && pf.blockers && pf.blockers.length > 0) || isDup;
  const warnings = (pf && pf.warnings) || [];
  const rowProps = { checks, isDup, pf, dupOrder, onViewDup };
  return (
    <div className="space-y-4">
      {hasBlockers ? (
        <div className="p-4 bg-red-50 border-2 border-red-400 rounded-2xl">
          <div className="flex items-start gap-3 mb-3">
            <span className="text-3xl">🚫</span>
            <div>
              <div className="font-bold text-red-800 text-base">Cannot process — blocker(s) found</div>
              <div className="text-sm text-red-700 mt-1">{pf && pf.suggestedAction}</div>
            </div>
          </div>
          <div className="space-y-1.5">
            {isDup && (
              <div className="flex items-center gap-2 p-2 bg-purple-50 border border-purple-200 rounded-xl text-xs">
                <span>🔄</span>
                <span className="text-purple-800 font-bold">DUPLICATE: </span>
                <span className="text-purple-700">PO {pf && pf.poNumber} already processed on {dateLabel(dupOrder && dupOrder.createdAt)}</span>
              </div>
            )}
            {(pf && pf.blockers || []).map((b, i) => (
              <div key={i} className="flex items-center gap-2 p-2 bg-red-100 border border-red-200 rounded-xl text-xs">
                <span>🔴</span><span className="text-red-700">{b}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="p-4 bg-emerald-50 border-2 border-emerald-300 rounded-2xl flex items-start gap-3">
          <span className="text-3xl">✅</span>
          <div>
            <div className="font-bold text-emerald-800 text-base">Pre-flight passed — ready to generate Sales Order</div>
            <div className="text-sm text-emerald-700 mt-1">{pf && pf.matchSummary}</div>
            {warnings.length > 0 && <div className="text-xs text-amber-700 mt-1">{warnings.length} warning(s) to review after processing</div>}
          </div>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
          <div className="text-xs font-bold text-amber-800 mb-2">Non-blocking Warnings</div>
          {warnings.map((w, i) => <div key={i} className="text-xs text-amber-700 flex gap-2 mb-1"><span>•</span><span>{w}</span></div>)}
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 px-1">Purchase Order Checks</div>
          {PO_KEYS.map((k) => <CheckRow key={k} k={k} {...rowProps} />)}
        </div>
        <div>
          <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 px-1">Quote Checks</div>
          {Q_KEYS.map((k) => <CheckRow key={k} k={k} {...rowProps} />)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="p-3 bg-slate-50 border rounded-xl text-xs space-y-1.5">
          <div className="font-bold text-slate-600 mb-1">PO Identified</div>
          {[["Number", pf && pf.poNumber],["Date",pf && pf.poDate],["Vendor",pf && pf.poVendorName],["GSTIN",pf && pf.poVendorGSTIN]].map(([l,v]) => (
            <div key={l} className="flex justify-between gap-2">
              <span className="text-slate-400">{l}</span>
              <span className="font-mono font-semibold text-slate-700">{v || "—"}</span>
            </div>
          ))}
        </div>
        <div className="p-3 bg-slate-50 border rounded-xl text-xs space-y-1.5">
          <div className="font-bold text-slate-600 mb-1">Quote Identified</div>
          {[["Number",pf && pf.quoteNumber],["Date",pf && pf.quoteDate],["Issuer",pf && pf.quoteIssuer],["Match",pf && pf.matchSummary]].map(([l,v]) => (
            <div key={l} className="flex justify-between gap-2">
              <span className="text-slate-400">{l}</span>
              <span className="font-mono font-semibold text-slate-700">{v || "—"}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex gap-3 pt-1">
        <Btn onClick={onReset} variant="secondary" size="md">Upload Different Documents</Btn>
        {!hasBlockers && <Btn onClick={onProceed} size="md" full>Generate Sales Order + Source POs</Btn>}
      </div>
    </div>
  );
};

// ─── APPROVAL MODAL ───────────────────────────────────────────────────────────
const ApprovalModal = ({ order, onClose, onDecide }) => {
  const [note, setNote] = useState("");
  const crits = ((order && order.result && order.result.discrepancies) || []).filter((d) => d.severity === "CRITICAL");
  const vNo = order && order.result && order.result.salesOrder && order.result.salesOrder.voucherNo;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.65)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 text-white font-bold text-sm tracking-widest uppercase" style={gradStyle}>
          Manager Review — {vNo}
        </div>
        <div className="p-5 space-y-4">
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl">
            <div className="font-bold text-red-700 text-sm mb-2">{crits.length} Critical Issue(s)</div>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {crits.map((d, i) => (
                <div key={i} className="text-xs p-2 bg-red-100 rounded-lg">
                  <div className="font-semibold text-red-800">{d.field}</div>
                  <div className="text-red-600 mt-0.5">{d.message}</div>
                  {d.poValue && <div className="font-mono text-slate-500 mt-1">PO: {d.poValue} | Quote: {d.quoteValue}</div>}
                </div>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-bold text-slate-600 uppercase tracking-wide block mb-1.5">
              Justification Note (required)
            </label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
              placeholder="e.g. Price variance confirmed by customer. Proceed."
              className="w-full border border-slate-300 rounded-xl p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-200 bg-slate-50" />
          </div>
          <div className="flex gap-2">
            <Btn onClick={onClose} variant="secondary" size="sm">Cancel</Btn>
            <Btn onClick={() => note.trim() && onDecide("REJECTED", note)} variant="danger" size="sm" disabled={!note.trim()}>Reject</Btn>
            <Btn onClick={() => note.trim() && onDecide("APPROVED", note)} variant="success" size="sm" disabled={!note.trim()} full>Approve and Unlock</Btn>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── SOURCE PO CARD ───────────────────────────────────────────────────────────
const SourcePOCard = ({ spo, onDownload }) => {
  const cm = CURRENCY_META[spo.currency] || { flag: "🌐", label: spo.currency, symbol: spo.currency + " " };
  const inferredItems = (spo.lineItems || []).filter((li) =>
    li.sourceConfidence === "pattern_inferred" || li.sourceConfidence === "price_comp_inferred"
  );
  const accentColor = spo.supplierType === "inter-company" ? "#1e40af" :
                      spo.supplierType === "internal"      ? "#065f46" : "#92400e";
  return (
    <Card>
      <CardHead
        accent={accentColor}
        title={cm.flag + "  " + spo.supplier}
        sub={spo.reference + " · " + spo.country + " · " + spo.currency + (spo.exchangeRate ? " @ ₹" + spo.exchangeRate : "")}
        right={
          <span className="text-xs font-bold px-2 py-1 rounded-full border border-white/40 text-white/90">
            {spo.supplierType}
          </span>
        }
      />
      <div className="p-4 space-y-3">
        {inferredItems.length > 0 && (
          <div className="p-2.5 bg-orange-50 border border-orange-200 rounded-xl text-xs text-orange-800 flex gap-2">
            <span className="flex-shrink-0">⚠️</span>
            <span>
              <strong>{inferredItems.length} item(s)</strong> have inferred source — not explicitly stated in price comp.
              Verify before raising purchase order.
            </span>
          </div>
        )}
        {!spo.hasCostData && (
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 flex gap-2">
            <span className="flex-shrink-0">📋</span>
            <span>No cost data available — price comp not uploaded or costs not stated for these items. Quantities and item names shown only.</span>
          </div>
        )}
        <Tbl
          headers={["#", "Tally Item Name", "Seller Part No", "Qty", "UOM",
            "Unit Cost (" + spo.currency + ")", "Amt (" + spo.currency + ")",
            "Unit Cost (INR)", "Landed Cost (INR)", "Source"]}
          rows={(spo.lineItems || []).map((li) => [
            li.sno,
            li.tallyItemName || li.sellerPartNo || "—",
            li.sellerPartNo || "—",
            li.qty,
            li.uom || "No.",
            li.unitCostForeign != null ? fmtFCY(li.unitCostForeign, cm.symbol) : "—",
            li.amountForeign   != null ? fmtFCY(li.amountForeign,   cm.symbol) : "—",
            li.unitCostINR     != null ? fmt(li.unitCostINR) : "—",
            li.landedCostINR   != null ? fmt(li.landedCostINR) : "—",
            <ConfidencePill key={li.sno} confidence={li.sourceConfidence} />,
          ])}
        />
        {spo.hasCostData && (
          <div className="flex justify-end">
            <div className="bg-slate-50 rounded-xl p-3 border text-xs space-y-1 min-w-72">
              {spo.supplierQuoteRef && (
                <div className="flex justify-between gap-8">
                  <span className="text-slate-500">Supplier Ref</span>
                  <span className="font-mono text-slate-600">{spo.supplierQuoteRef}</span>
                </div>
              )}
              <div className="flex justify-between gap-8">
                <span className="text-slate-500">Total {spo.currency} (cost)</span>
                <span className="font-mono font-bold text-slate-800">{fmtFCY(spo.totalForeign, cm.symbol)}</span>
              </div>
              {spo.exchangeRate && (
                <div className="flex justify-between gap-8">
                  <span className="text-slate-500">Exchange rate</span>
                  <span className="font-mono text-slate-600">1 {spo.currency} = ₹{spo.exchangeRate}</span>
                </div>
              )}
              {spo.totalINR != null && (
                <div className="flex justify-between gap-8">
                  <span className="text-slate-500">Total INR equivalent</span>
                  <span className="font-mono text-slate-700">{fmt(spo.totalINR)}</span>
                </div>
              )}
              {spo.totalLandedINR != null && spo.totalLandedINR > 0 && (
                <div className="flex justify-between gap-8 border-t pt-1">
                  <span className="text-slate-500 font-semibold">Total Landed Cost (INR)</span>
                  <span className="font-mono font-bold text-blue-800">{fmt(spo.totalLandedINR)}</span>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="flex justify-end pt-1">
          <a
            href={makeDataURI("\uFEFF" + buildSourcePOCSV(spo), "text/csv;charset=utf-8")}
            download={"SPO_" + spo.country + "_" + (spo.reference || "export") + ".csv"}
            onClick={onDownload}
            className="inline-flex items-center gap-2 text-white text-xs font-semibold py-2 px-4 rounded-xl shadow-md"
            style={gradStyle}
          >
            ⬇️ Download Source PO CSV
          </a>
        </div>
      </div>
    </Card>
  );
};

// ─── STAT CARD ────────────────────────────────────────────────────────────────
const StatCard = ({ icon, label, value, sub, color }) => (
  <Card className="p-4">
    <div className="text-2xl mb-2">{icon}</div>
    <div className={"text-xl font-bold font-mono " + (color || "text-slate-800")}>{value}</div>
    <div className="text-xs font-semibold text-slate-600 mt-0.5">{label}</div>
    {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
  </Card>
);

// ─── METRICS DASHBOARD ────────────────────────────────────────────────────────
const MetricsDash = ({ metrics, orders }) => {
  const processed = metrics.totalProcessed || 0;
  const blocked   = metrics.blocked || 0;
  const totalValue = (orders || []).filter((o) => o.result && o.result.salesOrder)
    .reduce((s, o) => s + (o.result.salesOrder.grandTotal || 0), 0);
  const avgT = metrics.avgMs ? (metrics.avgMs / 1000).toFixed(1) + "s" : "—";
  const manualMins = processed * 25;
  const aiMins = metrics.avgMs ? Math.round(processed * metrics.avgMs / 1000 / 60) : 0;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-4">
        <StatCard icon="📦" label="SOs Processed"    value={fmtN(processed)}   sub="fully generated" />
        <StatCard icon="💰" label="Total Value"       value={fmt(totalValue)}   sub="through agent" />
        <StatCard icon="🚫" label="Blocked at Intake" value={fmtN(blocked)}     sub="saved wasted effort" color="text-red-500" />
        <StatCard icon="⚡" label="Avg Process Time"  value={avgT}              sub="vs ~25 min manual" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <StatCard icon="🔄" label="Duplicates Caught" value={fmtN(metrics.duplicatesBlocked || 0)} sub="re-entry prevented" color="text-purple-600" />
        <StatCard icon="🏢" label="Wrong Vendor"       value={fmtN(metrics.wrongVendorBlocked || 0)} sub="not for Obara" color="text-orange-600" />
        <StatCard icon="📄" label="Wrong Quote"        value={fmtN(metrics.wrongQuoteBlocked || 0)}  sub="mismatched docs" color="text-amber-600" />
      </div>
      <Card>
        <CardHead title="Time Savings" accent={DARK} />
        <div className="p-5">
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="text-center p-4 bg-red-50 rounded-xl border">
              <div className="text-3xl font-bold text-red-500 font-mono">{manualMins}</div>
              <div className="text-xs text-slate-500 mt-1">Manual mins ({processed} x 25)</div>
            </div>
            <div className="text-center p-4 bg-emerald-50 rounded-xl border border-emerald-200">
              <div className="text-3xl font-bold text-emerald-600 font-mono">{aiMins}</div>
              <div className="text-xs text-slate-500 mt-1">AI mins (avg {avgT})</div>
            </div>
            <div className="text-center p-4 bg-blue-50 rounded-xl border border-blue-200">
              <div className="text-3xl font-bold text-blue-700 font-mono">{Math.max(0, manualMins - aiMins)}</div>
              <div className="text-xs text-slate-500 mt-1">Minutes saved</div>
            </div>
          </div>
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
            <strong>Annualised:</strong> ~200 SOs/month x 25 min = <strong>{Math.round(200*25/60)} hrs/month</strong>.
            At Rs.400/hr = <strong>Rs.{Math.round(200*25/60*400).toLocaleString("en-IN")}/month</strong> recoverable.
            Plus <strong>{fmtN(metrics.criticalsCaught || 0)} critical issues</strong> caught before Tally export.
          </div>
        </div>
      </Card>
    </div>
  );
};

// ─── HISTORY LIST ─────────────────────────────────────────────────────────────
const HistoryList = ({ orders, onSelect, onApprove }) => {
  if (!orders || !orders.length) {
    return (
      <div className="text-center py-12 text-slate-400">
        <div className="text-4xl mb-3">📂</div>
        <div className="font-semibold">No entries yet</div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {orders.map((o) => {
        const isBlocked = o.status === "BLOCKED" || o.status === "DUPLICATE";
        const crit  = ((o.result && o.result.discrepancies) || []).filter((d) => d.severity === "CRITICAL").length;
        const warn  = ((o.result && o.result.discrepancies) || []).filter((d) => d.severity === "WARNING").length;
        const vNo   = o.result && o.result.salesOrder && o.result.salesOrder.voucherNo;
        const cust  = (o.result && o.result.po && o.result.po.customer) || o.preflightCustomer;
        const total = o.result && o.result.salesOrder && o.result.salesOrder.grandTotal;
        const spoCnt = ((o.result && o.result.sourcePOs) || []).length;
        return (
          <div key={o.id} onClick={() => onSelect(o)}
            className={"p-4 border rounded-2xl cursor-pointer transition-all " + (isBlocked ? "bg-slate-50 border-slate-200 opacity-75 hover:opacity-100" : "bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm")}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-sm font-mono text-slate-800">{vNo || o.preflightPONumber || o.id}</span>
                  <StatusPill status={o.status} />
                  {!isBlocked && crit > 0 && <span className="text-xs text-red-500 font-semibold">{crit} critical</span>}
                  {!isBlocked && warn > 0 && <span className="text-xs text-amber-500">{warn} warnings</span>}
                  {spoCnt > 0 && <span className="text-xs text-blue-600 font-semibold">{spoCnt} source PO{spoCnt > 1 ? "s" : ""}</span>}
                </div>
                <div className="text-xs text-slate-500 mt-1">{cust || "—"} · PO: {o.preflightPONumber || (o.result && o.result.po && o.result.po.number) || "—"}</div>
                <div className="text-xs text-slate-400">{dateLabel(o.createdAt)} {timeLabel(o.createdAt)}</div>
                {o.blockerSummary && <div className="text-xs text-red-500 italic mt-1">Blocked: {o.blockerSummary}</div>}
              </div>
              <div className="text-right flex-shrink-0">
                {!isBlocked && <div className="font-bold text-sm text-slate-800">{fmt(total)}</div>}
                {o.status === "PENDING_REVIEW" && crit > 0 && (
                  <button onClick={(e) => { e.stopPropagation(); onApprove(o); }}
                    className="mt-2 text-xs font-bold text-amber-700 bg-amber-100 border border-amber-300 px-2 py-1 rounded-lg hover:bg-amber-200 block">
                    Review
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ─── TOKEN GAUGE ──────────────────────────────────────────────────────────────
const TokenGauge = ({ est }) => {
  if (!est) return null;

  const risk = tokenRiskLevel(est);
  if (risk === "none") return null;

  const riskMeta = {
    low:      { bg: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-800",   bar: "bg-blue-400",   icon: "ℹ️",  label: "Low token usage" },
    medium:   { bg: "bg-amber-50",  border: "border-amber-200",  text: "text-amber-800",  bar: "bg-amber-400",  icon: "⚠️",  label: "Moderate token usage" },
    high:     { bg: "bg-orange-50", border: "border-orange-300", text: "text-orange-800", bar: "bg-orange-500", icon: "🔶",  label: "High token usage — monitor carefully" },
    critical: { bg: "bg-red-50",    border: "border-red-300",    text: "text-red-800",    bar: "bg-red-500",    icon: "🔴",  label: "Near token limit — response may be truncated" },
  };
  const m = riskMeta[risk];

  const outPct   = Math.min(100, Math.round(est.outputRisk * 100));
  const inPct    = Math.min(100, Math.round(est.inputRisk  * 100));
  const fmtK     = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);

  const tips = [];
  if (est.outputRisk > 0.5)
    tips.push("Large output expected — JSON response may be near the 16k token limit.");
  if (est.inputRisk > 0.5)
    tips.push("Large input — approaching context window limit.");
  if (est.outputRisk > 0.7)
    tips.push("Consider whether the price comp is needed for this order, or process without it first.");
  if (est.outputRisk > 0.9)
    tips.push("HIGH RISK: The response is very likely to be truncated. Split the PO into batches or remove the price comp.");

  return (
    <div className={"p-3 border rounded-xl " + m.bg + " " + m.border}>
      <div className={"flex items-center gap-2 mb-2 " + m.text}>
        <span>{m.icon}</span>
        <span className="font-bold text-xs">{m.label}</span>
      </div>

      <div className="space-y-1.5 mb-2">
        <div>
          <div className="flex justify-between text-xs mb-0.5">
            <span className={m.text + " font-medium"}>Expected output</span>
            <span className={"font-mono font-bold " + m.text}>{fmtK(est.call2Output)} / {fmtK(MAX_OUTPUT_TOKENS)} tokens ({outPct}%)</span>
          </div>
          <div className="h-1.5 bg-white rounded-full border border-slate-200">
            <div className={"h-full rounded-full transition-all " + m.bar} style={{ width: outPct + "%" }} />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-xs mb-0.5">
            <span className={m.text + " font-medium"}>Total input (both calls)</span>
            <span className={"font-mono " + m.text}>{fmtK(est.totalInput)} / {fmtK(MAX_INPUT_TOKENS)} tokens ({inPct}%)</span>
          </div>
          <div className="h-1.5 bg-white rounded-full border border-slate-200">
            <div className={"h-full rounded-full transition-all " + (inPct > 70 ? m.bar : "bg-slate-300")} style={{ width: inPct + "%" }} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-2">
        {[
          ["PO",         fmtK(est.poTokens)],
          ["Quote",      fmtK(est.quoteTokens)],
          ["Price comp", est.pcTokens ? fmtK(est.pcTokens) : "—"],
        ].map(([label, val]) => (
          <div key={label} className={"text-center p-1.5 rounded-lg border " + m.border + " bg-white/60"}>
            <div className={"text-xs font-mono font-bold " + m.text}>{val}</div>
            <div className="text-xs text-slate-400">{label}</div>
          </div>
        ))}
      </div>

      {tips.map((tip, i) => (
        <div key={i} className={"text-xs mt-1 flex gap-1.5 " + m.text}>
          <span className="flex-shrink-0">→</span><span>{tip}</span>
        </div>
      ))}
    </div>
  );
};

// ─── DROP ZONE ────────────────────────────────────────────────────────────────
const DropZone = ({ label, file, setFile, inputRef, icon, optional }) => (
  <div
    onClick={() => inputRef.current && inputRef.current.click()}
    onDragOver={(e) => e.preventDefault()}
    onDrop={(e) => { e.preventDefault(); setFile(e.dataTransfer.files[0]); }}
    className="border-2 border-dashed rounded-2xl p-5 text-center cursor-pointer transition-all"
    style={{ borderColor: file ? "#10b981" : optional ? "#a5b4fc" : "#cbd5e1", background: file ? "#f0fdf4" : optional ? "#f5f3ff" : "#f8fafc" }}
  >
    <input ref={inputRef} type="file" accept=".pdf,.xlsx,.xls,image/*" className="hidden" onChange={(e) => setFile(e.target.files[0])} />
    {file ? (
      <>
        <div className="text-2xl mb-1">✅</div>
        <div className="text-sm font-semibold text-emerald-700 truncate px-2">{file.name}</div>
        <div className="text-xs text-emerald-500">{(file.size / 1024).toFixed(1)} KB</div>
      </>
    ) : (
      <>
        <div className="text-3xl mb-2">{icon}</div>
        <div className="text-sm font-semibold text-slate-600">{label}</div>
        <div className="text-xs text-slate-400 mt-1">{optional ? "Optional · PDF, Excel · drag or click" : "PDF · drag and drop or click"}</div>
      </>
    )}
  </div>
);

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]                   = useState("process");
  const [poFile, setPoFile]             = useState(null);
  const [quoteFile, setQuoteFile]       = useState(null);
  const [priceCompFile, setPriceCompFile] = useState(null);
  const [engineerNote, setEngineerNote] = useState("");
  const [stage, setStage]               = useState("idle");
  const [pf, setPf]                     = useState(null);
  const [isDup, setIsDup]               = useState(false);
  const [dupOrder, setDupOrder]         = useState(null);
  const [activeOrder, setActiveOrder]   = useState(null);
  const [orders, setOrders]             = useState([]);
  const [metrics, setMetrics]           = useState(emptyMetrics());
  const [error, setError]               = useState(null);
  const [showApproval, setShowApproval] = useState(false);
  const [approvalTarget, setApprovalTarget] = useState(null);
  const [ready, setReady]               = useState(false);
  const [customerFormats, setCustomerFormats] = useState({});
  const [formatStatus, setFormatStatus]   = useState(null); // null | "known" | "new" | "changed"
  const [tokenEst, setTokenEst]           = useState(null); // token estimate for current files

  const poRef        = useRef();
  const quoteRef     = useRef();
  const priceCompRef = useRef();
  const b64po  = useRef(null);
  const b64q   = useRef(null);
  const b64pc  = useRef(null);
  const poMime = useRef("application/pdf");
  const qMime  = useRef("application/pdf");
  const pcMime = useRef("application/pdf");

  useEffect(() => {
    loadOrders().then((os) => setOrders(os));
    loadMetrics().then((m) => { setMetrics(m); setReady(true); });
    loadFormats().then((f) => setCustomerFormats(f));
  }, []);

  // Recompute token estimate whenever files change
  useEffect(() => {
    if (!poFile && !quoteFile) { setTokenEst(null); return; }
    const est = estimateCallTokens(
      poFile        ? poFile.size        : 0,
      quoteFile     ? quoteFile.size     : 0,
      priceCompFile ? priceCompFile.size : 0,
      false  // conservatively assume no format context yet
    );
    setTokenEst(est);
  }, [poFile, quoteFile, priceCompFile]);

  const discrepancies = (activeOrder && activeOrder.result && activeOrder.result.discrepancies) || [];
  const critCount = discrepancies.filter((d) => d.severity === "CRITICAL").length;
  const warnCount = discrepancies.filter((d) => d.severity === "WARNING").length;
  const sourcePOs = (activeOrder && activeOrder.result && activeOrder.result.sourcePOs) || [];
  const canExport = activeOrder && activeOrder.result && (
    activeOrder.status === "APPROVED" ||
    activeOrder.status === "EXPORTED" ||
    (critCount === 0 && activeOrder.status !== "REJECTED")
  );

  const reset = useCallback(() => {
    setStage("idle"); setPoFile(null); setQuoteFile(null); setPriceCompFile(null);
    setEngineerNote(""); setPf(null); setIsDup(false); setDupOrder(null);
    setError(null); setFormatStatus(null); setTokenEst(null);
    b64po.current = null; b64q.current = null; b64pc.current = null;
  }, []);

  const runPreflight = useCallback(async () => {
    if (!poFile || !quoteFile) { setError("Upload PO and Quote at minimum."); return; }
    setStage("pf_running"); setError(null);
    try {
      const bases = await Promise.all([
        fileToBase64(poFile),
        fileToBase64(quoteFile),
        priceCompFile ? fileToBase64(priceCompFile) : Promise.resolve(null),
      ]);
      b64po.current = bases[0]; b64q.current = bases[1]; b64pc.current = bases[2];
      poMime.current = poFile.type   || "application/pdf";
      qMime.current  = quoteFile.type || "application/pdf";
      if (priceCompFile) pcMime.current = priceCompFile.type || "application/pdf";
      const docs = [
        { type:"text", text:"DOCUMENT 1 — Purchase Order:" },
        { type:"document", source:{ type:"base64", media_type: poMime.current, data: bases[0] } },
        { type:"text", text:"DOCUMENT 2 — Price Quotation:" },
        { type:"document", source:{ type:"base64", media_type: qMime.current, data: bases[1] } },
      ];
      const result = await callClaude(PREFLIGHT_PROMPT, docs);
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
        };
        await saveOrder(rec); setOrders((prev) => [rec, ...prev]);
      }
    } catch (e) { setError("Validation failed: " + e.message); setStage("idle"); }
  }, [poFile, quoteFile, priceCompFile]);

  const generateSO = useCallback(async () => {
    setStage("so_running"); setError(null); setFormatStatus(null);
    const t0 = Date.now();
    try {
      // ── Look up stored format profile for this customer ──────────────────
      const custGSTIN = pf && pf.poVendorGSTIN;
      const custName  = pf && pf.poVendorName;
      const custKey   = normalizeCustomerKey(custGSTIN, custName);
      const formats   = await loadFormats();
      const knownProfile = formats[custKey] || null;

      // ── Refresh token estimate with accurate format context knowledge ─────
      const refinedEst = estimateCallTokens(
        poFile        ? poFile.size        : 0,
        quoteFile     ? quoteFile.size     : 0,
        priceCompFile ? priceCompFile.size : 0,
        !!knownProfile
      );
      setTokenEst(refinedEst);

      // ── Build format context block if known customer ─────────────────────
      const formatCtx = knownProfile ? buildFormatContextBlock(knownProfile) : null;

      // ── Assemble system prompt: prepend format context if available ───────
      const systemPrompt = formatCtx
        ? formatCtx + "\n\n" + "=".repeat(60) + "\n" + SO_PROMPT
        : SO_PROMPT;

      const docs = [
        { type:"text", text:"DOCUMENT 1 — Customer Purchase Order:" },
        { type:"document", source:{ type:"base64", media_type: poMime.current, data: b64po.current } },
        { type:"text", text:"DOCUMENT 2 — Obara Price Quotation to Customer:" },
        { type:"document", source:{ type:"base64", media_type: qMime.current, data: b64q.current } },
      ];
      if (b64pc.current) {
        docs.push({ type:"text", text:"DOCUMENT 3 — Internal Price Composition (cost breakdown per item with source country, foreign currency cost, exchange rate):" });
        docs.push({ type:"document", source:{ type:"base64", media_type: pcMime.current, data: b64pc.current } });
      } else {
        docs.push({ type:"text", text:"DOCUMENT 3 — Price Composition: NOT PROVIDED. Infer source from part number patterns and add sourceConfidence = pattern_inferred for all items." });
      }
      if (engineerNote.trim()) {
        docs.push({ type:"text", text:"SALES ENGINEER SOURCE OVERRIDE: " + engineerNote.trim() + ". Apply this as the highest priority source assignment for the items mentioned." });
      }

      const result = await callClaude(systemPrompt, docs);
      const ms = Date.now() - t0;
      const crit = (result.discrepancies || []).filter((d) => d.severity === "CRITICAL").length;
      const warn = (result.discrepancies || []).filter((d) => d.severity === "WARNING").length;

      // ── Update customer format memory ─────────────────────────────────────
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
        };
        const newFormats = { ...formats, [custKey]: updatedProfile };
        await saveFormats(newFormats);
        setCustomerFormats(newFormats);
      }
      setFormatStatus(fStatus);

      const order = {
        id: "order_" + Date.now(),
        status: crit > 0 ? "PENDING_REVIEW" : "APPROVED",
        result,
        preflightPONumber: pf && pf.poNumber,
        preflightCustomer: result.po && result.po.customer,
        hasPriceComp: !!b64pc.current,
        engineerNote: engineerNote.trim() || null,
        formatStatus: fStatus,
        formatChanged: changed,
        formatChangeSummary: result.formatChangeSummary || "",
        usedKnownFormat: !!knownProfile,
        tokenEstimate: refinedEst,
        processingMs: ms, createdAt: nowISO(), approvalNote: null,
      };
      setActiveOrder(order); setOrders((prev) => [order, ...prev]);
      await saveOrder(order);
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
  }, [pf, engineerNote, customerFormats]);

  const handleApproval = useCallback(async (status, note) => {
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
  }, [approvalTarget, activeOrder]);

  const so  = activeOrder && activeOrder.result && activeOrder.result.salesOrder;
  const qt  = activeOrder && activeOrder.result && activeOrder.result.quote;
  const po  = activeOrder && activeOrder.result && activeOrder.result.po;

  return (
    <div style={{ fontFamily: "'IBM Plex Sans',system-ui,sans-serif", background: "#eef2f7", minHeight: "100vh" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {/* HEADER */}
      <div style={gradStyle} className="px-6 py-4 shadow-lg">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <div className="text-xs font-bold tracking-widest text-blue-300 uppercase mb-0.5">Obara India · Sales Operations</div>
            <h1 className="text-lg font-bold text-white">SO Processing Agent <span className="text-blue-300 font-normal text-sm">POC v4</span></h1>
            <p className="text-xs text-blue-300 mt-0.5">Preflight validation · Tally SO · Multi-currency Source POs · Customer format memory · Duplicate detection</p>
          </div>
          <div className="text-right text-xs">
            <div className="text-blue-300">{ready ? "Storage ready" : "Loading..."}</div>
            <div className="text-blue-400">{orders.filter((o) => o.result).length} SOs · {orders.filter((o) => !o.result).length} blocked</div>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-5">
        {/* TABS */}
        <div className="flex gap-1.5 flex-wrap mb-5">
          {[
            { id:"process",   label:"Process" },
            { id:"overview",  label:"PO vs Quote",  disabled: !activeOrder || !activeOrder.result },
            { id:"issues",    label:"Issues" + (activeOrder && activeOrder.result && (critCount + warnCount) > 0 ? " (" + (critCount + warnCount) + ")" : ""), disabled: !activeOrder || !activeOrder.result },
            { id:"so",        label:"Sales Order",  disabled: !activeOrder || !activeOrder.result },
            { id:"sourcepos", label:"Source POs" + (sourcePOs.length > 0 ? " (" + sourcePOs.length + ")" : ""), disabled: !activeOrder || !activeOrder.result },
            { id:"export",    label:"Export",       disabled: !activeOrder || !activeOrder.result },
            { id:"history",   label:"History" + (orders.length > 0 ? " (" + orders.length + ")" : "") },
            { id:"customers", label:"Customers" + (Object.keys(customerFormats).length > 0 ? " (" + Object.keys(customerFormats).length + ")" : "") },
            { id:"metrics",   label:"Proposal Metrics" },
            { id:"info",      label:"ℹ️ How It Works" },
          ].map((t) => (
            <button key={t.id} onClick={() => !t.disabled && setTab(t.id)} disabled={t.disabled}
              className="px-3 py-2 rounded-xl text-xs font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: tab === t.id ? "linear-gradient(135deg," + DARK + "," + MID + ")" : "#fff",
                color: tab === t.id ? "#fff" : "#475569",
                border: tab === t.id ? "none" : "1px solid #e2e8f0",
                boxShadow: tab === t.id ? "0 2px 8px rgba(15,37,64,0.25)" : "none",
              }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── PROCESS ── */}
        {tab === "process" && (
          <div className="max-w-2xl mx-auto space-y-4">
            {stage === "idle" && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <DropZone label="Customer Purchase Order" file={poFile} setFile={setPoFile} inputRef={poRef} icon="📄" />
                  <DropZone label="Obara Price Quotation"   file={quoteFile} setFile={setQuoteFile} inputRef={quoteRef} icon="📋" />
                </div>
                <DropZone
                  label="Price Composition"
                  file={priceCompFile}
                  setFile={setPriceCompFile}
                  inputRef={priceCompRef}
                  icon="💱"
                  optional
                />
                <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-xl text-xs text-indigo-800">
                  <strong>Price Composition</strong> — upload the internal cost breakdown document (Excel or PDF) that shows the foreign currency cost per item, source country, supplier name, and exchange rate. Used to generate Source POs in CNY, JPY, KRW, or INR. If not uploaded, sources will be inferred from part number patterns.
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase tracking-wide block mb-1.5">
                    Source Override Note <span className="text-slate-400 font-normal normal-case">(optional)</span>
                  </label>
                  <textarea
                    value={engineerNote}
                    onChange={(e) => setEngineerNote(e.target.value)}
                    rows={2}
                    placeholder="e.g. Items 1-3 source from Japan (Obara Corp). Item 6 is locally manufactured."
                    className="w-full border border-slate-300 rounded-xl p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white"
                  />
                  <div className="text-xs text-slate-400 mt-1">Override the AI source assignment for specific items. Highest priority over price comp and pattern inference.</div>
                </div>
                <TokenGauge est={tokenEst} />
                {error && <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700">{error}</div>}
                <Btn onClick={runPreflight} disabled={!poFile || !quoteFile} full size="lg">
                  Validate Documents
                </Btn>
              </>
            )}
            {stage === "pf_running" && (
              <div className="text-center py-12">
                <div className="text-4xl mb-3 animate-spin">⚙️</div>
                <div className="font-semibold text-slate-700">Running preflight validation...</div>
                <div className="text-xs text-slate-400 mt-1">Checking 9 conditions across PO and Quote</div>
              </div>
            )}
            {stage === "so_running" && (
              <div className="text-center py-12">
                <div className="text-4xl mb-3 animate-spin">🔄</div>
                <div className="font-semibold text-slate-700">Generating Sales Order + Source POs...</div>
                <div className="text-xs text-slate-400 mt-1">Extracting line items · Matching · Assigning sources · Calculating GST</div>
              </div>
            )}
            {(stage === "pf_done" || stage === "done") && pf && (
              <>
                <PreflightPanel
                  pf={pf}
                  isDup={isDup}
                  dupOrder={dupOrder}
                  onProceed={generateSO}
                  onReset={reset}
                  onViewDup={() => { if (dupOrder) { setActiveOrder(dupOrder); setTab("overview"); } }}
                />
                {formatStatus === "known" && (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center gap-2">
                    <span>✅</span>
                    <span>
                      <strong>Known customer format applied</strong> — extraction used stored fingerprint for faster, more accurate results.
                      {activeOrder && activeOrder.usedKnownFormat && (
                        <> {" "}Format confirmed consistent with previous orders.</>
                      )}
                    </span>
                  </div>
                )}
                {formatStatus === "changed" && (
                  <div className="p-3 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-800 flex items-start gap-2">
                    <span className="flex-shrink-0 text-base">⚠️</span>
                    <div>
                      <strong>PO format changed from previous orders.</strong>
                      {" "}Fingerprint updated automatically.
                      {activeOrder && activeOrder.formatChangeSummary && (
                        <div className="mt-1 text-amber-700">{activeOrder.formatChangeSummary}</div>
                      )}
                      <div className="mt-1">Review this SO carefully — field extraction may differ from usual.</div>
                    </div>
                  </div>
                )}
                {formatStatus === "new" && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800 flex items-center gap-2">
                    <span>🆕</span>
                    <span><strong>New customer — format fingerprint saved.</strong> Future POs from this customer will use this profile for improved accuracy.</span>
                  </div>
                )}
                {error && <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700">{error}</div>}
              </>
            )}
          </div>
        )}

        {/* ── PO vs QUOTE OVERVIEW ── */}
        {tab === "overview" && activeOrder && activeOrder.result && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <Card className="p-4 col-span-1">
                <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Order Status</div>
                <StatusPill status={activeOrder.status} />
                {activeOrder.approvalNote && (
                  <div className="mt-3 p-2 bg-slate-50 border rounded-xl text-xs text-slate-600">
                    <strong>Note:</strong> {activeOrder.approvalNote}
                  </div>
                )}
                {activeOrder.result && activeOrder.result._truncated && (
                  <div className="mt-2 px-2 py-1.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-start gap-1.5">
                    <span className="flex-shrink-0">⚠️</span>
                    <span><strong>Response was truncated</strong> — some line items or source POs may be incomplete. Consider splitting this PO into smaller batches or contact support.</span>
                  </div>
                )}
                {activeOrder.tokenEstimate && (() => {
                  const est = activeOrder.tokenEstimate;
                  const risk = tokenRiskLevel(est);
                  const fmtK = (n) => n >= 1000 ? (n/1000).toFixed(1)+"k" : String(n);
                  const riskColor = { none:"text-emerald-600", low:"text-blue-600", medium:"text-amber-600", high:"text-orange-600", critical:"text-red-600" };
                  return (
                    <div className="mt-2 p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                      <div className="font-semibold text-slate-500 mb-1.5">Token usage estimate</div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                        <span className="text-slate-400">Total input</span>
                        <span className="font-mono text-slate-700">{fmtK(est.totalInput)} tokens</span>
                        <span className="text-slate-400">Output (SO gen)</span>
                        <span className="font-mono text-slate-700">{fmtK(est.call2Output)} / {fmtK(MAX_OUTPUT_TOKENS)}</span>
                        <span className="text-slate-400">Output risk</span>
                        <span className={"font-bold " + (riskColor[risk] || "text-slate-600")}>{Math.round(est.outputRisk * 100)}% — {risk}</span>
                      </div>
                    </div>
                  );
                })()}
                  <div className="mt-2 px-2 py-1 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-700 flex items-center gap-1">
                    <span>✅</span><span>Known format used</span>
                  </div>
                )}
                {activeOrder.formatStatus === "changed" && (
                  <div className="mt-2 px-2 py-1 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-700 flex items-center gap-1">
                    <span>⚠️</span><span>Format changed — verify extraction</span>
                  </div>
                )}
                {activeOrder.formatStatus === "new" && (
                  <div className="mt-2 px-2 py-1 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700 flex items-center gap-1">
                    <span>🆕</span><span>New customer — fingerprint saved</span>
                  </div>
                )}
                <div className="mt-3 text-xs text-slate-400">
                  Processed {dateLabel(activeOrder.createdAt)} {timeLabel(activeOrder.createdAt)}
                  <br />in {activeOrder.processingMs ? (activeOrder.processingMs / 1000).toFixed(1) + "s" : "—"}
                  {activeOrder.hasPriceComp && <span className="ml-2 text-indigo-500 font-semibold">· Price comp included</span>}
                  {activeOrder.engineerNote && <span className="ml-2 text-purple-500 font-semibold">· Engineer override</span>}
                </div>
              </Card>
              <Card className="p-4">
                <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Purchase Order</div>
                {po && <>
                  <div className="font-mono font-bold text-slate-800 mb-1">{po.number}</div>
                  <div className="text-sm text-slate-600">{po.customer}</div>
                  <div className="text-xs text-slate-400 mt-1">{po.date} · {po.paymentTerms}</div>
                </>}
              </Card>
              <Card className="p-4">
                <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Quote</div>
                {qt && <>
                  <div className="font-mono font-bold text-slate-800 mb-1">{qt.number}</div>
                  <div className="text-sm text-slate-600">{qt.date}</div>
                  <div className="text-xs text-slate-400 mt-1">{qt.paymentTerms} · Lead time: {qt.leadTimeDays || "—"}</div>
                </>}
              </Card>
            </div>
            {po && po.lineItems && (
              <Card>
                <CardHead title="PO Line Items" sub={po.lineItems.length + " items"} accent={DARK} />
                <div className="p-4">
                  <Tbl
                    headers={["#","Description","Cust Part No","Qty","UOM","Unit Price","Amount"]}
                    rows={(po.lineItems || []).map((li) => [
                      li.sno, li.description, li.custPartNo || "—",
                      li.qty, li.uom, fmt(li.unitPrice), fmt(li.amount),
                    ])}
                  />
                </div>
              </Card>
            )}
            {qt && qt.lineItems && (
              <Card>
                <CardHead title="Quote Line Items" sub={qt.lineItems.length + " items"} accent={MID} />
                <div className="p-4">
                  <Tbl
                    headers={["#","Description","Seller Part No","HSN","Qty","UOM","Unit Price","CGST%","SGST%","IGST%"]}
                    rows={(qt.lineItems || []).map((li) => [
                      li.sno, li.description, li.sellerPartNo || "—", li.hsnCode || "—",
                      li.qty, li.uom, fmt(li.unitPrice), li.cgst, li.sgst, li.igst,
                    ])}
                  />
                </div>
              </Card>
            )}
          </div>
        )}

        {/* ── ISSUES ── */}
        {tab === "issues" && activeOrder && activeOrder.result && (
          <Card>
            <CardHead
              title={"Discrepancies (" + discrepancies.length + ")"}
              sub={critCount + " critical · " + warnCount + " warnings"}
              accent={critCount > 0 ? "#991b1b" : "#92400e"}
            />
            <div className="p-5 space-y-2">
              {discrepancies.length === 0 && (
                <div className="text-center py-8 text-emerald-600 font-semibold">No discrepancies — clean match</div>
              )}
              {discrepancies.map((d, i) => (
                <div key={i} className={"p-3 rounded-xl border " + (d.severity === "CRITICAL" ? "bg-red-50 border-red-200" : d.severity === "WARNING" ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-200")}>
                  <div className="flex items-center gap-2 mb-1">
                    <SevBadge sev={d.severity} />
                    <span className="font-semibold text-sm text-slate-800">{d.field}</span>
                  </div>
                  <p className="text-xs text-slate-600">{d.message}</p>
                  {(d.poValue || d.quoteValue) && (
                    <div className="mt-1.5 flex gap-3 text-xs font-mono">
                      <span className="text-blue-700">PO: {d.poValue}</span>
                      <span className="text-slate-400">vs</span>
                      <span className="text-emerald-700">Quote: {d.quoteValue}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ── SALES ORDER ── */}
        {tab === "so" && so && (
          <Card>
            <CardHead title="Sales Order Draft" sub={so.voucherNo} accent={DARK} right={<StatusPill status={activeOrder.status} />} />
            <div className="p-5">
              <div className="grid grid-cols-3 gap-x-6 mb-5">
                <Fld label="Voucher Type" value={so.voucherType} />
                <Fld label="Voucher No." value={so.voucherNo} mono />
                <Fld label="Date" value={so.date} />
                <Fld label="PO Reference" value={so.reference} mono />
                <Fld label="Party Name" value={so.partyName} />
              </div>
              <div className="grid grid-cols-2 gap-4 mb-5">
                <div className="bg-slate-50 p-3 rounded-xl border text-xs">
                  <div className="font-bold text-slate-400 uppercase mb-1.5">Bill To</div>
                  <div className="font-medium text-slate-700">{so.billTo && so.billTo.name}</div>
                  <div className="text-slate-500">{so.billTo && so.billTo.address}</div>
                  <div className="font-mono text-slate-400 mt-0.5">GSTIN: {so.billTo && so.billTo.gstin}</div>
                </div>
                <div className="bg-slate-50 p-3 rounded-xl border text-xs">
                  <div className="font-bold text-slate-400 uppercase mb-1.5">Ship To</div>
                  <div className="font-medium text-slate-700">{so.shipTo && so.shipTo.name}</div>
                  <div className="text-slate-500">{so.shipTo && so.shipTo.address}</div>
                  <div className="font-mono text-slate-400 mt-0.5">GSTIN: {so.shipTo && so.shipTo.gstin}</div>
                </div>
              </div>
              {so.lineItems && so.lineItems.some((li) => li.partNameMismatch) && (
                <div className="mb-3 p-3 bg-orange-50 border border-orange-300 rounded-xl text-xs text-orange-800 flex items-start gap-2">
                  <span className="flex-shrink-0">⚠️</span>
                  <div>
                    <strong>Part number format mismatch on one or more items.</strong>
                    {" "}Tally Item Name uses Quote format exactly. Verify it matches your Tally stock master before importing.
                  </div>
                </div>
              )}
              {so.lineItems && so.lineItems.some((li) => li.poUnitPriceInclGST) && (
                <div className="mb-3 p-3 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-800 flex items-start gap-2">
                  <span className="flex-shrink-0">💰</span>
                  <div>
                    <strong>GST-inclusive PO price detected.</strong>
                    {" "}Rate shown is GST-exclusive. Verify with customer.
                  </div>
                </div>
              )}
              <Tbl
                headers={["#","Tally Item Name","Src","HSN","Cust P/N","UOM","Qty","Rate","Amt","CGST","SGST","IGST","Total","Due"]}
                rows={(so.lineItems || []).map((li) => [
                  li.sno,
                  (li.partNameMismatch ? "⚠️ " : "") + (li.tallyItemName || li.itemName),
                  li.partNameSource === "quote_part_number" ? "✅" : li.partNameSource === "po_only" ? "🔴" : "⚠️",
                  li.hsnCode, li.custPartNo, li.uom, li.qty,
                  fmt(li.rate),
                  fmt(li.amount),
                  fmt(li.cgstAmt), fmt(li.sgstAmt), fmt(li.igstAmt),
                  fmt(li.totalWithGst), li.dueDate,
                ])}
              />
              <div className="mt-5 flex justify-end">
                <div className="bg-slate-50 rounded-2xl p-4 border min-w-72 space-y-2">
                  <div className="flex justify-between text-sm"><span className="text-slate-500">Sub Total</span><span className="font-mono font-semibold">{fmt(so.subTotal)}</span></div>
                  {so.totalCgst > 0 && <div className="flex justify-between text-sm"><span className="text-slate-500">CGST</span><span className="font-mono">{fmt(so.totalCgst)}</span></div>}
                  {so.totalSgst > 0 && <div className="flex justify-between text-sm"><span className="text-slate-500">SGST</span><span className="font-mono">{fmt(so.totalSgst)}</span></div>}
                  {so.totalIgst > 0 && <div className="flex justify-between text-sm"><span className="text-slate-500">IGST</span><span className="font-mono">{fmt(so.totalIgst)}</span></div>}
                  <div className="border-t pt-2 flex justify-between font-bold text-sm">
                    <span>Grand Total</span>
                    <span className="font-mono text-blue-900">{fmt(so.grandTotal)}</span>
                  </div>
                  <div className="text-xs text-slate-400 italic">{so.grandTotalWords}</div>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* ── SOURCE POs ── */}
        {tab === "sourcepos" && activeOrder && activeOrder.result && (
          <div className="space-y-5">
            <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-2xl text-sm text-indigo-900">
              <div className="font-bold mb-1">Internal Source Purchase Orders</div>
              <p className="text-xs leading-relaxed text-indigo-700">
                These are the procurement orders Obara India raises to its suppliers to fulfil the customer SO.
                Each card represents one supplier group. The currency and exchange rate are taken from the price composition document.
                Items with inferred source (no price comp) are flagged for manual verification.
              </p>
              {!activeOrder.hasPriceComp && (
                <div className="mt-3 p-2 bg-orange-100 border border-orange-300 rounded-xl text-xs text-orange-800 flex gap-2">
                  <span>⚠️</span>
                  <span><strong>No price composition was uploaded.</strong> All source assignments below are inferred from part number patterns. Upload the price comp document and reprocess for accurate foreign currency costs and supplier details.</span>
                </div>
              )}
              {activeOrder.engineerNote && (
                <div className="mt-3 p-2 bg-purple-100 border border-purple-300 rounded-xl text-xs text-purple-800 flex gap-2">
                  <span>👤</span>
                  <span><strong>Engineer override applied:</strong> {activeOrder.engineerNote}</span>
                </div>
              )}
            </div>
            {sourcePOs.length === 0 && (
              <div className="text-center py-12 text-slate-400">
                <div className="text-4xl mb-3">📦</div>
                <div className="font-semibold">No source POs generated</div>
                <div className="text-xs mt-1">Reprocess to generate source POs</div>
              </div>
            )}
            {sourcePOs.map((spo, i) => (
              <SourcePOCard key={i} spo={spo} onDownload={() => {}} />
            ))}
            {sourcePOs.length > 1 && (
              <div className="p-3 bg-slate-50 border rounded-xl text-xs text-slate-600">
                <strong>Summary:</strong> {sourcePOs.length} supplier(s) across {[...new Set(sourcePOs.map((s) => s.country))].join(", ")}.
                Total INR equivalent: {fmt(sourcePOs.reduce((sum, s) => sum + (s.totalINR || 0), 0))}.
                Download individual CSVs above for each supplier.
              </div>
            )}
          </div>
        )}

        {/* ── EXPORT ── */}
        {tab === "export" && (
          <div className="space-y-4">
            {activeOrder && !canExport && (
              <div className="p-4 bg-red-50 border-2 border-red-300 rounded-2xl flex items-start gap-4">
                <div className="text-3xl">🔒</div>
                <div>
                  <div className="font-bold text-red-700">{critCount} critical issue(s) need sign-off before export</div>
                  <Btn onClick={() => { setApprovalTarget(activeOrder); setShowApproval(true); }} variant="danger" size="sm" className="mt-3">Review and Approve</Btn>
                </div>
              </div>
            )}
            {activeOrder && canExport && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-2xl text-sm text-emerald-800 font-semibold">
                Export ready — {critCount === 0 ? "no critical issues" : "manager approved"}.
              </div>
            )}
            {!activeOrder && <div className="p-4 bg-slate-50 border rounded-2xl text-slate-500 text-sm text-center">Process a PO first.</div>}

            {activeOrder && so && canExport && (() => {
              const csvContent = "\uFEFF" + buildSalesOrderCSV(so);
              const xmlContent = buildSalesOrderXML(so);
              const csvName = "SO_" + (so.reference || "export") + "_Tally.csv";
              const xmlName = "SO_" + (so.reference || "export") + "_Tally.xml";
              const csvHref = makeDataURI(csvContent, "text/csv;charset=utf-8");
              const xmlHref = makeDataURI(xmlContent, "application/xml");
              return (
                <>
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">Customer Sales Order — Tally Import</div>
                  <div className="grid grid-cols-2 gap-5">
                    <Card>
                      <CardHead title="Tally CSV" sub="Tally Prime · review in Excel first" accent="#065f46" />
                      <div className="p-4 space-y-3">
                        {["Party, Bill-to, Ship-to, GSTINs","Tally Item Name + seller/cust part nos","CGST/SGST/IGST per line","Grand Total + amount in words"].map((f, i) => (
                          <div key={i} className="flex gap-2 text-xs text-slate-600"><span className="text-emerald-500 font-bold">✓</span>{f}</div>
                        ))}
                        <a href={csvHref} download={csvName}
                          className="block w-full text-center text-white text-sm font-semibold py-2 px-4 rounded-xl shadow-md"
                          style={{ background: "linear-gradient(135deg,#065f46,#047857)" }}>
                          ⬇️ Download Tally CSV
                        </a>
                        <div className="text-xs text-slate-400">Gateway of Tally → Import Data → CSV</div>
                      </div>
                    </Card>
                    <Card>
                      <CardHead title="Tally XML" sub="Tally ERP 9 / Prime · direct import" accent={DARK} />
                      <div className="p-4 space-y-3">
                        {["ENVELOPE + TALLYMESSAGE structure","ALLINVENTORYENTRIES per line item","Party ledger + PO reference","Works on ERP 9 and Prime"].map((f, i) => (
                          <div key={i} className="flex gap-2 text-xs text-slate-600"><span className="text-blue-500 font-bold">✓</span>{f}</div>
                        ))}
                        <a href={xmlHref} download={xmlName}
                          className="block w-full text-center text-white text-sm font-semibold py-2 px-4 rounded-xl shadow-md"
                          style={gradStyle}>
                          ⬇️ Download Tally XML
                        </a>
                        <div className="text-xs text-slate-400">Gateway of Tally → Import → Vouchers → XML</div>
                      </div>
                    </Card>
                  </div>

                  {sourcePOs.length > 0 && (
                    <>
                      <div className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1 pt-2">Source Purchase Orders — Procurement CSVs</div>
                      <div className="grid grid-cols-2 gap-4">
                        {sourcePOs.map((spo, i) => {
                          const cm = CURRENCY_META[spo.currency] || { flag: "🌐", symbol: spo.currency + " " };
                          const spoCSV = "\uFEFF" + buildSourcePOCSV(spo);
                          const spoHref = makeDataURI(spoCSV, "text/csv;charset=utf-8");
                          const spoName = "SPO_" + spo.country + "_" + (spo.reference || "export") + ".csv";
                          return (
                            <Card key={i}>
                              <CardHead
                                title={cm.flag + " " + spo.country + " — " + spo.supplier}
                                sub={spo.reference + " · " + spo.currency + (spo.exchangeRate ? " @ ₹" + spo.exchangeRate : "")}
                                accent={MID}
                              />
                              <div className="p-4 space-y-2">
                                <div className="text-xs text-slate-500">{(spo.lineItems || []).length} line items · {spo.hasCostData ? fmt(spo.totalINR) + " INR equivalent" : "No cost data"}</div>
                                <a href={spoHref} download={spoName}
                                  className="block w-full text-center text-white text-sm font-semibold py-2 px-4 rounded-xl shadow-md"
                                  style={gradStyle}>
                                  ⬇️ Download SPO CSV
                                </a>
                              </div>
                            </Card>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              );
            })()}

            {activeOrder && so && !canExport && (
              <div className="grid grid-cols-2 gap-5">
                {["Tally CSV","Tally XML"].map((label) => (
                  <Card key={label}>
                    <CardHead title={label} accent={DARK} />
                    <div className="p-4">
                      <div className="block w-full text-center text-white text-sm font-semibold py-2 px-4 rounded-xl opacity-50 cursor-not-allowed bg-slate-400">
                        🔒 Locked — Approval Needed
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── CUSTOMERS ── */}
        {tab === "customers" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold text-slate-800 text-base">Customer Format Profiles</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Stored PO format fingerprints. Each profile is built automatically after the first successful SO.
                  Future POs from the same customer use this profile for more accurate extraction and format-change detection.
                </p>
              </div>
            </div>

            {Object.keys(customerFormats).length === 0 && (
              <div className="text-center py-16 text-slate-400">
                <div className="text-5xl mb-3">🏭</div>
                <div className="font-semibold text-slate-500">No customer profiles yet</div>
                <div className="text-xs mt-2">Process a PO to automatically create the first profile.</div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4">
              {Object.entries(customerFormats).map(([key, profile]) => {
                const fp = profile.fingerprint || {};
                return (
                  <Card key={key}>
                    <div className="px-5 py-4 flex items-start justify-between gap-4 border-b border-slate-100">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="font-bold text-slate-800 text-sm">{profile.customerName || key}</span>
                          {profile.lastFormatChanged && (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full border bg-amber-100 text-amber-800 border-amber-300">Format Changed</span>
                          )}
                          {!profile.lastFormatChanged && profile.ordersProcessed > 1 && (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full border bg-emerald-100 text-emerald-800 border-emerald-300">Consistent</span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5 font-mono">{profile.customerGSTIN || "No GSTIN"}</div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          {profile.ordersProcessed} order{profile.ordersProcessed !== 1 ? "s" : ""} processed
                          {" · "}First seen {dateLabel(profile.firstSeen)}
                          {" · "}Last updated {dateLabel(profile.lastUpdated)}
                        </div>
                      </div>
                      <button
                        onClick={async () => {
                          const updated = { ...customerFormats };
                          delete updated[key];
                          await saveFormats(updated);
                          setCustomerFormats(updated);
                        }}
                        className="text-xs text-red-500 border border-red-200 bg-red-50 px-3 py-1.5 rounded-xl hover:bg-red-100 font-semibold flex-shrink-0"
                      >
                        Reset
                      </button>
                    </div>

                    <div className="p-5">
                      {profile.lastFormatChanged && profile.formatChangeSummary && (
                        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
                          <strong>Last change detected:</strong> {profile.formatChangeSummary}
                        </div>
                      )}

                      <div className="grid grid-cols-3 gap-x-8 gap-y-3 mb-4">
                        {[
                          ["Document Type",     fp.documentType || "—"],
                          ["PO Number Label",   fp.poNumberLabel || "—"],
                          ["Date Format",       fp.dateFormat || "—"],
                          ["Currency on PO",    fp.currencyOnPO || "INR"],
                          ["Payment Terms",     fp.paymentTermsFixed || "—"],
                          ["Multi-page",        fp.multiPage ? "Yes" + (fp.pageMarker ? " (" + fp.pageMarker + ")" : "") : "No"],
                          ["GST on PO",         fp.hasGSTOnPO ? "Yes" : "No"],
                          ["Explicit Delivery", fp.hasExplicitDeliveryDate ? "Yes" : "No"],
                          ["Part No Style",     fp.partNumberStyle || "—"],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <div className="text-xs text-slate-400 uppercase tracking-wide mb-0.5">{label}</div>
                            <div className="text-xs font-medium text-slate-700">{value}</div>
                          </div>
                        ))}
                      </div>

                      {fp.lineItemColumns && (
                        <div className="mb-3">
                          <div className="text-xs text-slate-400 uppercase tracking-wide mb-1">Line Item Column Order</div>
                          <div className="text-xs font-mono bg-slate-50 border rounded-lg px-3 py-2 text-slate-700">{fp.lineItemColumns}</div>
                        </div>
                      )}

                      {fp.quirks && (
                        <div className="mb-3">
                          <div className="text-xs text-slate-400 uppercase tracking-wide mb-1">Quirks / Notes</div>
                          <div className="text-xs bg-slate-50 border rounded-lg px-3 py-2 text-slate-600">{fp.quirks}</div>
                        </div>
                      )}

                      {fp.summary && (
                        <div>
                          <div className="text-xs text-slate-400 uppercase tracking-wide mb-1">AI Summary</div>
                          <div className="text-xs text-slate-600 leading-relaxed">{fp.summary}</div>
                        </div>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        {/* ── HISTORY ── */}
        {tab === "history" && (
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
        )}

        {/* ── METRICS ── */}
        {tab === "metrics" && <MetricsDash metrics={metrics} orders={orders} />}

        {/* ── INFO ── */}
        {tab === "info" && (
          <div className="space-y-5 max-w-4xl">

            {/* ── HOW IT WORKS ── */}
            <Card>
              <CardHead title="How This Tool Works" accent={DARK} />
              <div className="p-5 space-y-5">
                <p className="text-sm text-slate-600 leading-relaxed">
                  The SO Processing Agent sends your PDF and Excel documents directly to Claude (Anthropic AI), which reads them the same way a trained sales coordinator would — understanding layout, tables, part numbers, and context — but in seconds instead of 20-30 minutes. No OCR or pre-processing is applied: the raw file bytes are base64-encoded in the browser and sent to Claude natively.
                </p>

                {/* Stage 1 */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">1</span>
                    <span className="font-bold text-sm text-slate-800">Document Validation (Pre-flight Gate)</span>
                  </div>
                  <div className="ml-8 space-y-2 text-sm text-slate-600">
                    <p>The PO and Quote PDFs are sent to Claude Sonnet for a fast validation pass. Nine checks run in one API call before any SO is generated. Blockers stop processing immediately; warnings are surfaced for review after generation.</p>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 mt-2">
                      {[
                        ["🏢","Vendor check","Is the PO actually addressed to Obara India?"],
                        ["🔩","Material check","Are the items welding consumables Obara sells?"],
                        ["📅","Date check","Is the PO within the last 12 months?"],
                        ["🔄","Duplicate check","Has this PO number been processed before?"],
                        ["📋","PO completeness","Does the PO have all required fields?"],
                        ["📄","Quote source","Was this quote issued by Obara?"],
                        ["🔗","Quote match","Do quote line items correspond to PO items?"],
                        ["⏰","Quote freshness","Is the quote dated within acceptable range of the PO?"],
                        ["✅","Quote completeness","Does the quote have HSN codes, GST rates, prices?"],
                      ].map(([icon, name, desc]) => (
                        <div key={name} className="flex gap-2 text-xs">
                          <span className="flex-shrink-0">{icon}</span>
                          <div><span className="font-semibold text-slate-700">{name} — </span><span className="text-slate-500">{desc}</span></div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-800">
                      <strong>How Claude reads your documents:</strong> PDFs are sent as raw binary (base64-encoded). If the PDF has a text layer (all digitally generated POs do), Claude reads the text directly — fast and accurate. If it is a scanned image, Claude applies its internal vision model. Excel files (price comp) are read the same way — Claude sees the rendered spreadsheet and extracts cell values, understanding column structure from headers. No Tesseract, no pdfplumber, no intermediate conversion step is used.
                    </div>
                  </div>
                </div>

                {/* Stage 2 */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-6 h-6 rounded-full bg-emerald-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">2</span>
                    <span className="font-bold text-sm text-slate-800">Sales Order + Source PO Generation</span>
                  </div>
                  <div className="ml-8 space-y-2 text-sm text-slate-600">
                    <p>A second Claude call receives all documents together and produces a structured JSON response covering the full SO and source PO data in one pass.</p>
                    <div className="grid grid-cols-2 gap-3 mt-2">
                      {[
                        ["📄","Customer PO","Extracts items, quantities, unit prices, delivery address, payment terms"],
                        ["📋","Obara Quote","Extracts HSN codes, GST rates, seller part numbers, lead time"],
                        ["💱","Price Composition (Excel)","Reads source country (col S), supplier unit price in FCY (col U), exchange rate (col W), and landed cost (col AI) per line item"],
                        ["👤","Engineer Note","Free-text override — highest priority for source country assignment"],
                      ].map(([icon, name, desc]) => (
                        <div key={name} className="p-3 bg-slate-50 border rounded-xl text-xs">
                          <div className="font-bold text-slate-700 mb-1">{icon} {name}</div>
                          <div className="text-slate-500">{desc}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 p-3 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-800">
                      <strong>Customer format memory:</strong> After the first PO from any customer, Claude generates a format fingerprint (field labels, date format, column order, part number style). On subsequent orders from the same customer, this fingerprint is prepended to the prompt so Claude knows the layout in advance — reducing extraction errors and enabling format-change detection if the customer updates their ERP template.
                    </div>
                  </div>
                </div>

                {/* Stage 3 */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">3</span>
                    <span className="font-bold text-sm text-slate-800">Multi-currency Source POs</span>
                  </div>
                  <div className="ml-8 text-sm text-slate-600 space-y-2">
                    <p>Each line item is assigned to a source supplier using the price comp (col S: source country, col T: supplier quote ref). Items are grouped by supplier into separate Source POs in the supplier transaction currency.</p>
                    <div className="grid grid-cols-4 gap-2 mt-2">
                      {[
                        ["🇨🇳","China","CNY","Obara China"],
                        ["🇯🇵","Japan","JPY","Obara Corp"],
                        ["🇰🇷","Korea","USD","Obara Korea"],
                        ["🇮🇳","India","INR","Local / Internal"],
                      ].map(([flag, country, currency, supplier]) => (
                        <div key={country} className="p-2 bg-indigo-50 border border-indigo-100 rounded-xl text-xs text-center">
                          <div className="text-xl mb-1">{flag}</div>
                          <div className="font-bold text-indigo-800">{currency}</div>
                          <div className="text-indigo-500 text-xs mt-0.5">{supplier}</div>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-slate-500 mt-2">Note: Korea inter-company orders are transacted in USD (not KRW) — confirmed from price comp exchange rate (~83 INR/unit = USD rate). Source confidence: Engineer Override → Price Comp Stated → Price Comp Inferred → Pattern Inferred (lowest, triggers warning).</p>
                  </div>
                </div>

                {/* Tally name */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-6 h-6 rounded-full bg-orange-500 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">4</span>
                    <span className="font-bold text-sm text-slate-800">Tally Duplicate Stock Item Prevention</span>
                  </div>
                  <div className="ml-8 p-3 bg-orange-50 border border-orange-200 rounded-xl text-xs text-orange-700 leading-relaxed">
                    Tally uses the stock item name as its unique database key. A single space, hyphen, or capitalisation difference silently creates a new duplicate item. This agent always uses the exact seller part number from the Obara Quote as the Tally Item Name — since the Quote is generated from the same internal system as the Tally stock master. The PO version of the part number is stored separately as reference only and never used as the Tally import name.
                  </div>
                </div>

                {/* Data flow strip */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">Data Flow</div>
                  <div className="flex items-center gap-1.5 flex-wrap text-xs text-slate-600">
                    {["Upload PDFs + Excel","→","Claude Preflight (9 checks)","→","Blocked? Log + Stop","→","Claude SO + Source PO Generation","→","Discrepancy Review","→","Manager Approval (if needed)","→","Tally SO Export + Source PO CSVs"].map((step, i) => (
                      <span key={i} className={step === "→" ? "text-slate-300 font-bold" : "px-2 py-1 bg-white border border-slate-200 rounded-lg font-medium"}>{step}</span>
                    ))}
                  </div>
                </div>
              </div>
            </Card>

            {/* ── AI COST BREAKDOWN ── */}
            <Card>
              <CardHead title="AI Processing Cost per Order" accent="#7c3aed" />
              <div className="p-5 space-y-4">
                <p className="text-sm text-slate-600 leading-relaxed">
                  Every order runs two Claude Sonnet API calls. Cost is driven by document size (tokens) rather than line item count — the PDF pages dominate.
                </p>

                {/* Cost table */}
                <div className="overflow-x-auto rounded-xl border border-slate-100">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-50">
                        {["Call","What is sent","Input tokens","Output tokens","Cost (USD)","Cost (INR)"].map((h) => (
                          <th key={h} className="text-left px-3 py-2 font-semibold text-slate-500 border-b border-slate-200 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ["1 — Preflight","PO PDF (3 pg) + Quote PDF (2 pg)","~8,200","~350","$0.030","₹2.50"],
                        ["2 — SO Gen (no price comp)","PO + Quote PDFs","~10,800","~2,400","$0.068","₹5.70"],
                        ["2 — SO Gen (with price comp)","PO + Quote + Price Comp Excel","~14,900","~2,400","$0.081","₹6.80"],
                      ].map(([call, sent, inp, out, usd, inr]) => (
                        <tr key={call} className="bg-white border-b border-slate-50">
                          <td className="px-3 py-2 font-semibold text-slate-700 whitespace-nowrap">{call}</td>
                          <td className="px-3 py-2 text-slate-500">{sent}</td>
                          <td className="px-3 py-2 font-mono text-slate-600">{inp}</td>
                          <td className="px-3 py-2 font-mono text-slate-600">{out}</td>
                          <td className="px-3 py-2 font-mono font-bold text-slate-700">{usd}</td>
                          <td className="px-3 py-2 font-mono font-bold text-indigo-700">{inr}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Totals */}
                <div className="grid grid-cols-3 gap-3">
                  {[
                    ["Blocked at preflight","1 call only","₹2.50","text-slate-600"],
                    ["Passes, no price comp","2 calls","₹10.62","text-indigo-700"],
                    ["With price comp (typical)","2 calls","₹9.30","text-indigo-700"],
                  ].map(([label, calls, cost, cls]) => (
                    <div key={label} className="p-3 bg-slate-50 border rounded-xl text-center">
                      <div className="text-xs text-slate-400 mb-1">{label}</div>
                      <div className="text-xs text-slate-400 mb-1.5">{calls}</div>
                      <div className={"text-lg font-bold font-mono " + cls}>{cost}</div>
                      <div className="text-xs text-slate-400">per order</div>
                    </div>
                  ))}
                </div>

                <div className="p-3 bg-slate-50 border rounded-xl text-xs text-slate-600">
                  <strong>Per line item (13-item order at ₹9.30 total):</strong> ~₹0.72/item. Cost is mostly fixed (document pages dominate), so orders with more line items are proportionally cheaper per item.
                  At 200 orders/month: <strong>~₹1,860/month</strong> in AI cost vs ~₹1,60,000/month in manual processing labour (200 orders × 25 min × ₹400/hr).
                </div>
                <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-xl text-xs text-indigo-800">
                  <strong>Live token gauge:</strong> The app estimates token usage as soon as you upload files on the Process tab — before you click Validate. It uses <code className="bg-indigo-100 px-1 rounded">file.size × 0.015</code> tokens/byte (a conservative upper bound calibrated against real POs). If usage looks high, a colour-coded warning appears with specific recommendations before any API call is made.
                </div>
              </div>
            </Card>

            {/* ── COST OPTIMISATIONS ── */}
            <Card>
              <CardHead title="Cost Optimisation Roadmap" accent="#065f46" />
              <div className="p-5 space-y-4">
                <p className="text-sm text-slate-600 leading-relaxed">
                  The current all-Claude-Sonnet approach is correct for a POC — it handles every format automatically with zero code complexity. These optimisations apply when volume grows beyond 200 orders/month.
                </p>

                <div className="space-y-3">
                  {[
                    {
                      tier: "Tier 1",
                      color: "emerald",
                      title: "PDF text extraction before sending to Claude",
                      saving: "~82% token reduction on documents",
                      how: "For digitally-generated PDFs (all major OEM customers), use pdfplumber on the backend to extract text and table structure before calling Claude. A 3-page PDF drops from ~4,500 tokens to ~800 tokens of clean pre-extracted text. Claude receives text instead of a raw document, which is faster and cheaper.",
                      caveat: "Scanned PDFs still need raw document mode. Works for Hyundai, Maruti, Tata, Honda — not for smaller customers who scan their POs.",
                      impact: "~₹4.60 saved per order",
                    },
                    {
                      tier: "Tier 2",
                      color: "blue",
                      title: "Claude Haiku for preflight validation",
                      saving: "~98% cost reduction on Call 1",
                      how: "The preflight is purely classification — does this PO belong to Obara, is it a duplicate, does the quote match? Claude Haiku handles this at $0.25/M input tokens (vs Sonnet at $3.00/M). With pre-extracted text, preflight drops from ₹2.50 to under ₹0.10 per order.",
                      caveat: "Haiku is less capable on ambiguous or poorly structured documents. Keep Sonnet as fallback when Haiku confidence is low.",
                      impact: "~₹2.40 saved per order",
                    },
                    {
                      tier: "Tier 3",
                      color: "purple",
                      title: "Coordinate extraction for top 5 customers",
                      saving: "Skip AI entirely for header fields",
                      how: "For customers with perfectly consistent PDF layouts (confirmed via the format fingerprint system already built), extract PO number, date, GSTIN, and line item table using exact PDF coordinates (pdfplumber crop). These fields are deterministic — no AI needed. The customer format fingerprint stored in this app already captures the layout data needed to build these extractors.",
                      caveat: "Any customer template change breaks coordinate extraction silently. The format-change detection system in this app catches this — it would trigger a fallback to full Claude extraction automatically.",
                      impact: "~₹1.00 saved per order (header fields only)",
                    },
                    {
                      tier: "Tier 4",
                      color: "amber",
                      title: "Anthropic prompt caching",
                      saving: "90% discount on repeated prompt content",
                      how: "The SO_PROMPT system prompt (~2,800 tokens) is identical on every call. Anthropic prompt caching marks static content with a cache_control flag — cached tokens cost 10% of normal. Requires a backend server (not available in browser-only POC).",
                      caveat: "Cache TTL is 5 minutes; only useful when processing multiple orders in quick succession. Minimal benefit for one-at-a-time processing.",
                      impact: "~₹0.70 saved per order (when batching)",
                    },
                  ].map(({ tier, color, title, saving, how, caveat, impact }) => {
                    const colors = {
                      emerald: "border-emerald-200 bg-emerald-50",
                      blue:    "border-blue-200 bg-blue-50",
                      purple:  "border-purple-200 bg-purple-50",
                      amber:   "border-amber-200 bg-amber-50",
                    };
                    const textColors = {
                      emerald: "text-emerald-800",
                      blue:    "text-blue-800",
                      purple:  "text-purple-800",
                      amber:   "text-amber-800",
                    };
                    return (
                      <div key={tier} className={"p-4 border rounded-xl " + colors[color]}>
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div>
                            <span className={"text-xs font-bold uppercase tracking-widest " + textColors[color]}>{tier} — </span>
                            <span className="text-sm font-bold text-slate-800">{title}</span>
                          </div>
                          <span className={"text-xs font-bold px-2 py-1 rounded-full whitespace-nowrap " + textColors[color] + " bg-white border border-current"}>{impact}</span>
                        </div>
                        <div className="text-xs text-slate-600 mb-2"><strong>How:</strong> {how}</div>
                        <div className="text-xs text-slate-500 italic"><strong>Caveat:</strong> {caveat}</div>
                        <div className={"text-xs font-semibold mt-2 " + textColors[color]}>{saving}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="p-3 bg-slate-800 rounded-xl text-xs text-slate-200">
                  <div className="font-bold text-white mb-2">Combined impact (Tiers 1+2, top customers)</div>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    {[
                      ["Current","All Sonnet, raw PDFs","~₹9.30/order"],
                      ["Optimised","Extraction + Haiku PF","~₹2.20/order"],
                      ["Saving","At 200 orders/month","~₹1,420/month"],
                    ].map(([label, desc, value]) => (
                      <div key={label}>
                        <div className="text-slate-400 text-xs">{label}</div>
                        <div className="text-slate-300 text-xs mt-0.5">{desc}</div>
                        <div className="text-white font-bold font-mono text-sm mt-1">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>

            {/* ── TECHNICAL REQUIREMENTS ── */}
            <Card>
              <CardHead title="Technical Requirements — Production Scale-Up" accent={MID} />
              <div className="p-5 space-y-5">
                <p className="text-sm text-slate-600 leading-relaxed">
                  This POC runs entirely in the browser. A production deployment would require the following infrastructure.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { icon: "🖥️", title: "Backend API Server", items: ["Node.js or Python FastAPI to proxy Anthropic API","API key stays server-side, never in browser","Handles file upload, queuing, retry logic","Enables pdfplumber pre-extraction and Haiku routing"] },
                    { icon: "🗄️", title: "Persistent Database", items: ["PostgreSQL or Supabase replacing browser storage","Order history, metrics, approval audit trail","Customer format fingerprint library","Multi-user concurrent access"] },
                    { icon: "🔐", title: "Auth and Access Control", items: ["Manager vs. sales engineer roles","Google SSO via Clerk or Auth0","Manager-only approval and format-reset workflow","Audit log of all approvals"] },
                    { icon: "📁", title: "File Storage", items: ["S3 or Cloudflare R2 for uploaded PDFs","PDFs currently lost on browser refresh","Link stored PDFs to order records","Price comp versioning by customer"] },
                    { icon: "💹", title: "Live Exchange Rates", items: ["RBI or fixer.io API for daily FX rates","Override with price comp rate if provided","Store rate used at time of order","Variance alert if rate changes significantly"] },
                    { icon: "📊", title: "Direct Tally Integration", items: ["Tally ODBC or XML push API","Auto-import on manager approval","Reconciliation dashboard","Eliminate manual file import step"] },
                  ].map(({ icon, title, items }) => (
                    <div key={title} className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-xl">{icon}</span>
                        <span className="font-bold text-sm text-slate-700">{title}</span>
                      </div>
                      {items.map((item, i) => (
                        <div key={i} className="text-xs text-slate-500 flex gap-1.5 mb-1"><span className="text-slate-400">→</span>{item}</div>
                      ))}
                    </div>
                  ))}
                </div>
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
                  <strong>Note:</strong> The core AI prompts (preflight, SO generation, source PO assignment, format fingerprinting) require zero changes between POC and production. All logic transfers directly — only the infrastructure layer changes.
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>

      {showApproval && approvalTarget && (
        <ApprovalModal order={approvalTarget}
          onClose={() => { setShowApproval(false); setApprovalTarget(null); }}
          onDecide={handleApproval} />
      )}
      <div className="h-10" />
    </div>
  );
}
