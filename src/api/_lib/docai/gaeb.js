// GAEB tender format parser (Phase 5.3).
//
// GAEB DA XML is the German construction-tender exchange standard.
// X81 = cost-data exchange (rate book), X83 = bid invitation (buyer
// publishes BoQ), X84 = bid response (supplier fills in UP/IT), X86
// = award/contract (post-acceptance).
//
// All four variants share the same core structure. We parse it
// deterministically (no LLM) because the schema is rigid and a
// model would only hurt accuracy. Free-text positions still need
// language handling, but the structural backbone (item id, qty,
// unit, unit price, total) is fully encoded in tags.
//
// We deliberately avoid pulling in fast-xml-parser or similar so
// this adapter ships with zero new dependencies. The inline
// tokenizer below handles the well-known GAEB shape: nested
// elements, attributes (we only need RNoPart and ID/Currency), and
// CDATA/text content. It does NOT handle XML namespaces beyond
// stripping them, processing instructions are skipped, and entities
// are limited to the five XML defaults plus &nbsp;. That's enough
// for every real-world GAEB file we've seen.
//
// Output: the canonical {ok, normalized, raw, confidences} shape so
// the rest of the intake pipeline (extraction, validation, quoting,
// supplier RFQ) treats GAEB the same as a parsed PDF.

const XML_ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
  "&nbsp;": " ",
};

const decodeText = (s) => {
  if (!s) return s;
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner)
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (m) => XML_ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim();
};

// Strip XML namespace prefixes ("gaeb:GAEB" -> "GAEB"). GAEB files
// in the wild are inconsistent about whether they declare a default
// namespace or use a prefix.
const stripNs = (tag) => tag.includes(":") ? tag.split(":").pop() : tag;

// Tokenize an XML string into a flat list of { type, name, attrs, text }.
// Types: "open", "close", "self", "text". We then build a tree.
const tokenize = (xml) => {
  const tokens = [];
  let i = 0;
  const len = xml.length;
  while (i < len) {
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!", i)) {
      const end = xml.indexOf(">", i);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (xml[i] === "<") {
      const end = xml.indexOf(">", i);
      if (end === -1) break;
      const inner = xml.slice(i + 1, end).trim();
      if (inner.startsWith("/")) {
        tokens.push({ type: "close", name: stripNs(inner.slice(1).trim()) });
      } else {
        const selfClosing = inner.endsWith("/");
        const meat = (selfClosing ? inner.slice(0, -1) : inner).trim();
        const m = meat.match(/^(\S+)(?:\s+([\s\S]*))?$/);
        const name = stripNs(m ? m[1] : meat);
        const attrSrc = m && m[2] ? m[2] : "";
        const attrs = {};
        if (attrSrc) {
          // Attribute pairs: name="value" or name='value'.
          const attrRe = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
          let am;
          while ((am = attrRe.exec(attrSrc))) {
            attrs[stripNs(am[1])] = decodeText(am[3] !== undefined ? am[3] : am[4]);
          }
        }
        tokens.push({ type: selfClosing ? "self" : "open", name, attrs });
      }
      i = end + 1;
    } else {
      const next = xml.indexOf("<", i);
      const slice = xml.slice(i, next === -1 ? len : next);
      if (slice.trim()) tokens.push({ type: "text", text: slice });
      i = next === -1 ? len : next;
    }
  }
  return tokens;
};

const buildTree = (tokens) => {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  for (const t of tokens) {
    const top = stack[stack.length - 1];
    if (t.type === "open") {
      const node = { name: t.name, attrs: t.attrs || {}, children: [], text: "" };
      top.children.push(node);
      stack.push(node);
    } else if (t.type === "self") {
      top.children.push({ name: t.name, attrs: t.attrs || {}, children: [], text: "" });
    } else if (t.type === "close") {
      while (stack.length > 1 && stack[stack.length - 1].name !== t.name) stack.pop();
      if (stack.length > 1) stack.pop();
    } else if (t.type === "text") {
      top.text = (top.text || "") + decodeText(t.text);
    }
  }
  return root;
};

const findNode = (node, targetName) => {
  if (!node) return null;
  if (node.name === targetName) return node;
  for (const c of node.children) {
    const hit = findNode(c, targetName);
    if (hit) return hit;
  }
  return null;
};

const findAll = (node, targetName) => {
  const out = [];
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    if (cur.name === targetName) out.push(cur);
    for (let i = cur.children.length - 1; i >= 0; i--) stack.push(cur.children[i]);
  }
  return out;
};

const childByName = (node, name) => node?.children?.find((c) => c.name === name) || null;

