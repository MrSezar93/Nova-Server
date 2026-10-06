/**
 * VLESS-over-WebSocket proxy that runs **on the Worker itself**.
 *
 * This is the "TLS/TCP" half of the project: the Worker terminates TLS at
 * Cloudflare's edge (that part is free, automatic and un-blockable in practice),
 * speaks VLESS over a WebSocket, and pipes the decrypted TCP stream to the real
 * destination with the runtime's `connect()` socket API.
 *
 *   client (v2rayNG / sing-box / Clash.Meta / Hiddify …)
 *     └─ TLS + WebSocket + VLESS ─▶ Worker ─▶ connect() ─▶ destination
 *
 * No VPS and no external relay is involved, which is the whole point: the exit
 * IP belongs to Cloudflare, every port is 443, and the only inbound thing the
 * Worker has to expose is an ordinary HTTPS (WebSocket) endpoint.
 *
 * Limitations (documented for the panel user):
 *   - UDP (command 2) is not supported — the runtime has no UDP sockets, so QUIC
 *     and UDP-DNS through the tunnel fall back to TCP on the client side.
 *   - `connect()` cannot reach Cloudflare's own IP ranges or port 25.
 */

import { randomId } from "./b64";

export const PROXY_KIND = "proxy";
export const DEFAULT_PROXY_PATH = "/ws";

/* -------------------------------------------------------------------------- */
/*                              link generation                               */
/* -------------------------------------------------------------------------- */

export interface ProxyEndpoint {
  uuid: string;
  /** Public host the client connects to (worker hostname or a custom domain). */
  host: string;
  /** TLS port — 443 unless a custom domain is routed elsewhere. */
  port: number;
  /** WebSocket path, e.g. `/ws`. */
  path: string;
  name: string;
  /** Send the first bytes inside the WebSocket handshake (Xray "early data"). */
  padding?: boolean;
}

export function normalizeProxyPath(value: string | undefined): string {
  const raw = (value ?? DEFAULT_PROXY_PATH).trim() || DEFAULT_PROXY_PATH;
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, "") || DEFAULT_PROXY_PATH;
}

/** `vless://uuid@host:443?type=ws&security=tls&...#name` */
export function vlessLink(endpoint: ProxyEndpoint): string {
  const path = endpoint.padding ? `${endpoint.path}?ed=2048` : endpoint.path;
  const params = new URLSearchParams({
    type: "ws",
    security: "tls",
    sni: endpoint.host,
    host: endpoint.host,
    path,
  });
  const fragment = `#${encodeURIComponent(endpoint.name || "nova-proxy")}`;
  return `vless://${endpoint.uuid}@${endpoint.host}:${endpoint.port}?${params.toString()}${fragment}`;
}

/** Clash.Meta / Mihomo `proxies:` entry. */
export function clashProxy(endpoint: ProxyEndpoint): string {
  const path = endpoint.padding ? `${endpoint.path}?ed=2048` : endpoint.path;
  return [
    `  - name: "${endpoint.name}"`,
    "    type: vless",
    `    server: ${endpoint.host}`,
    `    port: ${endpoint.port}`,
    `    uuid: ${endpoint.uuid}`,
    "    network: ws",
    "    tls: true",
    `    servername: ${endpoint.host}`,
    "    udp: true",
    "    ws-opts:",
    `      path: "${path}"`,
    "      headers:",
    `        Host: ${endpoint.host}`,
  ].join("\n");
}

export function clashProxyList(endpoints: ProxyEndpoint[]): string {
  return `proxies:\n${endpoints.map(clashProxy).join("\n")}\n`;
}

/** sing-box outbound object. */
export function singboxOutbound(endpoint: ProxyEndpoint, tag = "proxy"): Record<string, unknown> {
  const path = endpoint.padding ? `${endpoint.path}?ed=2048` : endpoint.path;
  return {
    type: "vless",
    tag,
    server: endpoint.host,
    server_port: endpoint.port,
    uuid: endpoint.uuid,
    tls: {
      enabled: true,
      server_name: endpoint.host,
    },
    transport: {
      type: "ws",
      path,
      headers: { Host: endpoint.host },
    },
  };
}

