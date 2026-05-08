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
import { attachCodebase, repoRoot } from "../tools.mjs";

const sessionIds = [
  "save-session-source-test",
  "client-retro",
  "client-retro-2",
  "attached-repo-test",
  "repo-overview-test",
  "repo-risk-test",
  "test-plan-test",
  "embedded-tool-json-test",
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

test("save serializes concurrent writes for the same session", async () => {
  const session = new ChatSession({ sessionId: "save-session-source-test" });
  session.messages.push({ role: "user", content: "first turn" });
  const firstSave = session.save();

  session.messages.push({ role: "assistant", content: "second turn" });
  const secondSave = session.save();

  await Promise.all([firstSave, secondSave]);

  const loaded = new ChatSession({ sessionId: "save-session-source-test" });
  assert.equal(await loaded.load(), true);
  assert.equal(loaded.messages.at(-1)?.content, "second turn");
});

test("chat answers tool capability questions from quiet-lab tooling", async () => {
  await attachCodebase(repoRoot, { persist: false });
  const session = new ChatSession({ sessionId: "save-session-source-test", model: "no-network-needed" });
  const result = await session.chat("What tools do you have access to?");

  assert.match(result.text, /read-only repo tools/);
  assert.match(result.text, /summarize the repository structure/);
});

test("chat confirms the attached repository without asking for a URL", async () => {
  await attachCodebase(path.join(repoRoot, "projects/ollama-chat"), { persist: false });
  const session = new ChatSession({ sessionId: "attached-repo-test", model: "no-network-needed" });
  const result = await session.chat("I attached it on my desktop UI. Can you see it yet?");

  assert.match(result.text, /attached repository `ollama-chat`/);
  assert.doesNotMatch(result.text, /URL|upload|paste/i);
});

test("chat summarizes repository structure from tool evidence before asking the model", async () => {
  await attachCodebase(path.join(repoRoot, "projects/ollama-chat"), { persist: false });
  const session = new ChatSession({ sessionId: "repo-overview-test", model: "no-network-needed" });
  const result = await session.chat("Summarize this repository structure and the main entry points.");

  assert.match(result.text, /I inspected the attached repository `ollama-chat`/);
  assert.match(result.text, /Main entry points:/);
  assert.match(result.text, /`server\.mjs`|`index\.mjs`|`public\/index\.html`/);
  assert.doesNotMatch(result.text, /provide a URL|paste|without accessing/i);
});

test("chat reviews repo risks from tool evidence before asking the model", async () => {
  await attachCodebase(path.join(repoRoot, "projects/ollama-chat"), { persist: false });
  const session = new ChatSession({ sessionId: "repo-risk-test", model: "no-network-needed" });
  const result = await session.chat("Review the current app code for bugs, edge cases, security risks, and missing tests.");

  assert.match(result.text, /I inspected `ollama-chat`/);
  assert.match(result.text, /Likely risks:/);
  assert.match(result.text, /Scripts found:/);
  assert.doesNotMatch(result.text, /provide a URL|paste|without accessing/i);
});

test("chat suggests focused tests from repo evidence before asking the model", async () => {
  await attachCodebase(path.join(repoRoot, "projects/ollama-chat"), { persist: false });
  const session = new ChatSession({ sessionId: "test-plan-test", model: "no-network-needed" });
  const result = await session.chat("Suggest focused tests for this app.");

  assert.match(result.text, /Focused test plan for `ollama-chat`/);
  assert.match(result.text, /Recommended tests:/);
  assert.match(result.text, /Path safety/);
  assert.doesNotMatch(result.text, /provide a URL|paste|without accessing/i);
});

test("chat explains package.json from attached repo evidence", async () => {
  await attachCodebase(path.join(repoRoot, "projects/ollama-chat"), { persist: false });
  const session = new ChatSession({ sessionId: "save-session-source-test", model: "no-network-needed" });
  const result = await session.chat("Explain this specific file in my repository and call out risks: `package.json`");

  assert.match(result.text, /I read `package\.json`|I inspected `ollama-chat`/);
  assert.match(result.text, /node --test|package\.json/);
  assert.doesNotMatch(result.text, /provide a URL|paste/i);
});

test("chat executes tool JSON even when the model wraps it in prose", async () => {
  await attachCodebase(path.join(repoRoot, "projects/ollama-chat"), { persist: false });
  const originalFetch = globalThis.fetch;
  const responses = [
    {
      message: {
        content: [
          "I will search now.",
          "```json",
          "{\"name\":\"search_repo\",\"arguments\":{\"query\":\"createSessionIdFromTitle\"}}",
          "```",
        ].join("\n"),
      },
    },
    {
      message: {
        content: "The search found `createSessionIdFromTitle` in the session engine tests and implementation.",
      },
    },
  ];

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => responses.shift(),
  });

  try {
    const session = new ChatSession({ sessionId: "embedded-tool-json-test", model: "mock-model" });
    const result = await session.chat("search for createSessionIdFromTitle");

    assert.match(result.text, /search found `createSessionIdFromTitle`/);
    assert.equal(result.toolEvents.some((event) => event.call.function.name === "search_repo"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
