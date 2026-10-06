/**
 * Minimal, dependency-free QR Code encoder (ISO/IEC 18004).
 *
 * Scope: byte mode (UTF-8), error correction levels L/M/Q/H, versions 1..40,
 * automatic version + mask selection. Enough for embedding a WireGuard profile
 * into a scannable QR code inside the Worker (no image libraries needed).
 *
 * The tables below are the constants defined by the standard; the test suite
 * cross-checks the produced matrices against the widely used `qrcode` npm
 * package for hundreds of inputs and every error-correction level.
 */

export type EcLevel = "L" | "M" | "Q" | "H";

const EC_FORMAT_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
const EC_INDEX: Record<EcLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };
const EC_LEVELS: EcLevel[] = ["L", "M", "Q", "H"];

/** Total codewords (data + error correction) per version, index 0..39 == version - 1. */
const TOTAL_CODEWORDS = [
  26, 44, 70, 100, 134, 172, 196, 242,
  292, 346, 404, 466, 532, 581, 655, 733,
  815, 901, 991, 1085, 1156, 1258, 1364, 1474,
  1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465,
  2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

/** Number of error-correction blocks per version (L, M, Q, H). */
const EC_BLOCKS = [
  1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 2, 2, 1, 2, 2, 4,
  1, 2, 4, 4, 2, 4, 4, 4,
  2, 4, 6, 5, 2, 4, 6, 6,
  2, 5, 8, 8, 4, 5, 8, 8,
  4, 5, 8, 11, 4, 8, 10, 11,
  4, 9, 12, 16, 4, 9, 16, 16,
  6, 10, 12, 18, 6, 10, 17, 16,
  6, 11, 16, 19, 6, 13, 18, 21,
  7, 14, 21, 25, 8, 16, 20, 25,
  8, 17, 23, 25, 9, 17, 23, 34,
  9, 18, 25, 30, 10, 20, 27, 32,
  12, 21, 29, 35, 12, 23, 34, 37,
  12, 25, 34, 40, 13, 26, 35, 42,
  14, 28, 38, 45, 15, 29, 40, 48,
  16, 31, 43, 51, 17, 33, 45, 54,
  18, 35, 48, 57, 19, 37, 51, 60,
  19, 38, 53, 63, 20, 40, 56, 66,
  21, 43, 59, 70, 22, 45, 62, 74,
  24, 47, 65, 77, 25, 49, 68, 81,
];

/** Number of error-correction codewords per version (L, M, Q, H). */
const EC_CODEWORDS = [
  7, 10, 13, 17, 10, 16, 22, 28,
  15, 26, 36, 44, 20, 36, 52, 64,
  26, 48, 72, 88, 36, 64, 96, 112,
  40, 72, 108, 130, 48, 88, 132, 156,
  60, 110, 160, 192, 72, 130, 192, 224,
  80, 150, 224, 264, 96, 176, 260, 308,
  104, 198, 288, 352, 120, 216, 320, 384,
  132, 240, 360, 432, 144, 280, 408, 480,
  168, 308, 448, 532, 180, 338, 504, 588,
  196, 364, 546, 650, 224, 416, 600, 700,
  224, 442, 644, 750, 252, 476, 690, 816,
  270, 504, 750, 900, 300, 560, 810, 960,
  312, 588, 870, 1050, 336, 644, 952, 1110,
  360, 700, 1020, 1200, 390, 728, 1050, 1260,
  420, 784, 1140, 1350, 450, 812, 1200, 1440,
  480, 868, 1290, 1530, 510, 924, 1350, 1620,
  540, 980, 1440, 1710, 570, 1036, 1530, 1800,
  570, 1064, 1590, 1890, 600, 1120, 1680, 1980,
  630, 1204, 1770, 2100, 660, 1260, 1860, 2220,
  720, 1316, 1950, 2310, 750, 1372, 2040, 2430,
];

function totalCodewords(version: number): number {
  return TOTAL_CODEWORDS[version - 1];
}

function blocksCount(version: number, level: EcLevel): number {
  return EC_BLOCKS[(version - 1) * 4 + EC_INDEX[level]];
}

function ecCodewordsCount(version: number, level: EcLevel): number {
  return EC_CODEWORDS[(version - 1) * 4 + EC_INDEX[level]];
}

function symbolSize(version: number): number {
  return version * 4 + 17;
}

/* -------------------------------------------------------------------------- */
/*                          Galois field arithmetic                           */
/* -------------------------------------------------------------------------- */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial for GF(256)
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, degree: number): Uint8Array {
  const gen = rsGenerator(degree);
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < degree; i++) {
        remainder[i] ^= gfMul(gen[i + 1], factor);
      }
    }
  }
  return remainder;
}

