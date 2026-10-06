/**
 * Client for Cloudflare's (unofficial) WARP registration API.
 *
 * The endpoint shape follows the Android client, which is what `wgcf` and every
 * other community tool uses. Cloudflare fingerprints the TLS handshake, so on
 * top of plain `fetch()` we can retry over a raw TLS socket that mimics the
 * Android client's cipher list (see ./rawhttp.ts).
 */

import { base64ToBytes, bytesToBase64 } from "./b64";
import { rawTlsRequest } from "./rawhttp";
import { generateKeyPair, publicKeyFromPrivateKey, type WgKeyPair } from "./wg";

export const DEFAULT_API_BASE = "https://api.cloudflareclient.com";
export const DEFAULT_API_VERSION = "v0a5641";
export const DEFAULT_CLIENT_VERSION = "a-6.38.9-5641";
export const DEFAULT_USER_AGENT = "1.1.1.1/6.38.9-5641 (Android 16.0.0)";

export type WarpErrorKind =
  | "rate_limited"
  | "blocked"
  | "auth"
  | "not_found"
  | "bad_request"
  | "server"
  | "network"
  | "parse";

export class WarpApiError extends Error {
  readonly kind: WarpErrorKind;
  readonly status?: number;
  readonly detail?: string;

  constructor(kind: WarpErrorKind, message: string, status?: number, detail?: string) {
    super(message);
    this.name = "WarpApiError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }

  /** Suggested HTTP status for the panel API. */
  get httpStatus(): number {
    switch (this.kind) {
      case "rate_limited":
        return 429;
      case "blocked":
        return 502;
      case "auth":
        return 401;
      case "not_found":
        return 404;
      case "bad_request":
        return 400;
      default:
        return 502;
    }
  }
}

export interface WarpPeerEndpoint {
  host?: string;
  v4?: string;
  v6?: string;
  ports?: number[];
}

export interface WarpPeer {
  public_key: string;
  endpoint?: WarpPeerEndpoint;
}

export interface WarpConfig {
  client_id?: string;
  interface?: { addresses?: { v4?: string; v6?: string } };
  peers?: WarpPeer[];
  services?: { http_proxy?: string };
}

export interface WarpAccount {
  account_type?: string;
  warp_plus?: boolean;
  license?: string;
  usage?: number;
  quota?: number;
  premium_data?: number;
  referral_count?: number;
}

export interface WarpDevice {
  id: string;
  token?: string;
  name?: string;
  type?: string;
  model?: string;
  config?: WarpConfig;
  account?: WarpAccount;
  warp_enabled?: boolean;
  created?: string;
  updated?: string;
}

export interface NormalizedConfig {
  addressV4: string;
  addressV6?: string;
  peerPublicKey: string;
  endpointHost: string;
  endpointPort: number;
  clientId?: string;
}

export interface RegistrationResult {
  identity: {
    deviceId: string;
    token: string;
    privateKey: string;
    publicKey: string;
    addressV4: string;
    addressV6?: string;
    peerPublicKey: string;
    clientId?: string;
    endpointHost: string;
    endpointPort: number;
    account?: WarpAccount;
  };
  raw: WarpDevice;
}

export interface WarpClientOptions {
  baseUrl?: string;
  apiVersion?: string;
  userAgent?: string;
  clientVersion?: string;
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Disable the raw TLS fallback (used by tests). */
  allowRawTls?: boolean;
  timeoutMs?: number;
}

/** Remembers which transport worked last, per isolate. */
let preferredTransport: "fetch" | "raw-tls" | null = null;

export function resetTransportPreference(): void {
  preferredTransport = null;
}

export class WarpApi {
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly userAgent: string;
  private readonly clientVersion: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly allowRawTls: boolean;
  private readonly timeoutMs: number;

  constructor(options: WarpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.clientVersion = options.clientVersion ?? DEFAULT_CLIENT_VERSION;
    this.extraHeaders = options.extraHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.allowRawTls = options.allowRawTls ?? true;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private headers(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      "CF-Client-Version": this.clientVersion,
      Accept: "",
      ...this.extraHeaders,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; token?: string } = {},
  ): Promise<T> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = this.headers(options.token);
    if (body !== undefined) headers["Content-Type"] = "application/json; charset=UTF-8";

    const attemptFetch = async (): Promise<T | "retry-raw"> => {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw new WarpApiError(
          "network",
          "ارتباط با API کلادفلر برقرار نشد. اتصال شبکه‌ی Worker را بررسی کنید.",
          undefined,
          String(error),
        );
      }
      const text = await response.text();
      if (response.status === 403 || response.status === 429) {
        return "retry-raw";
      }
      return this.parseResponse<T>(response.status, text);
    };

    const attemptRawTls = async (): Promise<T> => {
      const url = new URL(this.baseUrl);
      const response = await rawTlsRequest({
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
        method,
        path,
        headers,
        body,
        timeoutMs: this.timeoutMs,
      });
      const text = new TextDecoder().decode(response.body);
      return this.parseResponse<T>(response.status, text);
    };

