#!/usr/bin/env node
/**
 * Local preview harness — فقط برای دیدن و کلیک‌کردن روی پنل، بدون Cloudflare.
 *
 *   npm run preview                 # پیش‌فرض: http://localhost:8080 ، رمز nova-preview
 *   PORT=3000 node scripts/preview.mjs
 *
 * این اسکریپت Worker را با esbuild باندل می‌کند، یک KV درون‌حافظه‌ای می‌سازد و
 * درخواست‌های HTTP محلی را به `export default { fetch }` می‌دهد.
 *
 * چون محیط سندباکس به api.cloudflareclient.com دسترسی ندارد، DEMO_MODE روشن است:
 * هویت‌های ساخته‌شده آزمایشی‌اند و کانفیگ‌هایشان واقعی کار نمی‌کند (اما کل جریان
 * پنل، ساخت کانفیگ، QR و لینک اشتراک قابل آزمایش است). برای ثبت‌نام واقعی،
 * Worker را روی Cloudflare دیپلوی کنید — راهنمای DEPLOY.fa.md.
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, ".preview");
const outfile = path.join(outDir, "worker.mjs");

const PASSWORD = process.env.PREVIEW_PASSWORD ?? "nova-preview";
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["node:*"],
  logLevel: "error",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

const worker = (await import(pathToFileURL(outfile).href)).default;

/* ----------------------------- KV درون‌حافظه‌ای ----------------------------- */

class PreviewKV {
  constructor() {
    this.map = new Map();
  }
  async get(key, options) {
    const raw = this.map.get(key);
    if (raw === undefined) return null;
    // KV accepts both `get(key, "json")` and `get(key, { type: "json" })`.
    const type = typeof options === "string" ? options : options?.type;
    if (type === "json") return JSON.parse(raw);
    if (type === "arrayBuffer") return new TextEncoder().encode(raw).buffer;
    return raw;
  }
  async put(key, value) {
    this.map.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list(options = {}) {
    const prefix = options.prefix ?? "";
    const keys = [...this.map.keys()].filter((key) => key.startsWith(prefix)).sort();
    return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: "" };
  }
  async getWithMetadata(key) {
    return { value: await this.get(key), metadata: null };
  }
}

const env = {
  WARP_KV: new PreviewKV(),
  PANEL_TITLE: "Nova WARP",
  PANEL_LANG: "fa",
  PANEL_PASSWORD: PASSWORD,
  SESSION_SECRET: "preview-session-secret",
  DEMO_MODE: "1",
  DISABLE_RAW_TLS: "1",
  MAX_REGISTRATIONS_PER_HOUR: "50",
  // فقط برای پیش‌نمایش: اجازه‌ی نمایش پنل داخل iframe
  ALLOW_FRAMING: "1",
};

const ctx = { waitUntil() {}, passThroughOnException() {} };

/* --------------------------- داده‌ی نمونه (seed) ---------------------------- */

async function seed() {
  const origin = `http://preview.local:${port}`;
  const call = async (method, path, body, cookie) => {
    const headers = { origin };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await worker.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx,
    );
    return response;
  };

  const form = new URLSearchParams({ password: PASSWORD });
  const loginResponse = await worker.fetch(
    new Request(`${origin}/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    env,
    ctx,
  );
  const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) {
    console.warn("⚠ seed: ورود ناموفق بود، پنل خالی می‌ماند");
    return;
  }

  const identity = await (
    await call("POST", "/api/v1/identities", { name: "nova-demo" }, cookie)
  ).json();
  const identityId = identity?.identity?.id;
  for (const [name, format] of [
    ["phone", "wg"],
    ["laptop", "singbox"],
  ]) {
    await call("POST", "/api/v1/clients", { name, format, identityId }, cookie);
  }
  console.log("✔ داده‌ی نمونه ساخته شد: ۱ هویت آزمایشی + ۲ کانفیگ (phone، laptop)");
}

await seed();

/* ------------------------------- HTTP bridge -------------------------------- */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const server = createServer(async (req, res) => {
  try {
    const proto = (req.headers["x-forwarded-proto"] ?? "http").toString().split(",")[0].trim();
    const hostHeader = (req.headers["x-forwarded-host"] ?? req.headers.host ?? `localhost:${port}`)
      .toString()
      .split(",")[0]
      .trim();
    const url = `${proto}://${hostHeader}${req.url}`;

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }

    const method = (req.method ?? "GET").toUpperCase();
    const request = new Request(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : req,
      duplex: "half",
    });

    const response = await worker.fetch(request, env, ctx);

    const outHeaders = [];
    for (const [name, value] of response.headers) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      outHeaders.push([name, value]);
    }
    res.writeHead(response.status, outHeaders);

    if (!response.body) {
      res.end();
      return;
    }
    for await (const chunk of response.body) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error("[preview] error:", error);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("preview error: " + (error?.stack ?? error));
  }
});

server.listen(port, host, () => {
  console.log(`پیش‌نمایش پنل:  http://localhost:${port}        (رمز: ${PASSWORD})`);
  console.log("حالت آزمایشی (DEMO_MODE=1): کانفیگ‌ها نمایشی هستند و واقعی کار نمی‌کنند.");
});
