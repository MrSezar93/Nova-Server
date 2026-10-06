/**
 * Nova WARP Worker — entry point.
 *
 * Routes
 *   /                      panel (session cookie)
 *   /login /setup /logout  panel authentication
 *   /api/v1/*              JSON API (session cookie or Bearer API key)
 *   /c/:token              public profile page (+ ?format=)
 *   /c/:token/raw          raw profile download
 *   /qr/:token.svg         QR code (SVG)
 *   /sub/:token            base64 subscription payload
 *   /healthz               health probe
 */

import {
  assertSameOrigin,
  clientIp,
  configureFraming,
  downloadResponse,
  htmlResponse,
  HttpError,
  json,
  optionalNumber,
  parseCookies,
  readJson,
  requireString,
  Router,
  serializeCookie,
  textResponse,
  type RequestContext,
} from "./lib/http";
import {
  bumpSessionEpoch,
  checkPassword,
  clearFailedLogins,
  createAuthRecord,
  createSessionToken,
  generateApiKey,
  getSessionEpoch,
  getSessionSecret,
  isPanelConfigured,
  registerFailedLogin,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieOptions,
  verifySessionToken,
} from "./lib/auth";
import { Store } from "./lib/store";
import {
  bindLicense,
  createClients,
  identitySummary,
  importIdentity,
  isDemoMode,
  registerNewIdentity,
  renderForClient,
  rotateClient,
  syncIdentity,
} from "./lib/service";
import { WarpApiError } from "./lib/warp";
import { isConfigFormat, type ConfigFormat } from "./lib/wg";
import { qrSvg } from "./lib/qr";
import { normalizeLang } from "./ui/i18n";
import {
  renderLoginPage,
  renderMessagePage,
  renderPanelPage,
  renderSetupPage,
  renderSharePage,
} from "./ui/pages";
import type { ClientRecord, Env, PanelSettings } from "./types";

const router = new Router();

/* -------------------------------------------------------------------------- */
/*                                  helpers                                   */
/* -------------------------------------------------------------------------- */

function buildStore(env: Env): Store {
  return new Store({ kv: env.WARP_KV });
}

async function effectiveSettings(env: Env, store: Store): Promise<PanelSettings> {
  const settings = await store.getSettings();
  if (env.PANEL_TITLE) settings.title = env.PANEL_TITLE;
  if (env.PANEL_LANG) settings.lang = normalizeLang(env.PANEL_LANG);
  return settings;
}

async function getApiKey(env: Env, store: Store): Promise<string | null> {
  if (env.API_KEY?.trim()) return env.API_KEY.trim();
  const record = await store.getAuth();
  return record?.apiKey ?? null;
}

interface AuthResult {
  viaApiKey: boolean;
}

/** Accepts either a signed session cookie or the panel API key. */
async function authenticate(context: RequestContext): Promise<AuthResult | null> {
  const cookies = parseCookies(context.request);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    const secret = await getSessionSecret(context.env, context.store);
    if (secret) {
      const epoch = await getSessionEpoch(context.store);
      const payload = await verifySessionToken(secret, token, epoch);
      if (payload) return { viaApiKey: false };
    }
  }
  const header = context.request.headers.get("authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  const headerKey = context.request.headers.get("x-api-key");
  const candidate = bearer ?? headerKey;
  if (candidate) {
    const expected = await getApiKey(context.env, context.store);
    if (expected) {
      const encoder = new TextEncoder();
      const a = encoder.encode(candidate);
      const b = encoder.encode(expected);
      let diff = a.length ^ b.length;
      const length = Math.max(a.length, b.length);
      for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
      if (diff === 0) return { viaApiKey: true };
    }
  }
  return null;
}

async function requireAuth(context: RequestContext): Promise<AuthResult> {
  const result = await authenticate(context);
  if (!result) throw new HttpError(401, "برای این عملیات باید وارد پنل شوید.", "unauthorized");
  context.viaApiKey = result.viaApiKey;
  return result;
}

