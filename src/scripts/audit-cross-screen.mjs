// Detect cross-screen identifier leaks left behind by the regex converter.
//
// In the legacy concatenated build, every JSX file shared one global
// scope. A helper defined in `wired-tally-masters-d.jsx` was visible to
// `wired-tally-push-d.jsx` automatically. After conversion to per-file
// ESM modules, those references break at runtime with ReferenceError.
//
// This script walks every `src/v3-app/screens/*.tsx`, collects every
// top-level declared name in each file, then for each screen looks for
// identifiers that:
//   - Are USED in the file (`Foo(...)` or `<Foo />` or `Foo.bar`)
//   - Are NOT imported
//   - Are NOT declared locally
//   - ARE declared in a different screen file
//
// Each finding is a likely runtime crash. Output groups by source file
// + suggests where the missing declaration lives, so we can either
// extract the helper to lib/ or duplicate the body where needed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS = path.join(ROOT, "src", "v3-app", "screens");
const LIB = path.join(ROOT, "src", "v3-app", "lib");

const WORD = "[A-Za-z_$][\\w$]*";

const sanitize = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ")
  .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
  .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, "``");

const collectImports = (text) => {
  const set = new Set();
  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) set.add(m[1]);
  for (const m of text.matchAll(/import\s+\{([^}]+)\}\s+from/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) set.add(name);
    }
  }
  for (const m of text.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g)) set.add(m[1]);
  return set;
};

// Top-level only: const/let/var/function/class at column 0.
const collectTopLevelDecls = (text) => {
  const set = new Set();
  for (const m of text.matchAll(new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${WORD})`, "gm"))) set.add(m[1]);
  for (const m of text.matchAll(new RegExp(`^(?:export\\s+)?function\\s+(${WORD})`, "gm"))) set.add(m[1]);
  for (const m of text.matchAll(new RegExp(`^(?:export\\s+)?class\\s+(${WORD})`, "gm"))) set.add(m[1]);
  return set;
};

// Function-scoped + destructured names. Best-effort scan so we don't
// flag a binding declared inside a callback.
const collectAnyDecls = (text) => {
  const set = new Set();
  for (const m of text.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${WORD})`, "g"))) set.add(m[1]);
  for (const m of text.matchAll(new RegExp(`\\bfunction\\s+(${WORD})`, "g"))) set.add(m[1]);
  for (const m of text.matchAll(new RegExp(`\\bclass\\s+(${WORD})`, "g"))) set.add(m[1]);
  // Destructured const { a, b: c } = ...
  for (const m of text.matchAll(/\{\s*([^{}]+)\s*\}\s*=\s*[A-Za-z_$]/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      const name = t.includes(":") ? t.split(":")[1].trim().split(/[\s=]/)[0] : t.split(/[\s=]/)[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) set.add(name);
    }
  }
  // Function parameter lists: const foo = (a, b) =>, function foo(a, b)
  for (const m of text.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[\s=:]/)[0].replace(/^\.\.\./, "");
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) set.add(name);
    }
  }
  return set;
};

// Browser + React + standard JS builtins that should never be flagged.
const BUILTINS = new Set([
  // JS
  "Array", "Object", "Number", "String", "Boolean", "Symbol", "BigInt",
  "Math", "Date", "JSON", "RegExp", "Error", "TypeError", "RangeError",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect",
  "Intl", "URLSearchParams", "URL", "Blob", "File", "FileReader", "FormData",
  "ArrayBuffer", "Uint8Array", "Uint16Array", "Int32Array", "Float32Array",
  "TextEncoder", "TextDecoder", "DataView", "AbortController",
  "isNaN", "isFinite", "parseInt", "parseFloat", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "globalThis",
  "console", "fetch", "Headers", "Request", "Response",
  "structuredClone", "queueMicrotask", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "requestAnimationFrame",
  // DOM
  "document", "window", "navigator", "location", "history", "alert",
  "confirm", "prompt", "Element", "HTMLElement", "Node", "NodeList",
  "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "FocusEvent",
  "DragEvent", "InputEvent", "PointerEvent", "TouchEvent", "ClipboardEvent",
  "MutationObserver", "ResizeObserver", "IntersectionObserver",
  // React
  "React", "Fragment", "Suspense",
  // TypeScript
  "as", "any", "true", "false", "null", "undefined", "void", "this", "new",
  "typeof", "instanceof", "in", "of", "if", "else", "for", "while", "do",
  "return", "break", "continue", "switch", "case", "default", "throw",
  "try", "catch", "finally", "yield", "await", "async", "function",
  "let", "const", "var", "class", "extends", "super", "import", "export",
  "from", "delete", "with", "debugger",
  // Common JSX-implicit
  "Symbol.toPrimitive",
]);

