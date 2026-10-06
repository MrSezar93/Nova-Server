/**
 * Domain logic: creating/syncing WARP identities and turning them into
 * WireGuard profiles for the panel clients.
 */

import { randomId } from "./b64";
import { applyWarpDefaults, detectAndParse, ImportError, type ImportedIdentity } from "./importer";
import { Store } from "./store";
import {
  DEFAULT_API_VERSION,
  accountInfoFrom,
  identityFromPrivateKey,
  normalizeDeviceConfig,
  registerIdentity,
  WarpApi,
  WarpApiError,
} from "./warp";
import { AWG_WARP_SAFE, normalizeAwg, type AwgOptions } from "./awg";
import {
  clientIdFromReserved,
  defaultAllowedIps,
  defaultDns,
  renderConfig,
  reservedFromClientId,
  resolveEndpoint,
  type ConfigFormat,
  type WgProfile,
} from "./wg";
import {
  clashProxyList,
  newUuid,
  normalizeProxyPath,
  proxyMeta,
  singboxConfig as proxySingboxConfig,
  vlessLink,
  xrayConfig as proxyXrayConfig,
  type ProxyEndpoint,
} from "./proxy";
import type { ClientKind, ClientRecord, Env, Identity, PanelSettings } from "../types";

export function warpApiFor(env: Env, fetchImpl?: typeof fetch): WarpApi {
  return new WarpApi({
    baseUrl: env.WARP_API_BASE || undefined,
    apiVersion: env.API_VERSION || DEFAULT_API_VERSION,
    extraHeaders: parseExtraHeaders(env.WARP_API_HEADERS),
    fetchImpl,
    // The raw TLS fallback can be disabled for tests / local tooling.
    allowRawTls: env.WARP_API_BASE ? env.DISABLE_RAW_TLS !== "1" : true,
  });
}

function parseExtraHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function isDemoMode(env: Env): boolean {
  return env.DEMO_MODE === "1" || env.DEMO_MODE === "true";
}

export function identityName(prefix: string): string {
  return `${prefix}-${randomId(3)}`;
}

export interface RegisterOptions {
  name?: string;
  teamToken?: string;
  model?: string;
  actor?: string;
  skipQuota?: boolean;
}

/** Registers a brand new WARP device and stores it as an identity. */
export async function registerNewIdentity(
  env: Env,
  store: Store,
  options: RegisterOptions = {},
  fetchImpl?: typeof fetch,
): Promise<Identity> {
  const settings = await store.getSettings();
  const limit = Number(env.MAX_REGISTRATIONS_PER_HOUR) || settings.registrationLimitPerHour || 6;

  if (!options.skipQuota) {
    const quota = await store.consumeRegistrationQuota(limit);
    if (!quota.allowed) {
      throw new WarpApiError(
        "rate_limited",
        `سهمیه‌ی ساخت هویت (${limit} در ساعت) پر شده است. ${Math.ceil(quota.retryAfter / 60)} دقیقه دیگر تلاش کنید.`,
        429,
      );
    }
  }

  if (isDemoMode(env)) {
    return createDemoIdentity(store, options.name ?? identityName(settings.namePrefix));
  }

  const api = warpApiFor(env, fetchImpl);
  const result = await registerIdentity(api, {
    model: options.model ?? "PC",
    type: "Android",
    teamToken: options.teamToken ?? env.TEAM_TOKEN,
  });
  const identity: Identity = {
    id: randomId(9),
    name: options.name?.trim() || identityName(settings.namePrefix),
    source: options.teamToken || env.TEAM_TOKEN ? "teams" : "api",
    deviceId: result.identity.deviceId,
    token: result.identity.token,
    privateKey: result.identity.privateKey,
    publicKey: result.identity.publicKey,
    addressV4: result.identity.addressV4,
    addressV6: result.identity.addressV6,
    peerPublicKey: result.identity.peerPublicKey,
    clientId: result.identity.clientId,
    account: accountInfoFrom(result.identity.account),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSyncAt: Date.now(),
  };
  await store.saveIdentity(identity);
  await store.addLog({
    level: "success",
    message: `هویت جدید ساخته شد: ${identity.name}`,
    details: `device=${identity.deviceId ?? "-"} address=${identity.addressV4 ?? "-"}`,
    actor: options.actor,
  });
  return identity;
}

