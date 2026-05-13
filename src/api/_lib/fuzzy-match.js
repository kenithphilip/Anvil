// Fuzzy-match primitives for the customer + item mapping engine
// (Wave CM 2.4).
//
// Pure-JS implementations of the classic string-similarity
// algorithms the entity-resolution literature settles on:
//
//   - Jaro-Winkler  : prefix-weighted edit similarity, 0..1.
//                     Empirically the best general-purpose
//                     metric for short codes + names. Source:
//                     Winkler 1990, Data Ladder 2026 review,
//                     Wikipedia record-linkage.
//   - Metaphone     : phonetic key collapsing English (and
//                     Latin-script) words to a sound-alike
//                     code. "smith" / "smyth" / "smithe" all
//                     produce "SM0".
//   - N-gram Jaccard: token-shingles overlap. Good for short
//                     codes with mixed letter/digit patterns
//                     where Jaro-Winkler under-counts substring
//                     overlap.
//
// We deliberately avoid third-party deps. The corpus per tenant
// is small (item_master <50k rows, customers <5k), pure-JS is
// fast enough, and adding a node-gyp build to the Vercel runtime
// is friction we don't need.

// ----- normalisation -----

const STOP_WORDS = new Set([
  "a","an","the","and","or","of","for","with","to","in","by",
  "no","nos","number","date","from","this","that","is","are","was",
  "pcs","each","set","unit","units","piece","pieces",
]);

