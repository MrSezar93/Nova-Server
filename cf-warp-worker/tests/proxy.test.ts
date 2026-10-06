/**
 * The built-in VLESS-over-WebSocket proxy: link generation, header parsing,
 * request detection and a full session driven through fake sockets.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  clashProxyList,
  detectProxyTarget,
  isValidUuid,
  newUuid,
  normalizeProxyPath,
  parseHttpHead,
  parseVlessRequest,
  proxyMeta,
  runVlessSession,
  setSocketConnector,
  singboxConfig,
  vlessLink,
  xrayConfig,
  type ProxyEndpoint,
} from "../src/lib/proxy";
import { FakeSocket, fakeSocketPair, concatBytes, waitFor } from "./helpers";

const endpoint: ProxyEndpoint = {
  uuid: "2076b1a8-6e6c-4d1c-9a1e-2f8a3c5d7e90",
  host: "nova-warp.example.workers.dev",
  port: 443,
  path: "/ws",
  name: "phone",
};

afterEach(() => {
  setSocketConnector(null);
});

/** Builds a VLESS request header (+ optional payload). */
function vlessHeader(options: {
  command?: number;
  address: string;
  port: number;
  version?: number;
}): Uint8Array {
  const bytes: number[] = [options.version ?? 0, options.command ?? 1];
  bytes.push((options.port >> 8) & 0xff, options.port & 0xff);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(options.address)) {
    bytes.push(1, ...options.address.split(".").map(Number));
  } else if (options.address.includes(":")) {
    bytes.push(3);
    for (const group of options.address.split(":")) {
      const value = parseInt(group || "0", 16);
      bytes.push((value >> 8) & 0xff, value & 0xff);
    }
  } else {
    const encoded = new TextEncoder().encode(options.address);
    bytes.push(2, encoded.length, ...encoded);
  }
  return new Uint8Array(bytes);
}

describe("proxy links", () => {
  it("builds a vless:// link that v2ray-family clients understand", () => {
    const link = vlessLink(endpoint);
    assert.ok(link.startsWith(`vless://${endpoint.uuid}@nova-warp.example.workers.dev:443?`));
    const params = new URL(link.replace("vless://", "https://")).searchParams;
    assert.equal(params.get("type"), "ws");
    assert.equal(params.get("security"), "tls");
    assert.equal(params.get("sni"), "nova-warp.example.workers.dev");
    assert.equal(params.get("host"), "nova-warp.example.workers.dev");
    assert.equal(params.get("path"), "/ws");
    assert.ok(link.endsWith("#phone"));

    const padded = vlessLink({ ...endpoint, padding: true });
    assert.match(padded, /path=%2Fws%3Fed%3D2048|path=\/ws\?ed=2048/);
  });

  it("renders Clash / sing-box / Xray outbounds", () => {
    const clash = clashProxyList([endpoint]);
    assert.match(clash, /type: vless/);
    assert.match(clash, /network: ws/);
    assert.match(clash, /servername: nova-warp\.example\.workers\.dev/);
    assert.match(clash, /path: "\/ws"/);

    const singbox = JSON.parse(singboxConfig([endpoint])) as {
      outbounds: Array<Record<string, unknown>>;
    };
    assert.equal(singbox.outbounds[0].type, "vless");
    assert.equal((singbox.outbounds[0].tls as Record<string, unknown>).enabled, true);
    assert.equal((singbox.outbounds[0].transport as Record<string, unknown>).path, "/ws");

    const xray = JSON.parse(xrayConfig([endpoint])) as { outbounds: Array<Record<string, unknown>> };
    const stream = xray.outbounds[0].streamSettings as Record<string, Record<string, unknown>>;
    assert.equal(stream.network, "ws");
    assert.equal(stream.tlsSettings.serverName, "nova-warp.example.workers.dev");

    const meta = proxyMeta(endpoint);
    assert.equal(meta.uuid, endpoint.uuid);
    assert.ok(meta.url.startsWith("vless://"));
  });

  it("generates valid UUIDs and normalises the WebSocket path", () => {
    const uuid = newUuid();
    assert.equal(isValidUuid(uuid), true);
    assert.equal(isValidUuid("not-a-uuid"), false);
    assert.equal(normalizeProxyPath("ws"), "/ws");
    assert.equal(normalizeProxyPath("/api/stream/"), "/api/stream");
    assert.equal(normalizeProxyPath(undefined), "/ws");
  });
});