/** Creates a fully synthetic identity for UI previews (DEMO_MODE). */
export async function createDemoIdentity(store: Store, name: string): Promise<Identity> {
  const keys = await generateDemoKeys();
  const randomHex = (length: number) =>
    Array.from({ length }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  const reserved = [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)];
  const identity: Identity = {
    id: randomId(9),
    name,
    source: "demo",
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    addressV4: `172.16.0.${2 + Math.floor(Math.random() * 200)}`,
    addressV6: `2606:4700:110:8${randomHex(3)}::1`,
    peerPublicKey: "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
    clientId: clientIdFromReserved(reserved),
    account: { accountType: "free", warpPlus: false, quota: 0, usage: 0, premiumData: 0, updatedAt: Date.now() },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSyncAt: Date.now(),
  };
  await store.saveIdentity(identity);
  await store.addLog({
    level: "warn",
    message: `هویت آزمایشی (DEMO) ساخته شد: ${identity.name}`,
    details: "DEMO_MODE فعال است؛ این هویت واقعی نیست.",
  });
  return identity;
}

async function generateDemoKeys() {
  const { generateKeyPair } = await import("./wg");
  return generateKeyPair();
}

/** Imports an existing WARP credential blob (conf / toml / json / raw key). */
export async function importIdentity(
  store: Store,
  input: { content: string; name?: string; actor?: string },
): Promise<Identity> {
  let parsed: ImportedIdentity;
  try {
    parsed = applyWarpDefaults(detectAndParse(input.content));
  } catch (error) {
    if (error instanceof ImportError) throw new WarpApiError("bad_request", error.message, 400);
    throw error;
  }
  const settings = await store.getSettings();
  const derived = await identityFromPrivateKey(parsed.privateKey, {
    addressV4: parsed.addressV4,
    addressV6: parsed.addressV6,
    peerPublicKey: parsed.peerPublicKey,
    // `reserved` in a .conf / JSON export is the same 3 bytes as `client_id`.
    clientId: parsed.clientId ?? clientIdFromReserved(parsed.reserved),
    deviceId: parsed.deviceId,
    token: parsed.token,
  });

  const identity: Identity = {
    id: randomId(9),
    name: input.name?.trim() || parsed.name || identityName(settings.namePrefix),
    source: "import",
    deviceId: derived.deviceId,
    token: derived.token,
    privateKey: derived.privateKey,
    publicKey: derived.publicKey,
    addressV4: derived.addressV4,
    addressV6: derived.addressV6,
    peerPublicKey: derived.peerPublicKey,
    clientId: derived.clientId,
    account: parsed.license ? { license: parsed.license, updatedAt: Date.now() } : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    inferred: !parsed.addressV4 || !parsed.clientId,
  };
  await store.saveIdentity(identity);
  await store.addLog({
    level: "success",
    message: `هویت وارد شد: ${identity.name}`,
    details: `قالب ورودی: ${parsed.sourceFormat}${identity.inferred ? " (مقادیر پیش‌فرض حدس زده شد)" : ""}`,
    actor: input.actor,
  });
  return identity;
}

/** Refreshes device config + account quota from Cloudflare. */
export async function syncIdentity(env: Env, store: Store, identity: Identity, fetchImpl?: typeof fetch): Promise<Identity> {
  if (identity.source === "demo" || !identity.deviceId || !identity.token) {
    identity.lastError = "این هویت به API کلادفلر وصل نیست (ورود دستی یا حالت آزمایشی).";
    return identity;
  }
  const api = warpApiFor(env, fetchImpl);
  try {
    const device = await api.getDevice(identity.deviceId, identity.token);
    const normalized = normalizeDeviceConfig(device);
    identity.addressV4 = normalized.addressV4;
    identity.addressV6 = normalized.addressV6;
    identity.peerPublicKey = normalized.peerPublicKey;
    identity.clientId = normalized.clientId ?? identity.clientId;
    identity.deviceName = device.name;
    try {
      const account = await api.getAccount(identity.deviceId, identity.token);
      identity.account = accountInfoFrom(account);
    } catch {
      /* account info is optional */
    }
    identity.lastSyncAt = Date.now();
    identity.lastError = undefined;
  } catch (error) {
    const message = error instanceof WarpApiError ? error.message : String(error);
    identity.lastError = message;
    await store.saveIdentity(identity);
    throw error;
  }
  await store.saveIdentity(identity);
  return identity;
}

export async function bindLicense(
  env: Env,
  store: Store,
  identity: Identity,
  license: string,
  fetchImpl?: typeof fetch,
): Promise<Identity> {
  if (!identity.deviceId || !identity.token) {
    throw new WarpApiError(
      "bad_request",
      "برای ثبت لایسنس WARP+ باید هویت با API کلادفلر ساخته شده باشد (نه ورود دستی).",
      400,
    );
  }
  const api = warpApiFor(env, fetchImpl);
  const account = await api.bindLicense(identity.deviceId, identity.token, license.trim());
  identity.account = { ...accountInfoFrom(account), license: license.trim() };
  await store.saveIdentity(identity);
  await store.addLog({
    level: "success",
    message: `لایسنس WARP+ روی هویت «${identity.name}» ثبت شد.`,
  });
  return identity;
}