/* -------------------------------------------------------------------------- */
/*                                  bit buffer                                */
/* -------------------------------------------------------------------------- */

class BitBuffer {
  bits: number[] = [];

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      if (bit) out[index >>> 3] |= 0x80 >>> (index & 7);
    });
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/*                             pattern coordinates                            */
/* -------------------------------------------------------------------------- */

function alignmentCoords(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = symbolSize(version);
  const interval = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < count - 1; i++) positions.push(positions[i - 1] - interval);
  positions.push(6);
  return positions.reverse();
}

function bchDigit(value: number): number {
  let digit = 0;
  let v = value;
  while (v !== 0) {
    digit++;
    v >>>= 1;
  }
  return digit;
}

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

function formatInfoBits(level: EcLevel, mask: number): number {
  const data = (EC_FORMAT_BITS[level] << 3) | mask;
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) {
    d ^= G15 << (bchDigit(d) - bchDigit(G15));
  }
  return ((data << 10) | d) ^ G15_MASK;
}

const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;

function versionInfoBits(version: number): number {
  let d = version << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) {
    d ^= G18 << (bchDigit(d) - bchDigit(G18));
  }
  return (version << 12) | d;
}

/* -------------------------------------------------------------------------- */
/*                                  matrix                                    */
/* -------------------------------------------------------------------------- */

interface Matrix {
  size: number;
  modules: Uint8Array; // 1 = dark
  reserved: Uint8Array; // 1 = function pattern (never masked)
}

function createMatrix(version: number): Matrix {
  const size = symbolSize(version);
  return { size, modules: new Uint8Array(size * size), reserved: new Uint8Array(size * size) };
}

function setModule(m: Matrix, row: number, col: number, dark: boolean, reserved = false): void {
  if (row < 0 || col < 0 || row >= m.size || col >= m.size) return;
  m.modules[row * m.size + col] = dark ? 1 : 0;
  if (reserved) m.reserved[row * m.size + col] = 1;
}

function getModule(m: Matrix, row: number, col: number): number {
  return m.modules[row * m.size + col];
}

function setupFinderPatterns(m: Matrix): void {
  const positions: [number, number][] = [
    [0, 0],
    [m.size - 7, 0],
    [0, m.size - 7],
  ];
  for (const [row, col] of positions) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        setModule(m, row + r, col + c, inRing, true);
      }
    }
  }
}

function setupTimingPattern(m: Matrix): void {
  for (let r = 8; r < m.size - 8; r++) {
    const dark = r % 2 === 0;
    setModule(m, r, 6, dark, true);
    setModule(m, 6, r, dark, true);
  }
}

function setupAlignmentPatterns(m: Matrix, version: number): void {
  const coords = alignmentCoords(version);
  for (const row of coords) {
    for (const col of coords) {
      // Skip the three positions occupied by finder patterns
      const nearFinder = (row <= 8 && col <= 8) ||
        (row <= 8 && col >= m.size - 9) ||
        (row >= m.size - 9 && col <= 8);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          setModule(m, row + r, col + c, dark, true);
        }
      }
    }
  }
}

function setupVersionInfo(m: Matrix, version: number): void {
  if (version < 7) return;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3);
    const col = (i % 3) + m.size - 8 - 3;
    const dark = ((bits >> i) & 1) === 1;
    setModule(m, row, col, dark, true);
    setModule(m, col, row, dark, true);
  }
}

function setupFormatInfo(m: Matrix, level: EcLevel, mask: number): void {
  const bits = formatInfoBits(level, mask);
  const size = m.size;
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    if (i < 6) {
      setModule(m, i, 8, dark, true);
    } else if (i < 8) {
      setModule(m, i + 1, 8, dark, true);
    } else {
      setModule(m, size - 15 + i, 8, dark, true);
    }

    if (i < 8) {
      setModule(m, 8, size - i - 1, dark, true);
    } else if (i < 9) {
      setModule(m, 8, 15 - i, dark, true);
    } else {
      setModule(m, 8, 15 - i - 1, dark, true);
    }
  }
  setModule(m, size - 8, 8, true, true);
}

