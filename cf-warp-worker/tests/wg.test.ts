/** WireGuard primitives, endpoint handling and config rendering. */
import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { base64ToBytes, bytesToBase64, timingSafeEqual } from "../src/lib/b64";
import {
  buildProfileFixture,
  configFor,
} from "./fixtures";
import {
  clampPrivateKey,
  defaultAllowedIps,
  formatEndpoint,
  generateKeyPair,
  ipv4Complement,
  isValidWgKey,
  publicKeyFromPrivateKey,
  reservedFromClientId,
  resolveEndpoint,
  wireGuardConf,
  singBoxConfig,
  clashConfig,
  xrayConfig,
  WARP_ENDPOINT_POOL,
  WARP_ENDPOINT_PORTS,
} from "../src/lib/wg";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

function nodePublicKeyFromRaw(raw: Uint8Array): string {
  const der = Buffer.concat([PKCS8_PREFIX, Buffer.from(raw)]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const exported = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return exported.subarray(exported.length - 32).toString("base64");
}

test("generated keys are clamped, valid and match Node's X25519", async () => {
  for (let i = 0; i < 12; i++) {
    const pair = await generateKeyPair();
    const raw = base64ToBytes(pair.privateKey);
    assert.equal(raw.length, 32);
    assert.equal(raw[0] & 0x07, 0, "low bits must be cleared");
    assert.equal(raw[31] & 0x80, 0, "high bit must be cleared");
    assert.equal(raw[31] & 0x40, 0x40, "bit 6 must be set");
    assert.equal(pair.publicKey, nodePublicKeyFromRaw(raw));
    assert.ok(isValidWgKey(pair.privateKey) && isValidWgKey(pair.publicKey));
  }
});

test("publicKeyFromPrivateKey matches the reference implementation", async () => {
  const { privateKey, publicKey } = await generateKeyPair();
  assert.equal(await publicKeyFromPrivateKey(privateKey), publicKey);
  assert.equal(publicKey, nodePublicKeyFromRaw(base64ToBytes(privateKey)));
});

test("clamping and base64 helpers behave", () => {
  const raw = new Uint8Array(32).fill(0xff);
  const clamped = clampPrivateKey(raw);
  assert.equal(clamped[0], 0xf8);
  assert.equal(clamped[31], 0x7f);
  assert.equal(raw[0], 0xff, "clamp must not mutate the input");

  const bytes = Uint8Array.from([1, 2, 3, 250]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.ok(timingSafeEqual("secret", "secret"));
  assert.ok(!timingSafeEqual("secret", "secret2"));
  assert.ok(!timingSafeEqual("", "x"));
});

test("reserved bytes come from the base64 client_id", () => {
  assert.deepEqual(reservedFromClientId("Uu8fHg=="), [0x52, 0xef, 0x1f]);
  assert.equal(reservedFromClientId(undefined), undefined);
  assert.equal(reservedFromClientId("AA"), undefined);
  assert.equal(reservedFromClientId("!!!not-base64!!!"), undefined);
});

test("endpoint resolution covers auto, random and custom", () => {
  assert.deepEqual(resolveEndpoint({ mode: "auto" }), { host: "engage.cloudflareclient.com", port: 2408 });
  const random = resolveEndpoint({ mode: "random" });
  assert.ok(WARP_ENDPOINT_POOL.includes(random.host));
  assert.ok(WARP_ENDPOINT_PORTS.includes(random.port));
  assert.deepEqual(resolveEndpoint({ mode: "custom", host: "1.2.3.4", port: 500 }), { host: "1.2.3.4", port: 500 });
  assert.equal(formatEndpoint("2606:4700:d0::1", 2408), "[2606:4700:d0::1]:2408");
  assert.equal(formatEndpoint("engage.cloudflareclient.com", 2408), "engage.cloudflareclient.com:2408");
});

test("IPv4 complement excludes exactly the LAN ranges", () => {
  const blocks = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"];
  const complement = ipv4Complement(blocks);
  const total = complement.reduce((sum, cidr) => {
    const bits = Number(cidr.split("/")[1]);
    return sum + 2 ** (32 - bits);
  }, 0);
  const excluded = blocks.reduce((sum, cidr) => sum + 2 ** (32 - Number(cidr.split("/")[1])), 0);
  assert.equal(total + excluded, 2 ** 32, "complement + excluded must cover the whole space");
  assert.ok(!complement.some((cidr) => cidr.startsWith("10.")));
  assert.ok(complement.includes("0.0.0.0/5"));
  assert.ok(complement.includes("11.0.0.0/8"));
  assert.ok(complement.includes("192.169.0.0/16"));
});

test("defaultAllowedIps honours the selected mode", () => {
  assert.deepEqual(defaultAllowedIps("all"), ["0.0.0.0/0", "::/0"]);
  const lan = defaultAllowedIps("exclude-lan");
  assert.ok(lan.includes("::/0"));
  assert.ok(lan.includes("10.0.0.0/8") === false, "must not route LAN through the tunnel");
  assert.deepEqual(defaultAllowedIps("custom", ["1.1.1.1/32"]), ["1.1.1.1/32"]);
});

test("WireGuard profile rendering is stable and spec compliant", () => {
  const profile = buildProfileFixture();
  const conf = wireGuardConf(profile);
  const lines = conf.split("\n");
  assert.equal(lines[0], "# Nova WARP — Cloudflare WireGuard profile");
  assert.ok(conf.includes("[Interface]"));
  assert.ok(conf.includes(`PrivateKey = ${profile.privateKey}`));
  assert.ok(conf.includes("Address = 172.16.0.2/32, 2606:4700:110::2/128"));
  assert.ok(conf.includes("DNS = 1.1.1.1, 1.0.0.1, 2606:4700:4700::1111, 2606:4700:4700::1001"));
  assert.ok(conf.includes("MTU = 1280"));
  assert.ok(conf.includes(`PublicKey = ${profile.peerPublicKey}`));
  assert.ok(conf.includes("AllowedIPs = 0.0.0.0/0, ::/0"));
  assert.ok(conf.includes("Endpoint = engage.cloudflareclient.com:2408"));
  assert.ok(conf.includes("PersistentKeepalive = 25"));
  assert.ok(conf.endsWith("\n"));

  const v4only = wireGuardConf({ ...profile, includeIPv6: false });
  assert.ok(v4only.includes("Address = 172.16.0.2/32\n"));
  assert.ok(!v4only.includes("2606:4700:4700::1111"));

  const noKeepalive = wireGuardConf({ ...profile, keepalive: 0 });
  assert.ok(!noKeepalive.includes("PersistentKeepalive"));
});

test("alternate formats embed the same credentials", () => {
  const profile = buildProfileFixture();
  const singbox = JSON.parse(singBoxConfig(profile, "warp-x")) as {
    outbounds: Array<Record<string, unknown>>;
  };
  assert.equal(singbox.outbounds[0].type, "wireguard");
  assert.equal(singbox.outbounds[0].private_key, profile.privateKey);
  assert.equal(singbox.outbounds[0].server_port, 2408);
  assert.deepEqual(singbox.outbounds[0].reserved, [0x52, 0xef, 0x1f]);

  const xray = JSON.parse(xrayConfig(profile)) as { settings: Record<string, unknown> };
  assert.equal(xray.settings.secretKey, profile.privateKey);
  assert.deepEqual(xray.settings.reserved, [0x52, 0xef, 0x1f]);

  const clash = clashConfig(profile);
  assert.ok(clash.includes("type: wireguard"));
  assert.ok(clash.includes(`private-key: ${profile.privateKey}`));
  assert.ok(clash.includes("reserved: [82, 239, 31]"));
});

test("configFor switches formats", () => {
  const profile = buildProfileFixture();
  assert.ok(configFor("wg", profile).includes("[Interface]"));
  assert.ok(configFor("clash", profile).includes("proxies:"));
  assert.ok(configFor("json", profile).includes("\"type\": \"wireguard\""));
});
