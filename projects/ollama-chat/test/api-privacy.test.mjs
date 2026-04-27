import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatSession } from "../engine.mjs";

test("session JSON exposed to API does not include absolute repoRoot", () => {
  const session = new ChatSession({ sessionId: "trust-json-test-1" });
  const payload = session.toJSON();

  assert.equal(Object.hasOwn(payload, "repoRoot"), false);
  assert.equal(typeof payload.repoName, "string");
  assert.ok(payload.repoName.length > 0);
});
