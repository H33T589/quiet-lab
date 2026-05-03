import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceStatePath = path.join(__dirname, "sessions", "workspace.json");
const maxRecentCodebases = 8;

let activeRepoRoot = null;
let activeRepoRootCanonical = null;
let recentCodebases = [];

export const hiddenPaths = [
  ".git",
  ".idea",
  ".vscode",
  ".DS_Store",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
];

const toolDescriptions = {
  get_repo_overview:
    "Inspect the attached repository and return a concise overview with structure, likely stack, entry points, and key files. Use this first for broad questions like what this project is or how it works.",
  find_entrypoints:
    "Find likely application entry points, build configs, route roots, and package scripts in the repository.",
  inspect_dependencies:
    "Inspect dependency manifests and summarize the framework, package scripts, runtime dependencies, and development tooling.",
  list_repo_files:
    "List files and directories inside the repository. Use this for structure questions. Prefer relative paths.",
  read_many_files:
    "Read bounded excerpts from multiple repository text files in one call. Use this when context spans package, README, app entry, and config files.",
  read_repo_file:
    "Read a text file from the repository with line numbers. Use this for README, source, and config questions.",
  search_repo:
    "Search repository files for a string or regex pattern. Use this only to locate unknown text or symbols.",
  summarize_file_symbols:
    "Summarize lightweight symbols from a source file: imports, exports, functions, classes, components, selectors, routes, and scripts.",
};

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "get_repo_overview",
      description: toolDescriptions.get_repo_overview,
      parameters: {
        type: "object",
        properties: {
          max_entries: {
            type: "integer",
            description: "Maximum top-level and important files to include. Defaults to 80 and is capped at 160.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_entrypoints",
      description: toolDescriptions.find_entrypoints,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_dependencies",
      description: toolDescriptions.inspect_dependencies,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_repo_files",
      description: toolDescriptions.list_repo_files,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path inside the repository. Leave empty for the repository root.",
          },
          depth: {
            type: "integer",
            description: "Maximum directory depth to explore. Defaults to 1 and is capped at 4.",
          },
          max_entries: {
            type: "integer",
            description: "Maximum number of entries to return. Defaults to 60 and is capped at 200.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_many_files",
      description: toolDescriptions.read_many_files,
      parameters: {
        type: "object",
        required: ["paths"],
        properties: {
          paths: {
            type: "array",
            description: "Repository-relative file paths to read.",
            items: {
              type: "string",
            },
          },
          max_lines_per_file: {
            type: "integer",
            description: "Maximum lines to include per file. Defaults to 80 and is capped at 160.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_repo_file",
      description: toolDescriptions.read_repo_file,
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Relative file path inside the repository.",
          },
          start_line: {
            type: "integer",
            description: "1-based starting line. Defaults to 1.",
          },
          end_line: {
            type: "integer",
            description: "1-based ending line. Defaults to 200 and is capped to a small window.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_repo",
      description: toolDescriptions.search_repo,
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Search pattern to run against repository files.",
          },
          path: {
            type: "string",
            description: "Optional relative path to limit the search scope.",
          },
          max_results: {
            type: "integer",
            description: "Maximum number of matches to return. Defaults to 20 and is capped at 50.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarize_file_symbols",
      description: toolDescriptions.summarize_file_symbols,
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Repository-relative source file path.",
          },
        },
      },
    },
  },
];

export function listTools() {
  return Object.entries(toolDescriptions)
    .map(([name, description]) => `${name}: ${description}`)
    .join("\n");
}

function expandHome(inputPath) {
  const raw = String(inputPath || "").trim();

  if (raw === "~") {
    return os.homedir();
  }

  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2));
  }

  return raw;
}

function normalizeRelative(value = ".") {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
}

function getActiveRepoRoot() {
  if (!activeRepoRoot || !activeRepoRootCanonical) {
    throw new Error("No codebase attached.");
  }

  return {
    root: activeRepoRoot,
    canonicalRoot: activeRepoRootCanonical,
    name: path.basename(activeRepoRoot),
  };
}

function createWorkspaceSnapshot({ includeRecent = false } = {}) {
  const snapshot = {
    attached: Boolean(activeRepoRoot),
    repoName: activeRepoRoot ? path.basename(activeRepoRoot) : null,
  };

  if (includeRecent) {
    snapshot.recentCodebases = recentCodebases;
  }

  return snapshot;
}

export function getWorkspaceSnapshot(options = {}) {
  return createWorkspaceSnapshot(options);
}

