/** Credential importers (conf / toml / json / raw key). */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWarpDefaults,
  detectAndParse,
  ImportError,
  parseWgcfToml,
  parseWireGuardConf,
} from "../src/lib/importer";
import { WG_CONF_SAMPLE, WARP_JSON_SAMPLE, WGCF_TOML_SAMPLE } from "./fixtures";

test("parses a WireGuard .conf profile", () => {
  const parsed = parseWireGuardConf(WG_CONF_SAMPLE);
  assert.equal(parsed.privateKey, "WCZJ1DCyQ9o3nJmY0TQvNtYCJN2u4aJdT8nB8GZ2XkI=");
  assert.equal(parsed.addressV4, "172.16.0.2");
  assert.equal(parsed.addressV6, "2606:4700:110:8a36:df92:102a:9602:fa18");
  assert.equal(parsed.peerPublicKey, "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=");
  assert.equal(parsed.endpointHost, "162.159.192.1");
  assert.equal(parsed.endpointPort, 2408);
  assert.equal(parsed.sourceFormat, "conf");
});

test("handles bracketed IPv6 endpoints and reserved lists", () => {
  const parsed = parseWireGuardConf(
    "[Interface]\nPrivateKey = WCZJ1DCyQ9o3nJmY0TQvNtYCJN2u4aJdT8nB8GZ2XkI=\n" +
      "[Peer]\nPublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=\n" +
      "Endpoint = [2606:4700:d0::a29f:c001]:2408\nReserved = 82, 239, 31\n",
  );
  assert.equal(parsed.endpointHost, "2606:4700:d0::a29f:c001");
  assert.equal(parsed.endpointPort, 2408);
  assert.deepEqual(parsed.reserved, [82, 239, 31]);
});

test("rejects profiles without a valid private key", () => {
  assert.throws(() => parseWireGuardConf("[Interface]\nAddress = 1.2.3.4/32\n"), ImportError);
  assert.throws(
    () => parseWireGuardConf("[Interface]\nPrivateKey = not-a-key\n"),
    /معتبر نیست/,
  );
});

test("parses wgcf TOML accounts", () => {
  const parsed = parseWgcfToml(WGCF_TOML_SAMPLE);
  assert.equal(parsed.privateKey, "WCZJ1DCyQ9o3nJmY0TQvNtYCJN2u4aJdT8nB8GZ2XkI=");
  assert.equal(parsed.deviceId, "cccc-dddd");
  assert.equal(parsed.token, "aaa-bbb");
  assert.equal(parsed.license, "12345678-abcdefgh");
});

test("parses WARP client JSON dumps including reserved bytes", () => {
  const parsed = detectAndParse(WARP_JSON_SAMPLE);
  assert.equal(parsed.addressV4, "172.16.0.2");
  assert.equal(parsed.clientId, "Uu8fHg==");
  assert.deepEqual(parsed.reserved, [0x52, 0xef, 0x1f]);
  assert.equal(parsed.deviceId, "device-abc");
  assert.equal(parsed.token, "secret-token");
});

test("detects a bare private key", () => {
  const parsed = detectAndParse("WCZJ1DCyQ9o3nJmY0TQvNtYCJN2u4aJdT8nB8GZ2XkI=");
  assert.equal(parsed.sourceFormat, "key");
  assert.equal(parsed.privateKey, "WCZJ1DCyQ9o3nJmY0TQvNtYCJN2u4aJdT8nB8GZ2XkI=");
});

test("defaults fill in the values Cloudflare always uses", () => {
  const withDefaults = applyWarpDefaults({ privateKey: "WCZJ1DCyQ9o3nJmY0TQvNtYCJN2u4aJdT8nB8GZ2XkI=", sourceFormat: "key" });
  assert.equal(withDefaults.addressV4, "172.16.0.2");
  assert.equal(withDefaults.peerPublicKey, "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=");
});

test("unknown payloads produce a helpful error", () => {
  assert.throws(() => detectAndParse("hello world"), /قالب ورودی/);
  assert.throws(() => detectAndParse("   "), /خالی/);
});
