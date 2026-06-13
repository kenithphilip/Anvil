// Server-side amount-in-words. Node-side mirror of the client helper
// at src/v3-app/lib/amount-words.ts (which api/* can't import). The
// quote PDF endpoint inlines an identical copy; new code should import
// from here. Pinned by the same convention as amount-words.test.ts.
//
//   amountInWords(123456, "INR")                         intl grouping
//   amountInWords(123456, { currency: "INR", style: "indian" })  lakh/crore

const _ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const _TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const _two = (n) => (n < 20 ? _ONES[n] : (n % 10 === 0 ? _TENS[Math.floor(n / 10)] : _TENS[Math.floor(n / 10)] + " " + _ONES[n % 10]));
const _three = (n) => {
  const h = Math.floor(n / 100); const r = n % 100;
  return [h ? _ONES[h] + " Hundred" : "", r ? _two(r) : ""].filter(Boolean).join(" ");
};

export const amountInWords = (raw, currencyOrOpts = "INR") => {
  const opts = typeof currencyOrOpts === "string"
    ? { currency: currencyOrOpts, style: "intl" }
    : { currency: currencyOrOpts?.currency || "INR", style: currencyOrOpts?.style || "intl" };
  const v = Number(raw);
  if (!Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  const parts = [];
  let out;
  if (opts.style === "indian") {
    let rem = rupees;
    const last3 = rem % 1000; rem = Math.floor(rem / 1000);
    const thousand = rem % 100; rem = Math.floor(rem / 100);
    const lakh = rem % 100; rem = Math.floor(rem / 100);
    const crore = rem;
    if (rupees === 0) parts.push("Zero");
    if (crore > 0) parts.push(_three(crore) + " Crore");
    if (lakh > 0) parts.push(_two(lakh) + " Lakh");
    if (thousand > 0) parts.push(_two(thousand) + " Thousand");
    if (last3 > 0) parts.push(_three(last3));
    out = (v < 0 ? "Minus " : "") + parts.join(" ");
  } else {
    const units = ["", "Thousand", "Million", "Billion"];
    let rem = rupees; let i = 0;
    if (rem === 0) parts.push("Zero");
    while (rem > 0) {
      const c = rem % 1000;
      if (c > 0) parts.unshift(_three(c) + (units[i] ? " " + units[i] : ""));
      rem = Math.floor(rem / 1000); i++;
    }
    out = (v < 0 ? "Minus " : "") + parts.join(" ");
  }
  if (paise > 0) out += " and " + _two(paise) + " Paise";
  return out + " " + opts.currency + " Only";
};