function handleError(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.code ?? "error", message: error.message }, { status: error.status });
  }
  if (error instanceof WarpApiError) {
    return json(
      { error: error.kind, message: error.message, detail: error.detail },
      { status: error.httpStatus },
    );
  }
  console.error("unhandled error", error);
  return json(
    { error: "internal", message: "خطای غیرمنتظره در Worker رخ داد." },
    { status: 500 },
  );
}

/* -------------------------------------------------------------------------- */
/*                                   API                                      */
/* -------------------------------------------------------------------------- */

router.get("/api/v1/state", async (context) => {
  const auth = await requireAuth(context);
  const settings = await effectiveSettings(context.env, context.store);
  const [identities, clients, logs] = await Promise.all([
    context.store.listIdentities(),
    context.store.listClients(),
    context.store.listLogs(),
  ]);
  const apiKey = auth.viaApiKey ? undefined : (await getApiKey(context.env, context.store)) ?? undefined;
  return json({
    settings,
    persistent: context.store.persistent,
    demo: isDemoMode(context.env),
    apiKey,
    identities: identities.map(identitySummary),
    clients: clients.map(publicClient),
    logs,
    stats: {
      clients: clients.length,
      identities: identities.length,
      plus: identities.filter((identity) => identity.account?.warpPlus).length,
      views: clients.reduce((total, client) => total + (client.views || 0), 0),
    },
  });
});

router.put("/api/v1/settings", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const body = await readJson<Record<string, unknown>>(context.request);
  const current = await context.store.getSettings();
  const next: PanelSettings = { ...current };

  if (body.title !== undefined) next.title = requireString(body.title, "title", 60);
  if (body.lang !== undefined) next.lang = normalizeLang(String(body.lang));
  if (body.dns !== undefined) next.dns = parseList(String(body.dns));
  if (body.mtu !== undefined) next.mtu = optionalNumber(body.mtu, "mtu", 576, 1500) ?? current.mtu;
  if (body.keepalive !== undefined) {
    next.keepalive = optionalNumber(body.keepalive, "keepalive", 0, 65535) ?? current.keepalive;
  }
  if (body.allowedIpsMode !== undefined) {
    const mode = String(body.allowedIpsMode);
    if (!["all", "exclude-lan", "custom"].includes(mode)) {
      throw new HttpError(400, "مقدار allowedIpsMode نامعتبر است.");
    }
    next.allowedIpsMode = mode as PanelSettings["allowedIpsMode"];
  }
  if (body.allowedIps !== undefined) next.allowedIps = parseList(String(body.allowedIps));
  if (body.endpointMode !== undefined) {
    const mode = String(body.endpointMode);
    if (!["auto", "random", "custom"].includes(mode)) {
      throw new HttpError(400, "مقدار endpointMode نامعتبر است.");
    }
    next.endpointMode = mode as PanelSettings["endpointMode"];
  }
  if (body.endpointHost !== undefined) next.endpointHost = String(body.endpointHost).trim() || undefined;
  if (body.endpointPort !== undefined) {
    next.endpointPort = optionalNumber(body.endpointPort, "endpointPort", 1, 65535) ?? 2408;
  }
  if (body.includeIPv6 !== undefined) next.includeIPv6 = Boolean(body.includeIPv6);
  if (body.defaultFormat !== undefined) {
    const format = String(body.defaultFormat);
    if (!isConfigFormat(format)) throw new HttpError(400, "قالب خروجی نامعتبر است.");
    next.defaultFormat = format;
  }
  if (body.identityPolicy !== undefined) {
    const policy = String(body.identityPolicy);
    if (!["pool", "shared"].includes(policy)) throw new HttpError(400, "سیاست هویت نامعتبر است.");
    next.identityPolicy = policy as PanelSettings["identityPolicy"];
  }
  if (body.namePrefix !== undefined) next.namePrefix = requireString(body.namePrefix, "namePrefix", 24);
  if (body.registrationLimitPerHour !== undefined) {
    next.registrationLimitPerHour =
      optionalNumber(body.registrationLimitPerHour, "registrationLimitPerHour", 1, 60) ?? 6;
  }

  await context.store.saveSettings(next);
  await context.store.addLog({ level: "info", message: "تنظیمات پنل به‌روزرسانی شد." });
  return json({ settings: next });
});

