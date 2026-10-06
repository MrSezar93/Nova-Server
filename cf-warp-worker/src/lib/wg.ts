/**
 * WireGuard / Cloudflare WARP primitives:
 *  - X25519 key generation & public key derivation (WebCrypto)
 *  - `reserved` (client_id) decoding used by WARP peers
 *  - config rendering for WireGuard, sing-box, Clash, Xray and raw JSON
 */

import { base64ToBytes, bytesToBase64, pickRandom } from "./b64";

const PKCS8_X25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

export interface WgKeyPair {
  privateKey: string;
  publicKey: string;
}

/** WireGuard clamps Curve25519 scalars; `wg genkey` output is always clamped. */
export function clampPrivateKey(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw);
  out[0] &= 248;
  out[31] = (out[31] & 127) | 64;
  return out;
}

export async function publicKeyFromPrivateKey(privateKeyBase64: string): Promise<string> {
  const raw = base64ToBytes(privateKeyBase64);
  if (raw.length !== 32) throw new Error("WireGuard private key must be 32 bytes");
  const der = new Uint8Array(PKCS8_X25519_PREFIX.length + 32);
  der.set(PKCS8_X25519_PREFIX, 0);
  der.set(raw, PKCS8_X25519_PREFIX.length);
  // NOTE: the key must be extractable so the public part can be exported; it is
  // an ephemeral, in-memory object that never leaves this isolate.
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der as unknown as ArrayBuffer,
    { name: "X25519" },
    true,
    ["deriveBits"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  if (!jwk.x) throw new Error("Could not derive X25519 public key");
  const x = jwk.x.replace(/-/g, "+").replace(/_/g, "/");
  return x + "=".repeat((4 - (x.length % 4)) % 4);
}

export async function generateKeyPair(): Promise<WgKeyPair> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const privateKey = bytesToBase64(clampPrivateKey(raw));
  const publicKey = await publicKeyFromPrivateKey(privateKey);
  return { privateKey, publicKey };
}

export function isValidWgKey(value: string): boolean {
  try {
    return base64ToBytes(value.trim()).length === 32;
  } catch {
    return false;
  }
}

/**
 * Cloudflare returns `config.client_id` (base64 of 3 bytes). User-space WireGuard
 * implementations (sing-box, Xray, Clash, warp-plus, …) must advertise those three
 * bytes as `reserved` so the WARP edge can map the session to the device.
 */
export function reservedFromClientId(clientId?: string | null): number[] | undefined {
  if (!clientId) return undefined;
  try {
    const bytes = base64ToBytes(clientId.trim());
    if (bytes.length < 3) return undefined;
    return [bytes[0], bytes[1], bytes[2]];
  } catch {
    return undefined;
  }
}

export function clientIdFromReserved(reserved?: number[] | null): string | undefined {
  if (!reserved || reserved.length < 3) return undefined;
  return bytesToBase64(new Uint8Array([reserved[0], reserved[1], reserved[2]]));
}

/* -------------------------------------------------------------------------- */
/*                              endpoint selection                            */
/* -------------------------------------------------------------------------- */

export const WARP_ENDPOINT_HOST = "engage.cloudflareclient.com";

/** Anycast prefixes announced for the WARP WireGuard service. */
export const WARP_ENDPOINT_POOL: readonly string[] = [
  "162.159.192.1",
  "162.159.193.1",
  "162.159.193.10",
  "162.159.195.1",
  "188.114.96.1",
  "188.114.97.1",
  "188.114.98.1",
  "188.114.99.1",
  "2606:4700:d0::a29f:c001",
  "2606:4700:d1::a29f:c001",
];

export const WARP_ENDPOINT_PORTS: readonly number[] = [
  500, 854, 859, 864, 878, 880, 890, 891, 894, 903, 908, 928, 934, 939, 942, 943, 945, 946, 955, 968,
  987, 988, 1002, 1018, 1070, 1387, 1701, 1843, 2371, 2408, 2506, 3138, 3476, 3581, 3854, 4177, 4198,
  4233, 4500, 5279, 5956, 7103, 7152, 7156, 7281, 7559, 8319, 8742, 8854, 8886,
];

export type EndpointMode = "auto" | "random" | "custom";

export interface EndpointPreference {
  mode: EndpointMode;
  host?: string;
  port?: number;
}

export interface WgEndpoint {
  host: string;
  port: number;
}

