import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  ChatSession,
  createSessionIdFromTitle,
  deleteSession,
  saveSessionAs,
  sessionsDir,
} from "../engine.mjs";

const sessionIds = [
  "save-session-source-test",
  "client-retro",
  "client-retro-2",
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

test("custom preset prompts are saved into the session system prompt", async () => {
  const session = new ChatSession({ sessionId: "save-session-source-test" });

  await session.setCustomPreset("Night Shift", "Answer in short operational notes.");

  assert.equal(session.activePreset, "custom:Night Shift");
  assert.match(session.systemPrompt, /Answer in short operational notes/);

  const loaded = new ChatSession({ sessionId: "save-session-source-test" });
  assert.equal(await loaded.load(), true);
  assert.equal(loaded.activePreset, "custom:Night Shift");
  assert.match(loaded.systemPrompt, /Answer in short operational notes/);
});