router.post("/api/v1/api-key", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const record = (await context.store.getAuth()) ?? (await createAuthRecord(generateApiKey(), context.env));
  record.apiKey = generateApiKey();
  await context.store.saveAuth(record);
  await context.store.addLog({ level: "warn", message: "کلید API بازتولید شد." });
  return json({ apiKey: record.apiKey });
});

router.post("/api/v1/logout", async (context) => {
  assertSameOrigin(context.request, context.url);
  // Invalidate every cookie issued for the previous epoch (covers stolen cookies).
  await bumpSessionEpoch(context.store);
  return json(
    { ok: true },
    { headers: { "set-cookie": serializeCookie(SESSION_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 }) } },
  );
});

router.delete("/api/v1/logs", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  await context.store.clearLogs();
  return json({ ok: true });
});

router.get("/api/v1/identities", async (context) => {
  await requireAuth(context);
  const identities = await context.store.listIdentities();
  return json({ identities: identities.map(identitySummary) });
});

router.post("/api/v1/identities", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const body = await readJson<{ name?: string; teamToken?: string; model?: string }>(context.request);
  const identity = await registerNewIdentity(context.env, context.store, {
    name: body.name,
    teamToken: body.teamToken,
    model: body.model,
  });
  return json({ identity: identitySummary(identity) }, { status: 201 });
});

router.post("/api/v1/identities/import", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const body = await readJson<{ content?: string; name?: string }>(context.request);
  const content = requireString(body.content, "content", 20000);
  const identity = await importIdentity(context.store, { content, name: body.name });
  return json({ identity: identitySummary(identity) }, { status: 201 });
});

router.patch("/api/v1/identities/:id", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const body = await readJson<{ name?: string }>(context.request);
  const identity = await context.store.getIdentity(context.params.id);
  if (!identity) throw new HttpError(404, "هویت پیدا نشد.");
  if (body.name !== undefined) identity.name = requireString(body.name, "name", 60);
  await context.store.saveIdentity(identity);
  return json({ identity: identitySummary(identity) });
});

router.delete("/api/v1/identities/:id", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const identity = await context.store.getIdentity(context.params.id);
  if (!identity) throw new HttpError(404, "هویت پیدا نشد.");
  const clients = await context.store.listClients();
  if (clients.some((client) => client.identityId === identity.id)) {
    throw new HttpError(409, "این هویت به یک یا چند کانفیگ متصل است. ابتدا آن‌ها را حذف یا کلیدشان را بازتولید کنید.");
  }
  await context.store.deleteIdentity(identity.id);
  await context.store.addLog({ level: "warn", message: `هویت حذف شد: ${identity.name}` });
  return json({ ok: true });
});

router.post("/api/v1/identities/:id/sync", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const identity = await context.store.getIdentity(context.params.id);
  if (!identity) throw new HttpError(404, "هویت پیدا نشد.");
  const updated = await syncIdentity(context.env, context.store, identity);
  return json({ identity: identitySummary(updated) });
});

router.post("/api/v1/identities/:id/license", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const body = await readJson<{ license?: string }>(context.request);
  const license = requireString(body.license, "license", 120);
  const identity = await context.store.getIdentity(context.params.id);
  if (!identity) throw new HttpError(404, "هویت پیدا نشد.");
  const updated = await bindLicense(context.env, context.store, identity, license);
  return json({ identity: identitySummary(updated) });
});

