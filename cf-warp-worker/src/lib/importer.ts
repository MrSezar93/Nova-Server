/**
 * Importers for existing Cloudflare WARP credentials.
 *
 * Supported inputs (auto-detected):
 *  1. WireGuard `.conf` profile (wgcf output, 1.1.1.1 app export, …)
 *  2. wgcf `wgcf-account.toml`
 *  3. Cloudflare WARP client `reg.json` / any JSON holding `private_key`
 *  4. a bare base64 WireGuard private key
 *
 * This path never talks to Cloudflare, which makes it the reliable fallback
 * when registration is rate limited.
 */

import { isValidWgKey, reservedFromClientId } from "./wg";

export interface ImportedIdentity {
  privateKey: string;
  addressV4?: string;
  addressV6?: string;
  peerPublicKey?: string;
  clientId?: string;
  reserved?: number[];
  endpointHost?: string;
  endpointPort?: number;
  deviceId?: string;
  token?: string;
  license?: string;
  name?: string;
  sourceFormat: "conf" | "toml" | "json" | "key";
}

export class ImportError extends Error {}

const DEFAULT_PEER_KEY = "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=";

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

function splitEndpoint(value: string): { host: string; port: number } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const bracketMatch = /^\[(.+)\]:(\d+)$/.exec(trimmed);
  if (bracketMatch) return { host: bracketMatch[1], port: Number(bracketMatch[2]) };
  const index = trimmed.lastIndexOf(":");
  if (index > 0 && /^\d+$/.test(trimmed.slice(index + 1))) {
    return { host: trimmed.slice(0, index), port: Number(trimmed.slice(index + 1)) };
  }
  return { host: trimmed, port: 2408 };
}

export function parseWireGuardConf(content: string): ImportedIdentity {
  const sections: Record<string, Record<string, string>> = {};
  let current = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].split(";")[0].trim();
    if (!line) continue;
    const sectionMatch = /^\[(.+)]$/.exec(line);
    if (sectionMatch) {
      current = sectionMatch[1].toLowerCase();
      sections[current] = sections[current] ?? {};
      continue;
    }
    const index = line.indexOf("=");
    if (index < 0 || !current) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (sections[current][key]) sections[current][key] += `, ${value}`;
    else sections[current][key] = value;
  }

  const iface = sections.interface ?? {};
  const peer = sections.peer ?? {};
  const privateKey = stripQuotes(iface.privatekey ?? "");
  if (!privateKey) throw new ImportError("در فایل کانفیگ، PrivateKey پیدا نشد.");
  if (!isValidWgKey(privateKey)) {
    throw new ImportError("PrivateKey موجود در فایل معتبر نیست (باید base64 و ۳۲ بایتی باشد).");
  }

  const addresses = (iface.address ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const addressV4 = addresses.find((value) => !value.includes(":"))?.split("/")[0];
  const addressV6 = addresses.find((value) => value.includes(":"))?.split("/")[0];

  const endpoint = splitEndpoint(peer.endpoint ?? "");
  const reservedRaw = peer.reserved;
  const reserved = reservedRaw
    ? reservedRaw
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value))
    : undefined;

  return {
    privateKey,
    addressV4,
    addressV6,
    peerPublicKey: stripQuotes(peer.publickey ?? "") || undefined,
    reserved: reserved && reserved.length >= 3 ? reserved.slice(0, 3) : undefined,
    endpointHost: endpoint?.host,
    endpointPort: endpoint?.port,
    sourceFormat: "conf",
  };
}