    if (preferredTransport === "raw-tls" && this.allowRawTls) {
      try {
        return await attemptRawTls();
      } catch (error) {
        preferredTransport = "fetch";
        if (!(error instanceof WarpApiError) || error.kind === "network") throw error;
        throw error;
      }
    }

    const result = await attemptFetch();
    if (result !== "retry-raw") {
      preferredTransport = "fetch";
      return result;
    }

    // Cloudflare rejected the plain client (or rate-limited it). Retry with a
    // handshake closer to the Android application.
    if (!this.allowRawTls) {
      throw new WarpApiError(
        "rate_limited",
        "کلادفلر درخواست را رد کرد (۴۲۹/۴۰۳). چند دقیقه بعد دوباره تلاش کنید یا از «ورود هویت دستی» استفاده کنید.",
        429,
      );
    }
    try {
      const viaTls = await attemptRawTls();
      preferredTransport = "raw-tls";
      return viaTls;
    } catch (error) {
      preferredTransport = "fetch";
      if (error instanceof WarpApiError) throw error;
      throw new WarpApiError(
        "blocked",
        "کلادفلر این Worker را برای ثبت‌نام مسدود کرده است (اثر انگشت TLS). از «ورود هویت دستی» استفاده کنید.",
        502,
        String(error),
      );
    }
  }

  private parseResponse<T>(status: number, text: string): T {
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (status >= 200 && status < 300) {
      if (parsed === undefined && text) {
        throw new WarpApiError("parse", "پاسخ API کلادفلر قابل خواندن نبود.", status, text.slice(0, 300));
      }
      return (parsed ?? {}) as T;
    }
    const detail = extractErrorDetail(parsed) ?? text.slice(0, 300);
    switch (status) {
      case 400:
        throw new WarpApiError("bad_request", "کلادفلر درخواست را نامعتبر دانست.", status, detail);
      case 401:
      case 403:
        throw new WarpApiError("auth", "توکن این هویت منقضی یا نامعتبر است.", status, detail);
      case 404:
        throw new WarpApiError("not_found", "این دستگاه در کلادفلر پیدا نشد.", status, detail);
      case 429:
        throw new WarpApiError(
          "rate_limited",
          "کلادفلر فعلاً ثبت‌نام‌های جدید را محدود کرده است. کمی بعد دوباره تلاش کنید.",
          status,
          detail,
        );
      default:
        throw new WarpApiError("server", `خطای API کلادفلر (HTTP ${status}).`, status, detail);
    }
  }

  /* --------------------------------- calls -------------------------------- */

  async register(
    publicKey: string,
    options: { model?: string; type?: string; teamToken?: string } = {},
  ): Promise<WarpDevice> {
    const body: Record<string, unknown> = {
      key: publicKey,
      install_id: "",
      fcm_token: "",
      tos: new Date().toISOString(),
      model: options.model ?? "PC",
      serial_number: "",
      locale: "en_US",
      os_version: "16.0.0",
      key_type: "curve25519",
      tunnel_type: "wireguard",
    };
    if (options.type) body.type = options.type;
    const teamToken = options.teamToken?.trim();
    if (teamToken) body.team_token = teamToken;

    const device = await this.request<WarpDevice>("POST", `/${this.apiVersion}/reg`, { body });
    if (!device?.id || !device.token) {
      throw new WarpApiError("parse", "پاسخ ثبت‌نام کلادفلر ناقص بود.");
    }
    return device;
  }

  async getDevice(deviceId: string, token: string): Promise<WarpDevice> {
    return this.request<WarpDevice>("GET", `/${this.apiVersion}/reg/${encodeURIComponent(deviceId)}`, {
      token,
    });
  }

  async updateDevice(deviceId: string, token: string, patch: Record<string, unknown>): Promise<WarpDevice> {
    return this.request<WarpDevice>("PATCH", `/${this.apiVersion}/reg/${encodeURIComponent(deviceId)}`, {
      token,
      body: patch,
    });
  }

  async getAccount(deviceId: string, token: string): Promise<WarpAccount> {
    return this.request<WarpAccount>(
      "GET",
      `/${this.apiVersion}/reg/${encodeURIComponent(deviceId)}/account`,
      { token },
    );
  }

  async bindLicense(deviceId: string, token: string, license: string): Promise<WarpAccount> {
    return this.request<WarpAccount>(
      "PUT",
      `/${this.apiVersion}/reg/${encodeURIComponent(deviceId)}/account`,
      { token, body: { license } },
    );
  }

  async listDevices(deviceId: string, token: string): Promise<WarpDevice[]> {
    return this.request<WarpDevice[]>(
      "GET",
      `/${this.apiVersion}/reg/${encodeURIComponent(deviceId)}/account/devices`,
      { token },
    );
  }

  async cancelDevice(deviceId: string, token: string): Promise<void> {
    await this.request<unknown>("DELETE", `/${this.apiVersion}/reg/${encodeURIComponent(deviceId)}`, {
      token,
    });
  }
}

