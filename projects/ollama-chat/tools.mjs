import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, "../..");

const repoRootCanonical = (() => {
  try {
    return realpathSync(repoRoot);
  } catch {
    return path.normalize(repoRoot);
  }
})();

export const hiddenPaths = [
  ".git",
  ".idea",
  ".vscode",
  ".DS_Store",
  "models/.ollama",
  "node_modules",
  "projects/ollama-chat/sessions",
];

const toolDescriptions = {
  list_repo_files:
    "List files and directories inside the repository. Use this for structure questions. Prefer relative paths.",
  read_repo_file:
    "Read a text file from the repository with line numbers. Use this for README, source, and config questions.",
  search_repo:
    "Search repository files for a string or regex pattern. Use this only to locate unknown text or symbols.",
};

const toolCatalog = {
  list_repo_files: {
    category: "repo",
    cost: "low",
    description: toolDescriptions.list_repo_files,
  },
  read_repo_file: {
    category: "repo",
    cost: "medium",
    description: toolDescriptions.read_repo_file,
  },
  search_repo: {
    category: "repo",
    cost: "medium",
    description: toolDescriptions.search_repo,
  },
};

export const resourceBudgets = {
  low: {
    label: "Low RAM",
    maxToolRounds: 1,
    maxBootstrapCalls: 2,
    maxListDepth: 2,
    maxListEntries: 80,
    maxFileLines: 120,
    maxSearchResults: 20,
  },
  balanced: {
    label: "Balanced",
    maxToolRounds: 3,
    maxBootstrapCalls: 4,
    maxListDepth: 3,
    maxListEntries: 120,
    maxFileLines: 200,
    maxSearchResults: 35,
  },
  expanded: {
    label: "More Context",
    maxToolRounds: 5,
    maxBootstrapCalls: 6,
    maxListDepth: 4,
    maxListEntries: 200,
    maxFileLines: 250,
    maxSearchResults: 50,
  },
};

export const toolProfiles = {
  minimal: {
    label: "Minimal",
    budget: "low",
    enabledTools: ["list_repo_files", "read_repo_file"],
  },
  coding: {
    label: "Coding",
    budget: "low",
    enabledTools: ["list_repo_files", "read_repo_file", "search_repo"],
  },
  deep: {
    label: "Deep",
    budget: "expanded",
    enabledTools: ["list_repo_files", "read_repo_file", "search_repo"],
  },
};

let toolRuntimeConfig = normalizeToolRuntimeConfig({
  profile: process.env.OLLAMA_TOOL_PROFILE || "coding",
  budget: process.env.OLLAMA_RESOURCE_BUDGET || null,
});

export const toolDefinitions = [
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
];

function normalizeToolRuntimeConfig(rawConfig = {}) {
  const requestedProfile = String(rawConfig.profile || "coding").trim();
  const profileName = Object.hasOwn(toolProfiles, requestedProfile) ? requestedProfile : "coding";
  const profile = toolProfiles[profileName];
  const requestedBudget = String(rawConfig.budget || profile.budget).trim();
  const budgetName = Object.hasOwn(resourceBudgets, requestedBudget)
    ? requestedBudget
    : profile.budget;
  const allowedTools = new Set(Object.keys(toolCatalog));
  const requestedTools = Array.isArray(rawConfig.enabledTools)
    ? rawConfig.enabledTools
    : profile.enabledTools;
  const enabledTools = requestedTools.filter((name) => allowedTools.has(name));

  return {
    profile: profileName,
    budget: budgetName,
    enabledTools: enabledTools.length ? enabledTools : [...profile.enabledTools],
    limits: resourceBudgets[budgetName],
  };
}

export function configureTooling(rawConfig = {}) {
  const nextConfig = { ...toolRuntimeConfig, ...rawConfig };

  if (Object.hasOwn(rawConfig, "profile") && !Object.hasOwn(rawConfig, "enabledTools")) {
    delete nextConfig.enabledTools;
  }

  toolRuntimeConfig = normalizeToolRuntimeConfig({
    ...nextConfig,
  });
  return getToolRuntimeConfig();
}

export function getToolRuntimeConfig() {
  return {
    ...toolRuntimeConfig,
    enabledTools: [...toolRuntimeConfig.enabledTools],
    limits: { ...toolRuntimeConfig.limits },
  };
}