/** Builds the WireGuard profile for a client, honouring client > panel defaults. */
export function buildProfile(settings: PanelSettings, identity: Identity, client: ClientRecord): WgProfile {
  const options = client.options ?? {};
  const awg = normalizeAwg(options.awg ?? settings.awg ?? AWG_WARP_SAFE, AWG_WARP_SAFE);
  const endpoint = resolveEndpoint({
    mode: options.endpointMode ?? settings.endpointMode,
    host: options.endpointHost ?? settings.endpointHost,
    port: options.endpointPort ?? settings.endpointPort,
  });
  const allowedIpsMode = options.allowedIpsMode ?? settings.allowedIpsMode;
  const allowedIps = defaultAllowedIps(allowedIpsMode, options.allowedIps ?? settings.allowedIps);
  return {
    awg,
    privateKey: identity.privateKey,
    addressV4: identity.addressV4 ?? "172.16.0.2",
    addressV6: identity.addressV6,
    peerPublicKey: identity.peerPublicKey,
    endpoint,
    dns: options.dns ?? settings.dns ?? defaultDns(),
    mtu: options.mtu ?? settings.mtu ?? 1280,
    keepalive: options.keepalive ?? settings.keepalive ?? 25,
    allowedIps,
    reserved: reservedFromClientId(identity.clientId),
    label: `client: ${client.name} • identity: ${identity.name}`,
    includeIPv6: options.includeIPv6 ?? settings.includeIPv6,
  };
}

export function renderForClient(
  settings: PanelSettings,
  identity: Identity | null,
  client: ClientRecord,
  format: ConfigFormat = client.format,
  host?: string,
): string {
  if (client.kind === "proxy") {
    const endpoint = buildProxyEndpoint(settings, client, host);
    const proxies = [endpoint];
    if (format === "clash") return clashProxyList(proxies);
    if (format === "singbox") return proxySingboxConfig(proxies);
    if (format === "xray") return proxyXrayConfig(proxies);
    if (format === "json") return JSON.stringify(proxyMeta(endpoint), null, 2) + "\n";
    // WireGuard formats are meaningless for a VLESS proxy: hand back the link.
    return vlessLink(endpoint);
  }
  if (!identity) throw new WarpApiError("not_found", "هویت این کانفیگ پیدا نشد.", 404);
  return renderConfig(format, buildProfile(settings, identity, client), client.name || "warp");
}