export function getWorkspaceName() {
  return activeRepoRoot ? path.basename(activeRepoRoot) : "no codebase attached";
}

export function hasAttachedCodebase() {
  return Boolean(activeRepoRoot);
}

async function saveWorkspaceState() {
  await mkdir(path.dirname(workspaceStatePath), { recursive: true });
  await writeFile(
    workspaceStatePath,
    JSON.stringify({ recentCodebases }, null, 2),
    "utf8",
  );
}

export async function loadWorkspaceState() {
  try {
    const raw = await readFile(workspaceStatePath, "utf8");
    const saved = JSON.parse(raw);
    recentCodebases = Array.isArray(saved.recentCodebases)
      ? saved.recentCodebases.filter((value) => typeof value === "string")
      : [];
  } catch {
    recentCodebases = [];
  }

  activeRepoRoot = null;
  activeRepoRootCanonical = null;
  return getWorkspaceSnapshot({ includeRecent: true });
}

export async function attachCodebase(inputPath) {
  const raw = expandHome(inputPath);

  if (!raw) {
    throw new Error("Codebase path is required.");
  }

  if (raw.includes("\0")) {
    throw new Error("Invalid path.");
  }

  const abs = path.resolve(raw);
  let info;

  try {
    info = await stat(abs);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Codebase path does not exist.");
    }

    throw error;
  }

  if (!info.isDirectory()) {
    throw new Error("Codebase path must be a directory.");
  }

  const canonical = realpathSync(abs);
  activeRepoRoot = canonical;
  activeRepoRootCanonical = canonical;
  recentCodebases = [
    canonical,
    ...recentCodebases.filter((candidate) => candidate !== canonical),
  ].slice(0, maxRecentCodebases);
  await saveWorkspaceState();
  return getWorkspaceSnapshot({ includeRecent: true });
}

export async function detachCodebase() {
  activeRepoRoot = null;
  activeRepoRootCanonical = null;
  return getWorkspaceSnapshot({ includeRecent: true });
}

function parseToolArguments(rawArguments) {
  if (rawArguments == null) {
    return {};
  }

  if (typeof rawArguments === "string") {
    try {
      return JSON.parse(rawArguments);
    } catch {
      return {};
    }
  }

  if (typeof rawArguments === "object") {
    return rawArguments;
  }

  return {};
}

function isHidden(relativePath) {
  const rel = normalizeRelative(relativePath);
  const segments = rel.split("/");
  return hiddenPaths.some((hiddenPath) => (
    rel === hiddenPath ||
    rel.startsWith(`${hiddenPath}/`) ||
    segments.includes(hiddenPath)
  ));
}

function getRipgrepHiddenGlobs() {
  return hiddenPaths.flatMap((hiddenPath) => [
    "--glob",
    `!${hiddenPath}`,
    "--glob",
    `!${hiddenPath}/**`,
    "--glob",
    `!**/${hiddenPath}`,
    "--glob",
    `!**/${hiddenPath}/**`,
  ]);
}

/** Ensures resolved paths cannot escape the repo via .. segments or symlink targets. */
function assertPathWithinRepo(absPath) {
  const { canonicalRoot } = getActiveRepoRoot();
  const normalizedAbs = path.normalize(absPath);

  let canonicalTarget;

  try {
    canonicalTarget = realpathSync(normalizedAbs);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    const relativeToRoot = path.relative(canonicalRoot, normalizedAbs);

    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error("Path must stay inside the repository root.");
    }

    return;
  }

  const relativeToRoot = path.relative(canonicalRoot, canonicalTarget);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("Path must stay inside the repository root.");
  }
}

