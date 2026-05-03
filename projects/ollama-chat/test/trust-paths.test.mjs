import assert from "node:assert/strict";
import { rmSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import { resolvePublicFilePath } from "../public-static.mjs";
import {
  attachCodebase,
  detachCodebase,
  findRepoEntrypoints,
  getRepoOverview,
  getWorkspaceSnapshot,
  inspectDependencyManifests,
  readManyRepoFiles,
  readRepoText,
  resolveRepoPath,
  summarizeFileSymbols,
} from "../tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatDir = path.join(__dirname, "..");
const publicDir = path.join(chatDir, "public");

describe("resolveRepoPath", () => {
  beforeEach(async () => {
    await attachCodebase(chatDir);
  });

  afterEach(async () => {
    await detachCodebase();
  });

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
        () => resolveRepoPath(".trust-symlink-test/secret.txt"),
        /repository root/,
      );
    } finally {
      rmSync(linkName);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("readRepoText", () => {
  beforeEach(async () => {
    await attachCodebase(chatDir);
  });

  afterEach(async () => {
    await detachCodebase();
  });

  test("does not read outside repo via symlink", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "quiet-lab-trust-"));
    const secret = path.join(tmp, "secret.txt");
    writeFileSync(secret, "secret");
    const linkName = path.join(chatDir, ".trust-symlink-test-read");
    symlinkSync(tmp, linkName);

    try {
      const result = await readRepoText({ path: ".trust-symlink-test-read/secret.txt" });
      assert.equal(result.status, "ERROR");
      assert.match(result.message, /repository root/);
    } finally {
      rmSync(linkName);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("workspace attachment", () => {
  afterEach(async () => {
    await detachCodebase();
  });

  test("starts with no active codebase after detach", async () => {
    await detachCodebase();
    assert.equal(getWorkspaceSnapshot().attached, false);
    assert.throws(() => resolveRepoPath("README.md"), /No codebase attached/);
  });

  test("attaches an existing directory", async () => {
    const workspace = await attachCodebase(chatDir);
    assert.equal(workspace.attached, true);
    assert.equal(workspace.repoName, "ollama-chat");
    assert.equal(resolveRepoPath("README.md").rel, "README.md");
  });

  test("rejects missing paths, files, and null bytes", async () => {
    await assert.rejects(
      () => attachCodebase(path.join(chatDir, "does-not-exist")),
      /does not exist/,
    );
    await assert.rejects(() => attachCodebase(path.join(chatDir, "README.md")), /directory/);
    await assert.rejects(() => attachCodebase(`${chatDir}\0`), /Invalid path/);
  });
});

describe("smart repo tools", () => {
  let tmp;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "quiet-lab-smart-tools-"));
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
            "@vitejs/plugin-react": "latest",
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
    await mkdir(path.join(tmp, "src"));
    writeFileSync(
      path.join(tmp, "src", "main.jsx"),
      [
        "import React from 'react';",
        "export function Portfolio() {",
        "  return <main>Hi</main>;",
        "}",
      ].join("\n"),
    );
    await attachCodebase(tmp);
  });

  afterEach(async () => {
    await detachCodebase();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("detects overview, stack, scripts, and entry points", async () => {
    const overview = await getRepoOverview();

    assert.equal(overview.status, "OK");
    assert.ok(overview.stack.includes("React"));
    assert.ok(overview.stack.includes("Vite"));
    assert.ok(overview.packageScripts.some((script) => script.includes("dev = vite")));
    assert.ok(overview.entrypoints.includes("index.html"));
    assert.ok(overview.entrypoints.includes("src/main.jsx"));
  });

  test("inspects dependencies and entrypoints directly", async () => {
    const dependencies = await inspectDependencyManifests();
    const entrypoints = await findRepoEntrypoints();

    assert.ok(dependencies.stack.includes("TypeScript"));
    assert.ok(entrypoints.packageScripts.some((script) => script.includes("build = vite build")));
    assert.ok(entrypoints.appRoots.includes("src/main.jsx"));
  });

  test("reads many files and summarizes file symbols", async () => {
    const files = await readManyRepoFiles({ paths: ["package.json", "src/main.jsx"] });
    const symbols = await summarizeFileSymbols({ path: "src/main.jsx" });

    assert.equal(files.status, "OK");
    assert.equal(files.files.length, 2);
    assert.deepEqual(symbols.symbols.functions, ["Portfolio"]);
    assert.ok(symbols.symbols.imports[0].includes("React"));
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