describe("vless request parsing", () => {
  it("parses IPv4, domain and IPv6 destinations", () => {
    const ipv4 = parseVlessRequest(vlessHeader({ address: "1.1.1.1", port: 443 }));
    assert.ok("request" in ipv4);
    assert.equal(ipv4.request.address, "1.1.1.1");
    assert.equal(ipv4.request.port, 443);
    assert.equal(ipv4.request.headerLength, 9);

    const domain = parseVlessRequest(vlessHeader({ address: "example.com", port: 80 }));
    assert.ok("request" in domain);
    assert.equal(domain.request.address, "example.com");
    assert.equal(domain.request.headerLength, 6 + "example.com".length);

    const ipv6 = parseVlessRequest(vlessHeader({ address: "2606:4700:4700:0:0:0:0:1111", port: 853 }));
    assert.ok("request" in ipv6);
    assert.equal(ipv6.request.port, 853);
    assert.equal(ipv6.request.headerLength, 21);
    assert.equal(ipv6.request.address, "2606:4700:4700:0:0:0:0:1111");
  });

  it("reports incomplete and invalid headers", () => {
    assert.deepEqual(parseVlessRequest(new Uint8Array([0, 1])), { incomplete: true });
    assert.deepEqual(parseVlessRequest(new Uint8Array([0, 1, 0, 80, 2, 20])), { incomplete: true });
    assert.deepEqual(parseVlessRequest(new Uint8Array([0, 7, 0, 80, 1, 1, 1, 1, 1])), { invalid: true });
  });

  it("detects only WebSocket upgrades on the configured path", () => {
    const path = "/ws";
    const upgrade = new Request(`https://panel.test${path}/${endpoint.uuid}`, {
      headers: { upgrade: "websocket" },
    });
    const detected = detectProxyTarget(upgrade, new URL(upgrade.url), path);
    assert.equal(detected.candidate, true);
    assert.equal(detected.uuid, endpoint.uuid);

    // a plain GET on the same path must fall through to the panel 404 page
    const plain = new Request(`https://panel.test${path}/${endpoint.uuid}`);
    assert.equal(detectProxyTarget(plain, new URL(plain.url), path).candidate, false);

    // other paths are never treated as proxy traffic
    const otherPath = new Request(`https://panel.test/other/${endpoint.uuid}`, {
      headers: { upgrade: "websocket" },
    });
    assert.equal(detectProxyTarget(otherPath, new URL(otherPath.url), path).candidate, false);

    const viaQuery = new Request(`https://panel.test${path}?id=${endpoint.uuid}`, {
      headers: { upgrade: "websocket" },
    });
    assert.equal(detectProxyTarget(viaQuery, new URL(viaQuery.url), path).uuid, endpoint.uuid);
  });

  it("parses an HTTP/1.1 request head for the fetch fallback", () => {
    const raw = new TextEncoder().encode(
      "GET /index.html HTTP/1.1\r\nHost: example.com\r\nUser-Agent: test\r\n\r\nbody-bytes",
    );
    const head = parseHttpHead(raw);
    assert.ok(head);
    assert.equal(head.method, "GET");
    assert.equal(head.target, "/index.html");
    assert.equal(head.bodyOffset, raw.byteLength - "body-bytes".length);
    assert.deepEqual(head.headers[0], ["Host", "example.com"]);
    assert.equal(parseHttpHead(new TextEncoder().encode("not http")), null);
  });
});

describe("vless session", () => {
  it("pipes bytes both ways through the TCP socket API", async () => {
    const { client, server } = fakeSocketPair();
    const sockets: FakeSocket[] = [];
    setSocketConnector((address) => {
      const socket = new FakeSocket(typeof address === "string" ? address : `${address.hostname}:${address.port}`);
      sockets.push(socket);
      return socket;
    });

    const header = vlessHeader({ address: "example.com", port: 80 });
    const payload = new TextEncoder().encode("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");
    const session = runVlessSession(server, concatBytes([header, payload]));

    await waitFor(() => sockets.length === 1);
    assert.equal(sockets[0].address, "example.com:80");
    await waitFor(() => sockets[0].toTarget.length > 0);
    assert.equal(new TextDecoder().decode(sockets[0].written()), new TextDecoder().decode(payload));

    // the VLESS response header (version + addon length 0) must come first
    await waitFor(() => client.received.length >= 1);
    const first = client.received[0] as Uint8Array;
    assert.deepEqual(Array.from(first), [0, 0]);

    // upstream → client (the request payload was already echoed as frame #1)
    sockets[0].push(new TextEncoder().encode("HTTP/1.0 200 OK\r\n\r\nhi"));
    await waitFor(() => client.received.length >= 3);
    const upstreamFrame = client.received[client.received.length - 1] as Uint8Array;
    assert.match(new TextDecoder().decode(upstreamFrame), /200 OK/);

    // a later client frame is forwarded too
    server.deliver(new TextEncoder().encode("extra"));
    await waitFor(() => sockets[0].toTarget.length >= 2);
    assert.equal(new TextDecoder().decode(sockets[0].written()).endsWith("extra"), true);

    sockets[0].close();
    await session;
  });

  it("rejects UDP and malformed headers without opening a socket", async () => {
    let connections = 0;
    setSocketConnector(() => {
      connections++;
      return null as never;
    });

    const udp = fakeSocketPair();
    await runVlessSession(udp.server, vlessHeader({ address: "1.1.1.1", port: 53, command: 2 }));
    assert.equal(connections, 0);
    assert.equal(udp.server.closeCode, 1003);

    const bad = fakeSocketPair();
    await runVlessSession(bad.server, new Uint8Array([0, 9, 0, 80, 1, 1, 1, 1, 1]));
    assert.equal(bad.server.closeCode, 1002);
  });

  it("falls back to HTTP over fetch when the runtime has no sockets API", async () => {
    const { client, server } = fakeSocketPair();
    setSocketConnector(null);

    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("hello from upstream", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "19" },
      });
    }) as typeof fetch;

    try {
      const header = vlessHeader({ address: "example.com", port: 80 });
      const payload = new TextEncoder().encode("GET /hello HTTP/1.1\r\nHost: example.com\r\n\r\n");
      await runVlessSession(server, concatBytes([header, payload]));

      assert.deepEqual(seen, ["http://example.com/hello"]);
      const text = new TextDecoder().decode(concatBytes(client.received as Uint8Array[]));
      assert.match(text, /^HTTP\/1\.1 200 OK\r\n/);
      assert.match(text, /content-type: text\/plain/i);
      assert.match(text, /hello from upstream$/);
      assert.match(text, /connection: close/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("closes the session when there is neither a socket API nor an HTTP request", async () => {
    const { server } = fakeSocketPair();
    setSocketConnector(null);
    // TLS ClientHello-ish bytes: not HTTP, so nothing can be forwarded.
    await runVlessSession(server, concatBytes([vlessHeader({ address: "1.1.1.1", port: 443 }), new Uint8Array([22, 3, 1, 0, 5])]));
    assert.equal(server.closeCode, 1011);
  });
});
