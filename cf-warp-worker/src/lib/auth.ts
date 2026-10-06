/**
 * Authentication: password storage, signed session cookies, API keys and a
 * best-effort login throttle.
 *
 * Notes on the PBKDF2 iteration count: Workers bill CPU time per request and
 * the free plan allows only a few milliseconds, so the KV-stored password hash
 * uses a conservative iteration count and the recommended setup is to provide
 * the password as a Worker *secret* (`PANEL_PASSWORD`), which is compared with
 * a constant-time HMAC instead of a slow KDF.
 */

import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  fromUtf8,
  hmacSha256,
  randomId,
  sha256Hex,
  timingSafeEqual,
  utf8,
} from "./b64";
import { Store } from "./store";
import type { AuthRecord, Env } from "../types";

export const SESSION_COOKIE = "nova_warp_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_ITERATIONS = 10_000;

export async function hashPassword(
  password: string,
  salt: string,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(password) as unknown as ArrayBuffer,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: utf8(salt) as unknown as ArrayBuffer,
      iterations,
    },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export function resolveIterations(env: Env): number {
  const parsed = Number(env.PASSWORD_ITERATIONS);
  if (Number.isFinite(parsed) && parsed >= 1000 && parsed <= 1_000_000) return Math.floor(parsed);
  return DEFAULT_ITERATIONS;
}

export async function createAuthRecord(password: string, env: Env): Promise<AuthRecord> {
  const salt = randomId(16);
  const iterations = resolveIterations(env);
  return {
    salt,
    iterations,
    hash: await hashPassword(password, salt, iterations),
    sessionSecret: randomId(32),
    createdAt: Date.now(),
  };
}

export async function verifyPassword(password: string, record: AuthRecord): Promise<boolean> {
  const hash = await hashPassword(password, record.salt, record.iterations || DEFAULT_ITERATIONS);
  return timingSafeEqual(hash, record.hash);
}

/** Password check that understands both the secret and the KV-stored hash. */
export async function checkPassword(
  password: string,
  env: Env,
  store: Store,
): Promise<{ ok: boolean; configured: boolean }> {
  const envPassword = env.PANEL_PASSWORD?.trim();
  if (envPassword) {
    return { ok: timingSafeEqual(password, envPassword), configured: true };
  }
  const record = await store.getAuth();
  if (!record) return { ok: false, configured: false };
  return { ok: await verifyPassword(password, record), configured: true };
}

export async function isPanelConfigured(env: Env, store: Store): Promise<boolean> {
  if (env.PANEL_PASSWORD?.trim()) return true;
  return Boolean(await store.getAuth());
}

export async function getSessionSecret(env: Env, store: Store): Promise<string | null> {
  if (env.SESSION_SECRET?.trim()) return env.SESSION_SECRET.trim();
  const record = await store.getAuth();
  if (record?.sessionSecret) return record.sessionSecret;
  const envPassword = env.PANEL_PASSWORD?.trim();
  if (envPassword) return sha256Hex(`nova-warp-session:${envPassword}`);
  return null;
}

export interface SessionPayload {
  sub: "admin";
  iat: number;
  exp: number;
  /** Session epoch — cookies signed with an older epoch are rejected after logout. */
  ep?: number;
}

export function sessionCookieOptions(maxAge = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge,
  };
}

export async function createSessionToken(
  secret: string,
  ttlSeconds = SESSION_TTL_SECONDS,
  epoch = 0,
): Promise<string> {
  const payload: SessionPayload = {
    sub: "admin",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    ep: epoch,
  };
  const encoded = base64UrlEncode(utf8(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmacSha256(secret, encoded));
  return `v1.${encoded}.${signature}`;
}

export async function verifySessionToken(
  secret: string,
  token: string,
  expectedEpoch = 0,
): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, encoded, signature] = parts;
  const expected = base64UrlEncode(await hmacSha256(secret, encoded));
  if (!timingSafeEqual(expected, signature)) return null;
  try {
    const payload = JSON.parse(fromUtf8(base64UrlDecode(encoded))) as SessionPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    if (payload.sub !== "admin") return null;
    if ((payload.ep ?? 0) !== expectedEpoch) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Current session epoch. Cookies are signed with it and rejected once it moves,
 * which is what makes `POST /api/v1/logout` actually revoke a session (the
 * cookie itself is stateless).
 */
export async function getSessionEpoch(store: Store): Promise<number> {
  return (await store.getAuth())?.sessionEpoch ?? 0;
}

/** Invalidates every session cookie issued so far (called on logout). */
export async function bumpSessionEpoch(store: Store): Promise<void> {
  const record = await store.getAuth();
  if (!record) return;
  record.sessionEpoch = (record.sessionEpoch ?? 0) + 1;
  await store.saveAuth(record);
}

export function generateApiKey(): string {
  return `nw_${randomId(24)}`;
}

export async function hashIp(ip: string): Promise<string> {
  return (await sha256Hex(`nova-warp-ip:${ip}`)).slice(0, 24);
}

interface ThrottleRecord {
  count: number;
  windowStart: number;
}

/**
 * Best-effort login throttle (KV is eventually consistent, so this slows down
 * brute force rather than guaranteeing a hard limit).
 */
export async function registerFailedLogin(
  store: Store,
  ip: string,
  maxAttempts = 8,
  windowMs = 10 * 60 * 1000,
): Promise<{ blocked: boolean; retryAfter: number }> {
  const key = `throttle:login:${await hashIp(ip)}`;
  const now = Date.now();
  const record = await store.getJson<ThrottleRecord>(key, { count: 0, windowStart: now });
  const fresh = now - record.windowStart > windowMs;
  const next: ThrottleRecord = fresh
    ? { count: 1, windowStart: now }
    : { count: record.count + 1, windowStart: record.windowStart };
  await store.setJson(key, next);
  if (next.count > maxAttempts) {
    return { blocked: true, retryAfter: Math.ceil((next.windowStart + windowMs - now) / 1000) };
  }
  return { blocked: false, retryAfter: 0 };
}

export async function clearFailedLogins(store: Store, ip: string): Promise<void> {
  await store.setJson(`throttle:login:${await hashIp(ip)}`, { count: 0, windowStart: 0 });
}