export function resolveRepoPath(inputPath = ".") {
  const { root, name } = getActiveRepoRoot();
  const raw = String(inputPath || ".").trim();

  if (raw.includes("\0")) {
    throw new Error("Invalid path.");
  }

  const repoPrefix = `${name}/`;

  if (raw === "/" || raw === root) {
    assertPathWithinRepo(root);
    return { abs: root, rel: "." };
  }

  const normalizedRaw = raw.startsWith(repoPrefix) ? raw.slice(repoPrefix.length) : raw;

  if (path.isAbsolute(normalizedRaw)) {
    const abs = path.resolve(normalizedRaw);
    assertPathWithinRepo(abs);

    const rel = normalizeRelative(path.relative(root, abs));

    if (rel !== "." && isHidden(rel)) {
      throw new Error("That path is intentionally hidden from tools.");
    }

    return { abs, rel };
  }

  const abs = path.resolve(root, normalizedRaw);
  assertPathWithinRepo(abs);

  const rel = normalizeRelative(path.relative(root, abs));

  if (rel !== "." && isHidden(rel)) {
    throw new Error("That path is intentionally hidden from tools.");
  }

  return { abs, rel };
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatToolResult(name, fields) {
  return [`TOOL: ${name}`, ...fields.map(([key, value]) => `${key}: ${value}`)].join("\n");
}

function formatList(values) {
  return values.length ? `\n${values.join("\n")}` : "(none)";
}

async function listRepoFilePaths(maxResults = 500) {
  const { root } = getActiveRepoRoot();

  try {
    const { stdout } = await execFileAsync("rg", [
      "--files",
      "--hidden",
      ...getRipgrepHiddenGlobs(),
      root,
    ]);

    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(`${root}/`, ""))
      .filter((line) => !isHidden(line))
      .slice(0, maxResults);
  } catch (error) {
    if (error?.code === 1) {
      return [];
    }

    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const files = [];

  async function walk(currentAbs, currentRel = ".") {
    if (files.length >= maxResults) {
      return;
    }

    const dirEntries = await readdir(currentAbs, { withFileTypes: true });
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirEntries) {
      if (files.length >= maxResults) {
        return;
      }

      const childRel = normalizeRelative(
        currentRel === "." ? dirent.name : `${currentRel}/${dirent.name}`,
      );

      if (isHidden(childRel)) {
        continue;
      }

      const childAbs = path.join(currentAbs, dirent.name);

      if (dirent.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (dirent.isFile()) {
        files.push(childRel);
      }
    }
  }

  await walk(root);
  return files;
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function pickExisting(files, candidates) {
  const fileSet = new Set(files);
  return candidates.filter((candidate) => fileSet.has(candidate));
}

function pickByBasename(files, basenames) {
  const wanted = new Set(basenames);
  return files.filter((file) => wanted.has(path.basename(file)));
}

function pickByPattern(files, patterns, limit = 40) {
  return files.filter((file) => patterns.some((pattern) => pattern.test(file))).slice(0, limit);
}

async function readJsonFileIfPresent(repoPath) {
  const result = await readRepoText({ path: repoPath, start_line: 1, end_line: 220 });

  if (result.status !== "OK") {
    return null;
  }

  try {
    return JSON.parse(result.content);
  } catch {
    return null;
  }
}

function inferStack(files, packageJsons) {
  const names = new Set();
  const depNames = new Set();

  for (const packageJson of packageJsons) {
    const dependencies = Array.isArray(packageJson.dependencies)
      ? packageJson.dependencies
      : Object.keys(packageJson.dependencies || {});
    const devDependencies = Array.isArray(packageJson.devDependencies)
      ? packageJson.devDependencies
      : Object.keys(packageJson.devDependencies || {});

    for (const dependency of [...dependencies, ...devDependencies]) {
      depNames.add(dependency);
    }
  }

  const addIfDep = (dependency, label) => {
    if (depNames.has(dependency)) {
      names.add(label);
    }
  };

  addIfDep("next", "Next.js");
  addIfDep("react", "React");
  addIfDep("vue", "Vue");
  addIfDep("svelte", "Svelte");
  addIfDep("astro", "Astro");
  addIfDep("vite", "Vite");
  addIfDep("express", "Express");
  addIfDep("tailwindcss", "Tailwind CSS");
  addIfDep("typescript", "TypeScript");

  if (files.some((file) => file === "index.html")) {
    names.add("static HTML");
  }

  if (files.some((file) => /\.tsx?$/.test(file))) {
    names.add("TypeScript");
  }

  if (files.some((file) => file.endsWith(".jsx") || file.endsWith(".tsx"))) {
    names.add("component UI");
  }

  return [...names];
}

function extractPackageScripts(packageJson, packagePath) {
  return Object.entries(packageJson.scripts || {}).map(
    ([name, command]) => `${packagePath}: ${name} = ${command}`,
  );
}

function getImportantFileCandidates(files) {
  return uniq([
    ...pickExisting(files, [
      "README.md",
      "package.json",
      "index.html",
      "vite.config.js",
      "vite.config.mjs",
      "vite.config.ts",
      "next.config.js",
      "next.config.mjs",
      "astro.config.mjs",
      "src/main.js",
      "src/main.jsx",
      "src/main.ts",
      "src/main.tsx",
      "src/App.js",
      "src/App.jsx",
      "src/App.tsx",
      "app/page.tsx",
      "pages/index.js",
      "pages/index.tsx",
    ]),
    ...pickByBasename(files, ["package.json", "README.md"]).slice(0, 8),
  ]).slice(0, 18);
}

function createSearchMatcher(query) {
  try {
    return new RegExp(query, query === query.toLowerCase() ? "i" : "");
  } catch {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, query === query.toLowerCase() ? "i" : "");
  }
}

async function searchRepoWithoutRipgrep({ query, rel, maxResults }) {
  const files = await listRepoFilePaths(1200);
  const matcher = createSearchMatcher(query);
  const scopedFiles = rel === "."
    ? files
    : files.filter((file) => file === rel || file.startsWith(`${rel}/`));
  const matches = [];

  for (const repoPath of scopedFiles) {
    if (matches.length >= maxResults) {
      break;
    }

    const { abs } = resolveRepoPath(repoPath);
    let raw;

    try {
      raw = await readFile(abs, "utf8");
    } catch {
      continue;
    }

    if (raw.includes("\u0000")) {
      continue;
    }

    const lines = raw.split("\n");

    for (const [index, line] of lines.entries()) {
      matcher.lastIndex = 0;

      if (matcher.test(line)) {
        matches.push(`${repoPath}:${index + 1}:${line}`);
      }

      if (matches.length >= maxResults) {
        break;
      }
    }
  }

  return matches;
}

async function getTargetInfo(abs) {
  try {
    const info = await stat(abs);
    return {
      exists: true,
      kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, kind: "missing" };
    }

    throw error;
  }
}