function extractErrorDetail(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const errors = record.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors
      .map((entry) =>
        typeof entry === "object" && entry && "message" in entry
          ? String((entry as { message?: unknown }).message)
          : String(entry),
      )
      .join("; ");
  }
  if (typeof record.detail === "string") return record.detail;
  if (typeof record.error === "string") return record.error;
  return undefined;
}

/** Extracts the WireGuard-relevant bits out of a WARP device object. */
export function normalizeDeviceConfig(device: WarpDevice): NormalizedConfig {
  const config = device.config;
  const addresses = config?.interface?.addresses;
  const peer = config?.peers?.[0];
  if (!addresses?.v4 || !peer?.public_key) {
    throw new WarpApiError("parse", "کلادفلر آدرس یا کلید Peer را برنگرداند.");
  }
  const endpoint = peer.endpoint ?? {};
  const port = Array.isArray(endpoint.ports) && endpoint.ports.length ? endpoint.ports[0] : 2408;
  let host = endpoint.host?.trim();
  if (!host) host = (endpoint.v4 || endpoint.v6 || "").trim();
  if (!host) host = "engage.cloudflareclient.com";
  if (host.includes(":") && !host.startsWith("[")) {
    const parts = host.split(":");
    // IPv6 literal without brackets vs host:port
    if (parts.length === 2 && /^\d+$/.test(parts[1])) host = parts[0];
    else host = `[${host}]`;
  } else if (host.includes("]")) {
    const match = /^\[(.+)\](?::\d+)?$/.exec(host);
    if (match) host = `[${match[1]}]`;
  }
  const parsedHost =/^\[(.+)\]$/.exec(host)?.[1] ?? host;
  return {
    addressV4: String(addresses.v4).split("/")[0],
    addressV6: addresses.v6 ? String(addresses.v6).split("/")[0] : undefined,
    peerPublicKey: peer.public_key,
    endpointHost: parsedHost,
    endpointPort: port,
    clientId: config?.client_id,
  };
}

export function accountInfoFrom(account?: WarpAccount) {
  if (!account) return undefined;
  return {
    accountType: account.account_type,
    warpPlus: account.warp_plus,
    license: account.license,
    usage: account.usage,
    quota: account.quota,
    premiumData: account.premium_data,
    referralCount: account.referral_count,
    updatedAt: Date.now(),
  };
}

/** Full registration flow: generate keys, register, read back the config. */
export async function registerIdentity(
  api: WarpApi,
  options: { model?: string; type?: string; teamToken?: string } = {},
): Promise<RegistrationResult> {
  const keys: WgKeyPair = await generateKeyPair();
  const device = await api.register(keys.publicKey, options);

  let full: WarpDevice = device;
  if (!device.config?.peers?.length || !device.config.interface?.addresses?.v4) {
    full = await api.getDevice(device.id, device.token as string);
  }
  const normalized = normalizeDeviceConfig(full);

  // Best effort: give the device a readable name (does not affect the tunnel).
  if (options.model) {
    try {
      await api.updateDevice(device.id, device.token as string, { name: options.model });
    } catch {
      /* non fatal */
    }
  }

  return {
    identity: {
      deviceId: device.id,
      token: device.token as string,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      addressV4: normalized.addressV4,
      addressV6: normalized.addressV6,
      peerPublicKey: normalized.peerPublicKey,
      clientId: normalized.clientId,
      endpointHost: normalized.endpointHost,
      endpointPort: normalized.endpointPort,
      account: device.account ?? full.account,
    },
    raw: full,
  };
}

/** Rebuilds an identity from an imported WireGuard private key + known peer data. */
export async function identityFromPrivateKey(
  privateKey: string,
  overrides: Partial<{
    addressV4: string;
    addressV6: string;
    peerPublicKey: string;
    clientId: string;
    deviceId: string;
    token: string;
  }> = {},
) {
  for (const value of [privateKey, overrides.peerPublicKey ?? ""].filter(Boolean)) {
    try {
      if (base64ToBytes(value).length !== 32) throw new Error("bad key length");
    } catch {
      throw new WarpApiError("bad_request", "کلید WireGuard وارد‌شده معتبر نیست (باید ۳۲ بایت base64 باشد).");
    }
  }
  const publicKey = await publicKeyFromPrivateKey(privateKey);
  return {
    publicKey,
    privateKey,
    addressV4: overrides.addressV4 ?? "172.16.0.2",
    addressV6: overrides.addressV6,
    peerPublicKey: overrides.peerPublicKey ?? "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
    clientId: overrides.clientId,
    deviceId: overrides.deviceId,
    token: overrides.token,
  };
}

export function clientIdToBase64(bytes: number[]): string {
  return bytesToBase64(new Uint8Array(bytes));
}