export function parseWgcfToml(content: string): ImportedIdentity {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    const match = /^([a-zA-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    values[match[1].toLowerCase()] = stripQuotes(match[2]);
  }
  const privateKey = values.private_key ?? values.privatekey ?? "";
  if (!privateKey) throw new ImportError("در فایل TOML، private_key پیدا نشد.");
  if (!isValidWgKey(privateKey)) throw new ImportError("private_key موجود در فایل معتبر نیست.");
  return {
    privateKey,
    deviceId: values.device_id,
    token: values.access_token,
    license: values.license_key || undefined,
    sourceFormat: "toml",
  };
}

export function parseJsonCredentials(content: string): ImportedIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ImportError("JSON دریافتی معتبر نیست.");
  }
  return identityFromJson(parsed as Record<string, unknown>);
}

export function identityFromJson(raw: Record<string, unknown>): ImportedIdentity {
  const privateKey = String(
    raw.private_key ?? raw.privateKey ?? (raw.interface as Record<string, unknown> | undefined)?.private_key ?? "",
  );
  if (!privateKey) throw new ImportError("کلید خصوصی (private_key) در JSON پیدا نشد.");
  if (!isValidWgKey(privateKey)) throw new ImportError("private_key موجود در JSON معتبر نیست.");

  const config = (raw.config as Record<string, unknown> | undefined) ?? raw;
  const iface = (config.interface as Record<string, unknown> | undefined) ?? {};
  const addresses = (iface.addresses as Record<string, unknown> | undefined) ?? {};
  const peers = Array.isArray(config.peers) ? (config.peers as Record<string, unknown>[]) : [];
  const peer = peers[0] ?? {};
  const endpoint = (peer.endpoint as Record<string, unknown> | undefined) ?? {};
  const clientId = (config.client_id ?? raw.client_id) as string | undefined;
  const endpointHost = (endpoint.host as string | undefined) ?? (endpoint.v4 as string | undefined);
  const ports = Array.isArray(endpoint.ports) ? (endpoint.ports as number[]) : [];
  const endpointInfo = endpointHost ? splitEndpoint(String(endpointHost)) : null;

  return {
    privateKey,
    addressV4: addresses.v4 ? String(addresses.v4).split("/")[0] : undefined,
    addressV6: addresses.v6 ? String(addresses.v6).split("/")[0] : undefined,
    peerPublicKey: (peer.public_key as string | undefined) ?? undefined,
    clientId,
    reserved: reservedFromClientId(clientId),
    deviceId: (raw.id ?? raw.device_id) as string | undefined,
    token: (raw.token ?? raw.access_token) as string | undefined,
    endpointHost: endpointInfo?.host,
    endpointPort: ports.length ? ports[0] : endpointInfo?.port,
    name: (raw.name ?? raw.model) as string | undefined,
    sourceFormat: "json",
  };
}

export function detectAndParse(content: string): ImportedIdentity {
  const trimmed = content.trim();
  if (!trimmed) throw new ImportError("محتوای ورودی خالی است.");

  if (/^[[{]/.test(trimmed)) {
    if (trimmed.startsWith("[")) {
      if (/\[interface]/i.test(trimmed)) return parseWireGuardConf(trimmed);
      throw new ImportError("ساختار فایل شناسایی نشد. فایل .conf یا TOML یا JSON بدهید.");
    }
    return parseJsonCredentials(trimmed);
  }

  if (/^[A-Za-z0-9+/]{43}=?$/.test(trimmed)) {
    if (!isValidWgKey(trimmed)) throw new ImportError("کلید وارد‌شده معتبر نیست.");
    return { privateKey: trimmed, sourceFormat: "key" };
  }

  if (/^[a-zA-Z0-9_]+ *=/.test(trimmed)) return parseWgcfToml(trimmed);

  throw new ImportError("قالب ورودی پشتیبانی نمی‌شود. .conf / .toml / JSON / کلید خام را امتحان کنید.");
}

/** Fills in the fields that Cloudflare uses by default. */
export function applyWarpDefaults(identity: ImportedIdentity): ImportedIdentity {
  return {
    ...identity,
    peerPublicKey: identity.peerPublicKey || DEFAULT_PEER_KEY,
    addressV4: identity.addressV4 || "172.16.0.2",
  };
}
