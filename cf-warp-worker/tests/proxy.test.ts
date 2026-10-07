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
  parseVlessMessage,
  parseVlessRequest,
  readEarlyData,
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
const TEST_UUID = "2076b1a8-6e6c-4d1c-9a1e-2f8a3c5d7e90";
const TEST_UUID_BYTES = Uint8Array.from(TEST_UUID.replace(/-/g, "").match(/.{2}/g)!.map((pair) => parseInt(pair, 16)));

/**
 * A message as a real client sends it:
 *   [version][uuid 16B][addon length][command][port 2B][atyp][address][addons]
 */
function vlessMessage(options: {
  command?: number;
  address: string;
  port: number;
  version?: number;
  addons?: Uint8Array;
}): Uint8Array {
  const addons = options.addons ?? new Uint8Array(0);
  const prefix = new Uint8Array([options.version ?? 0, ...TEST_UUID_BYTES, addons.byteLength]);
  const encoded = new TextEncoder().encode(options.address);
  const body: number[] = [options.command ?? 1, (options.port >> 8) & 0xff, options.port & 0xff];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(options.address)) body.push(1, ...options.address.split(".").map(Number));
  else if (options.address.includes(":")) body.push(3);
  else body.push(2, encoded.length, ...encoded);
  return concatBytes([prefix, Uint8Array.from(body), addons]);
}

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

    const header = vlessMessage({ address: "example.com", port: 80 });
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

    // upstream → client
    sockets[0].push(new TextEncoder().encode("HTTP/1.0 200 OK\r\n\r\nhi"));
    await waitFor(() => client.received.length >= 2);
    const upstreamFrame = client.received[client.received.length - 1] as Uint8Array;
    assert.match(new TextDecoder().decode(upstreamFrame), /200 OK/);

    // a later client frame is forwarded too
    server.deliver(new TextEncoder().encode("extra"));
    await waitFor(() => sockets[0].toTarget.length >= 2);
    assert.equal(new TextDecoder().decode(sockets[0].written()).endsWith("extra"), true);

    sockets[0].close();
    await session;
  });

  it("waits for a header that arrives after the session started", async () => {
    // Regression: a real client sends its first frame *after* the 101, so the
    // byte source has to keep accounting for chunks that arrive while reading.
    const { server } = fakeSocketPair();
    const sockets: FakeSocket[] = [];
    setSocketConnector((address) => {
      const socket = new FakeSocket(typeof address === "string" ? address : `${address.hostname}:${address.port}`);
      sockets.push(socket);
      return socket;
    });

    const session = runVlessSession(server, new Uint8Array(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.deliver(vlessMessage({ address: "10.0.0.1", port: 3128 }));
    await waitFor(() => sockets.length === 1);
    assert.equal(sockets[0].address, "10.0.0.1:3128");
    server.close(1000, "done");
    await session;
    assert.equal(sockets[0].closedFlag, true, "the upstream socket is torn down with the client");
  });

  it("reads xray early data out of the upgrade body", async () => {
    const body = concatBytes([vlessMessage({ address: "203.0.113.7", port: 8443 }), new TextEncoder().encode("ping")]);
    const withBody = new Request("https://panel.test/ws/uuid?ed=2048", { method: "POST", body });
    assert.deepEqual([...(await readEarlyData(withBody))], [...body]);

    const empty = new Request("https://panel.test/ws/uuid?ed=2048", { method: "POST" });
    assert.equal((await readEarlyData(empty)).byteLength, 0);
  });

  it("rejects UDP and malformed headers without opening a socket", async () => {
    let connections = 0;
    setSocketConnector(() => {
      connections++;
      return null as never;
    });

    const udp = fakeSocketPair();
    await runVlessSession(udp.server, vlessMessage({ address: "1.1.1.1", port: 53, command: 2 }));
    assert.equal(connections, 0);
    assert.equal(udp.server.closeCode, 1003);

    const bad = fakeSocketPair();
    await runVlessSession(bad.server, new Uint8Array([0, 1, 2, 3]));
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
      const header = vlessMessage({ address: "example.com", port: 80 });
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
    await runVlessSession(server, concatBytes([vlessMessage({ address: "1.1.1.1", port: 443 }), new Uint8Array([22, 3, 1, 0, 5])]));
    assert.equal(server.closeCode, 1011);
  });
});

describe("vless messages as sent on the wire", () => {
  const uuid = TEST_UUID;
  const uuidBytes = TEST_UUID_BYTES;

  function message(options: {
    address: string;
    port: number;
    atyp?: number;
    addons?: Uint8Array;
    version?: number;
    body?: Uint8Array;
  }): Uint8Array {
    const portBytes = [options.port >> 8, options.port & 0xff];
    const addons = options.addons ?? new Uint8Array(0);
    const head: number[] = [options.version ?? 0, ...uuidBytes, addons.byteLength, 1, ...portBytes];
    if (options.atyp === 2) {
      const name = new TextEncoder().encode(options.address);
      head.push(2, name.length, ...name);
    } else {
      head.push(1, ...options.address.split(".").map(Number));
    }
    return concatBytes([Uint8Array.from([...head, ...addons]), options.body ?? new Uint8Array(0)]);
  }

  it("parses a real client message including the 17-byte prefix", () => {
    const body = new TextEncoder().encode("GET / HTTP/1.0\r\n\r\n");
    const parsed = parseVlessMessage(message({ address: "127.0.0.1", port: 8080, body }));
    assert.ok("message" in parsed);
    assert.equal(parsed.message.uuid, uuid);
    assert.equal(parsed.message.command, 1);
    assert.equal(parsed.message.port, 8080);
    assert.equal(parsed.message.address, "127.0.0.1");
    assert.equal(parsed.message.headerLength, 26, "17 prefix bytes + 9 header bytes");
    assert.equal(parsed.message.addonLength, 0);
    assert.deepEqual(
      [...message({ address: "127.0.0.1", port: 8080, body }).subarray(parsed.message.headerLength)],
      [...body],
    );
  });

  it("skips addons and domain addresses", () => {
    const addons = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const parsed = parseVlessMessage(message({ address: "example.com", port: 443, atyp: 2, addons }));
    assert.ok("message" in parsed);
    assert.equal(parsed.message.address, "example.com");
    assert.equal(parsed.message.headerLength, 17 + 6 + "example.com".length + 3);
  });

  it("waits for bytes that have not arrived yet", () => {
    const full = message({ address: "1.1.1.1", port: 53 });
    for (const cut of [1, 5, 17, 24]) {
      assert.deepEqual(parseVlessMessage(full.subarray(0, cut)), { incomplete: true }, `cut at ${cut}`);
    }
    const withAddons = message({ address: "1.1.1.1", port: 53, addons: new Uint8Array([1, 2, 3, 4]) });
    assert.deepEqual(parseVlessMessage(withAddons.subarray(0, withAddons.byteLength - 2)), { incomplete: true });
    assert.ok("message" in parseVlessMessage(withAddons));
  });

  it("rejects junk before opening a socket", () => {
    assert.deepEqual(parseVlessMessage(new Uint8Array([0, 1, 2, 3])), { incomplete: true });
    const bad = message({ address: "1.1.1.1", port: 53 });
    bad[18] = 7; // command must be 1..3
    assert.deepEqual(parseVlessMessage(bad), { invalid: true });
  });
});
