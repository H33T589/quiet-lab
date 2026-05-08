import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  assertRequestAllowed,
  isAllowedHost,
  isAllowedOrigin,
  isLoopbackRemoteAddress,
  readJsonBody,
} from "../server.mjs";

function requestLike({ host = "127.0.0.1:4317", method = "GET", origin = null, remoteAddress = "127.0.0.1", token = null } = {}) {
  return {
    headers: {
      host,
      ...(origin ? { origin } : {}),
      ...(token ? { "x-quiet-lab-token": token } : {}),
    },
    method,
    socket: { remoteAddress },
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

test("request guard rejects mutation requests without origin", () => {
  assert.throws(
    () => assertRequestAllowed(requestLike({ method: "POST" })),
    /Origin is not allowed/,
  );
});

test("loopback remote address helper accepts local addresses", () => {
  assert.equal(isLoopbackRemoteAddress("127.0.0.1"), true);
  assert.equal(isLoopbackRemoteAddress("::1"), true);
  assert.equal(isLoopbackRemoteAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackRemoteAddress("203.0.113.10"), false);
});

test("request guard rejects non-loopback clients when local mode is required", () => {
  assert.throws(
    () =>
      assertRequestAllowed(requestLike({ remoteAddress: "203.0.113.10" }), "127.0.0.1", {
        requireLocalRemote: true,
      }),
    /Only local loopback clients are allowed/,
  );
});

test("request guard requires API token when configured", () => {
  assert.throws(
    () =>
      assertRequestAllowed(requestLike(), "127.0.0.1", {
        apiToken: "secret-token",
      }),
    /API token is required/,
  );

  assert.doesNotThrow(() =>
    assertRequestAllowed(requestLike({ token: "secret-token" }), "127.0.0.1", {
      apiToken: "secret-token",
    }),
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
