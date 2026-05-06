import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ChatSession, sessionsDir } from "../engine.mjs";
import {
  clearProjectMemory,
  loadProjectMemory,
  setProjectUserNotes,
  updateProjectMemoryFromBootstrap,
} from "../memory.mjs";
import { attachCodebase, repoRoot } from "../tools.mjs";

const tempRepos = [];

afterEach(async () => {
  for (const repoPath of tempRepos.splice(0)) {
    await attachCodebase(repoPath, { persist: false });
    await clearProjectMemory();
    rmSync(repoPath, { recursive: true, force: true });
  }

  await attachCodebase(repoRoot, { persist: false });
  rmSync(path.join(sessionsDir, "memory-answer-test.json"), { force: true });
});

function createTempRepo() {
  const repoPath = mkdtempSync(path.join(tmpdir(), "quiet-lab-memory-"));
  writeFileSync(path.join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  tempRepos.push(repoPath);
  return repoPath;
}

test("project memory stores user notes for the active repository", async () => {
  const repoPath = createTempRepo();
  await attachCodebase(repoPath, { persist: false });

  const saved = await setProjectUserNotes(["Prefer deterministic workflows", "Use small local models"]);
  const loaded = await loadProjectMemory();

  assert.equal(saved.repoName, path.basename(repoPath));
  assert.deepEqual(loaded.userNotes, ["Prefer deterministic workflows", "Use small local models"]);
});

test("project memory updates from repo workflow evidence", async () => {
  const repoPath = createTempRepo();
  await attachCodebase(repoPath, { persist: false });

  await updateProjectMemoryFromBootstrap(
    "Review the repo",
    [
      {
        name: "get_repo_overview",
        content: [
          "TOOL: get_repo_overview",
          "STATUS: OK",
          `REPO: ${path.basename(repoPath)}`,
          "STACK: Node.js, static HTML",
          "LOCKFILES: (none)",
          "PACKAGE_SCRIPTS:",
          "package.json: test = node --test",
          "ENTRYPOINTS:",
          "server.mjs",
          "IMPORTANT_FILES:",
          "package.json",
        ].join("\n"),
      },
    ],
    "Likely risks:\n- No package `lint` script was found.",
  );

  const memory = await loadProjectMemory();

  assert.deepEqual(memory.project.stack, ["Node.js", "static HTML"]);
  assert.ok(memory.project.packageScripts.includes("package.json: test = node --test"));
  assert.ok(memory.project.entrypoints.includes("server.mjs"));
  assert.equal(memory.project.knownRisks.length, 0);
});

test("chat can answer from stored project memory", async () => {
  const repoPath = createTempRepo();
  await attachCodebase(repoPath, { persist: false });
  await setProjectUserNotes(["User wants repo study mode"]);

  const session = new ChatSession({ sessionId: "memory-answer-test", model: "no-network-needed" });
  const result = await session.chat("What do you remember about this project?");

  assert.match(result.text, /Project memory/);
  assert.match(result.text, /User wants repo study mode/);
});
