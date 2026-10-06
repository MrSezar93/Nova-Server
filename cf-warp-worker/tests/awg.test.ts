/** AmneziaWG: parameter safety, CPS packets and rendered output. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AWG_WARP_SAFE,
  awgLines,
  awgMihomoOption,
  awgSummary,
  cpsPacket,
  cpsPackets,
  isWarpSafe,
  normalizeAwg,
  randomizeAwg,
  sanitizeCps,
} from "../src/lib/awg";
import { renderConfig, wireGuardConf, type WgProfile } from "../src/lib/wg";

function profile(): WgProfile {
  return {
    privateKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    addressV4: "172.16.0.2",
    addressV6: "2606:4700:110:8a2f::1",
    peerPublicKey: "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
    endpoint: { host: "engage.cloudflareclient.com", port: 2408 },
    dns: ["1.1.1.1"],
    mtu: 1280,
    keepalive: 25,
    allowedIps: ["0.0.0.0/0", "::/0"],
    reserved: [1, 2, 3],
  };
}

describe("amneziawg options", () => {
  it("keeps the WARP-safe defaults compatible with Cloudflare's stock peer", () => {
    const awg = normalizeAwg({ enabled: true, mode: "warp-safe", jc: 6, jmin: 50, jmax: 90 });
    assert.equal(isWarpSafe(awg), true);
    assert.deepEqual([awg.s1, awg.s2, awg.s3, awg.s4], [0, 0, 0, 0]);
    assert.deepEqual([awg.h1, awg.h2, awg.h3, awg.h4], [1, 2, 3, 4]);
  });

  it("forces S/H back to the safe values even if a client sends custom ones", () => {
    const awg = normalizeAwg({ enabled: true, mode: "warp-safe", s1: 64, s2: 32, h1: 987654 });
    assert.equal(awg.s1, 0);
    assert.equal(awg.s2, 0);
    assert.equal(awg.h1, 1);
  });

  it("keeps custom values in custom mode and clamps the ranges", () => {
    const awg = normalizeAwg({ enabled: true, mode: "custom", s1: 40, s4: 999, jc: 99, jmin: 200, jmax: 10, h1: 1234 });
    assert.equal(awg.mode, "custom");
    assert.equal(awg.s1, 40);
    assert.equal(awg.s4, 128);
    assert.equal(awg.jc, 12);
    assert.equal(awg.jmax >= awg.jmin, true);
    assert.equal(awg.h1, 1234);
    assert.equal(isWarpSafe(awg), false);
  });

  it("randomises client-side knobs without breaking the safe invariants", () => {
    for (let index = 0; index < 25; index++) {
      const awg = randomizeAwg({ ...AWG_WARP_SAFE, enabled: true });
      assert.ok(awg.jc >= 1 && awg.jc <= 12, `jc=${awg.jc}`);
      assert.ok(awg.jmin <= awg.jmax);
      assert.ok(awg.jmax < 1280, "junk packets must stay below the MTU");
      assert.equal(isWarpSafe(awg), true);
    }
  });

  it("summarises the options for the panel", () => {
    assert.equal(awgSummary({ ...AWG_WARP_SAFE, enabled: false }), undefined);
    assert.match(String(awgSummary({ ...AWG_WARP_SAFE, enabled: true })), /WARP-safe/);
  });
});

describe("CPS (fake protocol openings)", () => {
  it("builds a single <b> expression from hexadecimal bytes", () => {
    const packet = cpsPacket("quic", 400);
    const match = /^<b 0x([0-9a-f]+)>$/.exec(packet);
    assert.ok(match, packet.slice(0, 40));
    assert.equal(match[1].length % 2, 0);
    // QUIC long header: fixed bit set, version follows
    assert.equal(match[1].slice(0, 2), "c3");
    assert.ok(["00000001", "6b3343cf"].includes(match[1].slice(2, 10)));
  });

  it("produces recognisable STUN / DTLS / DNS openings", () => {
    assert.match(cpsPacket("stun"), /^<b 0x000100082112a442/);
    assert.match(cpsPacket("dtls"), /^<b 0x16fefd/);
    const dns = cpsPacket("dns");
    assert.match(dns, /^<b 0x123401000001000000000000/);
    // ends with QTYPE=A + QCLASS=IN after a zero-length root label
    assert.match(dns, /0000010001>$/);
    const body = Buffer.from(/^<b 0x([0-9a-f]+)>$/.exec(dns)?.[1] ?? "", "hex");
    const qname = body.subarray(12, body.length - 4);
    const labels: string[] = [];
    for (let index = 0; index < qname.length; ) {
      const length = qname[index];
      if (length) labels.push(qname.subarray(index + 1, index + 1 + length).toString("ascii"));
      index += 1 + length;
    }
    assert.ok(
      ["www.cloudflare.com", "cloudflare.com", "one.one.one.one", "cdn.jsdelivr.net"].includes(labels.join(".")),
      `decoded qname: ${labels.join(".")}`,
    );
    assert.equal(cpsPacket("none"), "");
    assert.match(cpsPacket("random", 320), /^<r 320>$/);
  });

  it("renders I1 plus filler packets and refuses tag injection", () => {
    const packets = cpsPackets({ ...AWG_WARP_SAFE, enabled: true, cps: "stun" });
    assert.match(String(packets.i1), /^<b 0x/);
    assert.match(String(packets.i2), /^<rc \d+>$/);
    assert.equal(packets.i5, undefined);

    assert.equal(sanitizeCps("<b 0x0102><r 32>"), "<b 0x0102> <r 32>");
    assert.equal(sanitizeCps("<b 0x01> ; rm -rf /"), undefined);
    assert.equal(sanitizeCps("javascript:alert(1)"), undefined);
    assert.equal(sanitizeCps(undefined), undefined);
    // explicit I-values win over the preset
    const explicit = cpsPackets({ ...AWG_WARP_SAFE, enabled: true, cps: "quic", i1: "<b 0xdeadbeef>" });
    assert.equal(explicit.i1, "<b 0xdeadbeef>");
  });
});

describe("amneziawg rendering", () => {
  it("adds the AWG fields in the documented order for .conf output", () => {
    const awg = normalizeAwg({ enabled: true, mode: "warp-safe", jc: 5, jmin: 44, jmax: 88, cps: "quic" });
    const lines = awgLines(awg);
    assert.deepEqual(lines.slice(0, 3), ["Jc = 5", "Jmin = 44", "Jmax = 88"]);
    assert.deepEqual(lines.slice(3, 7), ["H1 = 1", "H2 = 2", "H3 = 3", "H4 = 4"]);
    assert.equal(lines.some((line) => line.startsWith("S1 =")), false, "warp-safe output omits the padding lines");
    assert.ok(lines.some((line) => line.startsWith("I1 = <b 0x")));
  });

  it("emits the padding lines in custom mode", () => {
    const awg = normalizeAwg({ enabled: true, mode: "custom", s1: 12, s2: 20, s3: 3, s4: 8, h1: 111, h2: 222, h3: 333, h4: 444 });
    const lines = awgLines(awg);
    assert.deepEqual(lines.slice(3, 11), [
      "S1 = 12",
      "S2 = 20",
      "S3 = 3",
      "S4 = 8",
      "H1 = 111",
      "H2 = 222",
      "H3 = 333",
      "H4 = 444",
    ]);
  });

  it("keeps the profile a valid WireGuard config while adding AWG fields", () => {
    const awg = normalizeAwg({ enabled: true, mode: "warp-safe", cps: "dtls" });
    const conf = wireGuardConf({ ...profile(), awg });
    assert.match(conf, /\[Interface]/);
    assert.match(conf, /Jc = \d+/);
    assert.match(conf, /H4 = 4/);
    assert.match(conf, /\[Peer]/);
    assert.match(conf, /Endpoint = engage\.cloudflareclient\.com:2408/);
    assert.match(conf, /I1 = <b 0x/);
    // order: MTU before the AWG block, AWG block before [Peer]
    assert.ok(conf.indexOf("MTU = 1280") < conf.indexOf("Jc ="));
    assert.ok(conf.indexOf("Jc =") < conf.indexOf("[Peer]"));
    // a vanilla WireGuard client ignores unknown [Interface] keys
    assert.equal(/S1 = [1-9]/.test(conf), false);
  });

  it("the dedicated amneziawg format forces the obfuscation fields", () => {
    const plain = renderConfig("wg", profile());
    assert.equal(/Jc =/.test(plain), false);
    const awg = renderConfig("amneziawg", profile());
    assert.match(awg, /AmneziaWG/);
    assert.match(awg, /Jc = 4/);
    assert.match(awg, /I1 = </);
  });

  it("renders an amnezia-wg-option block for Clash.Meta", () => {
    const awg = normalizeAwg({ enabled: true, mode: "warp-safe", jc: 4, cps: "stun" });
    const clash = renderConfig("clash", { ...profile(), awg }, "phone");
    assert.match(clash, /amnezia-wg-option:/);
    assert.match(clash, /jc: 4/);
    assert.match(clash, /h1: 1/);
    assert.match(clash, /i1: "0x/);
    const option = awgMihomoOption(awg);
    assert.equal(option?.h4, 4);
    assert.equal(awgMihomoOption({ ...AWG_WARP_SAFE, enabled: false }), undefined);
  });
});