export function formatEndpoint(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function resolveEndpoint(pref: EndpointPreference): WgEndpoint {
  if (pref.mode === "custom" && pref.host) {
    return { host: pref.host.trim(), port: Number(pref.port) || 2408 };
  }
  if (pref.mode === "random") {
    return { host: pickRandom(WARP_ENDPOINT_POOL), port: pickRandom(WARP_ENDPOINT_PORTS) };
  }
  return { host: WARP_ENDPOINT_HOST, port: pref.port ? Number(pref.port) : 2408 };
}

/* -------------------------------------------------------------------------- */
/*                              config rendering                              */
/* -------------------------------------------------------------------------- */

export interface WgProfile {
  privateKey: string;
  addressV4: string;
  addressV6?: string;
  peerPublicKey: string;
  endpoint: WgEndpoint;
  dns: string[];
  mtu: number;
  /** 0 disables PersistentKeepalive */
  keepalive: number;
  allowedIps: string[];
  reserved?: number[];
  /** Optional friendly hint rendered as a comment in the .conf file */
  label?: string;
  includeIPv6?: boolean;
}

export type ConfigFormat = "wg" | "singbox" | "clash" | "xray" | "json";

export const CONFIG_FORMATS: readonly ConfigFormat[] = ["wg", "singbox", "clash", "xray", "json"];

export const FORMAT_LABELS: Record<ConfigFormat, string> = {
  wg: "WireGuard (.conf)",
  singbox: "sing-box (JSON)",
  clash: "Clash.Meta (YAML)",
  xray: "Xray / v2ray (JSON)",
  json: "JSON (خام)",
};

export function isConfigFormat(value: string): value is ConfigFormat {
  return (CONFIG_FORMATS as readonly string[]).includes(value);
}

function cleanAddress(value: string): string {
  return value.split("/")[0].trim();
}

export function wireGuardConf(profile: WgProfile): string {
  const lines: string[] = [];
  lines.push("# Nova WARP — Cloudflare WireGuard profile");
  if (profile.label) lines.push(`# ${profile.label}`);
  lines.push("[Interface]");
  lines.push(`PrivateKey = ${profile.privateKey}`);
  const v4 = `${cleanAddress(profile.addressV4)}/32`;
  const v6raw = profile.addressV6 ? cleanAddress(profile.addressV6) : "";
  const useV6 = Boolean(v6raw) && profile.includeIPv6 !== false;
  lines.push(`Address = ${useV6 ? `${v4}, ${v6raw}/128` : v4}`);
  if (profile.dns.length) {
    const dns = useV6 ? profile.dns : profile.dns.filter((entry) => !entry.includes(":"));
    if (dns.length) lines.push(`DNS = ${dns.join(", ")}`);
  }
  lines.push(`MTU = ${profile.mtu}`);
  lines.push("");
  lines.push("[Peer]");
  lines.push(`PublicKey = ${profile.peerPublicKey}`);
  lines.push(`AllowedIPs = ${profile.allowedIps.join(", ")}`);
  lines.push(`Endpoint = ${formatEndpoint(profile.endpoint.host, profile.endpoint.port)}`);
  if (profile.keepalive > 0) lines.push(`PersistentKeepalive = ${profile.keepalive}`);
  lines.push("");
  return lines.join("\n");
}

export function singBoxConfig(profile: WgProfile, tag = "warp"): string {
  const obj = {
    type: "wireguard",
    tag,
    server: profile.endpoint.host,
    server_port: profile.endpoint.port,
    local_address: [
      `${cleanAddress(profile.addressV4)}/32`,
      ...(profile.addressV6 ? [`${cleanAddress(profile.addressV6)}/128`] : []),
    ],
    private_key: profile.privateKey,
    peer_public_key: profile.peerPublicKey,
    mtu: profile.mtu,
    ...(profile.reserved ? { reserved: profile.reserved } : {}),
    ...(profile.keepalive > 0 ? { persistent_keepalive_interval: profile.keepalive } : {}),
  };
  return JSON.stringify({ outbounds: [obj] }, null, 2) + "\n";
}

export function clashConfig(profile: WgProfile, name = "warp"): string {
  const lines = [
    "proxies:",
    `  - name: "${name}"`,
    "    type: wireguard",
    `    server: ${profile.endpoint.host}`,
    `    port: ${profile.endpoint.port}`,
    `    ip: ${cleanAddress(profile.addressV4)}`,
    ...(profile.addressV6 ? [`    ipv6: ${cleanAddress(profile.addressV6)}`] : []),
    `    private-key: ${profile.privateKey}`,
    `    public-key: ${profile.peerPublicKey}`,
    `    allowed-ips: [${profile.allowedIps.map((v) => `'${v}'`).join(", ")}]`,
    `    reserved: [${(profile.reserved ?? [0, 0, 0]).join(", ")}]`,
    `    mtu: ${profile.mtu}`,
    "    udp: true",
    `    dns: [${profile.dns.map((v) => `'${v}'`).join(", ")}]`,
  ];
  return lines.join("\n") + "\n";
}

export function xrayConfig(profile: WgProfile, tag = "warp"): string {
  const obj = {
    tag,
    protocol: "wireguard",
    settings: {
      secretKey: profile.privateKey,
      address: [
        `${cleanAddress(profile.addressV4)}/32`,
        ...(profile.addressV6 ? [`${cleanAddress(profile.addressV6)}/128`] : []),
      ],
      peers: [
        {
          publicKey: profile.peerPublicKey,
          allowedIPs: profile.allowedIps,
          endpoint: formatEndpoint(profile.endpoint.host, profile.endpoint.port),
        },
      ],
      reserved: profile.reserved ?? [0, 0, 0],
      mtu: profile.mtu,
    },
  };
  return JSON.stringify(obj, null, 2) + "\n";
}

export function jsonMeta(profile: WgProfile): string {
  return (
    JSON.stringify(
      {
        type: "wireguard",
        privateKey: profile.privateKey,
        addresses: [
          `${cleanAddress(profile.addressV4)}/32`,
          ...(profile.addressV6 ? [`${cleanAddress(profile.addressV6)}/128`] : []),
        ],
        peerPublicKey: profile.peerPublicKey,
        endpoint: formatEndpoint(profile.endpoint.host, profile.endpoint.port),
        reserved: profile.reserved ?? [0, 0, 0],
        mtu: profile.mtu,
        dns: profile.dns,
        allowedIps: profile.allowedIps,
        keepalive: profile.keepalive,
      },
      null,
      2,
    ) + "\n"
  );
}

export function renderConfig(format: ConfigFormat, profile: WgProfile, name = "warp"): string {
  switch (format) {
    case "singbox":
      return singBoxConfig(profile, name);
    case "clash":
      return clashConfig(profile, name);
    case "xray":
      return xrayConfig(profile, name);
    case "json":
      return jsonMeta(profile);
    case "wg":
    default:
      return wireGuardConf(profile);
  }
}

export function configExtension(format: ConfigFormat): string {
  switch (format) {
    case "clash":
      return "yaml";
    case "singbox":
    case "xray":
    case "json":
      return "json";
    default:
      return "conf";
  }
}

export function defaultDns(): string[] {
  return ["1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001"];
}

/** Private / non-routable IPv4 space that split-tunnel profiles keep outside the tunnel. */
export const LAN_EXCLUDED_BLOCKS: readonly string[] = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
];