router.get("/api/v1/clients", async (context) => {
  await requireAuth(context);
  const clients = await context.store.listClients();
  return json({ clients: clients.map(publicClient) });
});

router.post("/api/v1/clients", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const body = await readJson<Record<string, unknown>>(context.request);
  const format = body.format === undefined ? undefined : String(body.format);
  if (format && !isConfigFormat(format)) throw new HttpError(400, "قالب خروجی نامعتبر است.");
  const result = await createClients(context.env, context.store, {
    name: typeof body.name === "string" ? body.name : undefined,
    count: optionalNumber(body.count, "count", 1, 25),
    identityId: typeof body.identityId === "string" && body.identityId ? body.identityId : undefined,
    format: format as ConfigFormat | undefined,
    options: typeof body.options === "object" && body.options ? (body.options as ClientRecord["options"]) : {},
  });
  return json({ clients: result.clients.map(publicClient) }, { status: 201 });
});

router.get("/api/v1/clients/:id/config", async (context) => {
  await requireAuth(context);
  const client = await context.store.getClient(context.params.id);
  if (!client) throw new HttpError(404, "کانفیگ پیدا نشد.");
  const identity = await context.store.getIdentity(client.identityId);
  if (!identity) throw new HttpError(409, "هویت این کانفیگ پیدا نشد.");
  const settings = await effectiveSettings(context.env, context.store);
  const requested = context.url.searchParams.get("format");
  const format = requested && isConfigFormat(requested) ? requested : client.format;
  return json({ format, content: renderForClient(settings, identity, client, format) });
});

router.post("/api/v1/clients/:id/rotate", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const client = await context.store.getClient(context.params.id);
  if (!client) throw new HttpError(404, "کانفیگ پیدا نشد.");
  const updated = await rotateClient(context.env, context.store, client);
  return json({ client: publicClient(updated) });
});

router.patch("/api/v1/clients/:id", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const body = await readJson<Record<string, unknown>>(context.request);
  const client = await context.store.getClient(context.params.id);
  if (!client) throw new HttpError(404, "کانفیگ پیدا نشد.");
  if (body.name !== undefined) client.name = requireString(body.name, "name", 60);
  if (body.enabled !== undefined) client.enabled = Boolean(body.enabled);
  if (body.note !== undefined) client.note = String(body.note).slice(0, 200);
  if (body.format !== undefined && isConfigFormat(String(body.format))) {
    client.format = String(body.format) as ConfigFormat;
  }
  if (body.options !== undefined && typeof body.options === "object") {
    client.options = { ...client.options, ...(body.options as ClientRecord["options"]) };
  }
  if (body.identityId !== undefined) {
    const identity = await context.store.getIdentity(String(body.identityId));
    if (!identity) throw new HttpError(404, "هویت پیدا نشد.");
    client.identityId = identity.id;
  }
  await context.store.saveClient(client);
  return json({ client: publicClient(client) });
});

router.delete("/api/v1/clients/:id", async (context) => {
  await requireAuth(context);
  assertSameOrigin(context.request, context.url);
  const client = await context.store.getClient(context.params.id);
  if (!client) throw new HttpError(404, "کانفیگ پیدا نشد.");
  await context.store.deleteClient(client.id);
  await context.store.addLog({ level: "warn", message: `کانفیگ حذف شد: ${client.name}` });
  return json({ ok: true });
});

/* -------------------------------------------------------------------------- */
/*                             public profile links                           */
/* -------------------------------------------------------------------------- */

