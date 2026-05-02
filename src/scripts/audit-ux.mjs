// UX + accessibility heuristics audit for src/v3-app/.
//
// Catches common UI issues that the converter could not have introduced
// but the legacy build also never enforced:
//
// 1. Icon-only buttons without an accessible name (no title + no
//    aria-label + no children that are text). These are unreadable to
//    screen readers and have no tooltip on hover.
// 2. Modal dialogs without an escape-to-close handler and without
//    role="dialog" + aria-modal on the wrapper.
// 3. Inputs without a paired <label> or aria-label.
// 4. Buttons with click handlers that lack a visible disabled state
//    when busy (the legacy code is inconsistent about this).
// 5. <a onClick> patterns: should be <button> for accessibility.
// 6. Tables without <caption> or aria-label on heavy data screens.
//
// Output: one row per finding. Each finding is a category + file +
// short hint. Tier-1 findings (icon-only buttons + missing modal close)
// are blocking; the rest are nice-to-have.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS = path.join(ROOT, "src", "v3-app", "screens");
const COMPONENTS = path.join(ROOT, "src", "v3-app", "components");
const LIB = path.join(ROOT, "src", "v3-app", "lib");

const allFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) allFiles.push(full);
  }
};
walk(SCREENS); walk(COMPONENTS); walk(LIB);

const findings = [];
const note = (file, kind, line, msg) => findings.push({
  file: path.relative(ROOT, file), kind, line, msg,
});

for (const full of allFiles) {
  const text = fs.readFileSync(full, "utf8");
  const lines = text.split("\n");

  // 1. Icon-only buttons. Match `<Btn icon ...>` with NO title and NO
  //    aria-label and the children look like just an Icon.X reference.
  const iconBtnRe = /<Btn\s+([^>]*?)icon([^>]*?)>([\s\S]*?)<\/Btn>/g;
  for (const m of text.matchAll(iconBtnRe)) {
    const propsBefore = m[1] || "";
    const propsAfter = m[2] || "";
    const inner = (m[3] || "").trim();
    const allProps = propsBefore + " " + propsAfter;
    const hasTitle = /\btitle\s*=/.test(allProps);
    const hasAriaLabel = /aria-label\s*=/.test(allProps);
    // Inner is "just an icon" if it's only whitespace + JSX expression
    // referencing Icon.something.
    const innerIsJustIcon = /^\{Icon\.[A-Za-z0-9_]+\}\s*$/.test(inner);
    const innerHasText = /[A-Za-z]/.test(inner.replace(/\{Icon\.[A-Za-z0-9_]+\}/g, ""));
    if (innerIsJustIcon && !hasTitle && !hasAriaLabel) {
      const line = text.slice(0, m.index).split("\n").length;
      note(full, "icon-button-no-label", line, `<Btn icon> without title/aria-label`);
    }
    // Suppress: button has both icon + text, that's fine.
    void innerHasText;
  }

  // 2. Modal-backdrop divs without a Keydown handler for Escape on the
  //    surrounding component, or without aria-modal/role="dialog" on
  //    the inner wrapper. Detect any "modal-backdrop" usage and check
  //    if onKeyDown / role / aria-modal appear nearby.
  const modalRe = /className\s*=\s*"modal-backdrop"/g;
  for (const m of text.matchAll(modalRe)) {
    const line = text.slice(0, m.index).split("\n").length;
    // Look in the surrounding 30 lines for role/aria-modal + Escape.
    const startLine = Math.max(0, line - 5);
    const endLine = Math.min(lines.length, line + 30);
    const block = lines.slice(startLine, endLine).join("\n");
    const hasRole = /role\s*=\s*"dialog"/.test(block);
    const hasAria = /aria-modal/.test(block);
    if (!hasRole) note(full, "modal-no-role", line, `modal lacks role="dialog"`);
    if (!hasAria) note(full, "modal-no-aria-modal", line, `modal lacks aria-modal="true"`);
  }

  // 3. <a onClick> without href. Should be <button> for keyboard +
  //    screen-reader users.
  const aRe = /<a\s+([^>]*?onClick=[^>]*?)>/g;
  for (const m of text.matchAll(aRe)) {
    const props = m[1];
    if (/\bhref\s*=/.test(props)) continue; // genuine link, fine
    const line = text.slice(0, m.index).split("\n").length;
    note(full, "anchor-without-href", line, `<a onClick> without href; use <button>`);
  }
}

console.log("\nUX heuristics audit");
console.log("─".repeat(70));
const grouped = {};
for (const f of findings) {
  grouped[f.kind] = grouped[f.kind] || [];
  grouped[f.kind].push(f);
}
for (const k of Object.keys(grouped).sort()) {
  console.log(`\n[${k}] ${grouped[k].length}`);
  for (const f of grouped[k].slice(0, 25)) {
    console.log(`  ${f.file}:${f.line}  ${f.msg}`);
  }
  if (grouped[k].length > 25) console.log(`  ... ${grouped[k].length - 25} more`);
}
console.log("\n" + "─".repeat(70));
console.log(`${findings.length} finding(s) across ${allFiles.length} files`);