export async function findRepoPathCandidates(input, maxResults = 5) {
  let root;

  try {
    ({ root } = getActiveRepoRoot());
  } catch {
    return [];
  }

  const raw = String(input || "").trim();

  if (!raw) {
    return [];
  }

  const needle = raw.replace(/^['"`]+|['"`]+$/g, "").replace(/^\.\/+/, "");

  if (!needle || needle === "/") {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("rg", [
      "--files",
      "--hidden",
      ...getRipgrepHiddenGlobs(),
      root,
    ]);

    const files = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(`${root}/`, ""))
      .filter((line) => !isHidden(line));

    const suffixMatches = files.filter(
      (file) => file === needle || file.endsWith(`/${needle}`),
    );

    if (suffixMatches.length) {
      return suffixMatches.slice(0, maxResults);
    }

    const basenameMatches = files.filter((file) => path.basename(file) === needle);
    return basenameMatches.slice(0, maxResults);
  } catch {
    return [];
  }
}

export async function listRepoEntries(rawArgs = {}) {
  const args = parseToolArguments(rawArgs);
  let abs;
  let rel;

  try {
    ({ abs, rel } = resolveRepoPath(args.path || "."));
  } catch (error) {
    return {
      status: "ERROR",
      path: ".",
      message: error.message,
    };
  }
  const maxDepth = Math.min(Math.max(toInt(args.depth, 1), 0), 4);
  const maxEntries = Math.min(Math.max(toInt(args.max_entries, 60), 1), 200);
  const entries = [];
  const info = await getTargetInfo(abs);

  if (!info.exists) {
    return {
      status: "ERROR",
      path: rel,
      message: "Target path does not exist.",
    };
  }

  if (info.kind !== "directory") {
    return {
      status: "ERROR",
      path: rel,
      message: "Target path is not a directory.",
    };
  }

  async function walk(currentAbs, currentRel, depth) {
    if (entries.length >= maxEntries || depth > maxDepth) {
      return;
    }

    const dirEntries = await readdir(currentAbs, { withFileTypes: true });
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirEntries) {
      if (entries.length >= maxEntries) {
        return;
      }

      const childRel = normalizeRelative(
        currentRel === "." ? dirent.name : `${currentRel}/${dirent.name}`,
      );

      if (isHidden(childRel)) {
        continue;
      }

      entries.push({
        path: childRel,
        name: dirent.name,
        kind: dirent.isDirectory() ? "directory" : "file",
      });

      if (dirent.isDirectory() && depth < maxDepth) {
        await walk(path.join(currentAbs, dirent.name), childRel, depth + 1);
      }
    }
  }

  await walk(abs, rel, 0);

  return {
    status: "OK",
    path: rel,
    targetKind: "directory",
    maxDepth,
    entryCount: entries.length,
    capped: entries.length >= maxEntries,
    entries,
  };
}