function setupData(m: Matrix, data: Uint8Array): void {
  const size = m.size;
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const target = col - c;
        if (!m.reserved[row * size + target]) {
          let dark = false;
          if (byteIndex < data.length) {
            dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          }
          setModule(m, row, target, dark);
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                   masking                                  */
/* -------------------------------------------------------------------------- */

function maskBit(mask: number, i: number, j: number): boolean {
  switch (mask) {
    case 0:
      return (i + j) % 2 === 0;
    case 1:
      return i % 2 === 0;
    case 2:
      return j % 3 === 0;
    case 3:
      return (i + j) % 3 === 0;
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5:
      return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6:
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    default:
      return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let col = 0; col < m.size; col++) {
    for (let row = 0; row < m.size; row++) {
      const index = row * m.size + col;
      if (m.reserved[index]) continue;
      if (maskBit(mask, row, col)) m.modules[index] ^= 1;
    }
  }
}

function penaltyN1(m: Matrix): number {
  const size = m.size;
  let points = 0;
  for (let row = 0; row < size; row++) {
    let sameCol = 0;
    let sameRow = 0;
    let lastCol: number | null = null;
    let lastRow: number | null = null;
    for (let col = 0; col < size; col++) {
      let module = getModule(m, row, col);
      if (module === lastCol) {
        sameCol++;
      } else {
        if (sameCol >= 5) points += 3 + (sameCol - 5);
        lastCol = module;
        sameCol = 1;
      }

      module = getModule(m, col, row);
      if (module === lastRow) {
        sameRow++;
      } else {
        if (sameRow >= 5) points += 3 + (sameRow - 5);
        lastRow = module;
        sameRow = 1;
      }
    }
    if (sameCol >= 5) points += 3 + (sameCol - 5);
    if (sameRow >= 5) points += 3 + (sameRow - 5);
  }
  return points;
}

function penaltyN2(m: Matrix): number {
  const size = m.size;
  let points = 0;
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const sum = getModule(m, row, col) + getModule(m, row, col + 1) +
        getModule(m, row + 1, col) + getModule(m, row + 1, col + 1);
      if (sum === 4 || sum === 0) points++;
    }
  }
  return points * 3;
}

function penaltyN3(m: Matrix): number {
  const size = m.size;
  let points = 0;
  for (let row = 0; row < size; row++) {
    let bitsCol = 0;
    let bitsRow = 0;
    for (let col = 0; col < size; col++) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | getModule(m, row, col);
      if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points++;

      bitsRow = ((bitsRow << 1) & 0x7ff) | getModule(m, col, row);
      if (col >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points++;
    }
  }
  return points * 40;
}

function penaltyN4(m: Matrix): number {
  let dark = 0;
  for (let i = 0; i < m.modules.length; i++) dark += m.modules[i];
  const percent = (dark * 100) / m.modules.length;
  const k = Math.abs(Math.ceil(percent / 5) - 10);
  return k * 10;
}

function penalty(m: Matrix): number {
  return penaltyN1(m) + penaltyN2(m) + penaltyN3(m) + penaltyN4(m);
}

/* -------------------------------------------------------------------------- */
/*                                   encoder                                  */
/* -------------------------------------------------------------------------- */

export interface QrOptions {
  ecLevel?: EcLevel;
  minVersion?: number;
  maxVersion?: number;
  /** Force a mask pattern (0..7). Mostly useful for tests. */
  maskPattern?: number;
}

export interface QrCode {
  version: number;
  size: number;
  ecLevel: EcLevel;
  maskPattern: number;
  /** Row-major bitmap, 1 = dark module, `size * size` entries. */
  modules: Uint8Array;
}

function dataCapacityBits(version: number, level: EcLevel): number {
  return (totalCodewords(version) - ecCodewordsCount(version, level)) * 8;
}

function charCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

function buildDataBits(version: number, level: EcLevel, payload: Uint8Array): BitBuffer {
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4); // byte mode
  buffer.put(payload.length, charCountBits(version));
  for (const byte of payload) buffer.put(byte, 8);

  const capacity = dataCapacityBits(version, level);
  if (buffer.length > capacity) throw new Error("QR payload does not fit the requested version");

  if (buffer.length + 4 <= capacity) buffer.put(0, 4);
  while (buffer.length % 8 !== 0) buffer.put(0, 1);
  const remainingBytes = (capacity - buffer.length) / 8;
  for (let i = 0; i < remainingBytes; i++) buffer.put(i % 2 === 0 ? 0xec : 0x11, 8);
  return buffer;
}

