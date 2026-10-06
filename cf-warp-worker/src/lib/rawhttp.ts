/**
 * Tiny HTTP/1.1 response parser + raw TLS request helper.
 *
 * Cloudflare's WARP registration API fingerprints the TLS ClientHello and
 * answers `429`/`403` to clients that do not look like the Android app. When
 * `fetch()` is rejected we retry over a raw `node:tls` socket (available through
 * the `nodejs_compat` flag) so we can present a closer handshake.
 *
 * The parser is a pure function which makes it easy to test.
 */

export interface RawHttpResponse {
  status: number;
  headers: Map<string, string>;
  body: Uint8Array;
}

function concat(chunks: Array<Uint8Array<ArrayBufferLike>>): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function decodeChunked(buffer: Uint8Array): { complete: boolean; body?: Uint8Array } {
  let position = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const lineEnd = buffer.indexOf(0x0a, position);
    if (lineEnd < 0) return { complete: false };
    const sizeText = new TextDecoder("latin1")
      .decode(buffer.subarray(position, lineEnd))
      .split(";", 1)[0]
      .trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) throw new Error("invalid chunk size");
    position = lineEnd + 1;
    if (size === 0) {
      return { complete: true, body: concat(chunks) };
    }
    if (buffer.length < position + size) return { complete: false };
    chunks.push(buffer.subarray(position, position + size));
    position += size;
    // skip CRLF after the chunk (a bare LF is tolerated)
    if (buffer[position] === 0x0d) position += 1;
    if (buffer[position] === 0x0a) position += 1;
  }
}

/**
 * Parses a (possibly partial) HTTP/1.1 response.
 * Returns null while the response is still incomplete.
 */
export function parseHttpResponse(buffer: Uint8Array, ended = false): RawHttpResponse | null {
  const marker = findHeaderEnd(buffer);
  if (!marker) {
    if (ended && buffer.length) throw new Error("incomplete HTTP response from WARP API");
    return null;
  }
  const headerText = new TextDecoder("latin1").decode(buffer.subarray(0, marker.start));
  const lines = headerText.split("\r\n");
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(lines.shift() ?? "");
  if (!statusMatch) throw new Error("invalid HTTP response from WARP API");

  const headers = new Map<string, string>();
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index > 0) {
      headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
    }
  }

  const rawBody = buffer.subarray(marker.end);
  const transferEncoding = (headers.get("transfer-encoding") ?? "").toLowerCase();
  if (transferEncoding.includes("chunked")) {
    const decoded = decodeChunked(rawBody);
    if (!decoded.complete) return null;
    return { status: Number(statusMatch[1]), headers, body: decoded.body ?? new Uint8Array() };
  }

  const lengthHeader = headers.get("content-length");
  if (lengthHeader !== undefined) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0) throw new Error("invalid Content-Length");
    if (rawBody.length < length) {
      if (ended) throw new Error("truncated HTTP response from WARP API");
      return null;
    }
    return { status: Number(statusMatch[1]), headers, body: rawBody.subarray(0, length) };
  }

  if (!ended) return null;
  return { status: Number(statusMatch[1]), headers, body: rawBody };
}

function findHeaderEnd(buffer: Uint8Array): { start: number; end: number } | null {
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a && buffer[i + 2] === 0x0d && buffer[i + 3] === 0x0a) {
      return { start: i, end: i + 4 };
    }
  }
  return null;
}

export interface RawTlsRequestOptions {
  host: string;
  port?: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Restrict the TLS handshake to mimic the Android client (best effort). */
  fingerprint?: boolean;
}

const MAX_RESPONSE_BYTES = 512 * 1024;

/** Minimal surface of `node:tls` that we rely on (the module is imported lazily). */
interface TlsSocketLike {
  write(data: Uint8Array<ArrayBufferLike> | string): void;
  destroy(): void;
  removeAllListeners(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface TlsModuleLike {
  connect(options: Record<string, unknown>): TlsSocketLike;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** Sends a single HTTP/1.1 request over a raw TLS socket (`node:tls`). */
export async function rawTlsRequest(options: RawTlsRequestOptions): Promise<RawHttpResponse> {
  // Dynamic specifier keeps the bundler/type-checker from resolving node:tls statically:
  // the module only exists when the `nodejs_compat` flag is enabled.
  const specifier = "node:tls";
  const tls = (await import(/* webpackIgnore: true */ specifier)) as unknown as TlsModuleLike;
  const host = options.host;
  const port = options.port ?? 443;
  const bodyBytes = options.body === undefined ? undefined : new TextEncoder().encode(options.body);
  const requestLines = [`${options.method} ${options.path} HTTP/1.1`, `Host: ${host}`];
  for (const [name, value] of Object.entries(options.headers)) {
    requestLines.push(`${name}: ${value}`);
  }
  if (bodyBytes) requestLines.push(`Content-Length: ${bodyBytes.length}`);
  requestLines.push("Connection: close");
  requestLines.push("", "");
  const head = new TextEncoder().encode(requestLines.join("\r\n"));

  const baseOptions: Record<string, unknown> = {
    host,
    port,
    servername: host,
    ALPNProtocols: ["http/1.1"],
    rejectUnauthorized: true,
  };
  const variants: Record<string, unknown>[] = options.fingerprint === false
    ? [baseOptions]
    : [
        {
          ...baseOptions,
          minVersion: "TLSv1.2",
          maxVersion: "TLSv1.2",
          ciphers: "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384",
          ecdhCurve: "X25519:P-256:P-384",
        },
        { ...baseOptions, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" },
        baseOptions,
      ];

  let lastError: unknown;
  for (const variant of variants) {
    try {
      return await sendOnce(tls, variant, head, bodyBytes, options.timeoutMs ?? 15_000);
    } catch (error) {
      lastError = error;
      if (!/not implemented|unsupported|OPTION_NOT_IMPLEMENTED|invalid.*option/i.test(String(error))) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sendOnce(
  tls: TlsModuleLike,
  connectOptions: Record<string, unknown>,
  head: Uint8Array,
  body: Uint8Array | undefined,
  timeoutMs: number,
): Promise<RawHttpResponse> {
  return new Promise<RawHttpResponse>((resolve, reject) => {
    let settled = false;
    let received: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    const socket = tls.connect(connectOptions);
    const timer = setTimeout(() => fail(new Error("WARP API connection timed out")), timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }

    function finish(response: RawHttpResponse): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    }

    function fail(error: unknown): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    socket.on("secureConnect", () => {
      const payload = body ? concat([head, body]) : head;
      socket.write(payload);
    });
    socket.on("data", (...args: unknown[]) => {
      const chunk = args[0] as Uint8Array;
      received = concat([received, chunk]);
      if (received.length > MAX_RESPONSE_BYTES) {
        fail(new Error("WARP API response too large"));
        return;
      }
      try {
        const parsed = parseHttpResponse(received, false);
        if (parsed) finish(parsed);
      } catch (error) {
        fail(error);
      }
    });
    socket.on("end", () => {
      try {
        const parsed = parseHttpResponse(received, true);
        if (parsed) finish(parsed);
        else fail(new Error("incomplete WARP API response"));
      } catch (error) {
        fail(error);
      }
    });
    socket.on("error", (...args: unknown[]) => fail(args[0]));
    socket.on("close", () => {
      if (!settled) {
        try {
          const parsed = parseHttpResponse(received, true);
          if (parsed) finish(parsed);
          else fail(new Error("connection closed before the WARP API answered"));
        } catch (error) {
          fail(error);
        }
      }
    });
  });
}
