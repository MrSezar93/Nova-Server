/**
 * AmneziaWG (AWG) support.
 *
 * AmneziaWG is a WireGuard fork that adds DPI resistance:
 *   - `Jc`/`Jmin`/`Jmax`: junk packets sent before each handshake (client only)
 *   - `S1..S4`: byte padding of the four message types (MUST match the server)
 *   - `H1..H4`: replacement of the 4-byte message-type header (MUST match the server)
 *   - `I1..I5`: "CPS" — fake protocol openings (QUIC/STUN/DTLS/DNS …) sent before
 *     the handshake so the flow looks like ordinary traffic (client only)
 *
 * Cloudflare's WARP peer is a **stock WireGuard** implementation, so the only
 * values that work against it are `S1..S4 = 0` and `H1..H4 = 1,2,3,4`. That is
 * the "warp-safe" profile: the obfuscation that matters (junk packets + fake
 * openings) is client-side only, while the wire format stays standard, so the
 * very same `.conf` also loads in a vanilla WireGuard client.
 */

import { pickRandom } from "./b64";

export type AwgCpsKind = "quic" | "stun" | "dtls" | "dns" | "random" | "none";

export interface AwgOptions {
  enabled: boolean;
  /** `warp-safe` keeps the wire format compatible with Cloudflare's stock peer. */
  mode: "warp-safe" | "custom";
  /** Junk packets per handshake (recommended 4-12). */
  jc: number;
  jmin: number;
  jmax: number;
  /** Message padding — must be 0 against Cloudflare. */
  s1: number;
  s2: number;
  s3: number;
  s4: number;
  /** Message headers — must be 1,2,3,4 against Cloudflare. */
  h1: number;
  h2: number;
  h3: number;
  h4: number;
  /** Which fake opening to send as `I1`. */
  cps: AwgCpsKind;
  /** Explicit `I1..I5` expressions (override `cps` when set). */
  i1?: string;
  i2?: string;
  i3?: string;
  i4?: string;
  i5?: string;
}

export const AWG_CPS_KINDS: readonly AwgCpsKind[] = ["quic", "stun", "dtls", "dns", "random", "none"];

export const CPS_LABELS: Record<AwgCpsKind, string> = {
  quic: "QUIC Initial",
  stun: "STUN Binding",
  dtls: "DTLS ClientHello",
  dns: "DNS Query",
  random: "بایت تصادفی",
  none: "بدون بسته‌ی اضافه",
};

/** Safe defaults for Cloudflare's WARP peer. */
export const AWG_WARP_SAFE: AwgOptions = {
  enabled: false,
  mode: "warp-safe",
  jc: 4,
  jmin: 40,
  jmax: 70,
  s1: 0,
  s2: 0,
  s3: 0,
  s4: 0,
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  cps: "quic",
};

/** Enabling AWG from the panel starts from a safe, working profile. */
export function awgEnabled(base: AwgOptions = AWG_WARP_SAFE, randomize = true): AwgOptions {
  const next: AwgOptions = { ...base, enabled: true, mode: base.mode ?? "warp-safe" };
  return randomize ? randomizeAwg(next) : next;
}

/**
 * Randomises the client-side obfuscation knobs within ranges that are known to
 * work against stock WireGuard peers. Regenerating with different values is the
 * usual fix when a network starts filtering one particular fingerprint.
 */
export function randomizeAwg(base: AwgOptions): AwgOptions {
  const safe = base.mode !== "custom";
  return {
    ...base,
    jc: clampInt(pickRandom([4, 5, 6, 7, 8]), 1, 12),
    jmin: clampInt(pickRandom([40, 48, 56, 64]), 8, 120),
    jmax: clampInt(pickRandom([70, 80, 96, 112]), 64, 200),
    s1: safe ? 0 : base.s1,
    s2: safe ? 0 : base.s2,
    s3: safe ? 0 : base.s3,
    s4: safe ? 0 : base.s4,
    h1: safe ? 1 : base.h1,
    h2: safe ? 2 : base.h2,
    h3: safe ? 3 : base.h3,
    h4: safe ? 4 : base.h4,
  };
}