export const normaliseToken = (s) => {
  if (s == null) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")     // strip accents
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

// Significant words: 3+ chars, not stop words.
export const significantWords = (s) => {
  const n = normaliseToken(s);
  if (!n) return [];
  return n.split(/\s+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
};

// ----- Jaro and Jaro-Winkler -----

// Jaro similarity per Winkler 1989 definition.
export const jaro = (s1, s2) => {
  if (s1 == null || s2 == null) return 0;
  const a = String(s1);
  const b = String(s2);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(b.length, i + matchWindow + 1);
    for (let j = lo; j < hi; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = Math.floor(transpositions / 2);
  return (
    matches / a.length
    + matches / b.length
    + (matches - transpositions) / matches
  ) / 3;
};

// Jaro-Winkler: bump similarity when the strings share a common
// prefix. p = scaling factor (typically 0.1), prefixLen capped
// at 4.
export const jaroWinkler = (s1, s2, opts = {}) => {
  const j = jaro(s1, s2);
  if (j === 0) return 0;
  const p = Number.isFinite(opts.p) ? opts.p : 0.1;
  const maxPrefix = Number.isFinite(opts.maxPrefix) ? opts.maxPrefix : 4;
  const a = String(s1 || "");
  const b = String(s2 || "");
  let prefix = 0;
  const cap = Math.min(maxPrefix, a.length, b.length);
  for (let i = 0; i < cap; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return j + prefix * p * (1 - j);
};

// ----- Metaphone (single, "double metaphone" lite) -----
//
// Implements the canonical 1990 Metaphone (not Double Metaphone)
// because (a) the corpus is mostly English, (b) we want one
// hash per word for blocking-key purposes, and (c) the gain from
// Double Metaphone on Indian / Korean transliterations is
// marginal compared to fine-tuning on operator confirmations
// later. The implementation is the standard Lawrence Philips
// 1990 reference, condensed.

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

const isVowel = (c) => VOWELS.has(c);

export const metaphone = (input) => {
  if (input == null) return "";
  let s = String(input).toUpperCase().replace(/[^A-Z]/g, "");
  if (!s.length) return "";

  // Pre-processing: common letter clusters that always collapse.
  // Per Philips 1990 reference, "AE", "GN", "KN", "PN", "WR" at
  // the start drop the first letter; "X" at start becomes "S";
  // "WH" at start becomes "W".
  if (s.length >= 2) {
    const head = s.slice(0, 2);
    if (head === "AE" || head === "GN" || head === "KN" || head === "PN" || head === "WR") s = s.slice(1);
    else if (head === "WH") s = "W" + s.slice(2);
    if (s[0] === "X") s = "S" + s.slice(1);
  }

  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const nx = s[i + 1] || "";
    const nx2 = s[i + 2] || "";
    const prev = s[i - 1] || "";

    // Skip duplicate consonants (except for C).
    if (c === prev && c !== "C") { i++; continue; }

    switch (c) {
      case "A": case "E": case "I": case "O": case "U":
        if (i === 0) out += c;
        i++;
        break;
      case "B":
        out += "B";
        // Drop silent B at end after M.
        if (i === n - 1 && prev === "M") out = out.slice(0, -1);
        i++;
        break;
      case "C":
        if (nx === "I" && nx2 === "A") { out += "X"; i += 1; }
        else if (nx === "H") { out += "X"; i += 2; }
        else if (nx === "I" || nx === "E" || nx === "Y") { out += "S"; i += 1; }
        else { out += "K"; i += 1; }
        break;
      case "D":
        if (nx === "G" && (nx2 === "E" || nx2 === "I" || nx2 === "Y")) { out += "J"; i += 3; }
        else { out += "T"; i++; }
        break;
      case "F": out += "F"; i++; break;
      case "G":
        if (nx === "H") {
          if (i > 0 && !isVowel(prev)) { i += 2; }
          else { out += "F"; i += 2; }
        }
        else if (nx === "N") { i += 2; }
        else if (nx === "E" || nx === "I" || nx === "Y") { out += "J"; i++; }
        else { out += "K"; i++; }
        break;
      case "H":
        if (i > 0 && !isVowel(prev)) { i++; }
        else if (isVowel(nx)) { out += "H"; i++; }
        else { i++; }
        break;
      case "J": out += "J"; i++; break;
      case "K":
        if (prev === "C") { i++; }
        else { out += "K"; i++; }
        break;
      case "L": out += "L"; i++; break;
      case "M": out += "M"; i++; break;
      case "N": out += "N"; i++; break;
      case "P":
        if (nx === "H") { out += "F"; i += 2; }
        else { out += "P"; i++; }
        break;
      case "Q": out += "K"; i++; break;
      case "R": out += "R"; i++; break;
      case "S":
        if (nx === "H") { out += "X"; i += 2; }
        else if (nx === "I" && (nx2 === "A" || nx2 === "O")) { out += "X"; i++; }
        else { out += "S"; i++; }
        break;
      case "T":
        if (nx === "H") { out += "0"; i += 2; }
        else if (nx === "I" && (nx2 === "A" || nx2 === "O")) { out += "X"; i++; }
        else if (nx === "C" && nx2 === "H") { i++; }
        else { out += "T"; i++; }
        break;
      case "V": out += "F"; i++; break;
      case "W":
        if (isVowel(nx)) { out += "W"; i++; }
        else { i++; }
        break;
      case "X": out += "KS"; i++; break;
      case "Y":
        if (isVowel(nx)) { out += "Y"; i++; }
        else { i++; }
        break;
      case "Z": out += "S"; i++; break;
      default: i++;
    }
  }
  return out;
};

// ----- N-gram Jaccard -----

export const nGrams = (s, n = 3) => {
  const t = normaliseToken(s).replace(/\s+/g, "");
  if (t.length < n) return new Set([t]);
  const out = new Set();
  for (let i = 0; i <= t.length - n; i++) out.add(t.slice(i, i + n));
  return out;
};

export const jaccardNgrams = (a, b, n = 3) => {
  const A = nGrams(a, n);
  const B = nGrams(b, n);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
};

// ----- blocking key -----
//
// For a candidate-set search we don't want to score every line
// against every item; we want to BLOCK the search space first.
// The standard cheap blocking-key strategy:
//
//   key = (first 3 chars of normalised partno) + (metaphone of
//         the first significant word of description)
//
// Two items with the same block share enough lexical + phonetic
// signal that they're worth scoring against each other; items
// in different blocks are safely skipped.

export const blockingKey = ({ partNo, description } = {}) => {
  const pn = normaliseToken(partNo).replace(/\s+/g, "");
  const head = pn.slice(0, 3);
  const words = significantWords(description);
  const meta = words.length ? metaphone(words[0]).slice(0, 4) : "";
  return (head + "|" + meta).toUpperCase();
};

// ----- composite score -----
//
// For ranking candidates within a block, combine all three
// signals. Per the entity-resolution literature, a tuned linear
// combination beats any single metric. Weights pegged to
// match what works for short codes + 3-7 word descriptions:
//   0.45 Jaro-Winkler over partNo
//   0.30 Jaccard 3-grams over description
//   0.25 Metaphone exact-match (1 if equal, 0 otherwise)

export const compositeScore = (queryLine, candidate) => {
  const qPart = normaliseToken(queryLine?.partNumber || queryLine?.partNo || "");
  const cPart = normaliseToken(candidate?.part_no || "");
  const qDesc = normaliseToken(queryLine?.description || "");
  const cDesc = normaliseToken(candidate?.description || candidate?.print_name || candidate?.alias || "");

  const jw = qPart && cPart ? jaroWinkler(qPart, cPart) : 0;
  const jc = qDesc && cDesc ? jaccardNgrams(qDesc, cDesc, 3) : 0;
  const qm = significantWords(qDesc).map(metaphone).join(" ");
  const cm = significantWords(cDesc).map(metaphone).join(" ");
  const mm = qm && cm && qm === cm ? 1 : 0;

  return 0.45 * jw + 0.30 * jc + 0.25 * mm;
};

export const __test = { STOP_WORDS, VOWELS };