export function isToolEnabled(name) {
  return toolRuntimeConfig.enabledTools.includes(name);
}

export function getEnabledToolDefinitions() {
  const enabled = new Set(toolRuntimeConfig.enabledTools);
  return toolDefinitions.filter((definition) => enabled.has(definition.function.name));
}

export function listToolCatalog() {
  return Object.entries(toolCatalog).map(([name, metadata]) => ({
    name,
    ...metadata,
    enabled: isToolEnabled(name),
  }));
}

export function listTools({ enabledOnly = false } = {}) {
  const entries = enabledOnly
    ? Object.entries(toolDescriptions).filter(([name]) => isToolEnabled(name))
    : Object.entries(toolDescriptions);

  return entries
    .map(([name, description]) => `${name}: ${description}`)
    .join("\n");
}

function normalizeRelative(value = ".") {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
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
  return hiddenPaths.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

/** Ensures resolved paths cannot escape the repo via .. segments or symlink targets. */
function assertPathWithinRepo(absPath) {
  const normalizedAbs = path.normalize(absPath);

  let canonicalTarget;

  try {
    canonicalTarget = realpathSync(normalizedAbs);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    const relativeToRoot = path.relative(repoRootCanonical, normalizedAbs);

    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error("Path must stay inside the repository root.");
    }

    return;
  }

  const relativeToRoot = path.relative(repoRootCanonical, canonicalTarget);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("Path must stay inside the repository root.");
  }
}

export function resolveRepoPath(inputPath = ".") {
  const raw = String(inputPath || ".").trim();

  if (raw.includes("\0")) {
    throw new Error("Invalid path.");
  }

  const repoPrefix = `${path.basename(repoRoot)}/`;

  if (raw === "/" || raw === repoRoot) {
    assertPathWithinRepo(repoRoot);
    return { abs: repoRoot, rel: "." };
  }

  const normalizedRaw = raw.startsWith(repoPrefix) ? raw.slice(repoPrefix.length) : raw;

  if (path.isAbsolute(normalizedRaw)) {
    const abs = path.resolve(normalizedRaw);
    assertPathWithinRepo(abs);

    const rel = normalizeRelative(path.relative(repoRoot, abs));

    if (rel !== "." && isHidden(rel)) {
      throw new Error("That path is intentionally hidden from tools.");
    }

    return { abs, rel };
  }

  const abs = path.resolve(repoRoot, normalizedRaw);
  assertPathWithinRepo(abs);

  const rel = normalizeRelative(path.relative(repoRoot, abs));

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
      "--glob",
      "!.git",
      "--glob",
      "!.idea/**",
      "--glob",
      "!.vscode/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!models/.ollama/**",
      "--glob",
      "!projects/ollama-chat/sessions/**",
      repoRoot,
    ]);

    const files = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(`${repoRoot}/`, ""))
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
  const { limits } = getToolRuntimeConfig();
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
  const maxDepth = Math.min(Math.max(toInt(args.depth, 1), 0), limits.maxListDepth);
  const maxEntries = Math.min(Math.max(toInt(args.max_entries, 60), 1), limits.maxListEntries);
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
  const { limits } = getToolRuntimeConfig();
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
  const endLine = Math.min(requestedEnd, startLine + limits.maxFileLines - 1);
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
  const { limits } = getToolRuntimeConfig();
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

  const maxResults = Math.min(Math.max(toInt(args.max_results, 20), 1), limits.maxSearchResults);
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
    const { stdout } = await execFileAsync("rg", [
      "-n",
      "--hidden",
      "-S",
      "--glob",
      "!.git",
      "--glob",
      "!.idea/**",
      "--glob",
      "!.vscode/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!models/.ollama/**",
      "--glob",
      "!projects/ollama-chat/sessions/**",
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
      .map((line) => line.replace(`${repoRoot}/`, ""))
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

    throw error;
  }
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

const toolHandlers = {
  list_repo_files: listRepoFiles,
  read_repo_file: readRepoFile,
  search_repo: searchRepo,
};

export async function executeToolCall(toolCall) {
  const name = toolCall?.function?.name;
  const handler = toolHandlers[name];

  if (name && !isToolEnabled(name)) {
    return formatToolResult(name, [
      ["STATUS", "ERROR"],
      ["MESSAGE", `Tool is disabled by the active tooling profile: ${name}`],
    ]);
  }

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