// Pull plain text out of nested description tags. GAEB wraps the
// item description in OutlineText / CompleteText / DetailTxt / Text
// trees, varying by version. We collect every text node under
// `Description` and concatenate.
const collectText = (node) => {
  if (!node) return "";
  const parts = [];
  const visit = (n) => {
    if (!n) return;
    if (n.text) parts.push(n.text.trim());
    for (const c of n.children) visit(c);
  };
  visit(node);
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
};

const itemToLine = (item) => {
  const id = item.attrs.ID || item.attrs.RNoPart || null;
  const qtyRaw = childByName(item, "Qty")?.text || "";
  const qty = Number(qtyRaw.replace(",", ".")) || null;
  const uom = (childByName(item, "QU")?.text || "").trim() || null;
  const upNode = childByName(item, "UP");
  const upRaw = upNode?.text || "";
  const upCurrency = upNode?.attrs?.Currency || null;
  const unitPrice = Number(upRaw.replace(",", ".")) || null;
  const itRaw = childByName(item, "IT")?.text || "";
  const lineTotal = Number(itRaw.replace(",", ".")) || (qty != null && unitPrice != null ? qty * unitPrice : null);
  const desc = collectText(childByName(item, "Description"));
  return {
    itemCode: id,
    description: desc || null,
    qty,
    uom,
    rate: unitPrice,
    lineTotal,
    raw_meta: {
      source: "gaeb",
      currency: upCurrency,
      rno_part: item.attrs.RNoPart || null,
    },
  };
};

// Heuristic detection: returns true if the file looks like GAEB.
// We accept the `.x83 / .x84 / .x86 / .x81` extension or the
// presence of `<GAEB>` in the first 4 KB.
export const looksLikeGaeb = ({ filename, bytes }) => {
  const f = (filename || "").toLowerCase();
  if (/\.x8[1346]$/.test(f)) return true;
  if (f.endsWith(".gaeb") || f.endsWith(".gaebxml")) return true;
  if (!bytes) return false;
  const sample = (typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8")).slice(0, 4096);
  return /<\s*(?:[\w-]+:)?GAEB\b/.test(sample);
};

export const isConfigured = (_settings) => true;

export const extract = async ({ bytes, filename }) => {
  if (!bytes) return { ok: false, error: "GAEB adapter requires file bytes" };
  const xml = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
  if (!/<\s*(?:[\w-]+:)?GAEB\b/i.test(xml)) {
    return { ok: false, error: "Input does not look like GAEB DA XML" };
  }
  let tree;
  try {
    tree = buildTree(tokenize(xml));
  } catch (err) {
    return { ok: false, error: "GAEB parse failed: " + (err.message || String(err)) };
  }

  const gaeb = findNode(tree, "GAEB") || tree;
  const info = findNode(gaeb, "GAEBInfo");
  const award = findNode(gaeb, "Award");
  const dp = findNode(gaeb, "DP");

  // Variant detection: file extension wins, otherwise DPType, else
  // default to X83 (bid invitation, the most common shape).
  const dpType = dp?.attrs?.DPType || childByName(dp, "DPType")?.text || null;
  const variant = ((filename || "").match(/\.(x8[1346])$/i) || [])[1]?.toLowerCase()
    || (dpType ? `x${dpType}` : null)
    || "x83";

  const prjName = collectText(childByName(dp, "PrjName")) || collectText(findNode(gaeb, "PrjName"));
  const dpNo = collectText(childByName(dp, "DPNo")) || collectText(findNode(gaeb, "DPNo"));
  const version = collectText(childByName(info, "Version"));

  const boq = findNode(award, "BoQ") || findNode(gaeb, "BoQ");
  const currency = childByName(award, "Currency")?.text
    || boq?.attrs?.Currency
    || findAll(gaeb, "UP").find((u) => u.attrs.Currency)?.attrs.Currency
    || null;

  const items = findAll(boq || gaeb, "Item");
  const lineItems = items.map(itemToLine);
  const grandTotal = lineItems.reduce((sum, l) => sum + (Number(l.lineTotal) || 0), 0) || null;

  const confidences = {
    project: prjName ? 1.0 : 0.0,
    line_items: lineItems.length ? 1.0 : 0.0,
    quantities: lineItems.every((l) => l.qty != null) ? 1.0 : 0.7,
    descriptions: lineItems.every((l) => l.description) ? 0.95 : 0.6,
    grand_total: grandTotal != null ? 1.0 : 0.0,
  };

  const normalized = {
    salesOrder: {
      mode: "GENERAL",
      grandTotal,
      currency,
      lineItems,
      gaeb: {
        variant,
        version,
        project_name: prjName,
        dp_number: dpNo,
        item_count: lineItems.length,
      },
    },
  };

  return {
    ok: true,
    raw: { variant, version, prjName, dpNo, currency, items_count: items.length },
    normalized,
    confidences,
  };
};
