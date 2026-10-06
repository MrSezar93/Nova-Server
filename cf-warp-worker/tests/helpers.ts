/** Shared helpers for the test suite: KV stub, environment factory, WARP API mock. */

import type { Env } from "../src/types";

export class FakeKV {
  readonly store = new Map<string, string>();
  writes = 0;

  async get(key: string, type?: "text" | "json" | ArrayBuffer): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === "json") return JSON.parse(raw);
    return raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.writes++;
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }> {
    const prefix = options?.prefix ?? "";
    return { keys: [...this.store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) };
  }
}

export interface TestEnv extends Env {
  WARP_KV: KVNamespace;
  __kv: FakeKV;
}

export function makeEnv(overrides: Partial<Env> = {}): TestEnv {
  const kv = new FakeKV();
  const env = {
    WARP_KV: kv as unknown as KVNamespace,
    API_VERSION: "v0a2158",
    DISABLE_RAW_TLS: "1",
    __kv: kv,
    ...overrides,
  } as TestEnv;
  return env;
}

export function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

export interface MockWarpOptions {
  rateLimit?: boolean;
  teamTokenRejected?: boolean;
  accountPlus?: boolean;
}

export interface MockWarpState {
  requests: Array<{ method: string; path: string; body: unknown }>;
  devices: Map<string, Record<string, unknown>>;
}

/** Installs a fake `fetch` that emulates the Cloudflare WARP registration API. */
export function installWarpMock(options: MockWarpOptions = {}): MockWarpState {
  const state: MockWarpState = { requests: [], devices: new Map() };
  let deviceCounter = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (!/api\.cloudflareclient\.com|warp\.test/.test(url.host)) {
      throw new Error(`unexpected fetch to ${url.host} in tests`);
    }
    const bodyText = init?.body ? String(init.body) : "";
    state.requests.push({
      method: request.method,
      path: url.pathname,
      body: bodyText ? JSON.parse(bodyText) : undefined,
    });

    if (options.rateLimit) {
      return new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), { status: 429 });
    }

    const version = url.pathname.split("/")[1];
    const deviceIdMatch = /\/reg\/([^/]+)(\/.*)?$/.exec(url.pathname);

    if (request.method === "POST" && url.pathname === `/${version}/reg`) {
      const payload = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
      if (options.teamTokenRejected && payload.team_token) {
        return new Response(JSON.stringify({ errors: [{ message: "invalid team token" }] }), { status: 400 });
      }
      deviceCounter++;
      const id = `device-${deviceCounter}-${Math.random().toString(16).slice(2, 8)}`;
      const token = `token-${id}`;
      const device = {
        id,
        token,
        name: "test-device",
        type: "Android",
        model: payload.model,
        config: {
          client_id: "Uu8fHg==",
          interface: { addresses: { v4: `172.16.0.${2 + deviceCounter}/32`, v6: `2606:4700:110::${deviceCounter}/128` } },
          peers: [
            {
              public_key: "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
              endpoint: { host: "engage.cloudflareclient.com", v4: "162.159.192.1", ports: [2408] },
            },
          ],
        },
        account: { account_type: "free", warp_plus: Boolean(options.accountPlus), quota: 0, usage: 0, premium_data: 0 },
      };
      state.devices.set(id, device);
      return new Response(JSON.stringify(device), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (deviceIdMatch && deviceIdMatch[1] !== "reg") {
      const id = deviceIdMatch[1];
      const suffix = deviceIdMatch[2] ?? "";
      const device = state.devices.get(id);
      if (!device) return new Response(JSON.stringify({ errors: [{ message: "not found" }] }), { status: 404 });
      if (request.method === "GET" && suffix === "/account") {
        return new Response(JSON.stringify(device.account), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (request.method === "PUT" && suffix === "/account") {
        const payload = bodyText ? (JSON.parse(bodyText) as { license?: string }) : {};
        device.account = { ...(device.account as object), license: payload.license, warp_plus: true, account_type: "unlimited" };
        return new Response(JSON.stringify(device.account), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (request.method === "GET" && suffix === "/account/devices") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (request.method === "PATCH" && suffix === "") {
        const payload = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
        Object.assign(device, payload);
        return new Response(JSON.stringify(device), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (request.method === "GET" && suffix === "") {
        return new Response(JSON.stringify(device), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (request.method === "DELETE" && suffix === "") {
        state.devices.delete(id);
        return new Response("", { status: 204 });
      }
    }

    return new Response(JSON.stringify({ errors: [{ message: "unhandled" }] }), { status: 500 });
  }) as typeof fetch;

  return state;
}

export function restoreFetch(original: typeof fetch): void {
  globalThis.fetch = original;
}

export function jsonRequest(
  url: string,
  init: RequestInit & { json?: unknown; cookie?: string } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(init.json);
  }
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && !headers.has("origin")) {
    headers.set("origin", new URL(url).origin);
  }
  return new Request(url, { ...init, headers });
}

export function formRequest(url: string, fields: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin },
    body: new URLSearchParams(fields).toString(),
  });
}

export function sessionCookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("no set-cookie header");
  return header.split(";")[0];
}

/* -------------------------------------------------------------------------- */
/*                    WebSocket / TCP socket test doubles                     */
/* -------------------------------------------------------------------------- */

/** Minimal stand-in for the runtime's `WebSocket` (server side of a pair). */
export class FakeWebSocket {
  readyState = 0;
  /** Frames this socket sent (seen by the peer). */
  sent: unknown[] = [];
  /** Frames this socket received from the peer. */
  received: unknown[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;
  accepted = false;
  peer: FakeWebSocket | null = null;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  accept(): void {
    this.accepted = true;
    this.readyState = 1;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: unknown): void {
    this.sent.push(data);
    if (this.peer) {
      this.peer.received.push(data);
      this.peer.emit("message", { data });
    }
  }

  close(code = 1000, reason = ""): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close", { code, reason });
    this.peer?.emit("close", { code, reason });
  }

  /** Test helper: pushes a frame coming from the client. */
  deliver(data: unknown): void {
    this.received.push(data);
    this.emit("message", { data });
  }
}

export function fakeSocketPair(): { client: FakeWebSocket; server: FakeWebSocket } {
  const client = new FakeWebSocket();
  const server = new FakeWebSocket();
  client.peer = server;
  server.peer = client;
  server.accept();
  return { client, server };
}

/** In-memory duplex socket returned by the fake `connect()`. */
export class FakeSocket {
  readonly toTarget: Uint8Array[] = [];
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>;
  readonly address: string;
  closedFlag = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private resolveClosed!: () => void;

  constructor(address: string) {
    this.address = address;
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.toTarget.push(chunk);
      },
    });
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  /** Test helper: sends bytes back to the session ("upstream → client"). */
  push(bytes: Uint8Array): void {
    try {
      this.controller.enqueue(bytes);
    } catch {
      /* stream closed */
    }
  }

  close(): void {
    this.closedFlag = true;
    try {
      this.controller.close();
    } catch {
      /* already closed */
    }
    this.resolveClosed();
  }

  /** Everything the session wrote, as one buffer. */
  written(): Uint8Array {
    return concatBytes(this.toTarget);
  }
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Waits until `check()` is true (or the timeout elapses). */
export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}
