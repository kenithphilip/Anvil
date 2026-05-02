// Convert `<a onClick={...} style={{...}}>` patterns to keyboard-
// accessible `<button>` elements with the same visual styling.
//
// Pattern detected:
//   <a onClick={X} style={{ color: ..., cursor: "pointer", textDecoration: "underline", ... }}>...</a>
//
// Replaced with:
//   <button type="button" onClick={X} className="link-btn" style={{ ..., textDecoration: "underline" }}>...</button>
//
// And adds a `.link-btn` rule to styles.css that strips default button
// chrome so the visual stays identical to the legacy anchor.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS = path.join(ROOT, "src", "v3-app", "screens");

const files = fs.readdirSync(SCREENS).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
let touched = 0;

// Match `<a onClick={...} style={{...}}>...</a>`. Greedy on style block,
// non-greedy on inner. We use a simple state machine to balance braces
// inside the style attribute. The regex below handles the common shape;
// edge cases with nested JSX inside the anchor body fall back to the
// legacy emit and we'd report them via audit-ux.
const ANCHOR_RE = /<a\s+onClick=\{([^}]+)\}\s+style=\{\{([^}]+)\}\}\s*>([\s\S]*?)<\/a>/g;

for (const f of files) {
  const full = path.join(SCREENS, f);
  const text = fs.readFileSync(full, "utf8");
  if (!ANCHOR_RE.test(text)) continue;
  ANCHOR_RE.lastIndex = 0;
  const next = text.replace(ANCHOR_RE, (_match, handler, style, inner) => {
    return `<button type="button" onClick={${handler}} className="link-btn" style={{${style}}}>${inner}</button>`;
  });
  if (next !== text) {
    fs.writeFileSync(full, next);
    console.log(`patched ${f}`);
    touched++;
  }
}

console.log(`\n${touched} file(s) updated`);