// Cross-reference: build a map of identifier -> screens that define it
// at the top level. Excludes the file itself when checking.
const screens = fs.readdirSync(SCREENS).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
const decls = {};
for (const f of screens) {
  const text = fs.readFileSync(path.join(SCREENS, f), "utf8");
  const top = collectTopLevelDecls(sanitize(text));
  for (const name of top) {
    decls[name] = decls[name] || [];
    decls[name].push(f);
  }
}

const findings = [];
const note = (file, kind, msg) => findings.push({ file, kind, msg });

for (const f of screens) {
  const raw = fs.readFileSync(path.join(SCREENS, f), "utf8");
  const text = sanitize(raw);
  const imports = collectImports(text);
  const locals = collectAnyDecls(text);

  // Identifiers used as function calls or JSX components or property
  // accesses. We capture every CamelCase/lowerCamel symbol that appears
  // in a position where it must resolve to a binding.
  const used = new Set();
  // Function call / construction: `foo(...)` or `new foo(...)`.
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])(?:new\\s+)?(${WORD})\\s*\\(`, "g"))) {
    used.add(m[1]);
  }
  // JSX tag: `<foo` or `</foo`. Components are always Capitalized.
  for (const m of text.matchAll(/<\/?([A-Z][A-Za-z0-9_]*)/g)) used.add(m[1]);
  // Property access on a free identifier: `foo.bar`.
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])(${WORD})\\.`, "g"))) {
    used.add(m[1]);
  }

  for (const name of used) {
    if (BUILTINS.has(name)) continue;
    if (imports.has(name)) continue;
    if (locals.has(name)) continue;
    // Property method like `array.map` would catch `map` here. Skip
    // common method names that show up everywhere as `x.map`.
    if (/^(map|filter|reduce|forEach|some|every|find|findIndex|slice|splice|sort|reverse|join|push|pop|shift|unshift|includes|concat|flat|flatMap|then|catch|finally|toString|valueOf|hasOwnProperty|test|exec|trim|toLowerCase|toUpperCase|substring|substr|charAt|charCodeAt|replace|replaceAll|split|matchAll|match|indexOf|lastIndexOf|startsWith|endsWith|padStart|padEnd|repeat|toFixed|toLocaleString|toLocaleDateString|toLocaleTimeString|getTime|getFullYear|getMonth|getDate|getHours|getMinutes|getDay|setHours|setMinutes|setSeconds|setDate|setMonth|setFullYear|setItem|getItem|removeItem|reload|focus|blur|click|preventDefault|stopPropagation|currentTarget|target|value|checked|files|name|type|key|innerWidth|innerHeight|stack|message|status|ok|error|warn|info|log|append|appendChild|removeChild|insertBefore|setAttribute|getAttribute|hasAttribute|removeAttribute|addEventListener|removeEventListener|querySelector|querySelectorAll|getElementById|getElementsByTagName|getElementsByClassName|createElement|createTextNode|stringify|parse|fromCharCode|abs|ceil|floor|round|min|max|pow|sqrt|sign|random|trunc|cbrt|cos|sin|tan|log|exp|now|isInteger|isFinite|isNaN|isArray|keys|values|entries|fromEntries|assign|freeze|defineProperty|getOwnPropertyDescriptor|getPrototypeOf|setPrototypeOf|create|all|allSettled|race|resolve|reject|forEach)$/.test(name)) {
      continue;
    }
    // If this name is declared in a DIFFERENT screen, it is a likely
    // hoist that broke during the ESM split.
    const otherFiles = (decls[name] || []).filter((d) => d !== f);
    if (otherFiles.length) {
      note(f, "cross-screen-leak", `${name} is referenced but declared in ${otherFiles.join(", ")}`);
    }
  }
}

console.log("\nCross-screen identifier audit");
console.log("─".repeat(70));
const grouped = {};
for (const fnd of findings) {
  grouped[fnd.kind] = grouped[fnd.kind] || [];
  grouped[fnd.kind].push(fnd);
}
let total = 0;
for (const k of Object.keys(grouped).sort()) {
  console.log(`\n[${k}] ${grouped[k].length} finding(s)`);
  for (const f of grouped[k]) {
    console.log(`  ${f.file.padEnd(28)} ${f.msg}`);
    total++;
  }
}
console.log("\n" + "─".repeat(70));
console.log(`${total} finding(s) across ${screens.length} screens`);
if (total > 0) process.exit(1);
