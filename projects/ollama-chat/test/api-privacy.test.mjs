import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ChatSession } from "../engine.mjs";
import { attachCodebase, detachCodebase } from "../tools.mjs";

test("session JSON exposed to API does not include absolute repoRoot", async () => {
  await detachCodebase();
  const session = new ChatSession({ sessionId: "trust-json-test-1" });
  const payload = session.toJSON();

  assert.equal(Object.hasOwn(payload, "repoRoot"), false);
  assert.equal(payload.repoName, null);
});

test("session JSON exposes only repo name after attaching a codebase", async () => {
  await attachCodebase(fileURLToPath(new URL("..", import.meta.url)));
  const session = new ChatSession({ sessionId: "trust-json-test-2" });
  const payload = session.toJSON();

  assert.equal(Object.hasOwn(payload, "repoRoot"), false);
  assert.equal(payload.repoName, "ollama-chat");
  await detachCodebase();
});
