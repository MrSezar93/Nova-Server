/** HTTP helpers: routing, responses, cookies and security headers. */

import { Store } from "./store";
import type { Env } from "../types";

export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface RequestContext {
  request: Request;
  url: URL;
  env: Env;
  store: Store;
  ip: string;
  params: Record<string, string>;
  waitUntil: (promise: Promise<unknown>) => void;
  /** Set when the caller authenticated with the panel API key instead of a cookie. */
  viaApiKey?: boolean;
}

export type Handler = (ctx: RequestContext) => Promise<Response> | Response;

interface Route {
  method: string;
  segments: string[];
  wildcard: boolean;
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];
  private fallbackHandler: Handler | null = null;

  add(method: string, pattern: string, handler: Handler): this {
    const wildcard = pattern.endsWith("*");
    const clean = wildcard ? pattern.slice(0, -1) : pattern;
    const segments = clean.split("/").filter(Boolean);
    this.routes.push({ method: method.toUpperCase(), segments, wildcard, handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }

  put(pattern: string, handler: Handler): this {
    return this.add("PUT", pattern, handler);
  }

  patch(pattern: string, handler: Handler): this {
    return this.add("PATCH", pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add("DELETE", pattern, handler);
  }

  fallback(handler: Handler): this {
    this.fallbackHandler = handler;
    return this;
  }

  match(
    method: string,
    pathname: string,
  ): { handler: Handler; params: Record<string, string> } | { methodNotAllowed: true } | null {
    const parts = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length > parts.length) continue;
      if (!route.wildcard && route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i];
        const value = parts[i];
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = decodeURIComponent(value);
        } else if (segment !== value) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method.toUpperCase()) {
        if (route.wildcard) params["*"] = parts.slice(route.segments.length).join("/");
        return { handler: route.handler, params };
      }
    }
    if (pathMatched) return { methodNotAllowed: true };
    if (this.fallbackHandler) return { handler: this.fallbackHandler, params: {} };
    return null;
  }
}

/**
 * Set from the request entrypoint (`env.ALLOW_FRAMING === "1"`). Purely a
 * convenience for local previews / embedded dashboards — production keeps the
 * strict defaults below.
 */
let framingAllowed = false;

export function configureFraming(allow: boolean): void {
  framingAllowed = allow;
}

export function securityHeaders(): Record<string, string> {
  const headers: Record<string, string> = { ...SECURITY_HEADERS };
  if (framingAllowed) delete headers["x-frame-options"];
  return headers;
}

export function contentSecurityPolicy(): string {
  return framingAllowed ? HTML_CSP.replace("frame-ancestors 'none'", "frame-ancestors *") : HTML_CSP;
}

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

export const HTML_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; " +
  "frame-ancestors 'none'";

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function textResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/plain; charset=utf-8");
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  return new Response(body, { ...init, headers });
}

export function htmlResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy", contentSecurityPolicy());
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  return new Response(body, { ...init, headers });
}

export function downloadResponse(
  body: string,
  filename: string,
  contentType = "application/octet-stream",
): Response {
  const headers = new Headers({
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename.replace(/[^\w.\-]+/g, "_")}"`,
    "cache-control": "no-store",
  });
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  return new Response(body, { status: 200, headers });
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie");
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly?: boolean; secure?: boolean; sameSite?: "Lax" | "Strict" | "None"; path?: string; maxAge?: number } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export async function readJson<T>(request: Request, maxBytes = 128 * 1024): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length && length > maxBytes) throw new HttpError(413, "بدنه‌ی درخواست بیش از حد بزرگ است.");
  const raw = await request.text();
  if (raw.length > maxBytes) throw new HttpError(413, "بدنه‌ی درخواست بیش از حد بزرگ است.");
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "بدنه‌ی JSON نامعتبر است.");
  }
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "0.0.0.0"
  );
}

/** Blocks cross-site state changing requests (defence in depth on top of SameSite cookies). */
export function assertSameOrigin(request: Request, url: URL): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.host !== url.host) {
        throw new HttpError(403, "درخواست از مبدأ نامعتبر رد شد.");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(403, "مبدأ درخواست نامعتبر است.");
    }
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    throw new HttpError(403, "درخواست بین‌سایتی مجاز نیست.");
  }
}

export function requireString(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `مقدار «${field}» لازم است.`, "invalid_field");
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `مقدار «${field}» بیش از حد بلند است.`, "invalid_field");
  }
  return trimmed;
}

export function optionalNumber(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `مقدار «${field}» باید بین ${min} و ${max} باشد.`, "invalid_field");
  }
  return Math.floor(parsed);
}
