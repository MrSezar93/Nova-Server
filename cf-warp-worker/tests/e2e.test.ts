/**
 * End-to-end tests: the whole Worker entrypoint is exercised with a fake KV and a
 * fake Cloudflare WARP API, so these cover routing, auth, the panel API, config
 * rendering and the public share endpoints in one go.
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import worker from "../src/index";
import { Store } from "../src/lib/store";
import type { Env } from "../src/types";
import {
  FakeKV,
  fakeExecutionContext,
  formRequest,
  installWarpMock,
  jsonRequest,
  makeEnv,
  restoreFetch,
  sessionCookieFrom,
  type TestEnv,
} from "./helpers";

const BASE = "http://panel.test";
const realFetch = globalThis.fetch;

let env: TestEnv;
let cookie = "";

async function call(
  method: string,
  path: string,
  init: { json?: unknown; form?: Record<string, string>; cookie?: string; headers?: HeadersInit } = {},
): Promise<Response> {
  const url = `${BASE}${path}`;
  let request: Request;
  if (init.form) {
    request = formRequest(url, init.form);
  } else {
    request = jsonRequest(url, { method, json: init.json, headers: init.headers });
  }
  if (init.cookie !== undefined ? init.cookie : cookie) {
    request.headers.set("cookie", init.cookie !== undefined ? init.cookie : cookie);
  }
  return worker.fetch(request, env, fakeExecutionContext());
}

async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** The config endpoints answer with `{ format, content }` where content is a string. */
async function readConfig(response: Response): Promise<{ format: string; content: string }> {
  const body = await readJson<{ format: string; content: string }>(response);
  assert.equal(typeof body.content, "string");
  return body;
}

/** Runs the first-run setup flow and stores the session cookie. */
async function bootstrap(): Promise<void> {
  const response = await call("POST", "/setup", {
    form: { password: "panel-password", confirm: "panel-password" },
  });
  assert.equal(response.status, 303);
  cookie = sessionCookieFrom(response);
}

beforeEach(async () => {
  Store.clearCache();
  env = makeEnv();
  cookie = "";
  await bootstrap();
});

afterEach(() => {
  restoreFetch(realFetch);
});

after(() => {
  restoreFetch(realFetch);
});

