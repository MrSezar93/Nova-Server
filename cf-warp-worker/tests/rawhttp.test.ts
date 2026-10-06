/** HTTP/1.1 parser used by the raw-TLS fallback transport. */
import assert from "node:assert/strict";
import test from "node:test";
import { parseHttpResponse } from "../src/lib/rawhttp";

const encoder = new TextEncoder();

test("parses a complete content-length response", () => {
  const raw = encoder.encode(
    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 12\r\n\r\n{\"ok\":true}\n",
  );
  const parsed = parseHttpResponse(raw);
  assert.ok(parsed);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.headers.get("content-type"), "application/json");
  assert.equal(new TextDecoder().decode(parsed.body), '{"ok":true}\n');
});

test("returns null while the response is incomplete", () => {
  const partial = encoder.encode("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{\"a\"");
  assert.equal(parseHttpResponse(partial), null);
  assert.throws(() => parseHttpResponse(partial, true), /incomplete|truncated/);
});

test("decodes chunked responses", () => {
  const raw = encoder.encode(
    "HTTP/1.1 429 Too Many Requests\r\nTransfer-Encoding: chunked\r\n\r\n" +
      "7\r\n{\"err\":\r\n" + // 7 bytes + CRLF
      "2\r\n1}\r\n" +
      "0\r\n\r\n",
  );
  const parsed = parseHttpResponse(raw);
  assert.ok(parsed);
  assert.equal(parsed.status, 429);
  assert.equal(new TextDecoder().decode(parsed.body), '{"err":1}');
});

test("waits for the end of the body when neither header is present", () => {
  const raw = encoder.encode("HTTP/1.1 204 No Content\r\n\r\n");
  const parsed = parseHttpResponse(raw, true);
  assert.ok(parsed);
  assert.equal(parsed.status, 204);
  assert.equal(parsed.body.length, 0);
});

test("rejects garbage", () => {
  assert.throws(() => parseHttpResponse(encoder.encode("NOT-HTTP\r\n\r\n")), /invalid HTTP response/);
});

test("parses multi-chunk bodies that arrive in pieces", () => {
  const head = encoder.encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n");
  assert.equal(parseHttpResponse(head), null);
  const rest = encoder.encode("3\r\nefg\r\n0\r\n\r\n");
  const combined = new Uint8Array(head.length + rest.length);
  combined.set(head, 0);
  combined.set(rest, head.length);
  const parsed = parseHttpResponse(combined);
  assert.ok(parsed);
  assert.equal(new TextDecoder().decode(parsed.body), "abcdefg");
});
