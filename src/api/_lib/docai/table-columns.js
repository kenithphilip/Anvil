// Column-header classification for the table-parsing adapters (docling,
// unstructured). Shared so the classification can't drift apart again — both
// adapters previously carried the same two bugs independently.
//
// THE BUG THIS FIXES. Both used `/(part|sku|item|catalog)/` to find the part
// column and `/(desc|name)/` to find the description. On an OEM PO whose header
// is
//     Line | Item Number | Service Parent Name | Item Description | ...
// "Item Number" matches `item` FIRST, so partNumber became the BUYER's own SAP
// code instead of the seller's; and "Service Parent Name" matches
// `name` before "Item Description" ever gets a look. Both adapters sit AHEAD
// of claude in the default provider order, so whenever they are configured
// they silently produce the exact inverse of the dual-code design.
//
// KEY RULE: a buyer-code column must NEVER become partNumber. Leaving
// partNumber null is strictly better than filling it with the buyer's code —
// null merely fails to match, whereas a wrong value gets burned into
// item_customer_parts as a lookup key and poisons every future PO.

// The BUYER's own code for the item: their SAP / material / item number.
export const BUYER_CODE_RE =
  /(item\s*(no\.?|num|number|code)|material(\s*(no\.?|num|number|code))?|sap|cust(omer)?[\s_-]*(part|item|material))/;

// OUR part / SKU code.
export const OUR_PART_RE = /(part\s*(no\.?|num|number)?|sku|catalog|p\/n|our\s*(part|code))/;

const norm = (h) => String(h || "").trim().toLowerCase();

// Index of the first header matching `re`, optionally excluding `notRe`.
export const findCol = (header, re, notRe = null) =>
  (Array.isArray(header) ? header : []).findIndex((h) => {
    const s = norm(h);
    if (!re.test(s)) return false;
    if (notRe && notRe.test(s)) return false;
    return true;
  });

// Classify a table header row into the columns the pipeline cares about.
// Returns -1 for anything absent.
export const classifyColumns = (header) => {
  // Description: a real "description" header wins outright. Only fall back to
  // name/product when there is none, and never accept "... Parent Name",
  // which is a hierarchy label rather than the item description.
  let desc = findCol(header, /desc/);
  if (desc < 0) desc = findCol(header, /(product|item\s*name)/, /parent/);

  // Our part code: must not be the buyer's code column, and must not be the
  // description column we just claimed.
  let part = findCol(header, OUR_PART_RE, BUYER_CODE_RE);
  if (part === desc) part = -1;

  const buyerCode = findCol(header, BUYER_CODE_RE);

  return {
    part,
    // A buyer-code column is only reported as such when it isn't already
    // serving as our part column (a PO with a single generic code column).
    buyerCode: buyerCode === part ? -1 : buyerCode,
    desc,
    qty: findCol(header, /(qty|quantity|q'?ty|count|pcs)/),
    price: findCol(header, /(unit\s*price|rate|price)/),
    uom: findCol(header, /(uom|unit\s*of\s*measure|\buom\b)/),
    hsn: findCol(header, /(hsn|sac)/),
  };
};

// How many of the signal columns were found — adapters use this to decide a
// table is a line-item table rather than a summary block.
export const columnMatchCount = (cols) =>
  [cols.part, cols.buyerCode, cols.qty, cols.price, cols.desc].filter((i) => i >= 0).length;