function clampInt(value: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

export function normalizeAwg(input: Partial<AwgOptions> | undefined | null, fallback: AwgOptions = AWG_WARP_SAFE): AwgOptions {
  if (!input) return { ...fallback };
  const mode: AwgOptions["mode"] = input.mode === "custom" ? "custom" : "warp-safe";
  const safe = mode === "warp-safe";
  const jc = clampInt(input.jc ?? fallback.jc, 0, 12);
  const jmin = clampInt(input.jmin ?? fallback.jmin, 0, 120);
  const jmax = clampInt(input.jmax ?? fallback.jmax, jmin, 200);
  const cps = (AWG_CPS_KINDS as readonly string[]).includes(String(input.cps))
    ? (input.cps as AwgCpsKind)
    : fallback.cps;
  return {
    enabled: input.enabled ?? fallback.enabled,
    mode,
    jc,
    jmin,
    jmax,
    s1: safe ? 0 : clampInt(input.s1 ?? fallback.s1, 0, 128),
    s2: safe ? 0 : clampInt(input.s2 ?? fallback.s2, 0, 128),
    s3: safe ? 0 : clampInt(input.s3 ?? fallback.s3, 0, 128),
    s4: safe ? 0 : clampInt(input.s4 ?? fallback.s4, 0, 128),
    h1: safe ? 1 : clampInt(input.h1 ?? fallback.h1, 0, 0xffffffff),
    h2: safe ? 2 : clampInt(input.h2 ?? fallback.h2, 0, 0xffffffff),
    h3: safe ? 3 : clampInt(input.h3 ?? fallback.h3, 0, 0xffffffff),
    h4: safe ? 4 : clampInt(input.h4 ?? fallback.h4, 0, 0xffffffff),
    cps,
    i1: sanitizeCps(input.i1),
    i2: sanitizeCps(input.i2),
    i3: sanitizeCps(input.i3),
    i4: sanitizeCps(input.i4),
    i5: sanitizeCps(input.i5),
  };
}

/**
 * Only the documented AWG tag syntax is accepted, so an imported/shared profile
 * can never inject arbitrary text into a generated config file.
 */
export function sanitizeCps(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) return undefined;
  const tag = /<b 0x[0-9a-fA-F]*>|<r \d{1,4}>|<rd \d{1,4}>|<rc \d{1,4}>|<t>/g;
  const parts = trimmed.match(tag);
  if (!parts) return undefined;
  // Everything that is not a recognised tag must be whitespace, so a profile
  // can never smuggle arbitrary lines into a generated config file.
  let cursor = 0;
  for (const match of trimmed.matchAll(new RegExp(tag.source, "g"))) {
    const index = match.index ?? 0;
    if (trimmed.slice(cursor, index).trim() !== "") return undefined;
    cursor = index + match[0].length;
  }
  if (trimmed.slice(cursor).trim() !== "") return undefined;
  return parts.join(" ");
}

export function isWarpSafe(awg: AwgOptions): boolean {
  return awg.s1 === 0 && awg.s2 === 0 && awg.s3 === 0 && awg.s4 === 0 && awg.h1 === 1 && awg.h2 === 2 && awg.h3 === 3 && awg.h4 === 4;
}

/* -------------------------------------------------------------------------- */
/*                          fake protocol openings (CPS)                      */
/* -------------------------------------------------------------------------- */

function hex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