router.get("/c/:token", async (context) => {
  const settingsEarly = await effectiveSettings(context.env, context.store);
  const client = await context.store.getClientByToken(context.params.token);
  if (client && !client.enabled) {
    return htmlResponse(
      renderMessagePage({
        panelTitle: settingsEarly.title,
        lang: panelLang(settingsEarly),
        heading: "403",
        message: "این لینک موقتاً غیرفعال شده است.",
      }),
      { status: 403 },
    );
  }
  if (!client) {
    return htmlResponse(
      renderMessagePage({
        panelTitle: settingsEarly.title,
        lang: panelLang(settingsEarly),
        heading: "404",
        message: "این لینک معتبر نیست یا حذف شده است.",
      }),
      { status: 404 },
    );
  }
  const settings = settingsEarly;
  const identity = await context.store.getIdentity(client.identityId);
  if (!identity) {
    return htmlResponse(
      renderMessagePage({
        panelTitle: settings.title,
        lang: panelLang(settings),
        heading: "410",
        message: "هویت این کانفیگ حذف شده است.",
      }),
      { status: 410 },
    );
  }
  const requested = context.url.searchParams.get("format");
  const formats: ConfigFormat[] = requested && isConfigFormat(requested) ? [requested] : ["wg"];
  const configs = formats.map((format) => ({
    format,
    content: renderForClient(settings, identity, client, format),
  }));

  let svg: string | null = null;
  let qrError: string | undefined;
  try {
    svg = qrSvg(configs[0].content, { ecLevel: "L", scale: 4, margin: 2, title: client.name });
  } catch (error) {
    qrError = "این کانفیگ برای کیو‌آر کد بزرگ‌تر از حد مجاز است؛ از دانلود فایل استفاده کنید.";
    void error;
  }

  // Count a view at most once per two minutes per client (keeps KV writes low).
  if (!client.lastViewedAt || Date.now() - client.lastViewedAt > 120_000) {
    client.views = (client.views || 0) + 1;
    client.lastViewedAt = Date.now();
    context.waitUntil(context.store.saveClient(client).catch(() => undefined));
  }

  return htmlResponse(
    renderSharePage({
      panelTitle: settings.title,
      lang: panelLang(settings),
      client,
      identity,
      configs,
      qrSvg: svg,
      qrError,
    }),
  );
});

router.get("/c/:token/raw", async (context) => {
  const client = await context.store.getClientByToken(context.params.token);
  if (!client) throw new HttpError(404, "لینک پیدا نشد.");
  if (!client.enabled) throw new HttpError(403, "این لینک موقتاً غیرفعال شده است.");
  const identity = await context.store.getIdentity(client.identityId);
  if (!identity) throw new HttpError(410, "هویت این کانفیگ حذف شده است.");
  const settings = await effectiveSettings(context.env, context.store);
  const requested = context.url.searchParams.get("format");
  const format = requested && isConfigFormat(requested) ? requested : client.format;
  const content = renderForClient(settings, identity, client, format);
  const extension = format === "wg" ? "conf" : format === "clash" ? "yaml" : "json";
  return downloadResponse(content, `${client.name}.${extension}`, "text/plain; charset=utf-8");
});

router.get("/qr/:token", async (context) => {
  const token = context.params.token.replace(/\.svg$/i, "");
  const client = await context.store.getClientByToken(token);
  if (!client) throw new HttpError(404, "لینک پیدا نشد.");
  if (!client.enabled) throw new HttpError(403, "این لینک موقتاً غیرفعال شده است.");
  const identity = await context.store.getIdentity(client.identityId);
  if (!identity) throw new HttpError(410, "هویت این کانفیگ حذف شده است.");
  const settings = await effectiveSettings(context.env, context.store);
  const requested = context.url.searchParams.get("format");
  const format = requested && isConfigFormat(requested) ? requested : client.format;
  const content = renderForClient(settings, identity, client, format);
  let svg: string;
  try {
    svg = qrSvg(content, { ecLevel: "L", scale: 4, margin: 2, title: client.name });
  } catch {
    svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80">` +
      `<text x="10" y="45" font-size="14">QR too large</text></svg>`;
  }
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" },
  });
});