function buildCodewords(version: number, level: EcLevel, payload: Uint8Array): Uint8Array {
  const buffer = buildDataBits(version, level, payload);
  const data = buffer.toBytes();
  const total = totalCodewords(version);
  const ecTotal = ecCodewordsCount(version, level);
  const dataTotal = total - ecTotal;
  const blockCount = blocksCount(version, level);

  const blocksInGroup2 = total % blockCount;
  const blocksInGroup1 = blockCount - blocksInGroup2;
  const codewordsPerBlock = Math.floor(total / blockCount);
  const dataCodewordsGroup1 = Math.floor(dataTotal / blockCount);
  const dataCodewordsGroup2 = dataCodewordsGroup1 + 1;
  const ecPerBlock = codewordsPerBlock - dataCodewordsGroup1;

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  let maxDataSize = 0;
  for (let b = 0; b < blockCount; b++) {
    const size = b < blocksInGroup1 ? dataCodewordsGroup1 : dataCodewordsGroup2;
    const block = data.subarray(offset, offset + size);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
    offset += size;
    maxDataSize = Math.max(maxDataSize, size);
  }

  const result = new Uint8Array(total);
  let index = 0;
  for (let i = 0; i < maxDataSize; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result[index++] = block[i];
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result[index++] = block[i];
  }
  return result;
}

function fitVersion(payloadLength: number, level: EcLevel, min: number, max: number): number {
  for (let version = Math.max(1, min); version <= Math.min(40, max); version++) {
    // mode indicator + char count + payload bits
    const bits = 4 + charCountBits(version) + payloadLength * 8;
    if (bits <= dataCapacityBits(version, level)) return version;
  }
  throw new Error(
    `QR payload is too large (${payloadLength} bytes) for error correction level ${level}`,
  );
}

export function encodeQr(text: string, options: QrOptions = {}): QrCode {
  const level = options.ecLevel ?? "M";
  if (!EC_LEVELS.includes(level)) throw new Error(`unknown error correction level: ${level}`);
  const payload = new TextEncoder().encode(text);
  const version = fitVersion(
    payload.length,
    level,
    options.minVersion ?? 1,
    options.maxVersion ?? 40,
  );
  const codewords = buildCodewords(version, level, payload);

  const matrix = createMatrix(version);
  // Drawing order matters: alignment patterns overwrite the timing pattern on
  // row/column 6, and the format-info slots must be reserved before the data
  // modules are placed into the encoding region.
  setupFinderPatterns(matrix);
  setupTimingPattern(matrix);
  setupAlignmentPatterns(matrix, version);
  setupFormatInfo(matrix, level, 0); // placeholder: only reserves the slots
  setupVersionInfo(matrix, version);
  setupData(matrix, codewords);

  const masks: number[] = [];
  if (options.maskPattern !== undefined) {
    if (options.maskPattern < 0 || options.maskPattern > 7) throw new Error("mask must be 0..7");
    masks.push(options.maskPattern);
  } else {
    for (let m = 0; m < 8; m++) masks.push(m);
  }

  let best: { mask: number; modules: Uint8Array } | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const mask of masks) {
    const candidate: Matrix = {
      size: matrix.size,
      modules: new Uint8Array(matrix.modules),
      reserved: new Uint8Array(matrix.reserved),
    };
    applyMask(candidate, mask);
    setupFormatInfo(candidate, level, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = { mask, modules: candidate.modules };
    }
  }

  return {
    version,
    size: matrix.size,
    ecLevel: level,
    maskPattern: best!.mask,
    modules: best!.modules,
  };
}

/* -------------------------------------------------------------------------- */
/*                                    SVG                                     */
/* -------------------------------------------------------------------------- */

export interface QrSvgOptions extends QrOptions {
  scale?: number;
  margin?: number;
  dark?: string;
  light?: string;
  title?: string;
}

export function qrSvg(text: string, options: QrSvgOptions = {}): string {
  const qr = encodeQr(text, options);
  const scale = options.scale ?? 4;
  const margin = options.margin ?? 2;
  const dark = options.dark ?? "#000000";
  const light = options.light ?? "#ffffff";
  const dimension = (qr.size + margin * 2) * scale;

  let path = "";
  for (let row = 0; row < qr.size; row++) {
    let col = 0;
    while (col < qr.size) {
      if (qr.modules[row * qr.size + col]) {
        let run = 1;
        while (col + run < qr.size && qr.modules[row * qr.size + col + run]) run++;
        path += `M${(col + margin) * scale} ${(row + margin) * scale}h${run * scale}v${scale}h${-run * scale}z`;
        col += run;
      } else {
        col++;
      }
    }
  }

  const title = options.title ? `<title>${escapeXml(options.title)}</title>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" ` +
    `viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges" role="img">${title}` +
    `<rect width="${dimension}" height="${dimension}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Internal helpers exposed for the test-suite only (not part of the public API). */
export const __testing = {
  rsEncode, rsGenerator, buildCodewords, dataCapacityBits, fitVersion, gfMul,
  createMatrix, setupFinderPatterns, setupAlignmentPatterns, setupTimingPattern, setupVersionInfo,
  setupFormatInfo, setupData, applyMask, symbolSize, buildDataBits,
};
