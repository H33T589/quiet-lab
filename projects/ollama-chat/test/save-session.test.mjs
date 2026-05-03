import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  ChatSession,
  createSessionIdFromTitle,
  deleteSession,
  saveSessionAs,
  sessionsDir,
} from "../engine.mjs";
import { attachCodebase, detachCodebase } from "../tools.mjs";

const sessionIds = [
  "save-session-source-test",
  "client-retro",
  "client-retro-2",
  "deterministic-file-answer-test",
];

function removeTestSessions() {
  for (const sessionId of sessionIds) {
    rmSync(path.join(sessionsDir, `${sessionId}.json`), { force: true });
  }
}

beforeEach(removeTestSessions);
afterEach(removeTestSessions);

test("createSessionIdFromTitle turns a conversation name into a safe session id", () => {
  assert.equal(createSessionIdFromTitle("Client Retro!"), "client-retro");
  assert.equal(createSessionIdFromTitle("  Client   Retro  "), "client-retro");
});

test("saveSessionAs copies the source session into a named session file", async () => {
  const source = new ChatSession({ sessionId: "save-session-source-test" });
  source.messages.push({ role: "user", content: "What changed?" });
  source.messages.push({ role: "assistant", content: "The save flow was added." });
  await source.save();

  const saved = await saveSessionAs("save-session-source-test", "Client Retro");

  assert.equal(saved.sessionId, "client-retro");
  assert.equal(saved.title, "Client Retro");
  assert.equal(saved.messages.at(-1).content, "The save flow was added.");

  const loaded = new ChatSession({ sessionId: "client-retro" });
  assert.equal(await loaded.load(), true);
  assert.equal(loaded.toJSON().title, "Client Retro");
});

test("saveSessionAs does not overwrite an existing named session", async () => {
  const source = new ChatSession({ sessionId: "save-session-source-test" });
  source.messages.push({ role: "user", content: "Save this twice." });
  await source.save();

  const first = await saveSessionAs("save-session-source-test", "Client Retro");
  const second = await saveSessionAs("save-session-source-test", "Client Retro");

  assert.equal(first.sessionId, "client-retro");
  assert.equal(second.sessionId, "client-retro-2");
});

test("deleteSession removes a saved session file", async () => {
  const source = new ChatSession({ sessionId: "save-session-source-test" });
  source.messages.push({ role: "user", content: "Temporary chat." });
  await source.save();

  assert.equal(await source.load(), true);
  await deleteSession("save-session-source-test");

  const deleted = new ChatSession({ sessionId: "save-session-source-test" });
  assert.equal(await deleted.load(), false);
});

test("chat returns deterministic file explanation from successful repo tools", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "quiet-lab-file-answer-"));
  writeFileSync(
    path.join(tmp, "index.html"),
    [
      "<!DOCTYPE html>",
      "<html>",
      "<head>",
      '<meta name="description" content="Portfolio for local AI work" />',
      "<title>Portfolio</title>",
      '<script src="https://example.com/app.js"></script>',
      "</head>",
      "<body></body>",
      "</html>",
    ].join("\n"),
  );
  await attachCodebase(tmp);

  try {
    const session = new ChatSession({ sessionId: "deterministic-file-answer-test", preset: "repo" });
    const result = await session.chat("Explain this file and call out risks: index.html");

    assert.match(result.text, /index\.html/);
    assert.match(result.text, /HTML entry document/);
    assert.match(result.text, /External assets/);
  } finally {
    await detachCodebase();
    rmSync(tmp, { recursive: true, force: true });
  }
});