/** Minimal QUIC varint encoder (RFC 9000 §16). */
function quicVarint(value: number): number[] {
  if (value < 64) return [value];
  if (value < 16384) return [(value >> 8) | 0x40, value & 0xff];
  return [(value >> 24) | 0x80, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** A structurally plausible QUIC Initial packet (`<b>` tags only, no random tags). */
function quicInitial(size: number): number[] {
  const dcid = Array.from(randomBytes(8));
  const scid = Array.from(randomBytes(4));
  const version = pick([[0x00, 0x00, 0x00, 0x01], [0x6b, 0x33, 0x43, 0xcf]]); // v1 / v2
  const payloadLength = Math.max(24, size - 32);
  const header = [
    0xc3, // long header, fixed bit, Initial, 4-byte packet number
    ...version,
    dcid.length,
    ...dcid,
    scid.length,
    ...scid,
    0x00, // token length = 0
    ...quicVarint(4 + payloadLength),
  ];
  const body = Array.from(randomBytes(payloadLength));
  return [...header, ...randomBytes(4), ...body];
}

function stunBinding(): number[] {
  // STUN Binding Request (RFC 5389) with a SOFTWARE attribute.
  return [
    0x00, 0x01, 0x00, 0x08, // type, length = 8 bytes of attributes
    0x21, 0x12, 0xa4, 0x42, // magic cookie
    ...randomBytes(12), // transaction id
    0x80, 0x22, 0x00, 0x04, 0x53, 0x54, 0x55, 0x4e, // SOFTWARE: "STUN"
  ];
}

function dtlsClientHello(): number[] {
  const payload = Math.max(64, 200);
  return [
    0x16, // handshake
    0xfe, 0xfd, // DTLS 1.2
    0x00, 0x00, // epoch
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, // sequence number
    0x00, payload & 0xff, // length
    ...randomBytes(payload),
  ];
}

const DNS_QUERY_DOMAINS: readonly string[] = ["www.cloudflare.com", "cloudflare.com", "one.one.one.one", "cdn.jsdelivr.net"];

function dnsQuery(): number[] {
  const domain = pick(DNS_QUERY_DOMAINS);
  const labels: number[] = [];
  for (const label of domain.split(".")) {
    labels.push(label.length, ...Array.from(new TextEncoder().encode(label)));
  }
  labels.push(0x00, 0x00, 0x01, 0x00, 0x01); // root label, QTYPE=A, QCLASS=IN
  return [
    0x12, 0x34, // id
    0x01, 0x00, // flags: recursion desired
    0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // qd/an/ns/ar counts
    ...labels,
  ];
}

/**
 * Builds one `I<n>` expression. The result only uses `<b>`/`<r>` tags so the
 * generated `.conf` stays a single, greppable line.
 */
export function cpsPacket(kind: AwgCpsKind, targetSize = 640): string {
  switch (kind) {
    case "quic":
      return `<b 0x${hex(quicInitial(targetSize))}>`;
    case "stun":
      return `<b 0x${hex(stunBinding())}>`;
    case "dtls":
      return `<b 0x${hex(dtlsClientHello())}>`;
    case "dns":
      return `<b 0x${hex(dnsQuery())}>`;
    case "random":
      return `<r ${clampInt(targetSize, 32, 1200)}>`;
    case "none":
    default:
      return "";
  }
}

/**
 * Fake openings sent before every handshake. `I1` carries the main disguise and
 * `I2..I5` add extra filler, which is what makes a fixed `I1` fingerprint much
 * harder to match. The values never reach the server as data — the server simply
 * ignores packets it cannot decrypt.
 */
export function cpsPackets(awg: AwgOptions): { i1?: string; i2?: string; i3?: string; i4?: string; i5?: string } {
  if (awg.i1 || awg.i2 || awg.i3 || awg.i4 || awg.i5) {
    return { i1: awg.i1, i2: awg.i2, i3: awg.i3, i4: awg.i4, i5: awg.i5 };
  }
  if (awg.cps === "none") return {};
  const primary = cpsPacket(awg.cps, 700);
  return {
    i1: primary || undefined,
    i2: `<rc ${clampInt(80 + Math.floor(Math.random() * 100), 32, 300)}>`,
    i3: `<rd ${clampInt(40 + Math.floor(Math.random() * 80), 16, 200)}>`,
    i4: `<r ${clampInt(32 + Math.floor(Math.random() * 60), 16, 200)}>`,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   output                                   */
/* -------------------------------------------------------------------------- */

/** `[Interface]` lines for an AmneziaWG client (order matches amneziawg-go). */
export function awgLines(awg: AwgOptions): string[] {
  if (!awg.enabled) return [];
  const lines = [
    `Jc = ${awg.jc}`,
    `Jmin = ${awg.jmin}`,
    `Jmax = ${awg.jmax}`,
  ];
  if (awg.mode === "custom") {
    lines.push(`S1 = ${awg.s1}`, `S2 = ${awg.s2}`, `S3 = ${awg.s3}`, `S4 = ${awg.s4}`);
  }
  lines.push(`H1 = ${awg.h1}`, `H2 = ${awg.h2}`, `H3 = ${awg.h3}`, `H4 = ${awg.h4}`);
  const packets = cpsPackets(awg);
  for (const key of ["i1", "i2", "i3", "i4", "i5"] as const) {
    const value = packets[key];
    if (value) lines.push(`${key.toUpperCase()} = ${value}`);
  }
  return lines;
}

/** `amnezia-wg-option` block for mihomo / Clash.Meta. */
export function awgMihomoOption(awg: AwgOptions): Record<string, unknown> | undefined {
  if (!awg.enabled) return undefined;
  const option: Record<string, unknown> = {
    jc: awg.jc,
    jmin: awg.jmin,
    jmax: awg.jmax,
    s1: awg.s1,
    s2: awg.s2,
    s3: awg.s3,
    s4: awg.s4,
    h1: awg.mode === "custom" ? `0x${awg.h1.toString(16)}` : 1,
    h2: awg.mode === "custom" ? `0x${awg.h2.toString(16)}` : 2,
    h3: awg.mode === "custom" ? `0x${awg.h3.toString(16)}` : 3,
    h4: awg.mode === "custom" ? `0x${awg.h4.toString(16)}` : 4,
  };
  const packets = cpsPackets(awg);
  for (const key of ["i1", "i2", "i3", "i4", "i5"] as const) {
    const value = packets[key];
    if (!value) continue;
    // mihomo takes the raw payload as hex (it does not understand AWG tag syntax).
    const plain = value.replace(/[<>]/g, " ").trim();
    if (/^b\s+0x[0-9a-f]+$/i.test(plain)) {
      option[key] = `0x${plain.replace(/^b\s+0x/i, "")}`;
      continue;
    }
    const size = /^r\s+(\d+)$/i.exec(plain)?.[1];
    option[key] = `0x${hex(randomBytes(Number(size) || 64))}`;
  }
  return option;
}

/** Short human readable summary used by the panel. */
export function awgSummary(awg: AwgOptions | undefined): string | undefined {
  if (!awg?.enabled) return undefined;
  const mode = isWarpSafe(awg) ? "WARP-safe" : "سفارشی";
  return `${mode} · Jc=${awg.jc} · ${CPS_LABELS[awg.cps] ?? awg.cps}`;
}
