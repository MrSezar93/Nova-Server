/** Cloudflare WARP API client (transport, error mapping, config normalisation). */
import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair } from "../src/lib/wg";
import {
  normalizeDeviceConfig,
  registerIdentity,
  WarpApi,
  WarpApiError,
} from "../src/lib/warp";
import { installWarpMock, restoreFetch } from "./helpers";

const originalFetch = globalThis.fetch;

test("registers a device and normalises its config", async (t) => {
  const mock = installWarpMock();
  t.after(() => restoreFetch(originalFetch));
  const api = new WarpApi({ baseUrl: "https://api.cloudflareclient.com", apiVersion: "v0a2158" });
  const result = await registerIdentity(api, { model: "PC" });

  assert.match(result.identity.deviceId, /^device-/);
  assert.ok(result.identity.token);
  assert.equal(result.identity.addressV4.startsWith("172.16.0."), true);
  assert.equal(result.identity.peerPublicKey, "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=");
  assert.equal(result.identity.clientId, "Uu8fHg==");
  assert.equal(result.identity.endpointHost, "engage.cloudflareclient.com");
  assert.equal(result.identity.endpointPort, 2408);

  const registerCall = mock.requests[0];
  assert.equal(registerCall.method, "POST");
  assert.equal(registerCall.path, "/v0a2158/reg");
  const body = registerCall.body as Record<string, unknown>;
  assert.equal(body.key_type, "curve25519");
  assert.equal(body.tunnel_type, "wireguard");
  assert.equal(body.locale, "en_US");
  assert.equal(typeof body.tos, "string");
  // a PATCH renaming the device is expected as best effort
  assert.ok(mock.requests.some((request) => request.method === "PATCH"));
});

test("sends the Android headers Cloudflare expects", async (t) => {
  t.after(() => restoreFetch(originalFetch));
  const seen: Headers[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(request.headers);
    return new Response(
      JSON.stringify({
        id: "device-1",
        token: "t",
        config: {
          interface: { addresses: { v4: "172.16.0.2/32" } },
          peers: [{ public_key: "peer", endpoint: { host: "engage.cloudflareclient.com", ports: [2408] } }],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const api = new WarpApi({ apiVersion: "v0a5641" });
  await api.register("public-key");
  const headers = seen[0];
  assert.match(headers.get("user-agent") ?? "", /^1\.1\.1\.1\//);
  assert.ok(headers.get("cf-client-version"));
  assert.equal(headers.get("content-type"), "application/json; charset=UTF-8");
});

test("maps Cloudflare errors to friendly kinds", async (t) => {
  t.after(() => restoreFetch(originalFetch));
  const cases: Array<[number, string]> = [
    [400, "bad_request"],
    [401, "auth"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "server"],
  ];
  for (const [status, kind] of cases) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: `boom-${status}` }] }), { status })) as typeof fetch;
    const api = new WarpApi({ apiVersion: "v0a2158", allowRawTls: false });
    await assert.rejects(
      () => api.getDevice("device-1", "token"),
      (error: unknown) => {
        assert.ok(error instanceof WarpApiError);
        assert.equal(error.kind, kind);
        assert.match(error.message, /./);
        return true;
      },
      `status ${status}`,
    );
  }
});

test("network failures surface as a network error", async (t) => {
  t.after(() => restoreFetch(originalFetch));
  globalThis.fetch = (async () => {
    throw new Error("dns down");
  }) as typeof fetch;
  const api = new WarpApi({ apiVersion: "v0a2158", allowRawTls: false });
  await assert.rejects(
    () => api.getDevice("device-1", "token"),
    (error: unknown) => error instanceof WarpApiError && error.kind === "network",
  );
});

test("429 falls back to the raw TLS transport when enabled", async (t) => {
  t.after(() => restoreFetch(originalFetch));
  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  const api = new WarpApi({
    apiVersion: "v0a2158",
    baseUrl: "https://warp.test.invalid",
    allowRawTls: true,
    timeoutMs: 1500,
  });
  await assert.rejects(
    () => api.getDevice("device-1", "token"),
    (error: unknown) =>
      error instanceof WarpApiError && (error.kind === "blocked" || error.kind === "network"),
  );
});

test("normalizeDeviceConfig rejects incomplete responses", () => {
  assert.throws(() => normalizeDeviceConfig({ id: "x" }), /آدرس یا کلید Peer/);
  const config = normalizeDeviceConfig({
    id: "x",
    config: {
      interface: { addresses: { v4: "172.16.0.5/32" } },
      peers: [{ public_key: "peer", endpoint: { v4: "162.159.192.1", ports: [500, 2408] } }],
    },
  });
  assert.equal(config.endpointHost, "162.159.192.1");
  assert.equal(config.endpointPort, 500);
  assert.equal(config.addressV4, "172.16.0.5");
});

test("licenses are bound and account state is refreshed", async (t) => {
  const mock = installWarpMock({ accountPlus: true });
  t.after(() => restoreFetch(originalFetch));
  const api = new WarpApi({ apiVersion: "v0a2158" });
  const { identity } = await registerIdentity(api);
  const account = await api.bindLicense(identity.deviceId, identity.token, "LICENSE-KEY-123");
  assert.equal(account.warp_plus, true);
  assert.equal(mock.requests.some((request) => request.method === "PUT"), true);
  const devices = await api.listDevices(identity.deviceId, identity.token);
  assert.deepEqual(devices, []);
});

test("key pairs used for registration are freshly generated", async (t) => {
  installWarpMock();
  t.after(() => restoreFetch(originalFetch));
  const api = new WarpApi({ apiVersion: "v0a2158" });
  const first = await registerIdentity(api);
  const second = await registerIdentity(api);
  assert.notEqual(first.identity.publicKey, second.identity.publicKey);
  const keys = await generateKeyPair();
  assert.notEqual(keys.publicKey, first.identity.publicKey);
});
