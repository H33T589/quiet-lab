import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  assertRequestAllowed,
  isAllowedHost,
  isAllowedOrigin,
  readJsonBody,
} from "../server.mjs";

function requestLike({ host = "127.0.0.1:4317", method = "GET", origin = null } = {}) {
  return {
    headers: {
      host,
      ...(origin ? { origin } : {}),
    },
    method,
  };
}

function jsonStream(value) {
  return Readable.from([value]);
}

test("host allowlist accepts local hosts and rejects unexpected hosts", () => {
  assert.equal(isAllowedHost("127.0.0.1:4317"), true);
  assert.equal(isAllowedHost("localhost:4317"), true);
  assert.equal(isAllowedHost("[::1]:4317"), true);
  assert.equal(isAllowedHost("example.com"), false);
});

test("origin allowlist accepts local origins and rejects cross-origin mutations", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:4317"), true);
  assert.equal(isAllowedOrigin("http://localhost:4317"), true);
  assert.equal(isAllowedOrigin("http://example.com"), false);
});

test("request guard rejects bad Host headers", () => {
  assert.throws(
    () => assertRequestAllowed(requestLike({ host: "example.com" })),
    /Host is not allowed/,
  );
});

test("request guard rejects cross-origin mutation requests", () => {
  assert.throws(
    () =>
      assertRequestAllowed(
        requestLike({
          method: "POST",
          origin: "http://example.com",
        }),
      ),
    /Origin is not allowed/,
  );
});

test("readJsonBody parses valid JSON", async () => {
  assert.deepEqual(await readJsonBody(jsonStream('{"profile":"minimal"}')), {
    profile: "minimal",
  });
});

test("readJsonBody returns a clear error for invalid JSON", async () => {
  await assert.rejects(
    () => readJsonBody(jsonStream("{")),
    /Request body must be valid JSON/,
  );
});

test("readJsonBody rejects oversized JSON bodies", async () => {
  await assert.rejects(
    () => readJsonBody(jsonStream(JSON.stringify({ value: "a".repeat(1_000_001) }))),
    /Request body is too large/,
  );
});
