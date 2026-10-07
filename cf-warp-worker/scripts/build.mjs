#!/usr/bin/env node
/**
 * Build script (esbuild).
 *
 *   npm run build          -> dist/worker.js        (readable ESM bundle, Worker)
 *   npm run build:single   -> dist/worker.min.js    (single file to paste in the dashboard)
 *   npm run build:pages    -> dist/pages/_worker.js (Cloudflare Pages "advanced mode" worker)
 *                             dist/pages/_routes.json
 *
 * The Pages bundle is byte-identical in behaviour: `_worker.js` is a module
 * worker with a `fetch` handler, which is exactly what this project exports.
 * Pages just serves it from `<project>.pages.dev` instead of `*.workers.dev`.
 */
import { build } from "esbuild";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const single = process.argv.includes("--single");
const pages = process.argv.includes("--pages");

const outfile = pages
  ? path.join(root, "dist/pages/_worker.js")
  : path.join(root, single ? "dist/worker.min.js" : "dist/worker.js");

// Only the artifact being rebuilt is removed, so `build`, `build:single` and
// `build:pages` can coexist in `dist/`.
await rm(pages ? path.join(root, "dist/pages") : outfile, { recursive: true, force: true });
await mkdir(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile,
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  conditions: ["worker", "browser", "import"],
  // `cloudflare:sockets` is provided by the Workers runtime, never bundled.
  external: ["cloudflare:*"],
  mainFields: ["module", "main"],
  minify: single || pages,
  legalComments: single || pages ? "none" : "inline",
  banner: {
    js: pages
      ? "// Nova WARP — Cloudflare Pages build (advanced mode: _worker.js)\n"
      : single
        ? "// Nova WARP Worker — single-file build (paste into the Cloudflare dashboard editor)\n"
        : "// Nova WARP Worker — bundled output\n",
  },
  logLevel: "info",
});

const info = await stat(outfile);
console.log(`\n✔ ${path.relative(root, outfile)} — ${(info.size / 1024).toFixed(1)} KiB`);

if (pages) {
  // Everything is handled by the worker; no static assets to exclude.
  await writeFile(
    path.join(root, "dist/pages/_routes.json"),
    `${JSON.stringify({ version: 1, include: ["/*"], exclude: [] }, null, 2)}\n`,
  );
  console.log("✔ dist/pages/_routes.json");
  console.log("  انتشار:  npm run deploy:pages");
} else if (!single) {
  console.log("  برای فایل تک‌قسمتی (کپی/پیست در داشبورد):  npm run build:single");
}
