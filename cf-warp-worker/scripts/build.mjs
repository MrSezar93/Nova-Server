#!/usr/bin/env node
/**
 * Build script (esbuild).
 *
 *   npm run build          -> dist/worker.js        (readable ESM bundle)
 *   npm run build:single   -> dist/worker.min.js    (single file to paste in the dashboard)
 */
import { build } from "esbuild";
import { mkdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const single = process.argv.includes("--single");

const outfile = path.join(root, single ? "dist/worker.min.js" : "dist/worker.js");

await rm(path.join(root, "dist"), { recursive: true, force: true });
await mkdir(path.join(root, "dist"), { recursive: true });

await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile,
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  conditions: ["worker", "browser", "import"],
  mainFields: ["module", "main"],
  minify: single,
  legalComments: single ? "none" : "inline",
  banner: {
    js: single
      ? "// Nova WARP Worker — single-file build (paste into the Cloudflare dashboard editor)\n"
      : "// Nova WARP Worker — bundled output\n",
  },
  logLevel: "info",
});

const info = await stat(outfile);
console.log(`\n✔ ${path.relative(root, outfile)} — ${(info.size / 1024).toFixed(1)} KiB`);
if (!single) {
  console.log("  برای فایل تک‌قسمتی (کپی/پیست در داشبورد):  npm run build:single");
}