export async function readRepoText(rawArgs = {}) {
  const args = parseToolArguments(rawArgs);
  let abs;
  let rel;

  try {
    ({ abs, rel } = resolveRepoPath(args.path));
  } catch (error) {
    return {
      status: "ERROR",
      path: ".",
      message: error.message,
    };
  }
  const startLine = Math.max(toInt(args.start_line, 1), 1);
  const requestedEnd = Math.max(toInt(args.end_line, startLine + 199), startLine);
  const endLine = Math.min(requestedEnd, startLine + 249);
  const info = await getTargetInfo(abs);

  if (!info.exists) {
    return {
      status: "ERROR",
      path: rel,
      message: "Target file does not exist.",
    };
  }

  if (info.kind !== "file") {
    return {
      status: "ERROR",
      path: rel,
      message: "Target path is not a file.",
    };
  }

  const raw = await readFile(abs, "utf8");

  if (raw.includes("\u0000")) {
    return {
      status: "ERROR",
      path: rel,
      message: "Binary files are not supported.",
    };
  }

  const lines = raw.split("\n");
  const slice = lines.slice(startLine - 1, endLine);
  const lineEnd = Math.min(endLine, lines.length);

  return {
    status: "OK",
    path: rel,
    targetKind: "file",
    lineRange: {
      start: startLine,
      end: lineEnd,
      total: lines.length,
    },
    content: slice.join("\n"),
    numberedLines: slice.map((line, index) => ({
      number: startLine + index,
      text: line,
    })),
  };
}

export async function searchRepoMatches(rawArgs = {}) {
  const args = parseToolArguments(rawArgs);
  const query = String(args.query || "").trim();

  if (!query) {
    return {
      status: "ERROR",
      path: ".",
      message: "search_repo requires a non-empty query.",
    };
  }

  let abs;
  let rel;

  try {
    ({ abs, rel } = resolveRepoPath(args.path || "."));
  } catch (error) {
    return {
      status: "ERROR",
      path: ".",
      query,
      message: error.message,
    };
  }

  const maxResults = Math.min(Math.max(toInt(args.max_results, 20), 1), 50);
  const targetInfo = await getTargetInfo(abs);

  if (!targetInfo.exists) {
    return {
      status: "ERROR",
      path: rel,
      query,
      message: "Target path does not exist.",
    };
  }

  try {
    const { root } = getActiveRepoRoot();
    const { stdout } = await execFileAsync("rg", [
      "-n",
      "--hidden",
      "-S",
      ...getRipgrepHiddenGlobs(),
      "--max-count",
      String(maxResults),
      "--",
      query,
      abs,
    ]);

    const matches = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(`${root}/`, ""))
      .slice(0, maxResults);

    return {
      status: "OK",
      path: rel,
      query,
      targetExists: true,
      targetKind: targetInfo.kind,
      matchCount: matches.length,
      capped: matches.length >= maxResults,
      matches,
    };
  } catch (error) {
    if (error?.code === 1) {
      return {
        status: "OK",
        path: rel,
        query,
        targetExists: true,
        targetKind: targetInfo.kind,
        matchCount: 0,
        capped: false,
        note: "The target path exists, but the query returned no matches.",
        matches: [],
      };
    }

    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const matches = await searchRepoWithoutRipgrep({ query, rel, maxResults });

  return {
    status: "OK",
    path: rel,
    query,
    targetExists: true,
    targetKind: targetInfo.kind,
    matchCount: matches.length,
    capped: matches.length >= maxResults,
    note: "Used built-in search because ripgrep was not available.",
    matches,
  };
}

export async function inspectDependencyManifests() {
  const files = await listRepoFilePaths(700);
  const packagePaths = pickByBasename(files, ["package.json"]).slice(0, 8);
  const manifests = [];

  for (const packagePath of packagePaths) {
    const packageJson = await readJsonFileIfPresent(packagePath);

    if (!packageJson) {
      manifests.push({
        path: packagePath,
        status: "unreadable",
      });
      continue;
    }

    manifests.push({
      path: packagePath,
      name: packageJson.name || null,
      private: Boolean(packageJson.private),
      scripts: packageJson.scripts || {},
      dependencies: Object.keys(packageJson.dependencies || {}),
      devDependencies: Object.keys(packageJson.devDependencies || {}),
    });
  }

  return {
    status: "OK",
    manifests,
    stack: inferStack(
      files,
      manifests.filter((manifest) => manifest.status !== "unreadable"),
    ),
    lockfiles: pickExisting(files, [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lockb",
    ]),
  };
}

