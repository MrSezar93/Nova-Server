/**
 * Cross-checks the dependency-free QR encoder against the well-known `qrcode`
 * npm package (dev dependency, used only by the test suite).
 *
 * Both sides are forced into pure byte mode so the codeword streams — and
 * therefore the full module matrices — must be byte-for-byte identical.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { create } from "qrcode";
// @ts-ignore - internal CJS module of the reference implementation
import Mode from "qrcode/lib/core/mode.js";
import { encodeQr, qrSvg, type EcLevel } from "../src/lib/qr";

const LEVELS: EcLevel[] = ["L", "M", "Q", "H"];

function referenceMatrix(text: string, ecLevel: EcLevel) {
  const bytes = new TextEncoder().encode(text);
  const block = create([{ data: bytes, mode: Mode.BYTE }], {
    errorCorrectionLevel: ecLevel,
  });
  assert.ok(block.modules, "reference produced no modules");
  return {
    size: block.modules.size,
    version: block.version,
    mask: block.maskPattern,
    modules: Uint8Array.from(block.modules.data as unknown as number[]),
  };
}

function bufferEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function randomAscii(length: number, seed: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789:/.=-_";
  let state = seed >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    out += alphabet[state % alphabet.length];
  }
  return out;
}

test("QR matrices match the reference implementation (every level, many versions)", () => {
  let checked = 0;
  for (const level of LEVELS) {
    for (let length = 1; length <= 900; length += 7) {
      const text = randomAscii(length, length * 31 + level.charCodeAt(0));
      const mine = encodeQr(text, { ecLevel: level });
      const ref = referenceMatrix(text, level);
      assert.equal(mine.version, ref.version, `version mismatch for ${level} len=${length}`);
      assert.equal(mine.size, ref.size, `size mismatch for ${level} len=${length}`);
      assert.equal(mine.maskPattern, ref.mask, `mask mismatch for ${level} len=${length}`);
      assert.ok(
        bufferEqual(mine.modules, ref.modules),
        `matrix mismatch for ${level} len=${length}`,
      );
      checked++;
    }
  }
  assert.ok(checked > 100, `expected many cases, got ${checked}`);
});

test("QR handles UTF-8 payloads and every version boundary", () => {
  const cases: Array<{ text: string; levels: EcLevel[] }> = [
    { text: "a", levels: LEVELS },
    { text: "سلام", levels: LEVELS },
    { text: "WireGuard قالب آزمایشی", levels: LEVELS },
    { text: "x".repeat(1000), levels: LEVELS },
    // 2000 bytes only fit in the largest symbols at L/M
    { text: "y".repeat(2000), levels: ["L", "M"] },
  ];
  for (const { text, levels } of cases) {
    for (const level of levels) {
      const mine = encodeQr(text, { ecLevel: level });
      const ref = referenceMatrix(text, level);
      assert.equal(mine.version, ref.version, `version mismatch (${level})`);
      assert.ok(bufferEqual(mine.modules, ref.modules), `matrix mismatch (${level})`);
    }
  }
  // Level Q cannot hold 2000 bytes in the maximum symbol size -> must throw
  assert.throws(() => encodeQr("y".repeat(2000), { ecLevel: "Q" }), /too large/);
});

test("QR supports explicit version and mask selection", () => {
  const text = "Nova WARP";
  for (let mask = 0; mask < 8; mask++) {
    const mine = encodeQr(text, { ecLevel: "M", maskPattern: mask });
    const ref = create([{ data: new TextEncoder().encode(text), mode: Mode.BYTE }], {
      errorCorrectionLevel: "M",
      version: mine.version,
      maskPattern: mask,
    });
    assert.ok(bufferEqual(mine.modules, Uint8Array.from(ref.modules.data as unknown as number[])));
  }
});

test("QR rejects oversized payloads", () => {
  assert.throws(() => encodeQr("x".repeat(5000), { ecLevel: "H" }), /too large/);
});

test("qrSvg renders a self-contained SVG", () => {
  const svg = qrSvg("Nova WARP Worker", { scale: 3, margin: 1 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<path d="M/);
  assert.match(svg, /role="img"/);
  assert.ok(!svg.includes("<script"));
});
