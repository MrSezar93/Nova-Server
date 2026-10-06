#!/usr/bin/env node
/**
 * Test runner: bundles every tests/*.test.ts with esbuild (so tests can import
 * Cloudflare workers types, .ts sources, npm references) and runs `node --test`.
 */
import { build } from "esbuild";
import { readdir, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testsDir = path.join(root, "tests");
const outDir = path.join(root, ".tmp-tests");

const entries = (await readdir(testsDir))
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => path.join(testsDir, file));

if (!entries.length) {
  console.error("no tests found");
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const built = [];
for (const entry of entries) {
  const outfile = path.join(outDir, path.basename(entry).replace(/\.ts$/, ".mjs"));
  built.push(outfile);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    external: ["node:*"],
    logLevel: "error",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
}

const args = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const child = spawn(
  process.execPath,
  ["--test", ...(process.argv.includes("--verbose") ? ["--test-reporter=spec"] : []), ...args, ...built],
  { stdio: "inherit", cwd: root },
);
child.on("exit", (code) => process.exit(code ?? 1));
