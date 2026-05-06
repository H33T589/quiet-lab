import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkspaceName, hasAttachedCodebase } from "./tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const memoryDir = path.join(__dirname, "sessions", "memory");
const memoryVersion = 1;

function createMemoryId(repoName = getWorkspaceName()) {
  return String(repoName || "no-codebase")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80) || "no-codebase";
}

function createEmptyMemory(repoName = getWorkspaceName()) {
  return {
    version: memoryVersion,
    memoryId: createMemoryId(repoName),
    repoName,
    updatedAt: null,
    project: {
      stack: [],
      entrypoints: [],
      packageScripts: [],
      importantFiles: [],
      lockfiles: [],
      knownRisks: [],
      recommendedTests: [],
    },
    userNotes: [],
    fileSummaries: {},
    events: [],
  };
}

function uniq(values, limit = 40) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

function getToolField(content, field) {
  const match = content.match(new RegExp(`^${field}:\\s*(.*)$`, "m"));
  return match?.[1]?.trim() || null;
}

function getToolListField(content, field) {
  const match = content.match(new RegExp(`(?:^|\\n)${field}:\\s*(?:\\n([\\s\\S]*?))?(?=\\n[A-Z_]+:|$)`));
  const raw = match?.[1] || "";

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "(none)" && line !== "(unknown)");
}

function findBootstrapResult(results, toolName) {
  return results.find(({ name }) => name === toolName);
}

function mergeMemory(existing, patch = {}) {
  const next = {
    ...createEmptyMemory(existing.repoName || getWorkspaceName()),
    ...existing,
    project: {
      ...createEmptyMemory(existing.repoName || getWorkspaceName()).project,
      ...(existing.project || {}),
    },
    fileSummaries: {
      ...(existing.fileSummaries || {}),
    },
  };

  next.project.stack = uniq([...(next.project.stack || []), ...(patch.stack || [])], 16);
  next.project.entrypoints = uniq([...(next.project.entrypoints || []), ...(patch.entrypoints || [])], 30);
  next.project.packageScripts = uniq([...(next.project.packageScripts || []), ...(patch.packageScripts || [])], 30);
  next.project.importantFiles = uniq([...(next.project.importantFiles || []), ...(patch.importantFiles || [])], 30);
  next.project.lockfiles = uniq([...(next.project.lockfiles || []), ...(patch.lockfiles || [])], 12);
  next.project.knownRisks = uniq([...(next.project.knownRisks || []), ...(patch.knownRisks || [])], 30);
  next.project.recommendedTests = uniq([...(next.project.recommendedTests || []), ...(patch.recommendedTests || [])], 30);

  if (patch.event) {
    next.events = [
      {
        at: new Date().toISOString(),
        ...patch.event,
      },
      ...(next.events || []),
    ].slice(0, 20);
  }

  if (Object.keys(patch).length) {
    next.updatedAt = new Date().toISOString();
  }

  return next;
}

export function getProjectMemoryPath(repoName = getWorkspaceName()) {
  return path.join(memoryDir, `${createMemoryId(repoName)}.json`);
}

export async function loadProjectMemory(repoName = getWorkspaceName()) {
  if (!hasAttachedCodebase()) {
    return createEmptyMemory("no codebase attached");
  }

  try {
    const raw = await readFile(getProjectMemoryPath(repoName), "utf8");
    const saved = JSON.parse(raw);
    return {
      ...createEmptyMemory(repoName),
      ...saved,
      project: {
        ...createEmptyMemory(repoName).project,
        ...(saved.project || {}),
      },
      fileSummaries: saved.fileSummaries || {},
      userNotes: Array.isArray(saved.userNotes) ? saved.userNotes : [],
      events: Array.isArray(saved.events) ? saved.events : [],
      repoName,
      updatedAt: saved.updatedAt || null,
    };
  } catch {
    return createEmptyMemory(repoName);
  }
}

