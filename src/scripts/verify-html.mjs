// Compile every plain <script> block in public/index.html with vm.Script.
// vm.Script parses but does not execute; perfect for verifying the build
// produced syntactically valid JS without spawning subprocesses.
// Skips Babel/JSX blocks (those need Babel, not the V8 parser).

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const htmlPath = path.join(process.cwd(), "public/index.html");
if (!fs.existsSync(htmlPath)) {
  console.error("public/index.html not found, run npm run build first");
  process.exit(2);
}

const html = fs.readFileSync(htmlPath, "utf8");
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

let count = 0;
let failed = 0;
let m;
while ((m = re.exec(html))) {
  if (/type=["'](text\/babel|text\/jsx)["']/.test(m[0])) continue;
  const body = m[1].trim();
  if (!body) continue;
  count++;
  try {
    new vm.Script(body, { filename: "block_" + count + ".js" });
  } catch (e) {
    console.error("block " + count + " failed: " + e.message);
    failed++;
  }
}

console.log("verified " + count + " script blocks, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