/** Public endpoint advertised for a proxy client (VLESS over WebSocket + TLS). */
export function buildProxyEndpoint(
  settings: PanelSettings,
  client: ClientRecord,
  host?: string,
): ProxyEndpoint {
  const fallbackHost = (host ?? "example.workers.dev").replace(/^https?:\/\//, "").split("/")[0];
  const cleanHost = (settings.proxyDomain?.trim() || fallbackHost).replace(/:\d+$/, "");
  return {
    uuid: client.uuid ?? "",
    host: cleanHost,
    port: Number(settings.proxyPort) || 443,
    path: normalizeProxyPath(settings.proxyPath),
    name: client.name || "nova-proxy",
    padding: Boolean(settings.proxyPadding),
  };
}

export interface CreateClientInput {
  name?: string;
  count?: number;
  identityId?: string;
  format?: ConfigFormat;
  options?: ClientRecord["options"];
  actor?: string;
  /** `warp` (default) or `proxy` (VLESS over WebSocket served by this Worker). */
  kind?: ClientKind;
  /** Enable AmneziaWG obfuscation on newly created WARP profiles. */
  awg?: AwgOptions;
}

export interface CreateClientResult {
  clients: ClientRecord[];
  identity: Identity;
}

/**
 * Creates one or more clients. In `pool` mode every client gets its own WARP
 * identity (recommended: sharing one identity across devices makes the WARP
 * edge flip the return path between devices), in `shared` mode all clients
 * reuse a single identity.
 */
export async function createClients(
  env: Env,
  store: Store,
  input: CreateClientInput,
  fetchImpl?: typeof fetch,
): Promise<CreateClientResult> {
  const settings = await store.getSettings();
  const count = Math.min(Math.max(input.count ?? 1, 1), 25);
  const baseName = input.name?.trim();
  const kind: ClientKind = input.kind === "proxy" ? "proxy" : "warp";
  const format = input.format ?? (kind === "proxy" ? "json" : settings.defaultFormat);
  const identities = await store.listIdentities();
  const created: ClientRecord[] = [];
  let identity: Identity | null = null;

  if (kind === "proxy") {
    for (let index = 0; index < count; index++) {
      const client: ClientRecord = {
        id: randomId(9),
        name: count > 1 ? `${baseName || "proxy"}-${index + 1}` : baseName || `proxy-${randomId(3)}`,
        kind: "proxy",
        identityId: "",
        uuid: newUuid(),
        shareToken: randomId(18),
        enabled: true,
        format: "json",
        options: {},
        createdAt: Date.now(),
        createdBy: input.actor,
        views: 0,
      };
      await store.saveClient(client);
      created.push(client);
    }
    await store.addLog({
      level: "success",
      message: `${created.length} پروکسی ساخته شد`,
      details: created.map((client) => client.name).join(", "),
      actor: input.actor,
    });
    // The caller only needs the identity for WARP clients.
    return { clients: created, identity: null as unknown as Identity };
  }

  if (input.identityId) {
    identity = identities.find((item) => item.id === input.identityId) ?? null;
    if (!identity) throw new WarpApiError("not_found", "هویت انتخاب‌شده پیدا نشد.", 404);
  } else if (settings.identityPolicy === "shared") {
    const sharedId = settings.sharedIdentityId;
    identity = identities.find((item) => item.id === sharedId) ?? identities[0] ?? null;
    if (!identity) {
      identity = await registerNewIdentity(env, store, { actor: input.actor }, fetchImpl);
      await store.patchSettings({ sharedIdentityId: identity.id });
    }
  }

  for (let index = 0; index < count; index++) {
    if (!identity) {
      identity = await registerNewIdentity(
        env,
        store,
        { name: baseName, actor: input.actor },
        fetchImpl,
      );
    }
    const client: ClientRecord = {
      id: randomId(9),
      name: count > 1 ? `${baseName || "client"}-${index + 1}` : baseName || identityName(settings.namePrefix),
      kind: "warp",
      identityId: identity.id,
      shareToken: randomId(18),
      enabled: true,
      format,
      options: {
        ...(input.options ?? {}),
        ...(input.awg ? { awg: normalizeAwg(input.awg) } : {}),
      },
      createdAt: Date.now(),
      createdBy: input.actor,
      views: 0,
    };
    await store.saveClient(client);
    created.push(client);
    if (settings.identityPolicy === "pool" && !input.identityId) identity = null; // next client gets a fresh identity
  }

  await store.addLog({
    level: "success",
    message: `${created.length} کانفیگ ساخته شد`,
    details: created.map((client) => client.name).join(", "),
    actor: input.actor,
  });
  return { clients: created, identity: identity as Identity };
}

/** Replaces the keys behind a client with a freshly registered identity. */
export async function rotateClient(
  env: Env,
  store: Store,
  client: ClientRecord,
  fetchImpl?: typeof fetch,
): Promise<ClientRecord> {
  if (client.kind === "proxy") {
    client.uuid = newUuid();
    await store.saveClient(client);
    await store.addLog({ level: "info", message: `شناسه‌ی پروکسی «${client.name}» بازتولید شد.` });
    return client;
  }
  const settings = await store.getSettings();
  const previousIdentityId = client.identityId;
  const identity = await registerNewIdentity(env, store, { name: client.name }, fetchImpl);
  client.identityId = identity.id;
  // keep the shared pointer consistent if this client used to own it
  if (settings.sharedIdentityId === previousIdentityId) {
    await store.patchSettings({ sharedIdentityId: identity.id });
  }
  await store.saveClient(client);
  await store.addLog({ level: "info", message: `کلید کانفیگ «${client.name}» بازتولید شد.` });
  return client;
}

/** Shape of a proxy client returned by the panel API. */
export function proxySummary(settings: PanelSettings, client: ClientRecord, host?: string) {
  const endpoint = buildProxyEndpoint(settings, client, host);
  const awg = normalizeAwg(client.options?.awg ?? settings.awg ?? AWG_WARP_SAFE, AWG_WARP_SAFE);
  return {
    ...proxyMeta(endpoint),
    awg: awg.enabled ? awg : undefined,
  };
}

export function identitySummary(identity: Identity) {
  return {
    id: identity.id,
    name: identity.name,
    source: identity.source,
    deviceId: identity.deviceId,
    addressV4: identity.addressV4,
    addressV6: identity.addressV6,
    clientId: identity.clientId,
    account: identity.account,
    createdAt: identity.createdAt,
    lastSyncAt: identity.lastSyncAt,
    lastError: identity.lastError,
    inferred: identity.inferred,
    linked: Boolean(identity.deviceId && identity.token),
  };
}