router.get("/sub/:token", async (context) => {
  const client = await context.store.getClientByToken(context.params.token);
  if (!client) throw new HttpError(404, "لینک پیدا نشد.");
  if (!client.enabled) throw new HttpError(403, "این لینک موقتاً غیرفعال شده است.");
  const identity = await context.store.getIdentity(client.identityId);
  if (!identity) throw new HttpError(410, "هویت این کانفیگ حذف شده است.");
  const settings = await effectiveSettings(context.env, context.store);
  const content = renderForClient(settings, identity, client, "wg");
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(content)));
  return textResponse(encoded, { headers: { "cache-control": "no-store" } });
});

router.get("/healthz", async (context) => {
  return json({
    ok: true,
    worker: "nova-warp",
    kv: context.store.persistent,
    demo: isDemoMode(context.env),
    time: new Date().toISOString(),
  });
});

/* -------------------------------------------------------------------------- */
/*                                panel pages                                 */
/* -------------------------------------------------------------------------- */

function panelLang(settings: PanelSettings) {
  return normalizeLang(settings.lang);
}

function parseFormValue(body: string, key: string): string | null {
  const params = new URLSearchParams(body);
  return params.get(key);
}

router.get("/login", async (context) => {
  const settings = await effectiveSettings(context.env, context.store);
  const configured = await isPanelConfigured(context.env, context.store);
  if (!configured) return redirect("/setup");
  const cookies = parseCookies(context.request);
  const secret = await getSessionSecret(context.env, context.store);
  const epoch = await getSessionEpoch(context.store);
  if (secret && cookies[SESSION_COOKIE] && (await verifySessionToken(secret, cookies[SESSION_COOKIE], epoch))) {
    return redirect("/");
  }
  return htmlResponse(
    renderLoginPage({ panelTitle: settings.title, lang: await panelLang(settings) }),
  );
});

router.post("/login", async (context) => {
  const settings = await effectiveSettings(context.env, context.store);
  const lang = await panelLang(settings);
  const body = await context.request.text();
  const password = parseFormValue(body, "password") ?? "";
  const configured = await isPanelConfigured(context.env, context.store);
  if (!configured) return redirect("/setup");

  const throttle = await registerFailedLogin(context.store, context.ip);
  if (throttle.blocked) {
    return htmlResponse(
      renderLoginPage({
        panelTitle: settings.title,
        lang,
        error: `تلاش‌های ناموفق زیاد بود. ${Math.ceil(throttle.retryAfter / 60)} دقیقه دیگر تلاش کنید.`,
      }),
      { status: 429 },
    );
  }

  const check = await checkPassword(password, context.env, context.store);
  if (!check.ok) {
    return htmlResponse(
      renderLoginPage({ panelTitle: settings.title, lang, error: "رمز عبور اشتباه است." }),
      { status: 401 },
    );
  }

  await clearFailedLogins(context.store, context.ip);
  const secret = await getSessionSecret(context.env, context.store);
  const epoch = await getSessionEpoch(context.store);
  const token = await createSessionToken(secret ?? password, SESSION_TTL_SECONDS, epoch);
  await context.store.addLog({ level: "info", message: "ورود موفق به پنل.", details: context.ip });
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": serializeCookie(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SECONDS)),
      "cache-control": "no-store",
    },
  });
});

router.get("/setup", async (context) => {
  const settings = await effectiveSettings(context.env, context.store);
  if (context.env.PANEL_PASSWORD?.trim()) {
    return htmlResponse(
      renderMessagePage({
        panelTitle: settings.title,
        lang: panelLang(settings),
        heading: "تنظیمات از طریق متغیرها",
        message: "رمز پنل با متغیر PANEL_PASSWORD تعیین شده است؛ نیازی به راه‌اندازی اولیه نیست.",
      }),
    );
  }
  const configured = await isPanelConfigured(context.env, context.store);
  if (configured) return redirect("/login");
  return htmlResponse(renderSetupPage({ panelTitle: settings.title, lang: await panelLang(settings) }));
});

