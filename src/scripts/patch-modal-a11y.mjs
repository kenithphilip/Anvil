// Add role="dialog" + aria-modal="true" to every existing modal in
// src/v3-app/screens/. Idempotent: skips files where role="dialog" is
// already present on the modal div.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS = path.join(ROOT, "src", "v3-app", "screens");

const files = fs.readdirSync(SCREENS).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
let touched = 0;

for (const f of files) {
  const full = path.join(SCREENS, f);
  let text = fs.readFileSync(full, "utf8");
  if (!text.includes("modal-backdrop")) continue;
  if (text.includes('role="dialog"') && text.includes('aria-modal="true"')) continue;
  // Match the inner modal div: `<div className="modal"` followed by props
  // and `onClick={(ev) => ev.stopPropagation()}`. Insert role + aria-modal
  // right after the className.
  const before = text;
  text = text.replace(
    /<div className="modal"(\s+onClick=\{[^}]*\})/g,
    '<div className="modal" role="dialog" aria-modal="true"$1'
  );
  if (text !== before) {
    fs.writeFileSync(full, text);
    touched++;
    console.log(`patched ${f}`);
  }
}

console.log(`\n${touched} file(s) updated`);
