import assert from "node:assert/strict";
import { rmSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { resolvePublicFilePath } from "../public-static.mjs";
import { readRepoText, resolveRepoPath } from "../tools.mjs";

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