export async function findRepoEntrypoints() {
  const files = await listRepoFilePaths(900);
  const packagePaths = pickByBasename(files, ["package.json"]).slice(0, 8);
  const scripts = [];

  for (const packagePath of packagePaths) {
    const packageJson = await readJsonFileIfPresent(packagePath);

    if (packageJson) {
      scripts.push(...extractPackageScripts(packageJson, packagePath));
    }
  }

  const configs = pickByPattern(files, [
    /(^|\/)vite\.config\.[cm]?[jt]s$/,
    /(^|\/)next\.config\.[cm]?js$/,
    /(^|\/)astro\.config\.mjs$/,
    /(^|\/)svelte\.config\.[cm]?js$/,
    /(^|\/)tailwind\.config\.[cm]?[jt]s$/,
    /(^|\/)tsconfig\.json$/,
  ]);
  const appRoots = pickExisting(files, [
    "index.html",
    "src/main.js",
    "src/main.jsx",
    "src/main.ts",
    "src/main.tsx",
    "src/App.js",
    "src/App.jsx",
    "src/App.tsx",
    "app/page.js",
    "app/page.jsx",
    "app/page.tsx",
    "pages/index.js",
    "pages/index.jsx",
    "pages/index.tsx",
  ]);
  const routes = pickByPattern(files, [
    /^app\/.*\/page\.[jt]sx?$/,
    /^pages\/.*\.[jt]sx?$/,
    /^src\/routes\/.*\.[jt]sx?$/,
  ], 30);
  const serverFiles = pickByPattern(files, [
    /(^|\/)(server|app|index|main)\.[cm]?[jt]s$/,
    /(^|\/)api\/.*\.[jt]s$/,
  ], 30);

  return {
    status: "OK",
    packageScripts: scripts,
    configs,
    appRoots,
    routes,
    serverFiles,
  };
}

export async function getRepoOverview(rawArgs = {}) {
  const args = parseToolArguments(rawArgs);
  const maxEntries = Math.min(Math.max(toInt(args.max_entries, 80), 20), 160);
  const files = await listRepoFilePaths(1000);
  const topLevel = await listRepoEntries({ path: ".", depth: 1, max_entries: maxEntries });
  const dependencies = await inspectDependencyManifests();
  const entrypoints = await findRepoEntrypoints();
  const importantFiles = getImportantFileCandidates(files);

  return {
    status: "OK",
    repoName: getWorkspaceName(),
    fileCountSampled: files.length,
    stack: dependencies.stack,
    topLevel: topLevel.status === "OK"
      ? topLevel.entries.map((entry) => (entry.kind === "directory" ? `${entry.path}/` : entry.path))
      : [],
    packageManifests: dependencies.manifests.map((manifest) => manifest.path),
    lockfiles: dependencies.lockfiles,
    packageScripts: entrypoints.packageScripts.slice(0, 20),
    entrypoints: uniq([
      ...entrypoints.appRoots,
      ...entrypoints.configs,
      ...entrypoints.routes.slice(0, 12),
      ...entrypoints.serverFiles.slice(0, 12),
    ]),
    importantFiles,
  };
}

export async function readManyRepoFiles(rawArgs = {}) {
  const args = parseToolArguments(rawArgs);
  const paths = Array.isArray(args.paths) ? args.paths.slice(0, 8) : [];
  const maxLines = Math.min(Math.max(toInt(args.max_lines_per_file, 80), 10), 160);

  if (!paths.length) {
    return {
      status: "ERROR",
      message: "read_many_files requires at least one path.",
      files: [],
    };
  }

  const files = [];

  for (const repoPath of paths) {
    const result = await readRepoText({
      path: repoPath,
      start_line: 1,
      end_line: maxLines,
    });

    files.push(result);
  }

  return {
    status: "OK",
    files,
  };
}