const IPV4_MAX = 0xffffffff;

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

function parseCidr(cidr: string): { start: number; end: number } {
  const [ip, bitsRaw] = cidr.split("/");
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`invalid CIDR: ${cidr}`);
  const base = ipv4ToInt(ip);
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  return { start, end: start + size - 1 };
}

/**
 * Complement of the given IPv4 blocks inside 0.0.0.0/0, emitted as canonical CIDR
 * blocks. Used to build "route everything except my LAN" AllowedIPs lists.
 */
export function ipv4Complement(blocks: readonly string[]): string[] {
  const ranges = blocks.map(parseCidr).sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  const free: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) free.push({ start: cursor, end: range.start - 1 });
    cursor = Math.max(cursor, range.end + 1);
  }
  if (cursor <= IPV4_MAX) free.push({ start: cursor, end: IPV4_MAX });

  const out: string[] = [];
  for (const range of free) {
    let start = range.start;
    while (start <= range.end) {
      // Largest CIDR block that is aligned on `start` and fits inside the range.
      let bits = 32;
      while (bits > 0) {
        const blockSize = 2 ** bits;
        if (start % blockSize === 0 && start + blockSize - 1 <= range.end) break;
        bits--;
      }
      out.push(`${intToIpv4(start)}/${32 - bits}`);
      start += 2 ** bits;
    }
  }
  return out;
}

export type AllowedIpsMode = "all" | "exclude-lan" | "custom";

export function defaultAllowedIps(
  mode: AllowedIpsMode,
  custom: string[] = [],
  exclude: readonly string[] = LAN_EXCLUDED_BLOCKS,
): string[] {
  if (mode === "custom" && custom.length) return custom.slice();
  if (mode === "exclude-lan") {
    return [...ipv4Complement(exclude), "::/0"];
  }
  return ["0.0.0.0/0", "::/0"];
}