export function singboxConfig(endpoints: ProxyEndpoint[]): string {
  return (
    JSON.stringify(
      {
        outbounds: [
          ...endpoints.map((endpoint, index) => singboxOutbound(endpoint, index === 0 ? "proxy" : `proxy-${index + 1}`)),
          { type: "direct", tag: "direct" },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

/** Xray / v2ray outbound object. */
export function xrayOutbound(endpoint: ProxyEndpoint, tag = "proxy"): Record<string, unknown> {
  const path = endpoint.padding ? `${endpoint.path}?ed=2048` : endpoint.path;
  return {
    tag,
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: endpoint.host,
          port: endpoint.port,
          users: [{ id: endpoint.uuid, encryption: "none", level: 0 }],
        },
      ],
    },
    streamSettings: {
      network: "ws",
      security: "tls",
      tlsSettings: { serverName: endpoint.host, allowInsecure: false },
      wsSettings: { path, headers: { Host: endpoint.host } },
    },
  };
}

export function xrayConfig(endpoints: ProxyEndpoint[]): string {
  return (
    JSON.stringify(
      {
        outbounds: [
          ...endpoints.map((endpoint, index) => xrayOutbound(endpoint, index === 0 ? "proxy" : `proxy-${index + 1}`)),
          { tag: "direct", protocol: "freedom" },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

export interface ProxyMeta {
  uuid: string;
  host: string;
  port: number;
  path: string;
  url: string;
  padding: boolean;
}

export function proxyMeta(endpoint: ProxyEndpoint): ProxyMeta {
  return {
    uuid: endpoint.uuid,
    host: endpoint.host,
    port: endpoint.port,
    path: endpoint.path,
    url: vlessLink(endpoint),
    padding: Boolean(endpoint.padding),
  };
}

/* -------------------------------------------------------------------------- */
/*                              VLESS server side                             */
/* -------------------------------------------------------------------------- */

export interface VlessRequest {
  version: number;
  command: 1 | 2 | 3;
  port: number;
  address: string;
  /** Number of bytes consumed by the header inside the buffer. */
  headerLength: number;
}

export type VlessParseResult = { request: VlessRequest } | { incomplete: true } | { invalid: true };

/** Parses the VLESS request header (version, command, port, address). */
export function parseVlessRequest(bytes: Uint8Array): VlessParseResult {
  if (bytes.length < 5) return { incomplete: true };
  const version = bytes[0];
  const command = bytes[1];
  if (command !== 1 && command !== 2 && command !== 3) return { invalid: true };
  const port = (bytes[2] << 8) | bytes[3];
  const addressType = bytes[4];
  if (addressType === 1) {
    if (bytes.length < 9) return { incomplete: true };
    const address = `${bytes[5]}.${bytes[6]}.${bytes[7]}.${bytes[8]}`;
    return { request: { version, command, port, address, headerLength: 9 } };
  }
  if (addressType === 2) {
    if (bytes.length < 6) return { incomplete: true };
    const length = bytes[5];
    if (bytes.length < 6 + length) return { incomplete: true };
    const address = new TextDecoder().decode(bytes.subarray(6, 6 + length));
    return { request: { version, command, port, address, headerLength: 6 + length } };
  }
  if (addressType === 3) {
    if (bytes.length < 21) return { incomplete: true };
    const parts: string[] = [];
    for (let index = 0; index < 8; index++) parts.push(((bytes[5 + index * 2] << 8) | bytes[6 + index * 2]).toString(16));
    return { request: { version, command, port, address: parts.join(":"), headerLength: 21 } };
  }
  return { invalid: true };
}

export function newUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const hex = randomId(16).replace(/[^a-f0-9]/gi, "0").padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/* -------------------------------------------------------------------------- */
/*                                 plumbing                                   */
/* -------------------------------------------------------------------------- */

interface SocketLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  closed: Promise<void>;
  close(): void | Promise<void>;
}

export type ProxySocket = SocketLike;
export type Connector = (address: string | { hostname: string; port: number }, options?: unknown) => SocketLike;

let connectorCache: Connector | null | undefined;

/**
 * Cloudflare's TCP socket API (`connect` from `cloudflare:sockets`). It is the
 * only way to reach arbitrary TCP ports from a Worker, so it is imported
 * dynamically: on a runtime without the module (tests, `npm run preview`) the
 * proxy transparently falls back to the HTTP-only `fetch` path.
 */
async function getConnector(): Promise<Connector | null> {
  if (connectorCache !== undefined) return connectorCache;
  try {
    const module = (await import(/* @vite-ignore */ "cloudflare:sockets")) as { connect?: Connector };
    connectorCache = typeof module.connect === "function" ? module.connect : null;
  } catch {
    connectorCache = null;
  }
  return connectorCache;
}

/** Byte queue on top of the WebSocket event API (pull based). */
class WsSource {
  private chunks: Uint8Array[] = [];
  private waiters: Array<(value: Uint8Array | null) => void> = [];
  private ended = false;

  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as ArrayBuffer | ArrayBufferView | string;
      let bytes: Uint8Array;
      if (typeof data === "string") {
        bytes = new TextEncoder().encode(data);
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      } else {
        bytes = new Uint8Array(data as ArrayBuffer);
      }
      if (bytes.byteLength) this.push(bytes);
    });
    const finish = () => this.push(null);
    socket.addEventListener("close", finish);
    socket.addEventListener("error", finish);
  }

  private push(bytes: Uint8Array | null): void {
    if (bytes === null) {
      this.ended = true;
      const waiters = this.waiters;
      this.waiters = [];
      for (const waiter of waiters) waiter(null);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(bytes);
    else this.chunks.push(bytes);
  }

  /** Reads at least one chunk (or `null` when the socket ended). */
  read(): Promise<Uint8Array | null> {
    const chunk = this.chunks.shift();
    if (chunk) return Promise.resolve(chunk);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Like {@link read}, but gives up after `timeoutMs` (returns `null`). */
  readWithTimeout(timeoutMs: number): Promise<Uint8Array | null> {
    const chunk = this.chunks.shift();
    if (chunk || this.ended) return Promise.resolve(chunk ?? null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      const waiter = (value: Uint8Array | null) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(waiter);
    });
  }

  private buffered(): number {
    return this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  }

  /** Reads until `size` bytes are buffered (used for the VLESS header). */
  async readAtLeast(size: number, timeoutMs = 10_000): Promise<Uint8Array> {
    while (this.buffered() < size) {
      const chunk = timeoutMs ? await this.readWithTimeout(timeoutMs) : await this.read();
      if (!chunk) break;
    }
    return this.takeAll();
  }

  /** Alias with a timeout, used by the header loop. */
  readUntil(size: number, timeoutMs: number): Promise<Uint8Array> {
    return this.readAtLeast(size, timeoutMs);
  }

  private takeAll(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks.shift() as Uint8Array;
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.chunks = [];
    return out;
  }
}

export interface ProxySessionOptions {
  /** Value of `env.PROXY_DEBUG` — logs session failures. */
  debug?: boolean;
  /** Keeps the tunnel alive after the 101 response has been returned. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Test hook: lets the unit tests inject an in-memory connector. */
export function setSocketConnector(connector: Connector | null): void {
  connectorCache = connector;
}

export interface VlessSessionHooks {
  /** Called instead of closing a WebSocket the session does not own. */
  close?: (code: number, reason: string) => void;
  debug?: boolean;
}

/**
 * Runs one VLESS session on an accepted server-side WebSocket.
 *
 * The caller has already validated the UUID, so from here on the only job is to
 * parse the VLESS header, open the outbound transport and pump bytes both ways.
 * Errors close the socket with a protocol code instead of throwing, which keeps
 * a hostile client from producing 5xx noise in the Worker log.
 */
export async function runVlessSession(
  server: WebSocket,
  early: Uint8Array,
  hooks: VlessSessionHooks = {},
): Promise<void> {
  const close = (code: number, reason: string) => {
    if (hooks.close) hooks.close(code, reason);
    else {
      try {
        server.close(code, reason);
      } catch {
        /* already closed */
      }
    }
  };

  const source = new WsSource(server);
  try {
    let buffer = early;
    let parsed = parseVlessRequest(buffer);
    let guard = 0;
    while ("incomplete" in parsed && guard++ < 8) {
      // A silent client must not keep the isolate alive forever.
      const chunk = await source.readUntil(5, guard === 1 ? 10_000 : 2_000);
      if (!chunk.byteLength) break;
      buffer = concat(buffer, chunk);
      if (buffer.byteLength > 4096) break;
      parsed = parseVlessRequest(buffer);
    }

    if (!("request" in parsed)) return close(1002, "invalid vless header");
    const { request: vless } = parsed;
    const payload = buffer.subarray(vless.headerLength);

    if (vless.command !== 1) return close(1003, "udp is not supported");

    const socket = await openSocket(vless.address, vless.port);
    if (!socket) {
      // No sockets API in this runtime: ordinary web browsing still works
      // through `fetch`, raw TCP/TLS does not.
      const forwarded = await forwardHttp(source, payload, vless, server);
      return close(forwarded ? 1000 : 1011, forwarded ? "done" : "no outbound transport");
    }

    // VLESS response header: version + addon length (0) — clients expect it.
    sendBytes(server, [new Uint8Array([vless.version, 0])]);
    if (payload.byteLength) sendBytes(server, [payload]);

    const writer = socket.writable.getWriter();
    const pumpUp = (async () => {
      try {
        if (payload.byteLength) await writer.write(payload);
        while (true) {
          const chunk = await source.read();
          if (!chunk) break;
          await writer.write(chunk);
        }
      } catch {
        /* client or upstream went away */
      } finally {
        try {
          await writer.close();
        } catch {
          /* already closed */
        }
      }
    })();

    const pumpDown = (async () => {
      const reader = socket.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.byteLength) sendBytes(server, [value]);
        }
      } catch {
        /* upstream closed */
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
        close(1000, "done");
      }
    })();

    await Promise.allSettled([pumpUp, pumpDown]);
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  } catch (error) {
    if (hooks.debug) console.error("vless session failed", error);
    close(1011, "proxy error");
  }
}

/** Reads the WebSocket upgrade body (Xray "?ed=" early data), if any. */
async function readEarlyData(request: Request): Promise<Uint8Array> {
  try {
    const body = await request.arrayBuffer();
    return body.byteLength ? new Uint8Array(body) : new Uint8Array(0);
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * Entry point used by the Worker: performs the WebSocket handshake and hands the
 * session over to {@link runVlessSession}.
 */
export async function handleVlessSession(request: Request, options: ProxySessionOptions = {}): Promise<Response> {
  const Pair = (globalThis as { WebSocketPair?: new () => [WebSocket, WebSocket] }).WebSocketPair;
  if (typeof Pair !== "function") {
    // Local preview harnesses (plain Node) have no WebSocket support.
    return new Response("websocket not supported in this runtime", { status: 501 });
  }
  const pair = new Pair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const early = await readEarlyData(request);
  // The session must not be awaited here: the client only starts sending frames
  // after it receives the 101, so we hand it to the runtime and answer right away.
  const session = runVlessSession(server, early, { debug: options.debug });
  if (options.waitUntil) options.waitUntil(session.catch(() => undefined));
  return new Response(null, { status: 101, webSocket: client } as ResponseInit);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function sendBytes(socket: WebSocket, chunks: Uint8Array[]): void {
  for (const chunk of chunks) {
    try {
      socket.send(chunk);
    } catch {
      return;
    }
  }
}

async function openSocket(address: string, port: number): Promise<SocketLike | null> {
  const connect = await getConnector();
  if (!connect) return null;
  try {
    return connect({ hostname: address, port });
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                       HTTP fallback (no sockets API)                       */
/* -------------------------------------------------------------------------- */

interface HttpHead {
  method: string;
  target: string;
  version: string;
  headers: Array<[string, string]>;
  /** Remaining bytes of the head + body that belong to the request. */
  bodyOffset: number;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Minimal HTTP/1.1 request-head parser (used only when raw sockets are missing). */
export function parseHttpHead(bytes: Uint8Array): HttpHead | null {
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.byteLength, 16 * 1024)));
  const end = text.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const lines = text.slice(0, end).split("\r\n");
  const requestLine = /^([A-Z]+) (\S+) HTTP\/(\d\.\d)$/.exec(lines[0]);
  if (!requestLine) return null;
  const headers: Array<[string, string]> = [];
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers.push([line.slice(0, index).trim(), line.slice(index + 1).trim()]);
  }
  return {
    method: requestLine[1],
    target: requestLine[2],
    version: requestLine[3],
    headers,
    bodyOffset: end + 4,
  };
}

function absolutizeTarget(head: HttpHead, address: string, port: number): string {
  const host = head.headers.find(([name]) => name.toLowerCase() === "host")?.[1] ?? address;
  if (/^https?:\/\//i.test(head.target)) return head.target;
  const scheme = port === 443 || port === 8443 ? "https" : "http";
  return `${scheme}://${host}${head.target.startsWith("/") ? head.target : `/${head.target}`}`;
}

/**
 * Proxies a plain HTTP/1.1 request through `fetch`. This exists because
 * `connect()` may be unavailable (older runtimes, some accounts): ordinary
 * browsing still works, raw TCP/TLS does not.
 */
async function forwardHttp(
  source: WsSource,
  payload: Uint8Array,
  vless: VlessRequest,
  socket: WebSocket,
): Promise<boolean> {
  let bytes = payload;
  let head = bytes.byteLength ? parseHttpHead(bytes) : null;
  if (!head) {
    // Give the client a short grace period to finish its request head, then
    // give up (raw TLS traffic cannot be proxied without the sockets API).
    const extra = await source.readAtLeast(1, 750);
    if (!extra.byteLength && !bytes.byteLength) return false;
    if (extra.byteLength) bytes = concat(bytes, extra);
    head = parseHttpHead(bytes);
    if (!head) return false;
  }

  const headers = new Headers();
  for (const [name, value] of head.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || name.toLowerCase() === "host") continue;
    try {
      headers.set(name, value);
    } catch {
      /* ignore malformed header from the client */
    }
  }

  const encoder = new TextEncoder();
  const body = bytes.subarray(head.bodyOffset);
  const hasBody = !["GET", "HEAD", "OPTIONS"].includes(head.method);
  try {
    const response = await fetch(absolutizeTarget(head, vless.address, vless.port), {
      method: head.method,
      headers,
      body: hasBody ? body.slice() : undefined,
      redirect: "manual",
    });

    const lines = [`HTTP/1.1 ${response.status} ${response.statusText || statusText(response.status)}`];
    for (const [name, value] of response.headers) {
      const lower = name.toLowerCase();
      // `fetch` already decoded the body, so the framing headers are rewritten.
      if (HOP_BY_HOP.has(lower) || lower === "content-length") continue;
      lines.push(`${name}: ${value}`);
    }
    lines.push("connection: close", "", "");
    sendBytes(socket, [encoder.encode(lines.join("\r\n"))]);

    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.byteLength) sendBytes(socket, [value]);
      }
    }
  } catch {
    return false;
  }
  return true;
}

function statusText(status: number): string {
  return status === 200 ? "OK" : status === 301 ? "Moved Permanently" : status === 302 ? "Found" : "Status";
}

/* -------------------------------------------------------------------------- */
/*                             request detection                              */
/* -------------------------------------------------------------------------- */

export interface ProxyTarget {
  /** UUID found in the path, if any. */
  uuid: string | null;
  /** True when the request looks like a WebSocket upgrade to the proxy path. */
  candidate: boolean;
}

/**
 * Detects proxy traffic. The check is deliberately strict and quiet: anything
 * that is not a WebSocket upgrade for the configured path is handed back to the
 * normal router, so a prober only ever sees the panel's ordinary 404 page.
 */
export function detectProxyTarget(request: Request, url: URL, proxyPath: string): ProxyTarget {
  const upgrade = request.headers.get("upgrade")?.toLowerCase() ?? "";
  if (upgrade !== "websocket") return { uuid: null, candidate: false };
  const path = normalizeProxyPath(proxyPath);
  if (url.pathname !== path && !url.pathname.startsWith(`${path}/`)) {
    return { uuid: null, candidate: false };
  }
  const rest = url.pathname.slice(path.length).replace(/^\/+/, "");
  const segments = rest.split("/").filter(Boolean);
  const candidate = segments.length ? segments[segments.length - 1] : (url.searchParams.get("id") ?? "");
  return { uuid: candidate || null, candidate: true };
}
