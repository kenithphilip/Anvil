// Convert a numeric amount into an English / Indian-numbering-system
// words representation. Used by the sales-order PDF render to print
// the "Amount Chargeable (in words)" line that appears on every
// Tally-style SO.
//
// Indian numbering uses lakhs and crores rather than millions. The
// SO PDF in our reference docs shows:
//   230,202.00 . Two Hundred Thirty Thousand Two Hundred Two INR Only
// which is the international-numbering variant. Both are supported
// via the `style` option.
//
// Decimal handling: paise are rendered as a separate "and X paise"
// suffix when non-zero, matching the Tally convention.

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

const twoDigit = (n: number): string => {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? TENS[t] : TENS[t] + " " + ONES[o];
};

const threeDigit = (n: number): string => {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const head = h ? ONES[h] + " Hundred" : "";
  const tail = rest ? twoDigit(rest) : "";
  return [head, tail].filter(Boolean).join(" ");
};

// International-numbering rendering. Splits the integer at
// thousand / million / billion boundaries.
const intlInteger = (n: number): string => {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const units = ["", "Thousand", "Million", "Billion", "Trillion"];
  let unit = 0;
  let rem = n;
  while (rem > 0) {
    const chunk = rem % 1000;
    if (chunk > 0) parts.unshift(threeDigit(chunk) + (units[unit] ? " " + units[unit] : ""));
    rem = Math.floor(rem / 1000);
    unit += 1;
  }
  return parts.join(" ").trim();
};

// Indian-numbering rendering. The pattern is
// crore (10^7) . lakh (10^5) . thousand (10^3) . hundred . tens.
const indianInteger = (n: number): string => {
  if (n === 0) return "Zero";
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const remainder = n % 1000;
  const parts: string[] = [];
  if (crore) parts.push(twoDigit(crore > 99 ? crore % 100 : crore) + " Crore");
  if (lakh) parts.push(twoDigit(lakh) + " Lakh");
  if (thousand) parts.push(twoDigit(thousand) + " Thousand");
  if (remainder) parts.push(threeDigit(remainder));
  return parts.join(" ").trim();
};

export type AmountWordsOptions = {
  // 'intl' renders 230,202 as "Two Hundred Thirty Thousand Two
  // Hundred Two" (matches the supplied SO sample).
  // 'indian' renders the same as "Two Lakh Thirty Thousand Two
  // Hundred Two" for tenants who prefer the Tally default.
  style?: "intl" | "indian";
  currency?: string;            // "INR" by default. Appended as " <CCY> Only".
  capitalise?: boolean;         // default true. Mirrors Tally's title-case style.
  showZeroPaise?: boolean;      // default false. Omits the "and Zero paise" suffix.
};

export const amountInWords = (amount: number | string | null | undefined, opts: AmountWordsOptions = {}): string => {
  if (amount == null) return "";
  const raw = typeof amount === "number" ? amount : Number(String(amount).replace(/[,_\s]/g, ""));
  if (!Number.isFinite(raw)) return "";
  const currency = opts.currency || "INR";
  // Default to Indian numbering (Lakh / Crore) when the currency
  // is INR. Operators printing a Meridian-style PO total of
  // ₹ 2,71,638 expect "Two Lakh Seventy One Thousand..." not
  // "Two Hundred Seventy One Thousand...". Non-INR currencies
  // (USD / EUR) keep the international default. An explicit
  // `style` arg always wins.
  const style = opts.style || (currency === "INR" ? "indian" : "intl");
  const sign = raw < 0 ? "Minus " : "";
  const abs = Math.abs(raw);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  const intText = style === "indian" ? indianInteger(rupees) : intlInteger(rupees);
  let out = sign + (intText || "Zero");
  if (paise > 0) out += " and " + twoDigit(paise) + " Paise";
  else if (opts.showZeroPaise) out += " and Zero Paise";
  out = out + " " + currency + " Only";
  return opts.capitalise === false ? out.toLowerCase() : out;
};

export default amountInWords;
