// One-shot rename: src/v3-app/**/*.{js,jsx} -> *.{ts,tsx}
//
// JSX heuristic: a file becomes .tsx if it contains a JSX-style tag (`<X`
// where X is a capitalized identifier or a known HTML tag) OR if its
// extension was already .jsx. Otherwise it becomes .ts.
//
// After rename, every import in every renamed file is rewritten to drop
// the explicit .js/.jsx extension. TypeScript with moduleResolution=
// "Bundler" resolves the bare path to .ts/.tsx automatically. Vite does
// the same. This keeps imports stable across both resolvers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_DIR = path.join(ROOT, "src", "v3-app");

const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
};

const isJsx = (text, oldExt) => {
  if (oldExt === ".jsx") return true;
  // Heuristic: JSX tags or React imports with createElement-like usage.
  if (/<[A-Z][A-Za-z0-9]*[\s/>]/.test(text)) return true;
  if (/<\/[A-Za-z]/.test(text)) return true;
  return false;
};

const stripImportExt = (text) => {
  // Match `import ... from "X"` or dynamic `import("X")` and strip
  // .js/.jsx from the trailing path. Avoid touching package imports
  // (those don't end in our extensions anyway).
  return text
    .replace(/from\s+(["'])(\.\.?\/[^"']+?)\.(jsx?|tsx?)\1/g, 'from $1$2$1')
    .replace(/import\s*\(\s*(["'])(\.\.?\/[^"']+?)\.(jsx?|tsx?)\1\s*\)/g, 'import($1$2$1)');
};

const main = () => {
  const files = walk(APP_DIR);
  const renames = new Map();

  // First pass: decide new extension for each file.
  for (const old of files) {
    const text = fs.readFileSync(old, "utf8");
    const oldExt = path.extname(old);
    const newExt = isJsx(text, oldExt) ? ".tsx" : ".ts";
    const next = old.replace(/\.(js|jsx)$/, newExt);
    renames.set(old, next);
  }

  // Second pass: rewrite contents (strip import extensions) + rename.
  for (const [oldPath, newPath] of renames) {
    let text = fs.readFileSync(oldPath, "utf8");
    text = stripImportExt(text);
    fs.writeFileSync(newPath, text);
    if (oldPath !== newPath) fs.unlinkSync(oldPath);
  }

  console.log(`renamed ${renames.size} files`);
};

main();
