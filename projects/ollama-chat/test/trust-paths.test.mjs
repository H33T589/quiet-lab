import assert from "node:assert/strict";
import { rmSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { resolvePublicFilePath } from "../public-static.mjs";
import {
  configureTooling,
  executeToolCall,
  getEnabledToolDefinitions,
  getToolRuntimeConfig,
  readRepoText,
  resolveRepoPath,
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
});

describe("tooling profiles and budgets", () => {
  test("minimal profile hides search from the model tool schema", () => {
    const original = getToolRuntimeConfig();

    try {
      const config = configureTooling({ profile: "minimal" });
      const enabledNames = getEnabledToolDefinitions().map((definition) => definition.function.name);

      assert.equal(config.profile, "minimal");
      assert.deepEqual(enabledNames, ["list_repo_files", "read_repo_file"]);
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

  test("invalid profile and budget fall back to coding low-ram defaults", () => {
    const original = getToolRuntimeConfig();

    try {
      const config = configureTooling({ profile: "massive", budget: "unbounded" });

      assert.equal(config.profile, "coding");
      assert.equal(config.budget, "low");
    } finally {
      configureTooling(original);
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
