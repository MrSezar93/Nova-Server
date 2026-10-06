/** Shared types for the Nova WARP Worker. */

import type { AllowedIpsMode, ConfigFormat, EndpointMode } from "./lib/wg";

export interface Env {
  /** KV namespace used to persist panel data (required in production). */
  WARP_KV?: KVNamespace;
  /** Panel password. Recommended: set with `wrangler secret put PANEL_PASSWORD`. */
  PANEL_PASSWORD?: string;
  /** Optional fixed secret used to sign session cookies. */
  SESSION_SECRET?: string;
  /** Optional fixed API key for automation. */
  API_KEY?: string;
  PANEL_TITLE?: string;
  PANEL_LANG?: string;
  /** Cloudflare Android client API version, e.g. v0a5641 */
  API_VERSION?: string;
  /** Override the WARP registration host (mostly for tests). */
  WARP_API_BASE?: string;
  /** Extra headers for the WARP API (JSON), mostly for tests. */
  WARP_API_HEADERS?: string;
  MAX_REGISTRATIONS_PER_HOUR?: string;
  PASSWORD_ITERATIONS?: string;
  /** "1" keeps the panel fully offline by generating fake identities (UI preview only). */
  DEMO_MODE?: string;
  /** "1" disables the raw-TLS registration fallback (tests, restricted environments). */
  DISABLE_RAW_TLS?: string;
  /** Optional default Zero Trust team token (JWT) applied to new registrations. */
  TEAM_TOKEN?: string;
  /**
   * "1" removes `X-Frame-Options`/`frame-ancestors` so the panel can be embedded
   * in an iframe (used by the local preview harness; leave unset in production).
   */
  ALLOW_FRAMING?: string;
}

export type IdentitySource = "api" | "import" | "demo" | "teams";

export interface WarpAccountInfo {
  accountType?: string;
  warpPlus?: boolean;
  license?: string;
  usage?: number;
  quota?: number;
  premiumData?: number;
  referralCount?: number;
  updatedAt?: number;
}

export interface Identity {
  id: string;
  name: string;
  source: IdentitySource;
  /** WARP device id (absent for imported WireGuard profiles). */
  deviceId?: string;
  /** Device name reported by Cloudflare (informational only). */
  deviceName?: string;
  /** WARP API bearer token (never exposed through the API). */
  token?: string;
  privateKey: string;
  publicKey: string;
  addressV4?: string;
  addressV6?: string;
  peerPublicKey: string;
  /** base64 of the 3 `reserved` bytes reported by Cloudflare. */
  clientId?: string;
  account?: WarpAccountInfo;
  createdAt: number;
  updatedAt: number;
  lastSyncAt?: number;
  lastError?: string;
  inferred?: boolean;
}

export interface ClientOptions {
  mtu?: number;
  dns?: string[];
  keepalive?: number;
  allowedIpsMode?: AllowedIpsMode;
  allowedIps?: string[];
  endpointMode?: EndpointMode;
  endpointHost?: string;
  endpointPort?: number;
  includeIPv6?: boolean;
}

export interface ClientRecord {
  id: string;
  name: string;
  identityId: string;
  shareToken: string;
  enabled: boolean;
  format: ConfigFormat;
  options: ClientOptions;
  createdAt: number;
  createdBy?: string;
  views: number;
  lastViewedAt?: number;
  note?: string;
}

export interface PanelSettings {
  title: string;
  lang: "fa" | "en";
  dns: string[];
  mtu: number;
  keepalive: number;
  allowedIpsMode: AllowedIpsMode;
  allowedIps: string[];
  endpointMode: EndpointMode;
  endpointHost?: string;
  endpointPort?: number;
  includeIPv6: boolean;
  defaultFormat: ConfigFormat;
  /** shared = every client uses the same WARP identity, pool = one identity per client. */
  identityPolicy: "shared" | "pool";
  sharedIdentityId?: string;
  namePrefix: string;
  registrationLimitPerHour: number;
  setupComplete: boolean;
}

export interface AuthRecord {
  salt: string;
  hash: string;
  iterations: number;
  sessionSecret: string;
  createdAt: number;
  apiKey?: string;
  /** Bumped on logout so already-issued cookies stop working. */
  sessionEpoch?: number;
}

export interface LogEntry {
  id: string;
  at: number;
  level: "info" | "warn" | "error" | "success";
  message: string;
  details?: string;
  actor?: string;
}

export interface RegistrationCounter {
  windowStart: number;
  count: number;
}

export const DEFAULT_SETTINGS: PanelSettings = {
  title: "Nova WARP",
  lang: "fa",
  dns: ["1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001"],
  mtu: 1280,
  keepalive: 25,
  allowedIpsMode: "all",
  allowedIps: [],
  endpointMode: "auto",
  endpointPort: 2408,
  includeIPv6: true,
  defaultFormat: "wg",
  identityPolicy: "pool",
  namePrefix: "nova",
  registrationLimitPerHour: 6,
  setupComplete: false,
};