export async function saveProjectMemory(memory) {
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    getProjectMemoryPath(memory.repoName),
    JSON.stringify(
      {
        ...memory,
        version: memoryVersion,
        updatedAt: memory.updatedAt || new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function clearProjectMemory(repoName = getWorkspaceName()) {
  await rm(getProjectMemoryPath(repoName), { force: true });
  return createEmptyMemory(repoName);
}

export async function setProjectUserNotes(notes, repoName = getWorkspaceName()) {
  const memory = await loadProjectMemory(repoName);
  memory.userNotes = uniq(Array.isArray(notes) ? notes : String(notes || "").split("\n"), 80);
  memory.updatedAt = new Date().toISOString();
  await saveProjectMemory(memory);
  return memory;
}

export async function updateProjectMemoryFromBootstrap(userInput, bootstrapResults = [], answerText = "") {
  if (!hasAttachedCodebase() || !bootstrapResults.length) {
    return loadProjectMemory();
  }

  const overview = findBootstrapResult(bootstrapResults, "get_repo_overview");
  const dependencies = findBootstrapResult(bootstrapResults, "inspect_dependencies");
  const patch = {
    event: {
      kind: "workflow",
      prompt: String(userInput || "").slice(0, 160),
    },
  };

  if (overview?.content && getToolField(overview.content, "STATUS") === "OK") {
    const stack = getToolField(overview.content, "STACK");
    patch.stack = stack && stack !== "(unknown)" ? stack.split(",").map((item) => item.trim()) : [];
    patch.entrypoints = getToolListField(overview.content, "ENTRYPOINTS");
    patch.packageScripts = getToolListField(overview.content, "PACKAGE_SCRIPTS");
    patch.importantFiles = getToolListField(overview.content, "IMPORTANT_FILES");
    patch.lockfiles = getToolListField(overview.content, "LOCKFILES");
  }

  if (/review|risk|bug|security|edge case/i.test(userInput) || /Likely risks:/i.test(answerText)) {
    patch.knownRisks = String(answerText)
      .split("\n")
      .map((line) => line.replace(/^-\s+/, "").trim())
      .filter((line) => /risk|script|lockfile|stack|entry point|lint|test|security/i.test(line))
      .slice(0, 12);
  }

  if (/test/i.test(userInput) || /Recommended tests:/i.test(answerText)) {
    patch.recommendedTests = String(answerText)
      .split("\n")
      .map((line) => line.replace(/^-\s+/, "").trim())
      .filter((line) => /test|safety|session|tool|workflow|path/i.test(line))
      .slice(0, 12);
  }

  if (dependencies?.content && getToolField(dependencies.content, "STATUS") === "OK") {
    const stack = getToolField(dependencies.content, "STACK");
    patch.stack = uniq([...(patch.stack || []), ...(stack && stack !== "(unknown)" ? stack.split(",") : [])], 16);
  }

  const existing = await loadProjectMemory();
  const next = mergeMemory(existing, patch);
  await saveProjectMemory(next);
  return next;
}

export function formatProjectMemoryContext(memory) {
  if (!memory || !memory.updatedAt) {
    return null;
  }

  const sections = [
    `Known project memory for "${memory.repoName}":`,
    memory.project.stack.length ? `Stack: ${memory.project.stack.join(", ")}` : null,
    memory.project.entrypoints.length ? `Entry points: ${memory.project.entrypoints.slice(0, 8).join(", ")}` : null,
    memory.project.packageScripts.length ? `Scripts: ${memory.project.packageScripts.slice(0, 8).join("; ")}` : null,
    memory.project.knownRisks.length ? `Known risks: ${memory.project.knownRisks.slice(0, 8).join("; ")}` : null,
    memory.project.recommendedTests.length ? `Recommended tests: ${memory.project.recommendedTests.slice(0, 8).join("; ")}` : null,
    memory.userNotes.length ? `User notes: ${memory.userNotes.slice(0, 12).join("; ")}` : null,
  ].filter(Boolean);

  return sections.length > 1 ? sections.join("\n") : null;
}