router.post("/setup", async (context) => {
  const settings = await effectiveSettings(context.env, context.store);
  const lang = await panelLang(settings);
  if (context.env.PANEL_PASSWORD?.trim() || (await isPanelConfigured(context.env, context.store))) {
    return redirect("/login");
  }
  const body = await context.request.text();
  const password = parseFormValue(body, "password") ?? "";
  const confirm = parseFormValue(body, "confirm") ?? "";
  if (password.length < 8) {
    return htmlResponse(
      renderSetupPage({ panelTitle: settings.title, lang, error: "رمز عبور باید حداقل ۸ کاراکتر باشد." }),
      { status: 400 },
    );
  }
  if (password !== confirm) {
    return htmlResponse(
      renderSetupPage({ panelTitle: settings.title, lang, error: "رمز عبور و تکرار آن یکسان نیستند." }),
      { status: 400 },
    );
  }
  const record = await createAuthRecord(password, context.env);
  record.apiKey = generateApiKey();
  await context.store.saveAuth(record);
  await context.store.patchSettings({ setupComplete: true });
  const token = await createSessionToken(record.sessionSecret);
  await context.store.addLog({ level: "success", message: "پنل راه‌اندازی شد." });
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": serializeCookie(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SECONDS)),
      "cache-control": "no-store",
    },
  });
});

router.get("/", async (context) => {
  const configured = await isPanelConfigured(context.env, context.store);
  if (!configured) return redirect("/setup");
  const cookies = parseCookies(context.request);
  const secret = await getSessionSecret(context.env, context.store);
  const token = cookies[SESSION_COOKIE];
  const valid = secret && token ? await verifySessionToken(secret, token) : null;
  if (!valid) return redirect("/login");

  const settingsForPage = await effectiveSettings(context.env, context.store);
  return htmlResponse(
    renderPanelPage({
      panelTitle: settingsForPage.title,
      lang: panelLang(settingsForPage),
      persistent: context.store.persistent,
      demo: isDemoMode(context.env),
    }),
  );
});

router.get("/robots.txt", () => textResponse("User-agent: *\nDisallow: /\n"));

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 64);
}

function publicClient(client: ClientRecord) {
  return {
    id: client.id,
    name: client.name,
    identityId: client.identityId,
    shareToken: client.shareToken,
    enabled: client.enabled,
    format: client.format,
    createdAt: client.createdAt,
    views: client.views || 0,
    note: client.note,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 entrypoint                                 */
/* -------------------------------------------------------------------------- */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // `ALLOW_FRAMING=1` lets the panel be embedded (local previews); production
    // keeps X-Frame-Options: DENY + frame-ancestors 'none'.
    configureFraming(env.ALLOW_FRAMING === "1" || env.ALLOW_FRAMING === "true");
    const url = new URL(request.url);
    const store = buildStore(env);
    const context: RequestContext = {
      request,
      url,
      env,
      store,
      ip: clientIp(request),
      params: {},
      waitUntil: (promise) => ctx.waitUntil(promise),
    };

    const matched = router.match(request.method, url.pathname);
    if (!matched) {
      if (url.pathname.startsWith("/api/")) {
        return json({ error: "not_found", message: "مسیر مورد نظر پیدا نشد." }, { status: 404 });
      }
      return htmlResponse(
        renderMessagePage({
          panelTitle: env.PANEL_TITLE ?? "Nova WARP",
          lang: normalizeLang(env.PANEL_LANG),
          heading: "404",
          message: "صفحه‌ی مورد نظر پیدا نشد.",
        }),
        { status: 404 },
      );
    }
    if ("methodNotAllowed" in matched) {
      return json({ error: "method_not_allowed", message: "متد مجاز نیست." }, { status: 405 });
    }

    try {
      const merged = { ...context, params: matched.params };
      assertSameOrigin(request, url);
      return await matched.handler(merged);
    } catch (error) {
      return handleError(error);
    }
  },
};