function summarizeSymbolsFromText(repoPath, content) {
  const lines = content.split("\n");
  const symbols = {
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    selectors: [],
    routes: [],
    scripts: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^import\s/.test(trimmed) && symbols.imports.length < 20) {
      symbols.imports.push(trimmed);
    }

    if (/^export\s/.test(trimmed) && symbols.exports.length < 20) {
      symbols.exports.push(trimmed);
    }

    const functionMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/) ||
      trimmed.match(/^(?:export\s+)?const\s+([A-Z][A-Za-z0-9_$]*)\s*=\s*(?:\(|async|\w+\s*=>)/);

    if (functionMatch && symbols.functions.length < 30) {
      symbols.functions.push(functionMatch[1]);
    }

    const classMatch = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z0-9_$]+)/);

    if (classMatch && symbols.classes.length < 20) {
      symbols.classes.push(classMatch[1]);
    }

    if (repoPath.endsWith(".css")) {
      const selectorMatch = trimmed.match(/^([.#][A-Za-z0-9_-][^{,\s]*)/);

      if (selectorMatch && symbols.selectors.length < 40) {
        symbols.selectors.push(selectorMatch[1]);
      }
    }

    if (repoPath.endsWith(".html")) {
      const scriptMatch = trimmed.match(/<script[^>]+src=["']([^"']+)/i);

      if (scriptMatch && symbols.scripts.length < 20) {
        symbols.scripts.push(scriptMatch[1]);
      }
    }

    const routeMatch = trimmed.match(/(?:path|href|to)=["']([^"']+)["']/);

    if (routeMatch && symbols.routes.length < 30) {
      symbols.routes.push(routeMatch[1]);
    }
  }

  return Object.fromEntries(
    Object.entries(symbols).filter(([, values]) => values.length),
  );
}

export async function summarizeFileSymbols(rawArgs = {}) {
  const args = parseToolArguments(rawArgs);
  const result = await readRepoText({
    path: args.path,
    start_line: 1,
    end_line: 260,
  });

  if (result.status !== "OK") {
    return {
      status: result.status,
      path: result.path,
      message: result.message,
    };
  }

  return {
    status: "OK",
    path: result.path,
    lineRange: result.lineRange,
    symbols: summarizeSymbolsFromText(result.path, result.content),
  };
}

async function listRepoFiles(rawArgs = {}) {
  const result = await listRepoEntries(rawArgs);

  if (result.status !== "OK") {
    return formatToolResult("list_repo_files", [
      ["STATUS", result.status],
      ["PATH", result.path || "."],
      ["MESSAGE", result.message],
    ]);
  }

  return formatToolResult("list_repo_files", [
    ["STATUS", "OK"],
    ["PATH", result.path],
    ["TARGET_KIND", result.targetKind],
    ["MAX_DEPTH", String(result.maxDepth)],
    ["ENTRY_COUNT", `${result.entryCount}${result.capped ? " (capped)" : ""}`],
    [
      "ENTRIES",
      result.entries.length
        ? `\n${result.entries
            .map((entry) => (entry.kind === "directory" ? `${entry.path}/` : entry.path))
            .join("\n")}`
        : "(empty)",
    ],
  ]);
}

async function getRepoOverviewTool(rawArgs = {}) {
  const result = await getRepoOverview(rawArgs);

  return formatToolResult("get_repo_overview", [
    ["STATUS", result.status],
    ["REPO", result.repoName],
    ["STACK", result.stack.length ? result.stack.join(", ") : "(unknown)"],
    ["FILE_COUNT_SAMPLED", String(result.fileCountSampled)],
    ["TOP_LEVEL", formatList(result.topLevel)],
    ["PACKAGE_MANIFESTS", formatList(result.packageManifests)],
    ["LOCKFILES", formatList(result.lockfiles)],
    ["PACKAGE_SCRIPTS", formatList(result.packageScripts)],
    ["ENTRYPOINTS", formatList(result.entrypoints)],
    ["IMPORTANT_FILES", formatList(result.importantFiles)],
  ]);
}

async function findEntrypointsTool() {
  const result = await findRepoEntrypoints();

  return formatToolResult("find_entrypoints", [
    ["STATUS", result.status],
    ["PACKAGE_SCRIPTS", formatList(result.packageScripts)],
    ["CONFIGS", formatList(result.configs)],
    ["APP_ROOTS", formatList(result.appRoots)],
    ["ROUTES", formatList(result.routes)],
    ["SERVER_FILES", formatList(result.serverFiles)],
  ]);
}

async function inspectDependenciesTool() {
  const result = await inspectDependencyManifests();

  return formatToolResult("inspect_dependencies", [
    ["STATUS", result.status],
    ["STACK", result.stack.length ? result.stack.join(", ") : "(unknown)"],
    ["LOCKFILES", formatList(result.lockfiles)],
    [
      "MANIFESTS",
      result.manifests.length
        ? `\n${result.manifests.map((manifest) => {
            if (manifest.status === "unreadable") {
              return `${manifest.path}: unreadable`;
            }

            return [
              `${manifest.path}${manifest.name ? ` (${manifest.name})` : ""}`,
              `scripts=${Object.keys(manifest.scripts).join(", ") || "(none)"}`,
              `dependencies=${manifest.dependencies.join(", ") || "(none)"}`,
              `devDependencies=${manifest.devDependencies.join(", ") || "(none)"}`,
            ].join("\n  ");
          }).join("\n")}`
        : "(none)",
    ],
  ]);
}

async function readManyFilesTool(rawArgs = {}) {
  const result = await readManyRepoFiles(rawArgs);

  if (result.status !== "OK") {
    return formatToolResult("read_many_files", [
      ["STATUS", result.status],
      ["MESSAGE", result.message],
    ]);
  }

  return formatToolResult("read_many_files", [
    ["STATUS", "OK"],
    [
      "FILES",
      result.files.length
        ? `\n${result.files.map((file) => {
            if (file.status !== "OK") {
              return `PATH: ${file.path || "."}\nSTATUS: ${file.status}\nMESSAGE: ${file.message}`;
            }

            return [
              `PATH: ${file.path}`,
              "STATUS: OK",
              `LINE_RANGE: ${file.lineRange.start}-${file.lineRange.end} of ${file.lineRange.total}`,
              "CONTENT:",
              file.numberedLines.map((line) => `${line.number}: ${line.text}`).join("\n"),
            ].join("\n");
          }).join("\n\n---\n")}`
        : "(none)",
    ],
  ]);
}

async function readRepoFile(rawArgs = {}) {
  const result = await readRepoText(rawArgs);

  if (result.status !== "OK") {
    return formatToolResult("read_repo_file", [
      ["STATUS", result.status],
      ["PATH", result.path || "."],
      ["MESSAGE", result.message],
    ]);
  }

  return formatToolResult("read_repo_file", [
    ["STATUS", "OK"],
    ["PATH", result.path],
    ["TARGET_KIND", result.targetKind],
    [
      "LINE_RANGE",
      `${result.lineRange.start}-${result.lineRange.end} of ${result.lineRange.total}`,
    ],
    [
      "CONTENT",
      result.numberedLines.length
        ? `\n${result.numberedLines
            .map((line) => `${line.number}: ${line.text}`)
            .join("\n")}`
        : "(no content)",
    ],
  ]);
}

async function searchRepo(rawArgs = {}) {
  const result = await searchRepoMatches(rawArgs);

  if (result.status !== "OK") {
    return formatToolResult("search_repo", [
      ["STATUS", result.status],
      ["PATH", result.path || "."],
      ["MESSAGE", result.message],
    ]);
  }

  return formatToolResult("search_repo", [
    ["STATUS", "OK"],
    ["PATH", result.path],
    ["TARGET_EXISTS", result.targetExists ? "yes" : "no"],
    ["TARGET_KIND", result.targetKind],
    ["QUERY", result.query],
    ["MATCH_COUNT", String(result.matchCount)],
    [
      "NOTE",
      result.note || (result.capped ? `Results were capped at ${result.matchCount}.` : ""),
    ],
    ["MATCHES", result.matches.length ? `\n${result.matches.join("\n")}` : "(none)"],
  ]);
}

async function summarizeFileSymbolsTool(rawArgs = {}) {
  const result = await summarizeFileSymbols(rawArgs);

  if (result.status !== "OK") {
    return formatToolResult("summarize_file_symbols", [
      ["STATUS", result.status],
      ["PATH", result.path || "."],
      ["MESSAGE", result.message],
    ]);
  }

  return formatToolResult("summarize_file_symbols", [
    ["STATUS", "OK"],
    ["PATH", result.path],
    ["LINE_RANGE", `${result.lineRange.start}-${result.lineRange.end} of ${result.lineRange.total}`],
    [
      "SYMBOLS",
      Object.keys(result.symbols).length
        ? `\n${Object.entries(result.symbols)
            .map(([name, values]) => `${name}:\n${values.map((value) => `- ${value}`).join("\n")}`)
            .join("\n")}`
        : "(none found)",
    ],
  ]);
}

const toolHandlers = {
  get_repo_overview: getRepoOverviewTool,
  find_entrypoints: findEntrypointsTool,
  inspect_dependencies: inspectDependenciesTool,
  list_repo_files: listRepoFiles,
  read_many_files: readManyFilesTool,
  read_repo_file: readRepoFile,
  search_repo: searchRepo,
  summarize_file_symbols: summarizeFileSymbolsTool,
};

export async function executeToolCall(toolCall) {
  const name = toolCall?.function?.name;
  const handler = toolHandlers[name];

  if (!handler) {
    return formatToolResult("unknown_tool", [
      ["STATUS", "ERROR"],
      ["MESSAGE", `Unknown tool: ${name}`],
    ]);
  }

  try {
    return await handler(toolCall.function.arguments || {});
  } catch (error) {
    return formatToolResult(name, [
      ["STATUS", "ERROR"],
      ["MESSAGE", error.message],
    ]);
  }
}