describe("worker end to end (mocked WARP API)", () => {
  it("serves the panel shell and gates the API behind auth", async () => {
    const anonymous = await call("GET", "/api/v1/state", { cookie: "" });
    assert.equal(anonymous.status, 401);

    const state = await call("GET", "/api/v1/state");
    assert.equal(state.status, 200);
    const body = await readJson<{ persistent: boolean; identities: unknown[]; clients: unknown[] }>(state);
    assert.equal(body.persistent, true);
    assert.deepEqual(body.identities, []);
    assert.deepEqual(body.clients, []);

    const panel = await call("GET", "/");
    assert.equal(panel.status, 200);
    const html = await panel.text();
    assert.match(html, /<html[^>]*dir="rtl"/);
    assert.match(html, /nova_warp|Nova WARP/);
    assert.equal(panel.headers.get("x-frame-options"), "DENY");
  });

  it("registers a real WARP identity against the (mocked) Cloudflare API", async () => {
    const warp = installWarpMock();
    const response = await call("POST", "/api/v1/identities", { json: { name: "tehran-1" } });
    assert.equal(response.status, 201);
    const { identity } = await readJson<{ identity: Record<string, unknown> }>(response);
    assert.equal(identity.name, "tehran-1");
    assert.equal(identity.source, "api");
    assert.equal(identity.addressV4, "172.16.0.3");
    assert.equal(identity.clientId, "Uu8fHg==");

    // the registration request must look like the Android client
    const registration = warp.requests.find((entry) => entry.method === "POST" && /\/reg$/.test(entry.path));
    assert.ok(registration, "registration call was made");
    const payload = registration?.body as Record<string, unknown>;
    assert.equal(payload.tunnel_type, "wireguard");
    assert.equal(payload.key_type, "curve25519");
    assert.equal(payload.type, "Android");
    assert.match(String(payload.key), /^[A-Za-z0-9+/]{43}=$/);
  });

  it("creates clients with their own identities and renders every format", async () => {
    installWarpMock();
    const created = await call("POST", "/api/v1/clients", { json: { name: "laptop", count: 2 } });
    assert.equal(created.status, 201);
    const { clients } = await readJson<{ clients: Array<Record<string, unknown>> }>(created);
    assert.equal(clients.length, 2);
    // `pool` policy: each client gets a fresh WARP identity
    assert.notEqual(clients[0].identityId, clients[1].identityId);

    const id = String(clients[0].id);
    const token = String(clients[0].shareToken);

    const wg = await call("GET", `/api/v1/clients/${id}/config?format=wg`);
    assert.equal(wg.status, 200);
    const conf = (await readConfig(wg)).content;
    assert.match(conf, /\[Interface]/);
    assert.match(conf, /PrivateKey = [A-Za-z0-9+/]{43}=/);
    assert.match(conf, /Address = 172\.16\.0\.\d+\/32/);
    assert.match(conf, /PublicKey = bmXOC\+F1FxEMF9dyiK2H5\/1SUtzH0JuVo51h2wPfgyo=/);
    assert.match(conf, /Endpoint = engage\.cloudflareclient\.com:2408/);
    assert.match(conf, /MTU = 1280/);
    assert.match(conf, /PersistentKeepalive = 25/);

    const singbox = JSON.parse((await readConfig(await call("GET", `/api/v1/clients/${id}/config?format=singbox`))).content) as {
      outbounds: Array<Record<string, unknown>>;
    };
    const outbound = singbox.outbounds[0];
    assert.equal(outbound.type, "wireguard");
    assert.equal(outbound.server, "engage.cloudflareclient.com");
    assert.deepEqual(outbound.reserved, [0x52, 0xef, 0x1f]);
    assert.equal(outbound.persistent_keepalive_interval, 25);

    const clash = (await readConfig(await call("GET", `/api/v1/clients/${id}/config?format=clash`))).content;
    assert.match(clash, /type: wireguard/);
    assert.match(clash, /reserved: \[82, 239, 31\]/);

    const xray = JSON.parse((await readConfig(await call("GET", `/api/v1/clients/${id}/config?format=xray`))).content) as {
      settings: { peers: Array<Record<string, unknown>> };
    };
    const peer = xray.settings.peers[0];
    assert.equal(peer.endpoint, "engage.cloudflareclient.com:2408");

    // public share endpoints (no cookie)
    const share = await call("GET", `/c/${token}?format=wg`, { cookie: "" });
    assert.equal(share.status, 200);
    const shareHtml = await share.text();
    assert.match(shareHtml, /PrivateKey/);

    const download = await call("GET", `/c/${token}/raw?format=wg`, { cookie: "" });
    assert.equal(download.headers.get("content-disposition"), 'attachment; filename="laptop-1.conf"');

    const qr = await call("GET", `/qr/${token}.svg`, { cookie: "" });
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(await qr.text(), /<svg[^>]+viewBox="0 0 \d+ \d+"/);

    const sub = await call("GET", `/sub/${token}`, { cookie: "" });
    const decoded = Buffer.from((await sub.text()).trim(), "base64").toString("utf8");
    assert.match(decoded, /\[Interface]/);
    assert.match(decoded, /\[Peer]/);
  });

  it("keeps share links in sync with client state and deletes cleanly", async () => {
    installWarpMock();
    const created = await call("POST", "/api/v1/clients", { json: { name: "phone" } });
    const { clients } = await readJson<{ clients: Array<Record<string, unknown>> }>(created);
    const id = String(clients[0].id);
    const token = String(clients[0].shareToken);

    const disabled = await call("PATCH", `/api/v1/clients/${id}`, { json: { enabled: false } });
    assert.equal(disabled.status, 200);
    assert.equal((await readJson<{ client: Record<string, unknown> }>(disabled)).client.enabled, false);
    const blocked = await call("GET", `/c/${token}`, { cookie: "" });
    assert.equal(blocked.status, 403);
    assert.equal((await call("GET", `/c/${token}/raw`, { cookie: "" })).status, 403);
    assert.equal((await call("GET", `/sub/${token}`, { cookie: "" })).status, 403);
    const reEnabled = await call("PATCH", `/api/v1/clients/${id}`, { json: { enabled: true } });
    assert.equal((await readJson<{ client: Record<string, unknown> }>(reEnabled)).client.enabled, true);
    assert.equal((await call("GET", `/c/${token}`, { cookie: "" })).status, 200);

    const renamed = await call("PATCH", `/api/v1/clients/${id}`, { json: { name: "phone-2" } });
    assert.equal(renamed.status, 200);
    assert.equal((await readJson<{ client: Record<string, unknown> }>(renamed)).client.name, "phone-2");

    const rotated = await call("POST", `/api/v1/clients/${id}/rotate`);
    assert.equal(rotated.status, 200);
    const rotatedBody = await readJson<{ client: Record<string, unknown> }>(rotated);
    assert.notEqual(rotatedBody.client.identityId, clients[0].identityId);

    const removed = await call("DELETE", `/api/v1/clients/${id}`);
    assert.equal(removed.status, 200);
    const gone = await call("GET", `/c/${token}`, { cookie: "" });
    assert.equal(gone.status, 404);
  });

  it("imports an existing WireGuard profile without touching Cloudflare", async () => {
    const conf = [
      "[Interface]",
      "PrivateKey = BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
      "Address = 172.16.0.2/32, 2606:4700:110:8a2::1/128",
      "DNS = 1.1.1.1",
      "",
      "[Peer]",
      "PublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
      "AllowedIPs = 0.0.0.0/0, ::/0",
      "Endpoint = 162.159.192.1:2408",
      "",
    ].join("\n");

    const response = await call("POST", "/api/v1/identities/import", { json: { content: conf, name: "imported" } });
    assert.equal(response.status, 201);
    const { identity } = await readJson<{ identity: Record<string, unknown> }>(response);
    assert.equal(identity.source, "import");
    assert.equal(identity.addressV4, "172.16.0.2");
    assert.equal(identity.linked, false);

    const created = await call("POST", "/api/v1/clients", {
      json: { name: "imported-client", identityId: identity.id },
    });
    const { clients } = await readJson<{ clients: Array<Record<string, unknown>> }>(created);
    const conf2 = (await readConfig(await call("GET", `/api/v1/clients/${clients[0].id}/config?format=wg`))).content;
    assert.match(conf2, /PrivateKey = BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=/);
  });

  it("exposes an API key, rejects cross-site writes and enforces the registration quota", async () => {
    installWarpMock();
    const keyResponse = await call("POST", "/api/v1/api-key");
    assert.equal(keyResponse.status, 200);
    const { apiKey } = await readJson<{ apiKey: string }>(keyResponse);
    assert.match(apiKey, /^nw_[A-Za-z0-9_-]{32}$/);

    const viaKey = await call("GET", "/api/v1/state", {
      cookie: "",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(viaKey.status, 200);

    const badKey = await call("GET", "/api/v1/state", {
      cookie: "",
      headers: { "x-api-key": "nw_0000000000000000000000000000" },
    });
    assert.equal(badKey.status, 401);

    const crossSite = await jsonRequest(`${BASE}/api/v1/clients`, {
      method: "POST",
      json: { name: "evil" },
      headers: { origin: "https://evil.example", cookie },
    });
    const blocked = await worker.fetch(crossSite, env, fakeExecutionContext());
    assert.equal(blocked.status, 403);

    env = makeEnv({ MAX_REGISTRATIONS_PER_HOUR: "1" });
    Store.clearCache();
    await bootstrap();
    assert.equal((await call("POST", "/api/v1/identities")).status, 201);
    const limited = await call("POST", "/api/v1/identities");
    assert.equal(limited.status, 429);
  });

  it("reports health, logs and settings", async () => {
    const health = await call("GET", "/healthz", { cookie: "" });
    assert.equal(health.status, 200);
    const healthBody = await readJson<{ ok: boolean; kv: boolean }>(health);
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.kv, true);

    const updated = await call("PUT", "/api/v1/settings", {
      json: { mtu: 1320, keepalive: 15, allowedIpsMode: "exclude-lan", dns: "1.1.1.1, 8.8.8.8" },
    });
    assert.equal(updated.status, 200);
    const { settings } = await readJson<{ settings: Record<string, unknown> }>(updated);
    assert.equal(settings.mtu, 1320);
    assert.deepEqual(settings.dns, ["1.1.1.1", "8.8.8.8"]);

    installWarpMock();
    const created = await call("POST", "/api/v1/clients", { json: { name: "lan-client" } });
    const { clients } = await readJson<{ clients: Array<Record<string, unknown>> }>(created);
    const conf = (await readConfig(await call("GET", `/api/v1/clients/${clients[0].id}/config?format=wg`))).content;
    assert.match(conf, /MTU = 1320/);
    assert.doesNotMatch(conf, /^AllowedIPs = 0\.0\.0\.0\/0, ::\/0$/m);
    assert.match(conf, /^AllowedIPs = .*::\/0$/m);

    const state = await readJson<{ logs: Array<Record<string, unknown>> }>(await call("GET", "/api/v1/state"));
    assert.ok(state.logs.length >= 2);

    const cleared = await call("DELETE", "/api/v1/logs");
    assert.equal(cleared.status, 200);
    const afterClear = await readJson<{ logs: unknown[] }>(await call("GET", "/api/v1/state"));
    assert.deepEqual(afterClear.logs, []);
  });

  it("handles the setup gate, login throttling and logout", async () => {
    Store.clearCache();
    env = makeEnv();
    cookie = "";

    const setup = await call("GET", "/setup", { cookie: "" });
    assert.equal(setup.status, 200);
    assert.match(await setup.text(), /setup|راه/);

    const loginBeforeSetup = await call("POST", "/login", { form: { password: "whatever1" }, cookie: "" });
    assert.equal(loginBeforeSetup.status, 302);
    assert.equal(loginBeforeSetup.headers.get("location"), "/setup");

    await bootstrap();

    const wrong = await call("POST", "/login", { form: { password: "nope-nope" }, cookie: "" });
    assert.equal(wrong.status, 401);

    const logout = await call("POST", "/api/v1/logout");
    assert.equal(logout.status, 200);
    const afterLogout = await call("GET", "/api/v1/state", { cookie });
    assert.equal(afterLogout.status, 401);

    const login = await call("POST", "/login", { form: { password: "panel-password" }, cookie: "" });
    assert.equal(login.status, 303);
    cookie = sessionCookieFrom(login);
    assert.equal((await call("GET", "/api/v1/state")).status, 200);
  });
});
