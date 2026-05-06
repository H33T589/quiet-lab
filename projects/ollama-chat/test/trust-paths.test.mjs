import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { resolvePublicFilePath } from "../public-static.mjs";
import {
  attachCodebase,
  configureTooling,
  executeToolCall,
  findRepoEntrypoints,
  getEnabledToolDefinitions,
  getRepoOverview,
  getToolRuntimeConfig,
  inspectDependencyManifests,
  readManyRepoFiles,
  readRepoText,
  repoRoot,
  resolveRepoPath,
  searchRepoMatches,
  summarizeFileSymbols,
} from "../tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatDir = path.join(__dirname, "..");
const publicDir = path.join(chatDir, "public");

describe("resolveRepoPath", () => {
  test("accepts README at repo root", () => {
    const { rel } = resolveRepoPath("README.md");
    assert.equal(rel, "README.md");
  });

  test("rejects parent traversal", () => {
    assert.throws(() => resolveRepoPath("../package.json"), /repository root/);
  });

  test("rejects absolute path outside repo", () => {
    assert.throws(() => resolveRepoPath("/etc/passwd"), /repository root/);
  });

  test("rejects null byte", () => {
    assert.throws(() => resolveRepoPath("README.md\0/../etc/passwd"), /Invalid path/);
  });

  test("rejects symlink escape", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "quiet-lab-trust-"));
    const secret = path.join(tmp, "secret.txt");
    writeFileSync(secret, "secret");
    const linkName = path.join(chatDir, ".trust-symlink-test");
    symlinkSync(tmp, linkName);

    try {
      assert.throws(
        () => resolveRepoPath("projects/ollama-chat/.trust-symlink-test/secret.txt"),
        /repository root/,
      );
    } finally {
      rmSync(linkName);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("readRepoText", () => {
  test("does not read outside repo via symlink", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "quiet-lab-trust-"));
    const secret = path.join(tmp, "secret.txt");
    writeFileSync(secret, "secret");
    const linkName = path.join(chatDir, ".trust-symlink-test-read");
    symlinkSync(tmp, linkName);

    try {
      const result = await readRepoText({ path: "projects/ollama-chat/.trust-symlink-test-read/secret.txt" });
      assert.equal(result.status, "ERROR");
      assert.match(result.message, /repository root/);
    } finally {
      rmSync(linkName);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("rejects oversized text files before reading them", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "quiet-lab-large-file-"));
    writeFileSync(path.join(tmp, "large.txt"), "a".repeat(1_000_001));

    try {
      await attachCodebase(tmp, { persist: false });
      const result = await readRepoText({ path: "large.txt" });

      assert.equal(result.status, "ERROR");
      assert.match(result.message, /too large/i);
    } finally {
      await attachCodebase(repoRoot, { persist: false });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("workspace switching", () => {
  test("repo paths resolve against the active attached workspace", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "quiet-lab-workspace-"));
    writeFileSync(path.join(tmp, "app.txt"), "workspace file");

    try {
      await attachCodebase(tmp, { persist: false });
      assert.equal(resolveRepoPath("app.txt").rel, "app.txt");
      const result = await readRepoText({ path: "app.txt" });

      assert.equal(result.status, "OK");
      assert.equal(result.content, "workspace file");
    } finally {
      await attachCodebase(repoRoot, { persist: false });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("hidden path search", () => {
  test("search_repo does not expose ollama-chat session contents", async () => {
    const secret = `hidden-session-${Date.now()}-${Math.random()}`;
    const secretSessionPath = path.join(chatDir, "sessions", "hidden-search-test.json");
    mkdirSync(path.dirname(secretSessionPath), { recursive: true });
    writeFileSync(secretSessionPath, JSON.stringify({ secret }));

    try {
      await attachCodebase(chatDir, { persist: false });
      const result = await searchRepoMatches({ query: secret });

      assert.equal(result.status, "OK");
      assert.equal(result.matchCount, 0);
      assert.deepEqual(result.matches, []);
    } finally {
      await attachCodebase(repoRoot, { persist: false });
      rmSync(secretSessionPath, { force: true });
    }
  });
});

describe("tooling profiles and budgets", () => {
  test("lite profile hides search from the model tool schema", () => {
    const original = getToolRuntimeConfig();

    try {
      const config = configureTooling({ profile: "minimal" });
      const enabledNames = getEnabledToolDefinitions().map((definition) => definition.function.name);

      assert.equal(config.profile, "minimal");
      assert.deepEqual(enabledNames, ["get_repo_overview", "list_repo_files", "read_repo_file"]);
    } finally {
      configureTooling(original);
    }
  });

  test("profile changes apply the profile recommended budget", () => {
    const original = getToolRuntimeConfig();

    try {
      configureTooling({ profile: "deep", budget: "expanded" });
      const config = configureTooling({ profile: "minimal" });

      assert.equal(config.profile, "minimal");
      assert.equal(config.budget, "low");
    } finally {
      configureTooling(original);
    }
  });

  test("disabled tools return a deterministic error", async () => {
    const original = getToolRuntimeConfig();

    try {
      configureTooling({ profile: "minimal" });
      const result = await executeToolCall({
        function: {
          name: "search_repo",
          arguments: { query: "README" },
        },
      });

      assert.match(result, /STATUS: ERROR/);
      assert.match(result, /Tool is disabled/);
    } finally {
      configureTooling(original);
    }
  });

  test("low budget caps file read windows", async () => {
    const original = getToolRuntimeConfig();

    try {
      configureTooling({ profile: "coding", budget: "low" });
      const result = await readRepoText({
        path: "projects/ollama-chat/engine.mjs",
        start_line: 1,
        end_line: 500,
      });

      assert.equal(result.status, "OK");
      assert.equal(result.lineRange.end, 120);
    } finally {
      configureTooling(original);
    }
  });

  test("invalid profile and budget fall back to explore low-ram defaults", () => {
    const original = getToolRuntimeConfig();

    try {
      const config = configureTooling({ profile: "massive", budget: "unbounded" });

      assert.equal(config.profile, "explore");
      assert.equal(config.budget, "low");
    } finally {
      configureTooling(original);
    }
  });
});

describe("smart repo tools", () => {
  test("detects stack, entrypoints, multiple reads, and file symbols", async () => {
    const original = getToolRuntimeConfig();
    const tmp = mkdtempSync(path.join(tmpdir(), "quiet-lab-smart-tools-"));

    try {
      writeFileSync(
        path.join(tmp, "package.json"),
        JSON.stringify(
          {
            name: "portfolio-test",
            scripts: {
              dev: "vite",
              build: "vite build",
            },
            dependencies: {
              react: "latest",
              vite: "latest",
            },
            devDependencies: {
              typescript: "latest",
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(path.join(tmp, "index.html"), '<script type="module" src="/src/main.jsx"></script>');
      mkdirSync(path.join(tmp, "src"));
      writeFileSync(
        path.join(tmp, "src", "main.jsx"),
        [
          "import React from 'react';",
          "export function Portfolio() {",
          "  return <main>Hi</main>;",
          "}",
        ].join("\n"),
      );
      await attachCodebase(tmp, { persist: false });
      configureTooling({ profile: "coding", budget: "balanced" });

      const overview = await getRepoOverview();
      const dependencies = await inspectDependencyManifests();
      const entrypoints = await findRepoEntrypoints();
      const files = await readManyRepoFiles({ paths: ["package.json", "src/main.jsx"] });
      const symbols = await summarizeFileSymbols({ path: "src/main.jsx" });

      assert.ok(overview.stack.includes("React"));
      assert.ok(overview.entrypoints.includes("index.html"));
      assert.ok(dependencies.stack.includes("Vite"));
      assert.ok(entrypoints.packageScripts.some((script) => script.includes("build = vite build")));
      assert.equal(files.files.length, 2);
      assert.deepEqual(symbols.symbols.functions, ["Portfolio"]);
    } finally {
      configureTooling(original);
      await attachCodebase(repoRoot, { persist: false });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolvePublicFilePath", () => {
  test("allows index.html", () => {
    const resolved = resolvePublicFilePath(publicDir, "/");
    assert(resolved);
    assert.ok(resolved.endsWith("index.html"));
  });

  test("blocks traversal", () => {
    assert.equal(resolvePublicFilePath(publicDir, "/../server.mjs"), null);
  });

  test("blocks symlink escape", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "quiet-lab-pub-"));
    const secret = path.join(tmp, "x.txt");
    writeFileSync(secret, "x");
    const linkPath = path.join(publicDir, ".trust-pub-link");
    symlinkSync(tmp, linkPath);

    try {
      assert.equal(resolvePublicFilePath(publicDir, "/.trust-pub-link/x.txt"), null);
    } finally {
      rmSync(linkPath);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
